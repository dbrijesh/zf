import type { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { loadDir, hasErrors, jsonSchemaFor, DOC_SCHEMAS, type DocName } from '@zerovity/definition';
import { validateFactory } from '@zerovity/skills';
import { localRegistry, printIssues, green, red, dim, table } from '../util';

export function registerValidate(p: Command) {
  p.command('validate [path]')
    .description('Validate a factory definition: syntax, cross-references, secrets, policy expressions, skill lint (spec 6.6)')
    .option('--json', 'machine-readable output')
    .option('--weights', 'also print the token weight of each agent')
    .action(async (dir = '.', o: { json?: boolean; weights?: boolean }) => {
      const abs = path.resolve(dir);
      if (!fs.existsSync(abs)) throw new Error(`${abs} does not exist`);
      const files = loadDir(abs);
      const r = await validateFactory(files, localRegistry(abs));
      printIssues(r.issues, o.json);
      if (o.weights && !o.json) {
        console.log('');
        table(Object.entries(r.agentSkills).map(([n, e]) => [n, String(e.skills.length), String(e.weight.body), String(e.weight.skillDescriptions), String(e.weight.total), String(e.weight.onDemand)]), ['AGENT', 'SKILLS', 'BODY', 'DESCRIPTIONS', 'ALWAYS-LOADED', 'ON-DEMAND']);
      }
      const errors = r.issues.filter((i) => i.severity === 'error').length;
      if (!o.json) console.log(errors || hasErrors(r.issues) ? red(`\n${errors} error(s). The factory would keep its last valid definition.`) : green(`\nValid. ${Object.keys(r.agentSkills).length} agents, ${r.skillReports.length} skills linted.`) + dim(`  (${r.issues.length - errors} warning(s))`));
      process.exitCode = errors ? 1 : 0;
    });

  p.command('schema <doc>')
    .description(`Print the JSON Schema for a definition document: ${Object.keys(DOC_SCHEMAS).join(', ')}`)
    .action((doc: string) => {
      if (!(doc in DOC_SCHEMAS)) throw new Error(`unknown document "${doc}"`);
      console.log(JSON.stringify(jsonSchemaFor(doc as DocName), null, 2));
    });
}
