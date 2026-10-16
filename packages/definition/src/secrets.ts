const REF = /\$\{secret:([A-Za-z0-9_]+)\}/g;

export function findSecretRefs(text: string): string[] {
  return [...text.matchAll(REF)].map((m) => m[1]);
}

/** Replace `${secret:NAME}` using a lookup; unknown names throw so a run never starts half-configured. */
export function resolveSecretRefs(text: string, lookup: (name: string) => string | undefined): string {
  return text.replace(REF, (_, n: string) => {
    const v = lookup(n);
    if (v === undefined) throw new Error(`Secret ${n} is not set`);
    return v;
  });
}

export function resolveDeep<T>(v: T, lookup: (name: string) => string | undefined): T {
  if (typeof v === 'string') return resolveSecretRefs(v, lookup) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => resolveDeep(x, lookup)) as unknown as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveDeep(x, lookup)])) as T;
  return v;
}

export function collectSecretRefs(v: unknown, out = new Set<string>()): Set<string> {
  if (typeof v === 'string') findSecretRefs(v).forEach((x) => out.add(x));
  else if (Array.isArray(v)) v.forEach((x) => collectSecretRefs(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => collectSecretRefs(x, out));
  return out;
}
