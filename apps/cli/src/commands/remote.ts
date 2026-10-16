import type { Command } from 'commander';
import { readConfig, writeConfig, remote, green, red, dim, table, bold } from '../util';

interface Factory { id: string; name: string; alias: string | null }
interface Item { id: string; shortId: string; title: string; state: string; costUsd: number; prUrl: string | null }

/** Commands that talk to a running factory over the REST API with a personal access token. */
export function registerRemote(p: Command) {
  p.command('login')
    .description('Save the server URL and a personal access token (Settings > Access tokens)')
    .requiredOption('--server <url>')
    .requiredOption('--token <token>')
    .option('--factory <id>', 'default factory id')
    .action(async (o: { server: string; token: string; factory?: string }) => {
      writeConfig({ ...readConfig(), server: o.server, token: o.token, factory: o.factory });
      process.env.ZF_SERVER = o.server; process.env.ZF_TOKEN = o.token;
      const me = await remote<{ name: string; email: string; role: string }>('GET', '/me');
      console.log(green(`Signed in as ${me.name} <${me.email}> (${me.role})`));
    });

  p.command('factories').description('List factories').action(async () => {
    const f = await remote<Factory[]>('GET', '/factories');
    table(f.map((x) => [x.id, x.name, x.alias ?? '']), ['ID', 'NAME', 'ALIAS']);
  });

  p.command('send <title>')
    .description('Create a work item (intake from the command line)')
    .option('-f, --factory <id>')
    .option('-b, --body <text>', 'description', '')
    .option('--start <phase>', 'auto | INTENT | SPEC | BUILD', 'auto')
    .action(async (title: string, o: { factory?: string; body: string; start: string }) => {
      const factoryId = o.factory ?? readConfig().factory ?? (await remote<Factory[]>('GET', '/factories'))[0]?.id;
      if (!factoryId) throw new Error('no factory');
      const wi = await remote<Item>('POST', '/work-items', { factoryId, title, body: o.body, startPhase: o.start });
      console.log(`${green('created')} ${bold(wi.shortId)} ${wi.title}  ${dim(wi.id)}`);
    });

  p.command('tasks')
    .description('List work items')
    .option('-f, --factory <id>')
    .option('--state <states>', 'comma separated states')
    .action(async (o: { factory?: string; state?: string }) => {
      const factoryId = o.factory ?? readConfig().factory ?? (await remote<Factory[]>('GET', '/factories'))[0]?.id;
      const q = new URLSearchParams({ factoryId, ...(o.state ? { state: o.state } : {}) } as Record<string, string>);
      const items = await remote<Item[]>('GET', `/work-items?${q}`);
      table(items.map((i) => [i.shortId, i.state, `$${i.costUsd.toFixed(2)}`, i.title.slice(0, 70)]), ['ID', 'STATE', 'COST', 'TITLE']);
    });

  const a = p.command('audit').description('Audit log tools');
  a.command('verify [factory]')
    .description('Verify the hash chain of a factory (exit 1 when tampering is detected)')
    .action(async (factory?: string) => {
      const id = factory ?? readConfig().factory ?? (await remote<Factory[]>('GET', '/factories'))[0]?.id;
      const r = await remote<{ ok: boolean; checked: number; brokenAt?: number; reason?: string }>('GET', `/factories/${id}/audit/verify`);
      if (r.ok) console.log(green(`audit chain intact: ${r.checked} entries`));
      else { console.error(red(`audit chain BROKEN at entry ${r.brokenAt}: ${r.reason}`)); process.exitCode = 1; }
    });
  a.command('export [factory]')
    .description('Export the audit log')
    .option('--format <f>', 'jsonl | csv', 'jsonl')
    .action(async (factory: string | undefined, o: { format: string }) => {
      const id = factory ?? readConfig().factory ?? (await remote<Factory[]>('GET', '/factories'))[0]?.id;
      const cfg = readConfig();
      const r = await fetch(`${(process.env.ZF_SERVER ?? cfg.server)!.replace(/\/$/, '')}/api/v1/factories/${id}/audit/export?format=${o.format}`, { headers: { authorization: `Bearer ${process.env.ZF_TOKEN ?? cfg.token}` } });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      process.stdout.write(await r.text());
    });
}
