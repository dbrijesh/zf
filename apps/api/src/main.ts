import path from 'node:path';
import { createServices, findRepoRoot } from '@zerovity/orchestrator';
import { createLogger, errMessage } from '@zerovity/core';
import { Worker } from '@zerovity/worker';
import { buildApp, makeConfig } from './app';
import { seedDemo, seedBulkItems } from './seed';

/**
 * One process: API + (embedded) worker + schedulers. With PGlite (no DATABASE_URL) the database is single-process, so the
 * worker must live here. With a real Postgres set ZF_EMBED_WORKER=0 and run apps/worker separately.
 */
async function main() {
  const log = createLogger({ service: 'api' });
  const dataDir = path.resolve(process.env.ZF_DATA_DIR ?? '.data');
  const s = await createServices({ dataDir, log });
  const cfg = makeConfig({ webDist: process.env.ZF_WEB_DIST, cors: process.env.ZF_CORS?.split(',').filter(Boolean) });
  const { app, ctx } = await buildApp({ services: s, cfg, logger: true });

  if (process.env.ZF_SEED === 'demo') {
    const r = await seedDemo(s, { withLive: process.env.ZF_SEED_LIVE !== '0' });
    log.info(r.created ? 'seeded the demo factory' : 'demo factory already exists');
    if (process.env.ZF_SEED_BULK && r.created) await seedBulkItems(s, r.factoryId, Number(process.env.ZF_SEED_BULK));
  }

  const embed = process.env.ZF_EMBED_WORKER ? process.env.ZF_EMBED_WORKER !== '0' : s.handle.kind === 'pglite';
  let worker: Worker | undefined;
  if (embed) {
    worker = new Worker(s, { concurrency: Number(process.env.ZF_WORKER_CONCURRENCY ?? 2), sandbox: (process.env.ZF_SANDBOX as 'local' | 'docker') ?? 'local', forges: ctx.forges, log, docker: { network: process.env.ZF_SANDBOX_NETWORK }, localSetup: process.env.ZF_LOCAL_SETUP === '1' });
    await worker.start();
    log.info('embedded worker started', { id: worker.id, sandbox: process.env.ZF_SANDBOX ?? 'local' });
  }

  const timers = [
    setInterval(() => void ctx.intake.tickSchedules().catch((e) => log.warn('schedule tick failed', { error: errMessage(e) })), 60_000),
    setInterval(() => void ctx.conns.checkAll().catch((e) => log.warn('connection check failed', { error: errMessage(e) })), 15 * 60_000),
  ];
  if (!embed) timers.push(setInterval(() => void s.orch.tick().catch(() => undefined), 60_000));

  const port = Number(process.env.PORT ?? 8787);
  await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
  log.info('Zerovity Factory is up', { url: cfg.publicUrl, db: s.handle.kind, devLogin: cfg.devLogin, oidc: !!cfg.oidc, repoRoot: findRepoRoot() });

  const stop = async () => {
    log.info('shutting down');
    timers.forEach(clearInterval);
    await app.close();
    await worker?.stop(20_000);
    await s.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => { console.error(e); process.exit(1); });
