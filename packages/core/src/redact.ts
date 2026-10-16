/** Redact obvious secrets and tokens before anything is stored (spec 14, PII). Regex + entropy. */
const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, '[REDACTED:anthropic-key]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[REDACTED:openai-key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, '[REDACTED:github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, '[REDACTED:github-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws-key]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack-token]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED:jwt]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, '$1[REDACTED]'],
  [/((?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi, '$1[REDACTED]'],
];

export function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const LONG_TOKEN = /[A-Za-z0-9+/_=-]{32,}/g;

export function redactText(input: string): string {
  let out = input;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  out = out.replace(LONG_TOKEN, (m) => {
    // hex hashes (sha) and long paths/words are fine; random-looking strings are not
    if (/^[0-9a-f]{32,}$/i.test(m) && m.length <= 64) return m;
    return shannonEntropy(m) > 4.3 && /[0-9]/.test(m) && /[A-Za-z]/.test(m) ? '[REDACTED:high-entropy]' : m;
  });
  return out;
}

export function redactValue<T>(v: T): T {
  if (typeof v === 'string') return redactText(v) as unknown as T;
  if (Array.isArray(v)) return v.map(redactValue) as unknown as T;
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) o[k] = /secret|token|password|apikey|api_key|authorization/i.test(k) && typeof val === 'string' ? '[REDACTED]' : redactValue(val);
    return o as T;
  }
  return v;
}
