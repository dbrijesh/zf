export interface Ver { major: number; minor: number; patch: number; pre?: string }

export function parseVer(v: string): Ver | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/.exec(v.trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] } : undefined;
}

export function cmpVer(a: Ver, b: Ver): number {
  for (const k of ['major', 'minor', 'patch'] as const) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/** Supports: *, x-ranges (1.x), exact, ^, ~, >=, >, <=, <, and space-separated AND. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVer(version);
  if (!v) return false;
  return range
    .trim()
    .split(/\s+/)
    .every((part) => satisfiesOne(v, part));
}

function satisfiesOne(v: Ver, r: string): boolean {
  if (r === '*' || r === '' || r === 'latest') return true;
  let m = /^\^(\d+)\.(\d+)\.(\d+)/.exec(r);
  if (m) {
    const lo: Ver = { major: +m[1], minor: +m[2], patch: +m[3] };
    const hi: Ver = lo.major > 0 ? { major: lo.major + 1, minor: 0, patch: 0 } : lo.minor > 0 ? { major: 0, minor: lo.minor + 1, patch: 0 } : { major: 0, minor: 0, patch: lo.patch + 1 };
    return cmpVer(v, lo) >= 0 && cmpVer(v, hi) < 0;
  }
  m = /^~(\d+)\.(\d+)\.(\d+)/.exec(r);
  if (m) {
    const lo: Ver = { major: +m[1], minor: +m[2], patch: +m[3] };
    return cmpVer(v, lo) >= 0 && cmpVer(v, { major: lo.major, minor: lo.minor + 1, patch: 0 }) < 0;
  }
  m = /^(>=|>|<=|<)\s*(\d+\.\d+\.\d+)$/.exec(r);
  if (m) {
    const c = cmpVer(v, parseVer(m[2])!);
    return m[1] === '>=' ? c >= 0 : m[1] === '>' ? c > 0 : m[1] === '<=' ? c <= 0 : c < 0;
  }
  m = /^(\d+)(?:\.(\d+|x))?(?:\.x)?$/.exec(r);
  if (m && (r.includes('x') || !r.includes('.') || r.split('.').length < 3)) return v.major === +m[1] && (m[2] === undefined || m[2] === 'x' || v.minor === +m[2]);
  const exact = parseVer(r);
  return !!exact && cmpVer(v, exact) === 0;
}

export function maxSatisfying(versions: string[], range: string): string | undefined {
  return versions
    .filter((v) => satisfies(v, range))
    .sort((a, b) => cmpVer(parseVer(b)!, parseVer(a)!))[0];
}
