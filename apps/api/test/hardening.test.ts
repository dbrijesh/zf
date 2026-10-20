import { describe, it, expect } from 'vitest';
import { assertDevLoginSafe, isLocalUrl } from '../src/app';
import { safeNext, makeLimiter } from '../src/routes/auth';

describe('dev login is refused on a public address', () => {
  it('recognises local addresses', () => {
    for (const u of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787', 'http://factory.localhost', 'http://box.local:8787']) expect(isLocalUrl(u), u).toBe(true);
    for (const u of ['https://factory.example.com', 'https://abc.trycloudflare.com', 'http://192.168.1.5:8787', 'https://localhost.evil.com', 'not a url']) expect(isLocalUrl(u), u).toBe(false);
  });
  it('refuses to start with dev login on a public URL unless explicitly overridden', () => {
    expect(() => assertDevLoginSafe({ devLogin: true, publicUrl: 'https://abc.trycloudflare.com' }, {})).toThrow(/Refusing to start/);
    expect(() => assertDevLoginSafe({ devLogin: true, publicUrl: 'https://abc.trycloudflare.com' }, { ZF_ALLOW_PUBLIC_DEV_LOGIN: '1' })).not.toThrow();
    expect(() => assertDevLoginSafe({ devLogin: true, publicUrl: 'http://localhost:8787' }, {})).not.toThrow();
    expect(() => assertDevLoginSafe({ devLogin: false, publicUrl: 'https://factory.example.com' }, {})).not.toThrow();
  });
});

describe('post-login redirect cannot leave the site', () => {
  it('only plain same-site paths are accepted', () => {
    for (const ok of ['/', '/items/ZF-1', '/runs?x=1']) expect(safeNext(ok)).toBe(ok);
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '', undefined, 42, '/a\r\nSet-Cookie: x=1']) expect(safeNext(bad), String(bad)).toBe('/');
  });
});

describe('rate limiter', () => {
  it('allows a burst up to the limit, blocks the rest, and recovers after the window', () => {
    let now = 0;
    const lim = makeLimiter(3, 1000, () => now);
    expect([lim('a'), lim('a'), lim('a'), lim('a')]).toEqual([true, true, true, false]);
    expect(lim('b')).toBe(true); // per client
    now = 1001;
    expect(lim('a')).toBe(true);
  });
});