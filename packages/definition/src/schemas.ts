import { z } from 'zod';
import { AgentPhaseSchema, HarnessTypeSchema, CONTEXT_KINDS, CONTEXT_LAYERS, CONTEXT_PRIORITIES } from '@zerovity/core';

export const SCHEMA_VERSION = 'zf/v1alpha1';

const name = z.string().regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and hyphens, starting with a letter');
const secretRef = z.string();

export const HarnessConfigSchema = z
  .object({
    type: HarnessTypeSchema,
    model: z.string().optional(),
    reasoning: z.enum(['low', 'medium', 'high']).optional(),
  })
  .strict();

export const FactorySchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    name: name,
    alias: name.optional(),
    description: z.string().optional(),
    shortIdPrefix: z.string().regex(/^[A-Z]{2,6}$/).optional(),
    repositories: z
      .array(z.object({ forge: z.enum(['github', 'gitlab', 'azuredevops', 'bitbucket']).default('github'), owner: z.string(), name: z.string(), defaultBranch: z.string().default('main'), url: z.string().optional() }).strict())
      .default([]),
    packs: z.array(z.object({ name: z.string(), version: z.string().default('*'), include: z.array(z.string()).optional() }).strict()).default([]),
    agentDefaults: z
      .object({
        harness: HarnessConfigSchema.optional(),
        runner: z.string().optional(),
        idleTimeoutMinutes: z.number().positive().optional(),
        maxRunMinutes: z.number().positive().optional(),
        budget: z.object({ maxTokensPerRun: z.number().positive().optional(), maxCostPerWorkItemUsd: z.number().positive().optional() }).strict().optional(),
      })
      .strict()
      .default({}),
    limits: z.object({ maxConcurrentRuns: z.number().int().positive().default(4), maxRunsPerRepo: z.number().int().positive().default(2) }).strict().optional(),
    gateway: z.object({ anthropicBaseUrl: secretRef.optional(), openaiBaseUrl: secretRef.optional() }).strict().optional(),
    secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'UPPER_SNAKE_CASE')).default([]),
    mcpServers: z
      .record(
        name,
        z
          .object({ url: z.string().optional(), command: z.string().optional(), args: z.array(z.string()).optional(), headers: z.record(z.string(), z.string()).optional(), env: z.record(z.string(), z.string()).optional() })
          .strict()
          .refine((s) => !!s.url !== !!s.command, 'exactly one of url or command is required'),
      )
      .default({}),
    /** partial per-agent overrides of pack or factory agents (harness, runner, skills...) so the UI never has to fork a pack agent */
    agentOverrides: z.record(z.string(), z.lazy(() => AgentFrontmatterSchema.partial())).default({}),
    integrations: z
      .object({
        jira: z
          .array(
            z
              .object({
                connection: z.string(),
                project: z.string(),
                label: z.string().default('zerovity'),
                statusMap: z.record(z.string(), z.string()).optional(),
              })
              .strict(),
          )
          .default([]),
        github: z.object({ connection: z.string().optional(), triggerLabel: z.string().default('zerovity') }).strict().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type FactoryDoc = z.infer<typeof FactorySchema>;

export const AgentFrontmatterSchema = z
  .object({
    description: z.string(),
    phase: AgentPhaseSchema,
    role: z.string().optional(),
    skills: z.array(z.string()).default([]),
    contextScopes: z.array(z.enum(CONTEXT_LAYERS)).default(['org', 'factory', 'repo', 'workItem']),
    harness: HarnessConfigSchema.optional(),
    outputs: z.array(z.string()).default([]),
    spawnableBy: z.array(z.string()).default(['foreman']),
    mcpServers: z.array(z.string()).default([]),
    credential: z.string().optional(),
    runner: z.string().optional(),
    secrets: z.array(z.string()).default([]),
    maxRunMinutes: z.number().positive().optional(),
    contextTokenBudget: z.number().int().positive().optional(),
  })
  .strict();
export type AgentFrontmatter = z.infer<typeof AgentFrontmatterSchema>;

const GateSchema = z
  .object({
    when: z.enum(['phase_completed']).default('phase_completed'),
    phase: z.enum(['INTENT', 'SPEC', 'BUILD', 'VERIFY']),
    required: z.boolean().default(true),
    approvers: z.object({ groups: z.array(z.string()).default([]), users: z.array(z.string()).default([]) }).strict().default({ groups: [], users: [] }),
    requireReason: z.boolean().default(false),
    reauthenticate: z.boolean().default(false),
  })
  .strict();
export type GateDef = z.infer<typeof GateSchema>;

export const GatesFileSchema = z
  .object({
    gates: z
      .object({
        specApproval: GateSchema.optional(),
        questionTimeoutHours: z.number().positive().default(48),
        handoff: z.object({ required: z.boolean().default(true) }).strict().default({ required: true }),
        riskOverrides: z.array(z.object({ if: z.string(), add: z.array(z.string()).min(1) }).strict()).default([]),
        maxRevisionLoops: z.number().int().min(0).max(10).default(3),
      })
      .catchall(GateSchema)
      .default({ questionTimeoutHours: 48, handoff: { required: true }, riskOverrides: [], maxRevisionLoops: 3 } as never),
    merge: z.object({ agentsMayMerge: z.literal(false) }).strict().default({ agentsMayMerge: false }),
  })
  .strict();
export type GatesFile = z.infer<typeof GatesFileSchema>;

export const TriggerSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('github'), event: z.enum(['issue_labeled', 'issue_commented', 'issue_mentioned', 'pull_request_commented', 'check_suite_completed']), filter: z.object({ repos: z.array(z.string()).optional(), labels: z.array(z.string()).optional() }).strict().optional() }).strict(),
  z.object({ provider: z.literal('schedule'), cron: z.string(), name: z.string().optional() }).strict(),
  z.object({ provider: z.literal('webhook'), name: z.string().optional() }).strict(),
  z.object({ provider: z.literal('factory'), event: z.enum(['work_item_phase_changed']), filter: z.object({ phase: AgentPhaseSchema.optional() }).strict().optional() }).strict(),
]);
export const AutomationFrontmatterSchema = z.object({ enabled: z.boolean().default(true), agent: z.string(), triggers: z.array(TriggerSchema).min(1) }).strict();
export type AutomationFrontmatter = z.infer<typeof AutomationFrontmatterSchema>;

