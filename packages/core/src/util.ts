export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export function pick<T extends object, K extends keyof T>(o: T, keys: K[]): Pick<T, K> {
  const r = {} as Pick<T, K>;
  for (const k of keys) r[k] = o[k];
  return r;
}

export function groupBy<T, K extends string | number>(arr: T[], f: (x: T) => K): Record<K, T[]> {
  const r = {} as Record<K, T[]>;
  for (const x of arr) (r[f(x)] ??= []).push(x);
  return r;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** structured JSON logger: factoryId / workItemId / runId on every line when known (spec 16) */
export type LogCtx = { factoryId?: string; workItemId?: string; runId?: string; [k: string]: unknown };
export type Logger = { info(msg: string, ctx?: LogCtx): void; warn(msg: string, ctx?: LogCtx): void; error(msg: string, ctx?: LogCtx): void; child(base: LogCtx): Logger };
export function createLogger(base: LogCtx = {}, sink: (line: string) => void = (l) => process.stdout.write(l + '\n')): Logger {
  const emit = (level: string, msg: string, ctx?: LogCtx) =>
    sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, factoryId: null, workItemId: null, runId: null, ...base, ...ctx }));
  return {
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
    child: (b) => createLogger({ ...base, ...b }, sink),
  };
}
export const nullLogger: Logger = { info() {}, warn() {}, error() {}, child: () => nullLogger };
