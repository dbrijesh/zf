import { createServices } from '@zerovity/orchestrator';
import { seedDemo, seedBulkItems } from './seed';

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}`))?.split('=')[1];

/** `npm run seed` (stop the server first when using the embedded database: it is single-process). */
const s = await createServices({});
const r = await seedDemo(s, { withLive: process.argv.includes('--live') });
if (arg('bulk')) await seedBulkItems(s, r.factoryId, Number(arg('bulk')));
console.log(r.created ? 'Seeded demo data.' : 'Demo data already present.', { factoryId: r.factoryId });
await s.close();
