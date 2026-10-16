import path from 'node:path';
import { estimateTokens } from '@zerovity/core';

export interface Converted {
  markdown: string;
  kind: 'text' | 'pdf' | 'docx' | 'xlsx' | 'csv' | 'html' | 'image' | 'binary';
  /** true when the content was described rather than extracted */
  described: boolean;
  tokens: number;
  warnings: string[];
}

export interface ConvertOptions {
  /** optional vision hook for images (e.g. an LLM call); without it images become a stub with their metadata */
  describeImage?: (buf: Buffer, mime: string, name: string) => Promise<string>;
  maxChars?: number;
}

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.yaml', '.yml', '.log', '.xml', '.toml', '.ini', '.sql', '.ts', '.js', '.py', '.java', '.cs', '.go', '.rb', '.sh', '.ps1', '.tsx', '.jsx', '.css', '.csv', '.tsv', '.rst']);
const IMAGE_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

/** Convert an uploaded file to Markdown at upload time; the original is stored alongside by the caller. */
export async function convertFile(buf: Buffer, name: string, opts: ConvertOptions = {}): Promise<Converted> {
  const ext = path.extname(name).toLowerCase();
  const max = opts.maxChars ?? 400_000;
  const warnings: string[] = [];
  const done = (markdown: string, kind: Converted['kind'], described = false): Converted => {
    let md = markdown;
    if (md.length > max) { md = md.slice(0, max) + `\n\n[truncated: file was ${markdown.length} characters]`; warnings.push('truncated'); }
    return { markdown: md, kind, described, tokens: estimateTokens(md), warnings };
  };
  try {
    if (ext === '.pdf') {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { text, totalPages } = await extractText(pdf, { mergePages: false });
      const pages = (Array.isArray(text) ? text : [text]) as string[];
      return done(`# ${name}\n\n${pages.map((p, i) => `<!-- page ${i + 1} of ${totalPages} -->\n${p.trim()}`).join('\n\n')}`, 'pdf');
    }
    if (ext === '.docx') {
      const mammoth = (await import('mammoth')) as unknown as { convertToMarkdown?: (i: { buffer: Buffer }) => Promise<{ value: string; messages: Array<{ message: string }> }>; default?: { convertToMarkdown: (i: { buffer: Buffer }) => Promise<{ value: string; messages: Array<{ message: string }> }> } };
      const conv = (mammoth.convertToMarkdown ?? mammoth.default!.convertToMarkdown)!;
      const r = await conv({ buffer: buf });
      for (const m of r.messages.slice(0, 5)) warnings.push(m.message);
      return done(`# ${name}\n\n${r.value}`, 'docx');
    }
    if (ext === '.xlsx') {
      const mod = (await import('read-excel-file/node')) as unknown as { default: (src: Buffer, o?: { sheet?: number | string }) => Promise<unknown[][]>; readSheetNames?: (src: Buffer) => Promise<string[]> };
      const names = mod.readSheetNames ? await mod.readSheetNames(buf) : ['Sheet1'];
      const parts: string[] = [`# ${name}`];
      for (const [i, sn] of names.slice(0, 12).entries()) {
        const rows = await mod.default(buf, { sheet: i + 1 });
        parts.push(`\n## Sheet: ${sn}\n\n${tableMd(rows)}`);
      }
      return done(parts.join('\n'), 'xlsx');
    }
    if (ext === '.html' || ext === '.htm') return done(htmlToMarkdown(buf.toString('utf8')), 'html');
    if (ext === '.csv' || ext === '.tsv') {
      const rows = parseDelimited(buf.toString('utf8'), ext === '.tsv' ? '\t' : ',');
      return done(`# ${name}\n\n${tableMd(rows.slice(0, 500))}${rows.length > 500 ? `\n\n[${rows.length - 500} more rows not shown]` : ''}`, 'csv');
    }
    if (IMAGE_EXT[ext]) {
      const mime = IMAGE_EXT[ext];
      const desc = opts.describeImage ? await opts.describeImage(buf, mime, name) : `Image file "${name}" (${mime}, ${buf.length} bytes). No description was generated; ask the person who attached it if its content matters.`;
      return done(`# ${name}\n\n${desc}`, 'image', true);
    }
    if (TEXT_EXT.has(ext) || isProbablyText(buf)) return done(ext === '.md' || ext === '.markdown' ? buf.toString('utf8') : '```\n' + buf.toString('utf8') + '\n```', 'text');
  } catch (e) {
    warnings.push(`conversion failed: ${(e as Error).message}`);
    return { markdown: `# ${name}\n\nThe file could not be converted (${(e as Error).message}). The original is stored.`, kind: 'binary', described: true, tokens: 20, warnings };
  }
  return { markdown: `# ${name}\n\nBinary file (${buf.length} bytes) of an unsupported type. The original is stored.`, kind: 'binary', described: true, tokens: 20, warnings: ['unsupported type'] };
}

export function isProbablyText(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

export function tableMd(rows: unknown[][]): string {
  if (!rows.length) return '_empty_';
  const w = Math.max(...rows.map((r) => r.length));
  const cell = (v: unknown) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const pad = (r: unknown[]) => Array.from({ length: w }, (_, i) => cell(r[i]));
  const [head, ...rest] = rows;
  return [`| ${pad(head).join(' | ')} |`, `|${Array(w).fill(' --- ').join('|')}|`, ...rest.map((r) => `| ${pad(r).join(' | ')} |`)].join('\n');
}

export function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.length));
}

/** Small dependency-free HTML to Markdown for snapshots; good enough for docs and wiki pages. */
export function htmlToMarkdown(html: string): string {
  let h = html.replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(h)?.[1]?.trim();
  const main = /<(main|article)[^>]*>([\s\S]*?)<\/\1>/i.exec(h)?.[2];
  h = main ?? /<body[^>]*>([\s\S]*?)<\/body>/i.exec(h)?.[1] ?? h;
  h = h
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, t: string) => `\n\n${'#'.repeat(Number(n))} ${stripTags(t)}\n\n`)
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, t: string) => `[${stripTags(t)}](${href})`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t: string) => `\n- ${stripTags(t)}`)
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, t: string) => `\n\n\`\`\`\n${decode(stripTags(t))}\n\`\`\`\n\n`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, t: string) => `\`${stripTags(t)}\``)
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_, __: string, t: string) => `**${stripTags(t)}**`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|ul|ol|table|section)>/gi, '\n\n')
    .replace(/<\/t[dh]>/gi, ' | ');
  const md = decode(stripTags(h)).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return (title ? `# ${decode(title)}\n\n` : '') + md;
}
const stripTags = (s: string) => s.replace(/<[^>]+>/g, '');
const decode = (s: string) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
