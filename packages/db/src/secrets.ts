import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { ulid } from '@zerovity/core';
import type { Db } from './client';
import * as s from './schema';

/**
 * Envelope encryption: every secret gets its own random data key (AES-256-GCM); the data key is
 * wrapped by the master key. The master key comes from ZF_MASTER_KEY (base64, 32 bytes), a KMS-fed
 * env var, or - for local use only - a key file under the data dir.
 */
export class SecretBox {
  constructor(private master: Buffer) {
    if (master.length !== 32) throw new Error('master key must be 32 bytes');
  }
  seal(plain: string): string {
    const dek = crypto.randomBytes(32);
    const n1 = crypto.randomBytes(12);
    const c1 = crypto.createCipheriv('aes-256-gcm', dek, n1);
    const ct = Buffer.concat([c1.update(plain, 'utf8'), c1.final()]);
    const t1 = c1.getAuthTag();
    const n2 = crypto.randomBytes(12);
    const c2 = crypto.createCipheriv('aes-256-gcm', this.master, n2);
    const wrapped = Buffer.concat([c2.update(dek), c2.final()]);
    const t2 = c2.getAuthTag();
    return JSON.stringify({ v: 1, ct: ct.toString('base64'), n: n1.toString('base64'), t: t1.toString('base64'), wk: wrapped.toString('base64'), wn: n2.toString('base64'), wt: t2.toString('base64') });
  }
  open(sealed: string): string {
    const o = JSON.parse(sealed) as Record<string, string>;
    const d2 = crypto.createDecipheriv('aes-256-gcm', this.master, Buffer.from(o.wn, 'base64'));
    d2.setAuthTag(Buffer.from(o.wt, 'base64'));
    const dek = Buffer.concat([d2.update(Buffer.from(o.wk, 'base64')), d2.final()]);
    const d1 = crypto.createDecipheriv('aes-256-gcm', dek, Buffer.from(o.n, 'base64'));
    d1.setAuthTag(Buffer.from(o.t, 'base64'));
    return Buffer.concat([d1.update(Buffer.from(o.ct, 'base64')), d1.final()]).toString('utf8');
  }
}

export function loadMasterKey(opts: { env?: string; dataDir?: string } = {}): Buffer {
  const env = opts.env ?? process.env.ZF_MASTER_KEY;
  if (env) {
    const b = Buffer.from(env, 'base64');
    if (b.length !== 32) throw new Error('ZF_MASTER_KEY must be base64 of 32 bytes (openssl rand -base64 32)');
    return b;
  }
  const dir = opts.dataDir ?? '.data';
  const file = path.join(dir, 'master.key');
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  fs.mkdirSync(dir, { recursive: true });
  const k = crypto.randomBytes(32);
  fs.writeFileSync(file, k.toString('base64'), { mode: 0o600 });
  return k;
}

export type SecretScope = 'org' | 'factory' | 'connection';

export interface SecretMeta { id: string; scope: string; scopeId: string; name: string; last4: string; updatedAt: Date }

/** DB-backed provider. Values are never returned by list(); get() is for the worker and connection tests only. */
export class DbSecrets {
  constructor(private db: Db, private box: SecretBox) {}

  async set(scope: SecretScope, scopeId: string, name: string, value: string, by?: string): Promise<string> {
    const ciphertext = this.box.seal(value);
    const last4 = value.slice(-4);
    const [ex] = await this.db.select({ id: s.secrets.id }).from(s.secrets).where(and(eq(s.secrets.scope, scope), eq(s.secrets.scopeId, scopeId), eq(s.secrets.name, name)));
    if (ex) {
      await this.db.update(s.secrets).set({ ciphertext, last4, updatedAt: new Date() }).where(eq(s.secrets.id, ex.id));
      return ex.id;
    }
    const id = ulid();
    await this.db.insert(s.secrets).values({ id, scope, scopeId, name, ciphertext, last4, createdBy: by ?? null });
    return id;
  }

