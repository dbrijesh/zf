import { z } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { readRev, runEventsAfter } from '@zerovity/orchestrator';
import { eq } from 'drizzle-orm';
import { tables as t } from '@zerovity/db';
import { factoryFor, runFor, type AppCtx } from '../context';

function open(reply: FastifyReply) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no', ...(reply.getHeader('access-control-allow-origin') ? { 'access-control-allow-origin': String(reply.getHeader('access-control-allow-origin')), 'access-control-allow-credentials': 'true' } : {}) });
  res.write('retry: 2000\n\n');
  const send = (event: string, data: unknown, id?: string | number) => { if (!res.writableEnded) res.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  return { res, send };
}

/** Server-sent events: one stream per factory for the floor and inbox, one per run for the live view (spec 4). */
export async function sseRoutes(app0: FastifyInstance, ctx: AppCtx) {
  const app = app0.withTypeProvider<ZodTypeProvider>();
  const { s } = ctx;

  app.get('/events', { schema: { querystring: z.object({ factoryId: z.string() }) } }, async (req, reply) => {
    const { f } = await factoryFor(ctx, req, req.query.factoryId);
    const { res, send } = open(reply);
    let rev = await readRev(s.db, f.id);
    send('rev', { rev });
    // in-process events give instant updates; the poll covers other processes (worker pods)
    const off = s.hub.subscribe((e) => { if (e.factoryId === f.id && (e.type === 'changed' || e.type === 'transition')) { rev++; send('rev', { rev, hint: { type: e.type, workItemId: e.workItemId, runId: e.runId } }); } });
    const poll = setInterval(async () => { try { const r = await readRev(s.db, f.id); if (r > rev) { rev = r; send('rev', { rev }); } } catch { /* db hiccup: next tick */ } }, 1200);
    const beat = setInterval(() => !res.writableEnded && res.write(': keep-alive\n\n'), 20_000);
    req.raw.on('close', () => { off(); clearInterval(poll); clearInterval(beat); });
  });

  app.get('/runs/:id/stream', { schema: { params: z.object({ id: z.string() }), querystring: z.object({ after: z.coerce.number().int().min(0).default(0) }) } }, async (req, reply) => {
    const { r } = await runFor(ctx, req, req.params.id);
    const last = Number(req.headers['last-event-id'] ?? 0);
    let cursor = Math.max(req.query.after, last);
    const { res, send } = open(reply);
    let busy = false, closed = false;
    const pump = async () => {
      if (busy || closed) return;
      busy = true;
      try {
        for (;;) {
          const rows = await runEventsAfter(s.db, r.id, cursor, 300);
          for (const e of rows) { cursor = e.seq; send('event', { seq: e.seq, ts: e.ts, ...e.payload }, e.seq); }
          if (rows.length < 300) break;
        }
        const [cur] = await s.db.select().from(t.runs).where(eq(t.runs.id, r.id));
        send('run', { status: cur.status, tokensIn: cur.tokensIn, tokensOut: cur.tokensOut, tokensCached: cur.tokensCached, costUsd: cur.costUsd, eventCount: cur.eventCount, sessionId: cur.sessionId, exitReason: cur.exitReason });
        if (cur.status !== 'running' && cur.status !== 'queued') {
          const more = await runEventsAfter(s.db, r.id, cursor, 1);
          if (!more.length) { send('end', { status: cur.status }); closed = true; res.end(); }
        }
      } catch { /* retry on next tick */ } finally { busy = false; }
    };
    const off = s.hub.subscribe((e) => { if (e.type === 'run.events' && e.runId === r.id) void pump(); });
    const poll = setInterval(() => void pump(), 500);
    const beat = setInterval(() => !res.writableEnded && res.write(': keep-alive\n\n'), 20_000);
    req.raw.on('close', () => { closed = true; off(); clearInterval(poll); clearInterval(beat); });
    void pump();
  });
}
