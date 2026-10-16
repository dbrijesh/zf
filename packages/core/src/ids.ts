const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

let lastTime = 0;
let lastRand: number[] = [];

/** ULID: 48-bit time + 80-bit randomness, monotonic within a millisecond. */
export function ulid(now: number = Date.now()): string {
  let rand: number[];
  if (now === lastTime && lastRand.length) {
    rand = [...lastRand];
    for (let i = 15; i >= 0; i--) {
      if (rand[i] < 31) {
        rand[i]++;
        break;
      }
      rand[i] = 0;
    }
  } else {
    rand = Array.from(randomBytes(16), (x) => x & 31);
  }
  lastTime = now;
  lastRand = rand;
  let t = '';
  let n = now;
  for (let i = 0; i < 10; i++) {
    t = ALPHABET[n % 32] + t;
    n = Math.floor(n / 32);
  }
  return t + rand.map((x) => ALPHABET[x]).join('');
}

export function ulidTime(id: string): number {
  let t = 0;
  for (const ch of id.slice(0, 10)) t = t * 32 + ALPHABET.indexOf(ch);
  return t;
}

export function slugify(s: string, max = 40): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/g, '') || 'item'
  );
}

/** Human short id for work items, e.g. ZF-214. */
export function formatShortId(prefix: string, n: number): string {
  return `${prefix}-${n}`;
}

export function randomToken(bytes = 24): string {
  return Array.from(randomBytes(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}