  async get(scope: SecretScope, scopeId: string, name: string): Promise<string | undefined> {
    const [r] = await this.db.select().from(s.secrets).where(and(eq(s.secrets.scope, scope), eq(s.secrets.scopeId, scopeId), eq(s.secrets.name, name)));
    return r ? this.box.open(r.ciphertext) : undefined;
  }

  async getById(id: string): Promise<string | undefined> {
    const [r] = await this.db.select().from(s.secrets).where(eq(s.secrets.id, id));
    return r ? this.box.open(r.ciphertext) : undefined;
  }

  async delete(scope: SecretScope, scopeId: string, name: string): Promise<void> {
    await this.db.delete(s.secrets).where(and(eq(s.secrets.scope, scope), eq(s.secrets.scopeId, scopeId), eq(s.secrets.name, name)));
  }

  async deleteById(id: string): Promise<void> {
    await this.db.delete(s.secrets).where(eq(s.secrets.id, id));
  }

  async list(scope: SecretScope, scopeId: string): Promise<SecretMeta[]> {
    const rows = await this.db.select().from(s.secrets).where(and(eq(s.secrets.scope, scope), eq(s.secrets.scopeId, scopeId)));
    return rows.map((r) => ({ id: r.id, scope: r.scope, scopeId: r.scopeId, name: r.name, last4: r.last4, updatedAt: r.updatedAt }));
  }
}

/**
 * Resolution order for `${secret:NAME}`: factory scope, then org scope, then an external provider
 * (Vault / AWS Secrets Manager), then ZF_SECRET_<NAME> in the service environment.
 */
export interface ExternalSecretsProvider { name: string; get(name: string): Promise<string | undefined> }

export class SecretResolver {
  constructor(private store: DbSecrets, private orgId: string, private factoryId: string, private external: ExternalSecretsProvider[] = []) {}
  async resolve(names: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const n of names) {
      const v = (await this.store.get('factory', this.factoryId, n)) ?? (await this.store.get('org', this.orgId, n)) ?? (await this.fromExternal(n)) ?? process.env[`ZF_SECRET_${n}`];
      if (v !== undefined) out[n] = v;
    }
    return out;
  }
  private async fromExternal(n: string) {
    for (const p of this.external) {
      const v = await p.get(n).catch(() => undefined);
      if (v !== undefined) return v;
    }
    return undefined;
  }
}

/** HashiCorp Vault KV v2 over HTTP. Config: VAULT_ADDR, VAULT_TOKEN, optional mount/path prefix. */
export function vaultProvider(o: { addr: string; token: string; mount?: string; prefix?: string; fetchImpl?: typeof fetch }): ExternalSecretsProvider {
  const f = o.fetchImpl ?? fetch;
  return {
    name: 'vault',
    async get(name) {
      const url = `${o.addr.replace(/\/$/, '')}/v1/${o.mount ?? 'secret'}/data/${o.prefix ?? 'zerovity'}/${encodeURIComponent(name)}`;
      const r = await f(url, { headers: { 'X-Vault-Token': o.token } });
      if (!r.ok) return undefined;
      const j = (await r.json()) as { data?: { data?: { value?: string } } };
      return j.data?.data?.value;
    },
  };
}

/** AWS Secrets Manager; the SDK is loaded lazily so it is only needed when this provider is configured. */
export function awsSecretsProvider(o: { region: string; prefix?: string }): ExternalSecretsProvider {
  return {
    name: 'aws-secrets-manager',
    async get(name) {
      const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager' as string).catch(() => {
        throw new Error('Install @aws-sdk/client-secrets-manager to use the AWS provider');
      });
      const c = new SecretsManagerClient({ region: o.region });
      const r = await c.send(new GetSecretValueCommand({ SecretId: `${o.prefix ?? 'zerovity/'}${name}` }));
      return r.SecretString as string | undefined;
    },
  };
}
