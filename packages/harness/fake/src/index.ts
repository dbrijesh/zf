import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalisedEvent } from '@zerovity/core';
import { firstSession, safeJson, sumUsage, type CommandSpec, type HarnessAdapter, type RunSpec } from '@zerovity/harness-common';

const AGENT_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agent.mjs');
const KINDS = new Set(['session.started', 'message.assistant', 'tool.call', 'tool.result', 'file.changed', 'command.run', 'usage', 'error', 'session.ended']);

/**
 * Offline harness for demos, e2e tests and CI. It exercises the whole pipeline (sandbox, skills,
 * context, result contract, usage) without any model. It is never chosen implicitly.
 */
export class FakeAdapter implements HarnessAdapter {
  type = 'fake' as const;
  async detect() {
    return { installed: true, version: '1.0.0' };
  }
  buildCommand(spec: RunSpec): CommandSpec {
    const env: Record<string, string> = { ...spec.env };
    if (spec.resumeSessionId) env.ZF_FAKE_RESUME = spec.resumeSessionId;
    return { cmd: process.execPath, args: [AGENT_SCRIPT, spec.prompt], env };
  }
  sendFollowUp(sessionId: string, message: string, spec: RunSpec): CommandSpec {
    const c = this.buildCommand({ ...spec, prompt: message, resumeSessionId: sessionId });
    c.env.ZF_FAKE_REPAIR = '1';
    return c;
  }
  parseLine(line: string): NormalisedEvent[] {
    const o = safeJson(line);
    return o && typeof o.kind === 'string' && KINDS.has(o.kind) ? [o as unknown as NormalisedEvent] : [];
  }
  extractSessionId = firstSession;
  extractUsage = sumUsage;
}
export const createFakeAdapter = () => new FakeAdapter();
