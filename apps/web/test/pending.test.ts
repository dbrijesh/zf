import { describe, it, expect } from 'vitest';
import { pendingCalls, describeCall, fmtElapsed } from '../src/lib/pending';

const ev = (seq: number, kind: string, extra: Record<string, unknown>) => ({ seq, ts: `2026-10-17T17:00:${String(seq).padStart(2, '0')}Z`, kind, ...extra });

describe('pending tool calls', () => {
  it('lists calls that have no result yet and drops finished ones', () => {
    const events = [
      ev(1, 'tool.call', { id: 'a', tool: 'Bash', input: { command: 'npm ci' } }),
      ev(2, 'tool.call', { id: 'b', tool: 'Read', input: { file_path: 'README.md' } }),
      ev(3, 'tool.result', { id: 'b', ok: true, summary: 'x' }),
    ];
    const p = pendingCalls(events);
    expect(p.map((c) => c.id)).toEqual(['a']);
    expect(p[0].label).toBe('npm ci');
    expect(p[0].since).toBe(events[0].ts);
  });
  it('is empty once every call returned, and ignores events without ids', () => {
    expect(pendingCalls([ev(1, 'tool.call', { id: 'a', tool: 'Bash', input: {} }), ev(2, 'tool.result', { id: 'a' })])).toEqual([]);
    expect(pendingCalls([ev(1, 'tool.call', { tool: 'Bash' }), ev(2, 'message.assistant', { text: 'hi' })])).toEqual([]);
  });
  it('keeps several in-flight calls in start order', () => {
    const p = pendingCalls([ev(1, 'tool.call', { id: 'a', tool: 'Bash', input: { command: 'one' } }), ev(2, 'tool.call', { id: 'b', tool: 'Bash', input: { command: 'two' } })]);
    expect(p.map((c) => c.label)).toEqual(['one', 'two']);
  });
  it('describes commands, files and unknown tools compactly', () => {
    expect(describeCall('Bash', { command: 'npm   --prefix frontend\n ci' })).toBe('npm --prefix frontend ci');
    expect(describeCall('Bash', { command: 'x'.repeat(300) }).length).toBeLessThanOrEqual(140);
    expect(describeCall('Read', { file_path: 'src/a.ts' })).toBe('Read src/a.ts');
    expect(describeCall('Mystery', null)).toBe('Mystery');
  });
  it('formats elapsed time', () => {
    expect(fmtElapsed(0)).toBe('0s');
    expect(fmtElapsed(59_000)).toBe('59s');
    expect(fmtElapsed(372_000)).toBe('6m 12s');
    expect(fmtElapsed(3_900_000)).toBe('1h 05m');
    expect(fmtElapsed(-5)).toBe('0s');
  });
});
