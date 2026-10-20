import { describe, it, expect } from 'vitest';
import { estimateTokens } from '@zerovity/core';
import { assembleContext, bundleToFiles, convertFile, htmlToMarkdown, isPrivateIp, fetchSnapshot, _pinnedGet, buildItemBody, parseDelimited, qaMarkdown, repoConventionItems, type ContextItemRecord } from '../src';

let n = 0;
const item = (o: Partial<ContextItemRecord> & { title: string }): ContextItemRecord => {
  const body = o.body ?? `Body of ${o.title}. `.repeat(5);
  return { id: `i${++n}`, layer: 'factory', scopeId: 'F1', kind: 'note', summary: '', tags: [], appliesTo: { phases: [], agents: [] }, priority: 'always', tokenCount: estimateTokens(body), enabled: true, version: 1, createdAt: new Date(2026, 0, n), body, ...o };
};
const wi = { id: 'W1', shortId: 'ZF-1', title: 'Do it', body: '', factoryId: 'F1', repoKey: 'acme/pay' };
const agent = { name: 'zerovity-executor', phase: 'BUILD', contextScopes: ['org', 'factory', 'repo', 'workItem', 'phase'] };

describe('assembly order and scope (spec 9.3)', () => {
  it('orders org -> factory -> repo -> workItem -> phase and includes the Q&A history', () => {
    const items = [
      item({ title: 'PHASE', layer: 'phase', scopeId: 'W1:BUILD' }),
      item({ title: 'WORK', layer: 'workItem', scopeId: 'W1' }),
      item({ title: 'REPO', layer: 'repo', scopeId: 'acme/pay' }),
      item({ title: 'FACT', layer: 'factory' }),
      item({ title: 'ORG', layer: 'org', scopeId: '' }),
    ];
    const b = assembleContext({ items, agent, workItem: wi, qa: [{ question: 'Stop on AC04?', kind: 'decision', answer: 'Yes, stop', answeredBy: 'Priya' }] });
    const pos = ['ORG', 'FACT', 'REPO', 'WORK', 'PHASE'].map((t) => b.contextMd.indexOf(`] ${t}\n`));
    expect(pos.every((p) => p > 0)).toBe(true);
    expect([...pos].sort((a, c) => a - c)).toEqual(pos);
    expect(b.contextMd.indexOf('Question and answer history')).toBeGreaterThan(pos[4]);
    expect(b.contextMd).toContain('Answer: Yes, stop');
  });

  it('skips items from other factories, repos, work items and phases', () => {
    const items = [item({ title: 'other factory', scopeId: 'F2' }), item({ title: 'other repo', layer: 'repo', scopeId: 'x/y' }), item({ title: 'other wi', layer: 'workItem', scopeId: 'W9' }), item({ title: 'other phase', layer: 'phase', scopeId: 'W1:SPEC' }), item({ title: 'mine' })];
    const b = assembleContext({ items, agent, workItem: wi, qa: [] });
    expect(b.contextMd).toContain('mine');
    for (const t of ['other factory', 'other repo', 'other wi', 'other phase']) expect(b.contextMd).not.toContain(t);
    expect(b.report.filter((r) => r.reason === 'not_in_scope')).toHaveLength(4);
  });

  it('respects the agent contextScopes', () => {
    const b = assembleContext({ items: [item({ title: 'ORG', layer: 'org', scopeId: '' }), item({ title: 'FACT' })], agent: { ...agent, contextScopes: ['factory'] }, workItem: wi, qa: [] });
    expect(b.contextMd).not.toContain('] ORG');
  });

  it('applies phase and agent filters', () => {
    const items = [item({ title: 'spec only', appliesTo: { phases: ['SPEC'], agents: [] } }), item({ title: 'build only', appliesTo: { phases: ['BUILD'], agents: [] } }), item({ title: 'verifier only', appliesTo: { phases: [], agents: ['zerovity-verifier'] } })];
    const b = assembleContext({ items, agent, workItem: wi, qa: [] });
    expect(b.contextMd).toContain('build only');
    expect(b.contextMd).not.toContain('spec only');
    expect(b.contextMd).not.toContain('verifier only');
  });

  it('honours per-work-item toggles in both directions', () => {
    const on = item({ title: 'default-off', enabled: false });
    const off = item({ title: 'default-on' });
    const b = assembleContext({ items: [on, off], agent, workItem: wi, qa: [], toggles: { [on.id]: true, [off.id]: false } });
    expect(b.contextMd).toContain('default-off');
    expect(b.contextMd).not.toContain('] default-on\n');
  });
});

