import { and, desc, eq } from 'drizzle-orm';
import { stringify as yamlStringify } from 'yaml';
import { ulid, notFound, invalid, type HarnessType } from '@zerovity/core';
import { tables as t, type Db, type ArtifactStore, appendAudit } from '@zerovity/db';
import { filesHash, parseFrontmatter, checkSchema, AgentFrontmatterSchema, type AgentFrontmatter, type Files, type Definition, type Issue, hasErrors } from '@zerovity/definition';
import { validateFactory, resolveLock, lockToYaml, effectiveSkills, loadPackDir, packHash, type Pack, type PackRegistry, type SkillSources, type SkillFiles, type FullValidation, type EffectiveSkills, MemoryPackRegistry } from '@zerovity/skills';
import { policyFromGates, type Policy } from './policy';

/** Packs live in the database + artifact store so they survive restarts and can be imported from tarballs or Git. */
export class DbPackRegistry implements PackRegistry {
  private cache = new Map<string, Pack>();
  constructor(private db: Db, private artifacts: ArtifactStore) {}

  async install(p: Pack, source = 'import'): Promise<void> {
    const key = `packs/${p.manifest.name}/${p.manifest.version}.json`;
    await this.artifacts.put(key, JSON.stringify({ manifest: p.manifest, skills: p.skills, agents: p.agents }), 'application/json');
    const [ex] = await this.db.select().from(t.packs).where(and(eq(t.packs.name, p.manifest.name), eq(t.packs.version, p.manifest.version)));
    const row = { description: p.manifest.description, manifest: p.manifest as unknown as Record<string, unknown>, hash: p.hash, artifactKey: key, skillCount: Object.keys(p.skills).length, agentCount: Object.keys(p.agents).length, source, updatedAt: new Date() };
    if (ex) await this.db.update(t.packs).set(row).where(eq(t.packs.id, ex.id));
    else await this.db.insert(t.packs).values({ id: ulid(), name: p.manifest.name, version: p.manifest.version, ...row });
    this.cache.set(`${p.manifest.name}@${p.manifest.version}`, p);
  }
  async list() {
    const rows = await this.db.select().from(t.packs).orderBy(t.packs.name);
    const by = new Map<string, { name: string; versions: string[]; description: string }>();
    for (const r of rows) {
      const e = by.get(r.name) ?? { name: r.name, versions: [], description: r.description };
      e.versions.push(r.version);
      by.set(r.name, e);
    }
    return [...by.values()];
  }
  async get(name: string, version: string): Promise<Pack | undefined> {
    const ck = `${name}@${version}`;
    const hit = this.cache.get(ck);
    if (hit) return hit;
    const [r] = await this.db.select().from(t.packs).where(and(eq(t.packs.name, name), eq(t.packs.version, version)));
    if (!r) return undefined;
    const buf = await this.artifacts.get(r.artifactKey);
    if (!buf) return undefined;
    const raw = JSON.parse(buf.toString('utf8')) as Omit<Pack, 'hash'>;
    const p: Pack = { ...raw, hash: packHash(raw) };
    this.cache.set(ck, p);
    return p;
  }
  async resolve(name: string, range: string): Promise<Pack | undefined> {
    const rows = await this.db.select({ v: t.packs.version }).from(t.packs).where(eq(t.packs.name, name));
    const mem = new MemoryPackRegistry();
    for (const r of rows) { const p = await this.get(name, r.v); if (p) mem.add(p); }
    return mem.resolve(name, range);
  }
}

/** Install the packs shipped in the repository (packs/*) if missing or changed. */
export async function installBuiltinPacks(reg: DbPackRegistry, dirs: string[]): Promise<string[]> {
  const done: string[] = [];
  const fs = await import('node:fs');
  const path = await import('node:path');
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    const candidates = fs.existsSync(path.join(d, 'pack.yaml')) ? [d] : fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(d, e.name, 'pack.yaml'))).map((e) => path.join(d, e.name));
    for (const c of candidates) {
      const p = loadPackDir(c);
      const ex = await reg.get(p.manifest.name, p.manifest.version);
      if (!ex || ex.hash !== p.hash) { await reg.install(p, 'builtin'); done.push(`${p.manifest.name}@${p.manifest.version}`); }
    }
  }
  return done;
}

export interface AgentDef {
  name: string;
  source: string; // 'factory' | 'pack:<name>'
  fm: AgentFrontmatter;
  body: string;
}

export interface ActiveDefinition {
  versionId: string;
  commit: string;
  files: Files;
  definition: Definition;
  validation: FullValidation;
  policy: Policy;
  agents: Map<string, AgentDef>;
  sources: SkillSources;
}

export interface ApplyResult { ok: boolean; versionId: string; commit: string; issues: Issue[]; applied: boolean }

