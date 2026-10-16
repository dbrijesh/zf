import { z } from 'zod';

/** Output schemas: every route validates what it returns (spec 16). Rows are loose objects so new columns never break clients. */
export const D = z.union([z.date(), z.string()]);
export const DN = D.nullable();
const L = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape);

export const WorkItemS = L({
  id: z.string(), factoryId: z.string(), shortId: z.string(), title: z.string(), body: z.string(), state: z.string(), sourceType: z.string(), costUsd: z.number(), loops: z.number(),
  branch: z.string().nullable(), prUrl: z.string().nullable(), createdAt: D, stateSince: D,
});
export const RunS = L({ id: z.string(), workItemId: z.string(), factoryId: z.string(), agentName: z.string(), phase: z.string(), harness: z.string(), status: z.string(), tokensIn: z.number(), tokensOut: z.number(), costUsd: z.number(), createdAt: D });
export const InboxS = L({ id: z.string(), kind: z.string(), status: z.string(), read: z.boolean(), title: z.string(), body: z.string(), workItemId: z.string().nullable(), payload: z.record(z.string(), z.unknown()), createdAt: D });
export const QuestionS = L({ id: z.string(), workItemId: z.string(), kind: z.string(), text: z.string(), options: z.array(z.string()).nullable(), answer: z.string().nullable() });
export const GateS = L({ id: z.string(), workItemId: z.string(), type: z.string(), status: z.string(), subjectHash: z.string().nullable(), requestedAt: D, decidedBy: z.string().nullable(), decidedAt: DN, reason: z.string().nullable() });
export const MessageS = L({ id: z.string(), workItemId: z.string(), authorKind: z.string(), body: z.string(), createdAt: D });
export const FactoryS = L({ id: z.string(), orgId: z.string(), name: z.string(), alias: z.string().nullable(), shortPrefix: z.string(), status: z.string(), paused: z.boolean(), definitionCommit: z.string().nullable() });
export const ContextS = L({ id: z.string(), layer: z.string(), scopeId: z.string(), kind: z.string(), title: z.string(), summary: z.string(), tags: z.array(z.string()), priority: z.string(), tokenCount: z.number(), version: z.number(), enabled: z.boolean(), updatedAt: D });
export const IssueS = z.object({ severity: z.enum(['error', 'warning', 'info']), code: z.string(), message: z.string(), file: z.string(), line: z.number().optional(), col: z.number().optional() });
export const Ok = z.object({ ok: z.boolean() });
export const Any = z.unknown();

export const IdP = z.object({ id: z.string().min(1) });
export const FactoryIdP = z.object({ factoryId: z.string().min(1) });