describe('priorities, index and budgets', () => {
  it('on_request items are index-only with a one-line summary and a file under items/', () => {
    const it = item({ title: 'Refund policy', priority: 'on_request', body: '# Refund policy\n\nRefunds over $10k need two approvers.\n' + 'x '.repeat(500) });
    const b = assembleContext({ items: [it], agent, workItem: wi, qa: [] });
    expect(b.contextMd).toContain('Index of items you can open');
    expect(b.contextMd).toContain(`items/${it.id}.md`);
    expect(b.contextMd).not.toContain('x x x x');
    expect(Object.keys(bundleToFiles(b))).toContain(`.zerovity/context/items/${it.id}.md`);
  });

  it('trims relevant items first (oldest first), keeps always items and every answer when over budget', () => {
    const big = 'lorem ipsum dolor sit amet '.repeat(400);
    const always = item({ title: 'ALWAYS', body: 'short always body' });
    const rel1 = item({ title: 'REL-OLD', priority: 'relevant', body: big });
    const rel2 = item({ title: 'REL-NEW', priority: 'relevant', body: big });
    const qa = Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}`, kind: 'decision', answer: `A${i} `.repeat(20) }));
    const b = assembleContext({ items: [always, rel1, rel2], agent: { ...agent, tokenBudget: 2600 }, workItem: wi, qa });
    expect(b.trimmed).toBe(true);
    expect(b.tokens).toBeLessThanOrEqual(2600);
    expect(b.report.find((r) => r.id === rel1.id)?.form).toBe('index');
    expect(b.contextMd).toContain('short always body');
    for (let i = 0; i < 5; i++) expect(b.contextMd).toContain(`A${i} A${i}`);
    expect(b.items[rel1.id]).toContain('lorem ipsum');
  });

  it('demotes broad-layer always items before work item items when still over budget', () => {
    const big = 'word '.repeat(2000);
    const org = item({ title: 'ORG-BIG', layer: 'org', scopeId: '', body: big });
    const mine = item({ title: 'WI-BIG', layer: 'workItem', scopeId: 'W1', body: big });
    const b = assembleContext({ items: [org, mine], agent: { ...agent, tokenBudget: 3500 }, workItem: wi, qa: [] });
    expect(b.report.find((r) => r.id === org.id)?.form).toBe('index');
    expect(b.report.find((r) => r.id === mine.id)?.form).toBe('full');
  });

  it('the bundle hash is stable for the same input and changes when anything changes', () => {
    const items = [item({ title: 'a' })];
    const h1 = assembleContext({ items, agent, workItem: wi, qa: [] }).bundleHash;
    expect(assembleContext({ items, agent, workItem: wi, qa: [] }).bundleHash).toBe(h1);
    expect(assembleContext({ items, agent, workItem: wi, qa: [{ question: 'q', kind: 'decision', answer: 'a' }] }).bundleHash).not.toBe(h1);
  });

  it('reports every item with tokens for the preview panel', () => {
    const b = assembleContext({ items: [item({ title: 'x' }), item({ title: 'y', enabled: false })], agent, workItem: wi, qa: [] });
    expect(b.report).toHaveLength(2);
    expect(b.report.every((r) => r.tokens > 0)).toBe(true);
  });
});

describe('item building, repo conventions and Q&A', () => {
  it('glossary, adr and repoPointer produce readable bodies', () => {
    expect(buildItemBody({ layer: 'factory', title: 'Payout', kind: 'glossary', meta: { term: 'Payout', definition: 'Money to merchants.' } }).body).toBe('**Payout**: Money to merchants.');
    expect(buildItemBody({ layer: 'factory', title: 'ADR-31', kind: 'adr', meta: { status: 'Accepted', decision: 'Use idempotency keys.' } }).body).toContain('Status: Accepted');
    expect(buildItemBody({ layer: 'repo', title: 'Docs', kind: 'repoPointer', meta: { repo: 'acme/pay', glob: 'docs/**' } }).body).toContain('docs/**');
  });
  it('repo conventions files become repo items', () => {
    const r = repoConventionItems([{ path: 'AGENTS.md', content: '# Rules\nRun pnpm test.' }, { path: 'CLAUDE.md', content: '  ' }], 'acme/pay');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ layer: 'repo', priority: 'always' });
  });
  it('unanswered questions are marked', () => expect(qaMarkdown([{ question: 'Q?', kind: 'decision' }])).toContain('Not answered yet'));
});

describe('conversion and snapshots', () => {
  it('text, csv and html convert to markdown', async () => {
    expect((await convertFile(Buffer.from('# T\nhello'), 'a.md')).markdown).toBe('# T\nhello');
    const csv = await convertFile(Buffer.from('a,b\n1,"x,y"\n'), 'd.csv');
    expect(csv.markdown).toContain('| a | b |');
    expect(csv.markdown).toContain('x,y');
    const html = await convertFile(Buffer.from('<html><head><title>Doc</title></head><body><h1>Hi</h1><p>one <b>two</b></p><ul><li>x</li></ul></body></html>'), 'p.html');
    expect(html.markdown).toContain('# Hi');
    expect(html.markdown).toContain('- x');
  });
  it('images are described via the hook or stubbed; unknown binaries are stored, not read', async () => {
    expect((await convertFile(Buffer.from([1, 2, 3]), 'a.png', { describeImage: async () => 'A bar chart' })).markdown).toContain('A bar chart');
    expect((await convertFile(Buffer.from([1, 2, 3]), 'a.png')).described).toBe(true);
    expect((await convertFile(Buffer.from([0, 1, 2, 0]), 'a.bin')).kind).toBe('binary');
  });
  it('broken documents degrade gracefully', async () => {
    const r = await convertFile(Buffer.from('not a pdf'), 'x.pdf');
    expect(r.kind).toBe('binary');
    expect(r.warnings[0]).toMatch(/conversion failed/);
  });
  it('delimited parser handles quotes and newlines', () => expect(parseDelimited('a,b\n"x\ny",2\n', ',')).toEqual([['a', 'b'], ['x\ny', '2']]));
  it('html to markdown strips scripts and keeps links', () => expect(htmlToMarkdown('<body><script>x()</script><a href="https://e.x">link</a></body>')).toBe('[link](https://e.x)'));
  it('private addresses are blocked for URL snapshots', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.4', '172.20.1.1', '169.254.169.254', '::1', 'fd00::1']) expect(isPrivateIp(ip)).toBe(true);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    await expect(fetchSnapshot('http://169.254.169.254/latest')).rejects.toThrow(/private/);
    await expect(fetchSnapshot('file:///etc/passwd')).rejects.toThrow(/http/);
  });
  it('snapshots html through an injected fetch', async () => {
    const f = (async () => new Response('<html><head><title>Wiki</title></head><body><h1>Refunds</h1><p>Two approvers.</p></body></html>', { headers: { 'content-type': 'text/html' } })) as typeof fetch;
    const s = await fetchSnapshot('https://example.com/wiki', { fetchImpl: f, lookup: async () => ['93.184.216.34'] });
    expect(s.markdown).toContain('Two approvers.');
    expect(s.title).toBe('Wiki');
  });

  it('blocks every spelling of a private IPv6 address, including IPv4-mapped hex forms', () => {
    for (const ip of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:c0a8:1', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1', '::', '64:ff9b::a00:1', '::10.0.0.1', 'not-an-ip']) expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ['198.19.0.1', '192.0.0.8', '100.64.0.1', '224.0.0.1']) expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ['2606:4700:4700::1111', '::ffff:8.8.8.8', '8.8.8.8', '1.1.1.1']) expect(isPrivateIp(ip), ip).toBe(false);
  });
  it('re-checks every redirect hop: a public page cannot bounce the fetch to an internal address', async () => {
    const seen: string[] = [];
    const f = (async (u: string) => { seen.push(u); return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }); }) as typeof fetch;
    const lookup = async (h: string) => (h === 'example.com' ? ['93.184.216.34'] : ['169.254.169.254']);
    await expect(fetchSnapshot('https://example.com/go', { fetchImpl: f, lookup })).rejects.toThrow(/private/);
    expect(seen).toEqual(['https://example.com/go']); // the internal address was never requested
  });
  it('follows a normal redirect chain, and stops redirect loops', async () => {
    const f = (async (u: string) => (u.endsWith('/a') ? new Response('', { status: 301, headers: { location: '/b' } }) : new Response('# Final\nbody', { headers: { 'content-type': 'text/markdown' } }))) as typeof fetch;
    const s = await fetchSnapshot('https://example.com/a', { fetchImpl: f, lookup: async () => ['93.184.216.34'] });
    expect(s.finalUrl).toBe('https://example.com/b');
    expect(s.title).toBe('Final');
    const loop = (async () => new Response('', { status: 302, headers: { location: '/again' } })) as typeof fetch;
    await expect(fetchSnapshot('https://example.com/x', { fetchImpl: loop, lookup: async () => ['93.184.216.34'] })).rejects.toThrow(/redirects/);
  });
  it('the pinned transport connects to the validated address while keeping the real Host name (DNS rebinding)', async () => {
    const http = await import('node:http');
    const server = http.createServer((req, res) => res.end(JSON.stringify({ host: req.headers.host, enc: req.headers['accept-encoding'] }))).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as import('node:net').AddressInfo).port;
    // "rebind.test" does not resolve at all: only the pinned address can have been used
    const r = await _pinnedGet(new URL(`http://rebind.test:${port}/x`), '127.0.0.1', {}, new AbortController().signal);
    expect(JSON.parse(r.body.toString())).toEqual({ host: `rebind.test:${port}`, enc: 'identity' });
    server.close();
  });});
