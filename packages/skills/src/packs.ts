import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as tar from 'tar';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { PackManifestSchema, type PackManifest, type LockFile } from '@zerovity/definition';
import { invalid, notFound } from '@zerovity/core';
import { sha } from './skill';
import { maxSatisfying, satisfies, parseVer, cmpVer } from './semver';
import type { SkillFiles } from './skill';

export interface Pack {
  manifest: PackManifest;
  skills: Record<string, SkillFiles>; // skill name -> files relative to the skill folder
  agents: Record<string, string>; // agent name -> agent.md content
  agentSkills?: never;
  hash: string;
}

export function packHash(p: Omit<Pack, 'hash'>): string {
  const parts: string[] = [JSON.stringify(p.manifest)];
  for (const n of Object.keys(p.skills).sort()) for (const f of Object.keys(p.skills[n]).sort()) parts.push(`skills/${n}/${f}\0${p.skills[n][f]}`);
  for (const n of Object.keys(p.agents).sort()) parts.push(`agents/${n}\0${p.agents[n]}`);
  return 'sha256:' + sha(parts.join('\0\0'));
}

/** Read a pack folder: pack.yaml, skills/<name>/..., agents/<name>/agent.md */
export function loadPackDir(dir: string): Pack {
  const mf = path.join(dir, 'pack.yaml');
  if (!fs.existsSync(mf)) throw invalid(`${dir} has no pack.yaml`);
  const manifest = PackManifestSchema.parse(parseYaml(fs.readFileSync(mf, 'utf8')));
  const skills: Pack['skills'] = {};
  const sdir = path.join(dir, 'skills');
  if (fs.existsSync(sdir)) {
    for (const s of fs.readdirSync(sdir, { withFileTypes: true }).filter((e) => e.isDirectory())) skills[s.name] = readTree(path.join(sdir, s.name));
  }
  const agents: Pack['agents'] = {};
  const adir = path.join(dir, 'agents');
  if (fs.existsSync(adir)) {
    for (const a of fs.readdirSync(adir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const f = path.join(adir, a.name, 'agent.md');
      if (fs.existsSync(f)) agents[a.name] = fs.readFileSync(f, 'utf8').replace(/^﻿/, '');
    }
  }
  const base = { manifest, skills, agents };
  return { ...base, hash: packHash(base) };
}

function readTree(dir: string, rel = ''): SkillFiles {
  const out: SkillFiles = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, readTree(path.join(dir, e.name), r));
    else out[r] = fs.readFileSync(path.join(dir, e.name), 'utf8').replace(/^﻿/, '');
  }
  return out;
}

