import type { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { loadPackDir, packToTarball, resolveLock, lockToYaml, type Pack } from '@zerovity/skills';
import { localRegistry, green, red, dim, table } from '../util';

export function registerPack(p: Command) {
  const g = p.command('pack').description('Skill packs: list, install into a definition, lock, bundle');
  g.command('list').description('Packs available on this machine').action(async () => {
    const list = await localRegistry().list();
    table(list.map((x) => [x.name, x.versions.join(', '), x.description.slice(0, 80)]), ['PACK', 'VERSIONS', 'DESCRIPTION']);
  });

  g.command('install [name]')
    .description('Install a pack into the definition in --dir (animated picker when no name is given)')
    .option('-d, --dir <path>', 'definition folder', '.')
    .option('--skills <list>', 'comma separated skills to include (default: all)')
    .option('--version <range>', 'version range', '^1.0.0')
    .action(async (name: string | undefined, o: { dir: string; skills?: string; version: string }) => {
      const dir = path.resolve(o.dir);
      const file = path.join(dir, 'zerovity.factory.yaml');
      if (!fs.existsSync(file)) throw new Error(`${file} not found. Run this inside a factory definition folder (or pass --dir).`);
      const reg = localRegistry(dir);
      let pack: Pack | undefined;
      let include: string[] | undefined = o.skills?.split(',').map((s) => s.trim()).filter(Boolean);
      if (!name) {
        if (!process.stdin.isTTY) throw new Error('A pack name is required when not running in a terminal.');
        const all: Pack[] = [];
        for (const e of await reg.list()) for (const v of e.versions) { const pk = await reg.get(e.name, v); if (pk) all.push(pk); }
        if (!all.length) throw new Error('No packs found. Set ZF_PACK_DIRS or add a packs/ folder.');
        const { runInstaller } = await import('../installer');
        const choice = await runInstaller(all);
        if (!choice) return console.log(dim('Cancelled.'));
        pack = choice.pack;
        include = choice.skills.length === Object.keys(choice.pack.skills).length ? undefined : choice.skills;
      } else {
        pack = await reg.resolve(name, o.version);
        if (!pack) throw new Error(`pack ${name}@${o.version} not found`);
      }
      if (include) for (const s of include) if (!(s in pack.skills)) throw new Error(`pack ${pack.manifest.name} has no skill "${s}"`);
      const doc = (parseYaml(fs.readFileSync(file, 'utf8')) ?? {}) as { packs?: Array<{ name: string; version: string; include?: string[] }> };
      doc.packs = (doc.packs ?? []).filter((x) => x.name !== pack!.manifest.name);
      doc.packs.push({ name: pack.manifest.name, version: `^${pack.manifest.version}`, ...(include ? { include } : {}) });
      fs.writeFileSync(file, stringifyYaml(doc));
      const { lock } = await resolveLock(doc.packs, reg);
      fs.writeFileSync(path.join(dir, 'zerovity.lock'), lockToYaml(lock));
      console.log(green(`Installed ${pack.manifest.name}@${pack.manifest.version}`) + (include ? ` (${include.length} of ${Object.keys(pack.skills).length} skills)` : ` (${Object.keys(pack.skills).length} skills)`));
      console.log(dim('Updated zerovity.factory.yaml and zerovity.lock. Run: zf validate'));
    });

  g.command('lock')
    .description('Resolve the packs named in zerovity.factory.yaml and write zerovity.lock')
    .option('-d, --dir <path>', 'definition folder', '.')
    .action(async (o: { dir: string }) => {
      const dir = path.resolve(o.dir);
      const doc = parseYaml(fs.readFileSync(path.join(dir, 'zerovity.factory.yaml'), 'utf8')) as { packs?: Array<{ name: string; version: string }> };
      const { lock } = await resolveLock(doc.packs ?? [], localRegistry(dir));
      fs.writeFileSync(path.join(dir, 'zerovity.lock'), lockToYaml(lock));
      for (const l of lock.packs) console.log(`${l.name}@${l.version} ${dim(l.hash.slice(0, 24))}`);
    });

  g.command('bundle <dir>')
    .description('Create a .tgz from a pack folder (pack.yaml, skills/, agents/)')
    .option('-o, --out <file>', 'output file')
    .action(async (dir: string, o: { out?: string }) => {
      const pack = loadPackDir(path.resolve(dir));
      const out = path.resolve(o.out ?? `${pack.manifest.name}-${pack.manifest.version}.tgz`);
      fs.writeFileSync(out, await packToTarball(pack));
      console.log(`${green('wrote')} ${out} ${dim(pack.hash.slice(0, 24))}`);
    });
  void red;
}
