import { createServices, DbForgeResolver } from '@zerovity/orchestrator';
import { createLogger } from '@zerovity/core';
import { Worker } from './worker';

/** Standalone worker process (compose service `worker`): needs DATABASE_URL (a real Postgres) shared with the API. */
async function main() {
  const log = createLogger({ service: 'worker' });
  if (!process.env.DATABASE_URL) {
    log.error('DATABASE_URL is required for a standalone worker. Embedded mode runs the worker inside the API process.');
    process.exit(2);
  }
  const s = await createServices({ log });
  const forges = new DbForgeResolver(s);
  const w = new Worker(s, { concurrency: Number(process.env.ZF_WORKER_CONCURRENCY ?? 2), sandbox: (process.env.ZF_SANDBOX as 'local' | 'docker') ?? 'docker', forges, log, docker: { network: process.env.ZF_SANDBOX_NETWORK } });
  await w.start();
  log.info('worker started', { id: w.id });
  const stop = async () => { log.info('worker stopping'); await w.stop(30_000); await s.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
void main();