export function writePackDir(pack: Pack, dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.yaml'), stringifyYaml(pack.manifest));
  for (const [n, files] of Object.entries(pack.skills)) for (const [f, c] of Object.entries(files)) writeSafe(path.join(dir, 'skills', n), f, c);
  for (const [n, c] of Object.entries(pack.agents)) writeSafe(path.join(dir, 'agents', n), 'agent.md', c);
}
function writeSafe(base: string, rel: string, content: string) {
  const target = path.resolve(base, rel);
  if (!target.startsWith(path.resolve(base))) throw invalid(`unsafe path in pack: ${rel}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

/** Pack to a gzip tarball buffer (used by the registry and `zf pack`). */
export async function packToTarball(pack: Pack): Promise<Buffer> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-pack-'));
  try {
    writePackDir(pack, path.join(tmp, 'pack'));
    const out = path.join(tmp, 'pack.tgz');
    await tar.create({ gzip: true, file: out, cwd: path.join(tmp, 'pack'), portable: true }, ['.']);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function packFromTarball(buf: Buffer): Promise<Pack> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-pack-'));
  try {
    const file = path.join(tmp, 'in.tgz');
    fs.writeFileSync(file, buf);
    const dir = path.join(tmp, 'x');
    fs.mkdirSync(dir);
    await tar.extract({ file, cwd: dir, strict: true, filter: (p) => !p.split(/[\\/]/).includes('..') && !path.isAbsolute(p) });
    // allow a single top-level folder
    const entries = fs.readdirSync(dir);
    const root = entries.length === 1 && fs.statSync(path.join(dir, entries[0])).isDirectory() && !fs.existsSync(path.join(dir, 'pack.yaml')) ? path.join(dir, entries[0]) : dir;
    return loadPackDir(root);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ---------------- registry ---------------- */

export interface PackRegistry {
  list(): Promise<Array<{ name: string; versions: string[]; description: string }>>;
  get(name: string, version: string): Promise<Pack | undefined>;
  resolve(name: string, range: string): Promise<Pack | undefined>;
}

export class MemoryPackRegistry implements PackRegistry {
  private packs: Pack[] = [];
  add(p: Pack): this {
    this.packs = this.packs.filter((x) => !(x.manifest.name === p.manifest.name && x.manifest.version === p.manifest.version));
    this.packs.push(p);
    return this;
  }
  async list() {
    const names = [...new Set(this.packs.map((p) => p.manifest.name))].sort();
    return names.map((name) => {
      const ps = this.packs.filter((p) => p.manifest.name === name).sort((a, b) => cmpVer(parseVer(b.manifest.version)!, parseVer(a.manifest.version)!));
      return { name, versions: ps.map((p) => p.manifest.version), description: ps[0].manifest.description };
    });
  }
  async get(name: string, version: string) {
    return this.packs.find((p) => p.manifest.name === name && p.manifest.version === version);
  }
  async resolve(name: string, range: string) {
    const v = maxSatisfying(this.packs.filter((p) => p.manifest.name === name).map((p) => p.manifest.version), range);
    return v ? this.get(name, v) : undefined;
  }
}

/** Registry reading pack folders from one or more directories (each child folder with pack.yaml). */
export function dirPackRegistry(...dirs: string[]): MemoryPackRegistry {
  const reg = new MemoryPackRegistry();
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    if (fs.existsSync(path.join(d, 'pack.yaml'))) reg.add(loadPackDir(d));
    else for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && fs.existsSync(path.join(d, e.name, 'pack.yaml'))) reg.add(loadPackDir(path.join(d, e.name)));
  }
  return reg;
}

/* ---------------- lockfile ---------------- */

export async function resolveLock(packs: Array<{ name: string; version: string }>, reg: PackRegistry): Promise<{ lock: LockFile; resolved: Pack[] }> {
  const resolved: Pack[] = [];
  for (const want of packs) {
    const p = await reg.resolve(want.name, want.version);
    if (!p) throw notFound('Pack', `${want.name}@${want.version}`);
    resolved.push(p);
  }
  return { lock: { lockVersion: 1, packs: resolved.map((p) => ({ name: p.manifest.name, version: p.manifest.version, hash: p.hash })) }, resolved };
}

/** Load the exact packs pinned in a lockfile and check their content hashes. */
export async function loadLocked(lock: LockFile, reg: PackRegistry): Promise<{ packs: Pack[]; problems: string[] }> {
  const packs: Pack[] = [];
  const problems: string[] = [];
  for (const l of lock.packs) {
    const p = await reg.get(l.name, l.version);
    if (!p) { problems.push(`${l.name}@${l.version} is pinned but not available in the registry`); continue; }
    if (p.hash !== l.hash) problems.push(`${l.name}@${l.version} content hash differs from zerovity.lock (pack was modified)`);
    packs.push(p);
  }
  return { packs, problems };
}

export const lockToYaml = (lock: LockFile): string => '# generated by zf; do not edit by hand\n' + stringifyYaml(lock);

export interface PackDiff { added: string[]; removed: string[]; changed: string[]; agentsAdded: string[]; agentsRemoved: string[]; agentsChanged: string[] }
/** Diff two versions of a pack so an upgrade can be reviewed (spec 7.4). */
export function diffPacks(a: Pack, b: Pack): PackDiff {
  const ks = (o: Record<string, unknown>) => new Set(Object.keys(o));
  const sa = ks(a.skills), sb = ks(b.skills), aa = ks(a.agents), ab = ks(b.agents);
  const sameSkill = (n: string) => JSON.stringify(a.skills[n]) === JSON.stringify(b.skills[n]);
  return {
    added: [...sb].filter((n) => !sa.has(n)),
    removed: [...sa].filter((n) => !sb.has(n)),
    changed: [...sb].filter((n) => sa.has(n) && !sameSkill(n)),
    agentsAdded: [...ab].filter((n) => !aa.has(n)),
    agentsRemoved: [...aa].filter((n) => !ab.has(n)),
    agentsChanged: [...ab].filter((n) => aa.has(n) && a.agents[n] !== b.agents[n]),
  };
}

export { satisfies };
