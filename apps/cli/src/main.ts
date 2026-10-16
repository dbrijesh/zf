#!/usr/bin/env node
import { Command } from 'commander';
import { registerValidate } from './commands/validate';
import { registerSkills } from './commands/skills';
import { registerPack } from './commands/pack';
import { registerRun } from './commands/run';
import { registerRemote } from './commands/remote';
import { registerMisc } from './commands/misc';

const program = new Command('zf')
  .description('Zerovity Factory command line: validate definitions, lint skills, install packs, run an agent locally, send tasks and verify audit chains.')
  .version('0.1.0')
  .showHelpAfterError();

registerValidate(program);
registerSkills(program);
registerPack(program);
registerRun(program);
registerRemote(program);
registerMisc(program);

program.parseAsync(process.argv).catch((e: Error) => {
  console.error(`zf: ${e.message}`);
  process.exit(1);
});
