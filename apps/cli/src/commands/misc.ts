import type { Command } from 'commander';
import { detectAll } from '@zerovity/harness';
import { green, red, table, readConfig, CONFIG_PATH, dim } from '../util';

export function registerMisc(p: Command) {
  p.command('doctor').description('Check which harness CLIs are installed and whether you are signed in').action(async () => {
    const d = await detectAll();
    table(Object.entries(d).filter(([k]) => k !== 'fake').map(([k, v]) => [k, v.installed ? green('installed') : red('missing'), v.version ?? '']), ['HARNESS', 'STATUS', 'VERSION']);
    const cfg = readConfig();
    console.log(`\nnode ${process.version}`);
    console.log(cfg.server ? `server ${cfg.server} ${dim(`(from ${CONFIG_PATH})`)}` : dim('not signed in to a server (zf login)'));
  });
}
