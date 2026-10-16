import { z } from 'zod';
import { HARNESS_TYPES, ROLES, AGENT_PHASES, PHASES } from './phases';

export const HarnessTypeSchema = z.enum(HARNESS_TYPES);
export const PhaseSchema = z.enum(PHASES);
export const AgentPhaseSchema = z.enum(AGENT_PHASES);
export const RoleSchema = z.enum(ROLES);

/* ---------- result.json (spec 8.4) ---------- */
export const QuestionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  options: z.array(z.string()).optional(),
  why: z.string().optional(),
  kind: z.enum(['decision', 'context_request']).default('decision'),
});
export type Question = z.infer<typeof QuestionSchema>;

export const ResultSchema = z.object({
  status: z.enum(['done', 'needs_input', 'blocked', 'failed']),
  summary: z.string().default(''),
  questions: z.array(QuestionSchema).default([]),
  artifacts: z.array(z.object({ path: z.string(), type: z.string().optional() })).default([]),
  evidence: z
    .array(
      z.object({
        type: z.string(),
        command: z.string().optional(),
        exitCode: z.number().optional(),
        logPath: z.string().optional(),
        note: z.string().optional(),
      }),
    )
    .default([]),
  recommendation: z.enum(['accept', 'revise', 'escalate']).optional(),
  findings: z
    .array(
      z.object({
        severity: z.enum(['low', 'medium', 'high', 'critical']),
        file: z.string().optional(),
        line: z.number().optional(),
        text: z.string(),
      }),
    )
    .default([]),
  triage: z
    .object({
      complexity: z.enum(['S', 'M', 'L']).optional(),
      risk: z.enum(['low', 'medium', 'high']).optional(),
      skipSpec: z.boolean().default(false),
    })
    .optional(),
  pathsTouched: z.array(z.string()).default([]),
});
export type RunResult = z.infer<typeof ResultSchema>;
export type RunResultInput = z.input<typeof ResultSchema>;

/** JSON Schema written into every run as `.zerovity/run/result.schema.json`. */
export const resultJsonSchema = () => z.toJSONSchema(ResultSchema, { io: 'input' });

/* ---------- usage ---------- */
export const UsageSchema = z.object({
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  cachedTokens: z.number().default(0),
  costUsd: z.number().optional(),
  premiumRequests: z.number().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;
export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });

/* ---------- context items (spec 9.2) ---------- */
export const CONTEXT_LAYERS = ['org', 'factory', 'repo', 'workItem', 'phase'] as const;
export type ContextLayer = (typeof CONTEXT_LAYERS)[number];
export const CONTEXT_KINDS = ['note', 'file', 'url', 'glossary', 'adr', 'repoPointer', 'ticket'] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];
export const CONTEXT_PRIORITIES = ['always', 'relevant', 'on_request'] as const;
export type ContextPriority = (typeof CONTEXT_PRIORITIES)[number];

export const ContextItemInputSchema = z.object({
  layer: z.enum(CONTEXT_LAYERS),
  scopeId: z.string().default(''),
  title: z.string().min(1).max(200),
  kind: z.enum(CONTEXT_KINDS).default('note'),
  body: z.string().default(''),
  tags: z.array(z.string()).default([]),
  appliesTo: z
    .object({ phases: z.array(AgentPhaseSchema).default([]), agents: z.array(z.string()).default([]) })
    .default({ phases: [], agents: [] }),
  priority: z.enum(CONTEXT_PRIORITIES).default('always'),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type ContextItemInput = z.input<typeof ContextItemInputSchema>;

/* ---------- foreman advisor (spec 10.2) ---------- */
export const IntakeDecisionSchema = z.object({
  startPhase: z.enum(['INTENT', 'SPEC', 'BUILD']),
  askFirst: z.string().optional(),
  rationale: z.string(),
});
export const QuestionRewriteSchema = z.object({ message: z.string(), rationale: z.string().optional() });
export const HandoffSummarySchema = z.object({ message: z.string(), risks: z.array(z.string()).default([]) });
export type IntakeDecision = z.infer<typeof IntakeDecisionSchema>;
export type QuestionRewrite = z.infer<typeof QuestionRewriteSchema>;
export type HandoffSummary = z.infer<typeof HandoffSummarySchema>;

/* ---------- misc ---------- */
export const PageSchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) });
export const IdParam = z.object({ id: z.string().min(1) });
