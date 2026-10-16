// `npm run dev`: API with the embedded worker and database (hot reload) plus the Vite dev server for the web app.
import { spawn } from 'node:child_process';
const env = { ...process.env, ZF_DEV_LOGIN: process.env.ZF_DEV_LOGIN ?? '1', ZF_SEED: process.env.ZF_SEED ?? 'demo', ZF_FORCE_HARNESS: process.env.ZF_FORCE_HARNESS ?? 'fake' };
const run = (name, args, cwd) => {
  const p = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, { stdio: 'inherit', env, cwd, shell: process.platform === 'win32' });
  p.on('exit', (c) => { console.log(`[${name}] exited with ${c}`); process.exit(c ?? 0); });
  return p;
};
console.log('API  http://localhost:8787   Web (dev)  http://localhost:5173   (sign in with any email; demo users are seeded)');
run('api', ['tsx', 'watch', 'apps/api/src/main.ts']);
run('web', ['vite'], 'apps/web');