export const RunnerSchema = z
  .object({
    description: z.string().optional(),
    image: z.string(),
    setupCommands: z.array(z.string()).default([]),
    resources: z.object({ cpus: z.number().positive().default(2), memoryGb: z.number().positive().default(4) }).strict().default({ cpus: 2, memoryGb: 4 }),
    network: z.object({ egress: z.enum(['allowlist', 'open', 'none']).default('allowlist'), allow: z.array(z.string()).default([]) }).strict().default({ egress: 'allowlist', allow: [] }),
  })
  .strict();
export type RunnerDef = z.infer<typeof RunnerSchema>;

export const ScorerFrontmatterSchema = z
  .object({
    description: z.string(),
    labels: z.array(z.string()).min(2).default(['pass', 'fail']),
    passLabels: z.array(z.string()).default(['pass']),
    sampling: z.number().min(0).max(1).default(0.2),
    appliesTo: z.object({ phases: z.array(AgentPhaseSchema).default([]), agents: z.array(z.string()).default([]) }).strict().default({ phases: [], agents: [] }),
    harness: HarnessConfigSchema.optional(),
  })
  .strict();
export type ScorerFrontmatter = z.infer<typeof ScorerFrontmatterSchema>;

export const ContextFileSchema = z
  .object({
    title: z.string().optional(),
    layer: z.enum(CONTEXT_LAYERS).default('factory'),
    kind: z.enum(CONTEXT_KINDS).default('note'),
    tags: z.array(z.string()).default([]),
    appliesTo: z.object({ phases: z.array(AgentPhaseSchema).default([]), agents: z.array(z.string()).default([]) }).strict().default({ phases: [], agents: [] }),
    priority: z.enum(CONTEXT_PRIORITIES).default('always'),
    // yaml-form kinds
    term: z.string().optional(),
    definition: z.string().optional(),
    status: z.string().optional(),
    decision: z.string().optional(),
    repo: z.string().optional(),
    glob: z.string().optional(),
    body: z.string().optional(),
  })
  .strict();
export type ContextFile = z.infer<typeof ContextFileSchema>;

export const LockSchema = z
  .object({
    lockVersion: z.literal(1).default(1),
    packs: z.array(z.object({ name: z.string(), version: z.string(), hash: z.string() }).strict()).default([]),
  })
  .strict();
export type LockFile = z.infer<typeof LockSchema>;

export const PackManifestSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/, 'semver'),
    description: z.string().default(''),
    skills: z.array(z.string()).optional(),
    agents: z.array(z.string()).optional(),
  })
  .strict();
export type PackManifest = z.infer<typeof PackManifestSchema>;

/** Published JSON Schemas, one per document type (spec 6.6). */
export const DOC_SCHEMAS = {
  factory: FactorySchema,
  agent: AgentFrontmatterSchema,
  gates: GatesFileSchema,
  automation: AutomationFrontmatterSchema,
  runner: RunnerSchema,
  scorer: ScorerFrontmatterSchema,
  context: ContextFileSchema,
  lock: LockSchema,
  pack: PackManifestSchema,
} as const;
export type DocName = keyof typeof DOC_SCHEMAS;

export function jsonSchemaFor(doc: DocName): Record<string, unknown> {
  const js = z.toJSONSchema(DOC_SCHEMAS[doc], { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return { ...js, $id: `https://zerovity.dev/schemas/${SCHEMA_VERSION}/${doc}.json`, title: `Zerovity ${doc} (${SCHEMA_VERSION})` };
}
