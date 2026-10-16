import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRepoRootSync } from './root';
import { dirPackRegistry, type MemoryPackRegistry } from '@zerovity/skills';
import { formatIssue, type Issue } from '@zerovity/definition';

export const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const red = c(31), green = c(32), yellow = c(33), cyan = c(36), dim = c(2), bold = c(1);

export const CONFIG_PATH = path.join(os.homedir(), '.zerovity', 'config.json');
export interface Config { server?: string; token?: string; factory?: string; packDirs?: string[] }
export const readConfig = (): Config => { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Config; } catch { return {}; } };
export const writeConfig = (cfg: Config) => { fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true }); fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 }); };

/** Pack registry from: ZF_PACK_DIRS, config, ./packs next to the definition, the product's own packs/, and ~/.zerovity/packs. */
export function localRegistry(defDir?: string): MemoryPackRegistry {
  const dirs = [...(process.env.ZF_PACK_DIRS?.split(path.delimiter) ?? []), ...(readConfig().packDirs ?? []), defDir ? path.join(defDir, 'packs') : '', path.join(findRepoRootSync(), 'packs'), path.join(os.homedir(), '.zerovity', 'packs')].filter(Boolean);
  return dirPackRegistry(...dirs);
}

export function printIssues(issues: Issue[], json = false) {
  if (json) return console.log(JSON.stringify(issues, null, 2));
  for (const i of issues) {
    const line = formatIssue(i);
    console.log(i.severity === 'error' ? red(line) : i.severity === 'warning' ? yellow(line) : dim(line));
  }
}

export async function remote<T>(method: string, p: string, body?: unknown): Promise<T> {
  const cfg = readConfig();
  const server = process.env.ZF_SERVER ?? cfg.server;
  const token = process.env.ZF_TOKEN ?? cfg.token;
  if (!server || !token) throw new Error('Not logged in. Run: zf login --server https://factory.example.com --token zfp_...');
  const r = await fetch(`${server.replace(/\/$/, '')}/api/v1${p}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  const j = text ? JSON.parse(text) : undefined;
  if (!r.ok) throw new Error(`${r.status} ${(j as { message?: string })?.message ?? r.statusText}`);
  return j as T;
}

export function table(rows: string[][], header?: string[]) {
  const all = header ? [header, ...rows] : rows;
  const w = all[0].map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  for (const r of all) console.log(r.map((x, i) => (x ?? '').padEnd(w[i])).join('  ').trimEnd() + '');
}