export class DefinitionService {
  private cache = new Map<string, ActiveDefinition>();
  constructor(private db: Db, readonly packs: DbPackRegistry, private opts: { onApplied?: (factoryId: string, a: ActiveDefinition) => Promise<void>; forceHarness?: HarnessType } = {}) {}

  /** Validate and store a candidate definition. An invalid one is recorded but never applied (spec 6.6). */
  async apply(factoryId: string, files: Files, o: { message?: string; by: string }): Promise<ApplyResult> {
    const [f] = await this.db.select().from(t.factories).where(eq(t.factories.id, factoryId));
    if (!f) throw notFound('Factory', factoryId);
    const work = { ...files };
    // keep the lock in step with the declared packs so applying is a single click
    const first = await validateFactory(work, this.packs);
    if (first.definition?.factory.packs.length) {
      const wanted = first.definition.factory.packs;
      const lock = first.definition.lock;
      const stale = !lock || wanted.some((w) => !lock.packs.some((l) => l.name === w.name));
      if (stale) {
        try {
          const { lock: nl } = await resolveLock(wanted, this.packs);
          work['zerovity.lock'] = lockToYaml(nl);
        } catch { /* reported by validation */ }
      }
    }
    const v = await validateFactory(work, this.packs);
    const [last] = await this.db.select({ seq: t.definitionVersions.seq }).from(t.definitionVersions).where(eq(t.definitionVersions.factoryId, factoryId)).orderBy(desc(t.definitionVersions.seq)).limit(1);
    const seq = (last?.seq ?? 0) + 1;
    const hash = filesHash(work);
    const id = ulid();
    const commit = `${seq}-${hash.slice(0, 8)}`;
    const valid = v.ok;
    await this.db.insert(t.definitionVersions).values({ id, factoryId, commit, seq, files: work, filesHash: hash, message: o.message ?? '', valid, issues: v.issues as unknown[], appliedAt: valid ? new Date() : null, appliedBy: valid ? o.by : null });
    await appendAudit(this.db, { chain: factoryId, factoryId, actor: o.by, action: valid ? 'definition.applied' : 'definition.rejected', subject: commit, payload: { filesHash: hash, message: o.message ?? '', errors: v.issues.filter((i) => i.severity === 'error').length } });
    if (!valid) return { ok: false, versionId: id, commit, issues: v.issues, applied: false };
    await this.db.update(t.factories).set({ definitionCommit: commit, updatedAt: new Date() }).where(eq(t.factories.id, factoryId));
    await this.syncRepositories(factoryId, v.definition!);
    this.cache.delete(factoryId);
    const active = await this.getActive(factoryId);
    if (active && this.opts.onApplied) await this.opts.onApplied(factoryId, active);
    return { ok: true, versionId: id, commit, issues: v.issues, applied: true };
  }

  private async syncRepositories(factoryId: string, d: Definition) {
    const existing = await this.db.select().from(t.repositories).where(eq(t.repositories.factoryId, factoryId));
    for (const r of d.factory.repositories) {
      const ex = existing.find((e) => e.owner === r.owner && e.name === r.name && e.forge === r.forge);
      if (ex) await this.db.update(t.repositories).set({ defaultBranch: r.defaultBranch, cloneUrl: r.url ?? ex.cloneUrl, updatedAt: new Date() }).where(eq(t.repositories.id, ex.id));
      else await this.db.insert(t.repositories).values({ id: ulid(), factoryId, forge: r.forge, owner: r.owner, name: r.name, defaultBranch: r.defaultBranch, cloneUrl: r.url ?? null });
    }
  }

  async getActive(factoryId: string): Promise<ActiveDefinition | undefined> {
    const hit = this.cache.get(factoryId);
    const [f] = await this.db.select().from(t.factories).where(eq(t.factories.id, factoryId));
    if (!f?.definitionCommit) return undefined;
    if (hit && hit.commit === f.definitionCommit) return hit;
    const [ver] = await this.db.select().from(t.definitionVersions).where(and(eq(t.definitionVersions.factoryId, factoryId), eq(t.definitionVersions.commit, f.definitionCommit)));
    if (!ver) return undefined;
    const active = await this.build(ver.id, ver.commit, ver.files);
    if (active) this.cache.set(factoryId, active);
    return active;
  }

  async getVersion(factoryId: string, commit?: string) {
    const rows = await this.db.select().from(t.definitionVersions).where(commit ? and(eq(t.definitionVersions.factoryId, factoryId), eq(t.definitionVersions.commit, commit)) : eq(t.definitionVersions.factoryId, factoryId)).orderBy(desc(t.definitionVersions.seq)).limit(1);
    return rows[0];
  }

  async history(factoryId: string) {
    return this.db.select({ id: t.definitionVersions.id, commit: t.definitionVersions.commit, seq: t.definitionVersions.seq, message: t.definitionVersions.message, valid: t.definitionVersions.valid, appliedAt: t.definitionVersions.appliedAt, appliedBy: t.definitionVersions.appliedBy, createdAt: t.definitionVersions.createdAt, issues: t.definitionVersions.issues }).from(t.definitionVersions).where(eq(t.definitionVersions.factoryId, factoryId)).orderBy(desc(t.definitionVersions.seq)).limit(100);
  }

