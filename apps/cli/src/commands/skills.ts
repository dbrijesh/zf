import type { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { lintSkill, loadPackDir, type SkillFiles } from '@zerovity/skills';
import { red, yellow, green, dim, table } from '../util';

function readSkill(dir: string, rel = ''): SkillFiles {
  const out: SkillFiles = {};
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, readSkill(dir, r));
    else out[r] = fs.readFileSync(path.join(dir, r), 'utf8').replace(/^﻿/, '');
  }
  return out;
}

export function registerSkills(p: Command) {
  const s = p.command('skills').description('Skill tooling');
  s.command('lint [path]')
    .description('Lint a skill folder, a folder of skills, or a pack against the lightness rules (spec 7.2) and report token cost')
    .option('--strict', 'treat warnings as errors')
    .action((target = '.', o: { strict?: boolean }) => {
      const abs = path.resolve(target);
      const skills: Array<{ label: string; files: SkillFiles }> = [];
      if (fs.existsSync(path.join(abs, 'SKILL.md'))) skills.push({ label: `skills/${path.basename(abs)}`, files: readSkill(abs) });
      else if (fs.existsSync(path.join(abs, 'pack.yaml'))) for (const [n, f] of Object.entries(loadPackDir(abs).skills)) skills.push({ label: `skills/${n}`, files: f });
      else {
        const base = fs.existsSync(path.join(abs, 'skills')) ? path.join(abs, 'skills') : abs;
        for (const e of fs.readdirSync(base, { withFileTypes: true })) if (e.isDirectory() && fs.existsSync(path.join(base, e.name, 'SKILL.md'))) skills.push({ label: `skills/${e.name}`, files: readSkill(path.join(base, e.name)) });
      }
      if (!skills.length) throw new Error(`no skills found under ${abs}`);
      let errors = 0, warnings = 0;
      const rows: string[][] = [];
      for (const sk of skills) {
        const r = lintSkill(sk.files, sk.label);
        for (const i of r.issues) {
          if (i.severity === 'error') errors++; else if (i.severity === 'warning') warnings++;
          console.log((i.severity === 'error' ? red : yellow)(`${i.severity.toUpperCase().padEnd(7)} ${i.file}${i.line ? ':' + i.line : ''}  ${i.message} [${i.code}]`));
        }
        rows.push([r.name, String(r.bodyLines), String(r.tokens.body), String(r.tokens.description), r.issues.some((i) => i.severity === 'error') ? red('errors') : r.issues.length ? yellow('warnings') : green('ok')]);
      }
      console.log('');
      table(rows, ['SKILL', 'LINES', 'BODY TOKENS', 'ALWAYS-LOADED', 'LINT']);
      console.log(dim(`\n${skills.length} skills, ${errors} errors, ${warnings} warnings`));
      process.exitCode = errors || (o.strict && warnings) ? 1 : 0;
    });
}