  private async build(versionId: string, commit: string, files: Files): Promise<ActiveDefinition | undefined> {
    const validation = await validateFactory(files, this.packs);
    if (!validation.definition) return undefined;
    const def = validation.definition;
    const agents = new Map<string, AgentDef>();
    for (const p of validation.packs) {
      for (const [name, content] of Object.entries(p.agents)) {
        const fm = parseFrontmatter(content, `${p.manifest.name}/agents/${name}`);
        const c = fm.yaml ? checkSchema(AgentFrontmatterSchema, fm.yaml, name) : { value: undefined };
        if (c.value) agents.set(name, { name, source: `pack:${p.manifest.name}`, fm: c.value, body: fm.body });
      }
    }
    for (const a of Object.values(def.agents)) agents.set(a.name, { name: a.name, source: 'factory', fm: a.fm, body: a.body });
    for (const [name, ov] of Object.entries(def.factory.agentOverrides)) {
      const a = agents.get(name);
      if (a) agents.set(name, { ...a, fm: { ...a.fm, ...stripUndefined(ov), harness: ov.harness ? { ...a.fm.harness, ...ov.harness } as AgentFrontmatter['harness'] : a.fm.harness } });
    }
    const factorySkills: Record<string, SkillFiles> = {};
    const agentSkills: Record<string, Record<string, SkillFiles>> = {};
    for (const [p, c] of Object.entries(files)) {
      let m = /^skills\/([^/]+)\/(.+)$/.exec(p);
      if (m) (factorySkills[m[1]] ??= {})[m[2]] = c;
      m = /^agents\/([^/]+)\/skills\/([^/]+)\/(.+)$/.exec(p);
      if (m) ((agentSkills[m[1]] ??= {})[m[2]] ??= {})[m[3]] = c;
    }
    return { versionId, commit, files, definition: def, validation, policy: policyFromGates(def.gates), agents, sources: { packs: validation.packs, factory: factorySkills, agent: agentSkills } };
  }

  /** Which agent works a phase: factory agents win over pack agents; ties break by name. */
  agentForPhase(a: ActiveDefinition, phase: string): AgentDef | undefined {
    const c = [...a.agents.values()].filter((x) => x.fm.phase === phase);
    c.sort((x, y) => (x.source === 'factory' ? 0 : 1) - (y.source === 'factory' ? 0 : 1) || x.name.localeCompare(y.name));
    return c[0];
  }

  effectiveHarness(a: ActiveDefinition, agent: AgentDef, force?: HarnessType | null): { type: HarnessType; model?: string; reasoning?: 'low' | 'medium' | 'high' } {
    const h = { ...(a.definition.factory.agentDefaults.harness ?? { type: 'claude-code' as const }), ...(agent.fm.harness ?? {}) };
    const f = force === null ? undefined : (force ?? this.opts.forceHarness);
    return f ? { type: f, model: undefined, reasoning: h.reasoning } : (h as { type: HarnessType; model?: string; reasoning?: 'low' | 'medium' | 'high' });
  }

  skillsFor(a: ActiveDefinition, agent: AgentDef): EffectiveSkills {
    return effectiveSkills(agent.name, agent.body, agent.fm.skills, a.sources);
  }

  /** Update one agent's harness etc. by writing agentOverrides in the factory file (so the UI never forks pack agents). */
  async setAgentOverride(factoryId: string, agent: string, patch: Partial<AgentFrontmatter>, by: string): Promise<ApplyResult> {
    const v = await this.getVersion(factoryId);
    if (!v) throw notFound('Definition', factoryId);
    const { parse } = await import('yaml');
    const files = { ...v.files };
    const doc = (parse(files['zerovity.factory.yaml']) ?? {}) as Record<string, unknown>;
    const ov = ((doc.agentOverrides ??= {}) as Record<string, Record<string, unknown>>);
    const cur = ov[agent] ?? {};
    ov[agent] = { ...cur, ...stripUndefined(patch as Record<string, unknown>), ...(patch.harness ? { harness: { ...((cur.harness as object) ?? {}), ...patch.harness } } : {}) };
    if (!ov[agent] || !Object.keys(ov[agent]).length) delete ov[agent];
    files['zerovity.factory.yaml'] = yamlStringify(doc);
    return this.apply(factoryId, files, { message: `Update agent ${agent}`, by });
  }

  assertValid(r: ApplyResult): void {
    if (!r.ok) throw invalid('Definition is not valid', { issues: r.issues.filter((i) => i.severity === 'error') });
  }
}

const stripUndefined = <T extends Record<string, unknown>>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
export { hasErrors };
