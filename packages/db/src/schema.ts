import { pgTable, text, integer, bigint, boolean, jsonb, timestamp, doublePrecision, primaryKey, uniqueIndex, index, serial } from 'drizzle-orm/pg-core';

/** IDs are ULIDs stored as text. Timestamps are timestamptz. */
const id = () => text('id').primaryKey();
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();
const json = <T = unknown>(name: string) => jsonb(name).$type<T>();

export const orgs = pgTable('orgs', {
  id: id(), name: text('name').notNull(), slug: text('slug').notNull().unique(),
  settings: json<Record<string, unknown>>('settings').notNull().default({}),
  createdAt: createdAt(), updatedAt: updatedAt(),
});

export const users = pgTable('users', {
  id: id(), orgId: text('org_id').notNull().references(() => orgs.id),
  email: text('email').notNull(), name: text('name').notNull(), externalId: text('external_id'),
  groups: json<string[]>('groups').notNull().default([]),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('users_org_email').on(t.orgId, t.email)]);

export const memberships = pgTable('memberships', {
  id: id(), userId: text('user_id').notNull().references(() => users.id), orgId: text('org_id').notNull().references(() => orgs.id),
  factoryId: text('factory_id'), role: text('role').notNull(),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('memberships_user').on(t.userId)]);

export const personalAccessTokens = pgTable('personal_access_tokens', {
  id: id(), userId: text('user_id').notNull().references(() => users.id), name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(), prefix: text('prefix').notNull(),
  lastUsedAt: ts('last_used_at'), expiresAt: ts('expires_at'),
  createdAt: createdAt(), updatedAt: updatedAt(),
});

export const factories = pgTable('factories', {
  id: id(), orgId: text('org_id').notNull().references(() => orgs.id),
  name: text('name').notNull(), alias: text('alias'), shortPrefix: text('short_prefix').notNull().default('ZF'), nextSeq: integer('next_seq').notNull().default(1),
  definitionSource: text('definition_source').notNull().default('internal'), // internal | git
  definitionCommit: text('definition_commit'), definitionRepo: json<{ forge: string; owner: string; name: string; branch: string; path: string }>('definition_repo'),
  status: text('status').notNull().default('active'), settings: json<Record<string, unknown>>('settings').notNull().default({}),
  paused: boolean('paused').notNull().default(false),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('factories_org_name').on(t.orgId, t.name)]);

export const definitionVersions = pgTable('definition_versions', {
  id: id(), factoryId: text('factory_id').notNull().references(() => factories.id),
  commit: text('commit').notNull(), seq: integer('seq').notNull(), files: json<Record<string, string>>('files').notNull(), filesHash: text('files_hash').notNull(),
  message: text('message').notNull().default(''), appliedAt: ts('applied_at'), appliedBy: text('applied_by'), valid: boolean('valid').notNull().default(false),
  issues: json<unknown[]>('issues').notNull().default([]),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('defver_factory').on(t.factoryId, t.seq)]);

export const repositories = pgTable('repositories', {
  id: id(), factoryId: text('factory_id').notNull().references(() => factories.id),
  forge: text('forge').notNull().default('github'), owner: text('owner').notNull(), name: text('name').notNull(), defaultBranch: text('default_branch').notNull().default('main'),
  installId: text('install_id'), cloneUrl: text('clone_url'),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('repos_factory_slug').on(t.factoryId, t.owner, t.name)]);

export const workItems = pgTable('work_items', {
  id: id(), factoryId: text('factory_id').notNull().references(() => factories.id),
  shortId: text('short_id').notNull(), seq: integer('seq').notNull(), title: text('title').notNull(), body: text('body').notNull().default(''),
  sourceType: text('source_type').notNull().default('web'), sourceRef: text('source_ref'), sourceUrl: text('source_url'),
  state: text('state').notNull().default('INTAKE'), phase: text('phase'), pausedState: text('paused_state'), gate: text('gate'),
  loops: integer('loops').notNull().default(0), failures: integer('failures').notNull().default(0),
  repoId: text('repo_id'), branch: text('branch'), prUrl: text('pr_url'), prNumber: integer('pr_number'),
  requesterId: text('requester_id'), budgetUsd: doublePrecision('budget_usd'), costUsd: doublePrecision('cost_usd').notNull().default(0),
  tokensIn: bigint('tokens_in', { mode: 'number' }).notNull().default(0), tokensOut: bigint('tokens_out', { mode: 'number' }).notNull().default(0),
  triage: json<Record<string, unknown>>('triage'), pathsTouched: json<string[]>('paths_touched').notNull().default([]),
  startPhase: text('start_phase'), flags: json<Record<string, unknown>>('flags').notNull().default({}),
  stateSince: ts('state_since').notNull().defaultNow(), completedAt: ts('completed_at'),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('wi_factory_short').on(t.factoryId, t.shortId), index('wi_factory_state').on(t.factoryId, t.state), index('wi_source').on(t.factoryId, t.sourceType, t.sourceRef)]);

export const runs = pgTable('runs', {
  id: id(), workItemId: text('work_item_id').notNull().references(() => workItems.id), factoryId: text('factory_id').notNull(),
  agentName: text('agent_name').notNull(), phase: text('phase').notNull(), harness: text('harness').notNull(), model: text('model'), sessionId: text('session_id'),
  runner: text('runner'), status: text('status').notNull().default('queued'), // queued|running|done|needs_input|blocked|failed|timeout|cancelled
  attempt: integer('attempt').notNull().default(1), kind: text('kind').notNull().default('phase'), // phase | followup | repair | scorer
  startedAt: ts('started_at'), endedAt: ts('ended_at'), exitReason: text('exit_reason'), contextBundleHash: text('context_bundle_hash'),
  definitionVersionId: text('definition_version_id'), resultJson: json<Record<string, unknown>>('result_json'), prompt: text('prompt'),
  tokensIn: bigint('tokens_in', { mode: 'number' }).notNull().default(0), tokensOut: bigint('tokens_out', { mode: 'number' }).notNull().default(0), tokensCached: bigint('tokens_cached', { mode: 'number' }).notNull().default(0),
  costUsd: doublePrecision('cost_usd').notNull().default(0), premiumRequests: integer('premium_requests'), eventCount: integer('event_count').notNull().default(0),
  headSha: text('head_sha'), baseSha: text('base_sha'),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('runs_wi').on(t.workItemId), index('runs_status').on(t.factoryId, t.status)]);

export const runEvents = pgTable('run_events', {
  id: serial('id').primaryKey(), runId: text('run_id').notNull(), seq: integer('seq').notNull(), kind: text('kind').notNull(),
  payload: json<Record<string, unknown>>('payload').notNull(), ts: ts('ts').notNull().defaultNow(),
}, (t) => [uniqueIndex('run_events_run_seq').on(t.runId, t.seq)]);

export const agentSessions = pgTable('agent_sessions', {
  workItemId: text('work_item_id').notNull(), agentName: text('agent_name').notNull(), harness: text('harness').notNull(), sessionId: text('session_id').notNull(), updatedAt: updatedAt(),
}, (t) => [primaryKey({ columns: [t.workItemId, t.agentName] })]);

export const questions = pgTable('questions', {
  id: id(), workItemId: text('work_item_id').notNull(), runId: text('run_id'), qid: text('qid').notNull(), kind: text('kind').notNull().default('decision'),
  text: text('text').notNull(), options: json<string[]>('options'), why: text('why'), askedBy: text('asked_by'), phase: text('phase'),
  answer: text('answer'), answeredBy: text('answered_by'), answeredAt: ts('answered_at'), contextItemId: text('context_item_id'),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('questions_wi').on(t.workItemId)]);

export const gates = pgTable('gates', {
  id: id(), workItemId: text('work_item_id').notNull(), type: text('type').notNull(), status: text('status').notNull().default('pending'), // pending|approved|rejected|changes_requested
  subjectHash: text('subject_hash'), requestedAt: ts('requested_at').notNull().defaultNow(), decidedBy: text('decided_by'), decidedAt: ts('decided_at'), reason: text('reason'),
  comments: json<Array<{ file?: string; line?: number; text: string }>>('comments').notNull().default([]), reauthenticated: boolean('reauthenticated').notNull().default(false),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('gates_wi').on(t.workItemId)]);

export const messages = pgTable('messages', {
  id: id(), workItemId: text('work_item_id').notNull(), authorKind: text('author_kind').notNull(), // requester|foreman|agent|user|system
  authorId: text('author_id'), authorName: text('author_name'), body: text('body').notNull(), channel: text('channel').notNull().default('web'), externalRef: text('external_ref'),
  meta: json<Record<string, unknown>>('meta').notNull().default({}), createdAt: createdAt(),
}, (t) => [index('messages_wi').on(t.workItemId, t.createdAt)]);

export const inboxItems = pgTable('inbox_items', {
  id: id(), orgId: text('org_id').notNull(), factoryId: text('factory_id'), userId: text('user_id'), workItemId: text('work_item_id'),
  kind: text('kind').notNull(), status: text('status').notNull().default('open'), read: boolean('read').notNull().default(false),
  title: text('title').notNull(), body: text('body').notNull().default(''), payload: json<Record<string, unknown>>('payload').notNull().default({}),
  refKey: text('ref_key'), resolvedAt: ts('resolved_at'), resolvedBy: text('resolved_by'), resolution: text('resolution'),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('inbox_open').on(t.orgId, t.status), index('inbox_ref').on(t.refKey)]);

export const skills = pgTable('skills', {
  id: id(), scope: text('scope').notNull(), scopeId: text('scope_id').notNull(), name: text('name').notNull(), version: text('version').notNull().default('0.0.0'),
  description: text('description').notNull().default(''), contentHash: text('content_hash').notNull(), tokenCount: integer('token_count').notNull().default(0), sourcePack: text('source_pack'),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('skills_scope_name').on(t.scope, t.scopeId, t.name)]);

export const packs = pgTable('packs', {
  id: id(), name: text('name').notNull(), version: text('version').notNull(), description: text('description').notNull().default(''), manifest: json<Record<string, unknown>>('manifest').notNull(),
  hash: text('hash').notNull(), artifactKey: text('artifact_key').notNull(), skillCount: integer('skill_count').notNull().default(0), agentCount: integer('agent_count').notNull().default(0), source: text('source'),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('packs_name_version').on(t.name, t.version)]);

export const contextItems = pgTable('context_items', {
  id: id(), orgId: text('org_id').notNull(), layer: text('layer').notNull(), scopeId: text('scope_id').notNull().default(''), kind: text('kind').notNull().default('note'),
  title: text('title').notNull(), body: text('body').notNull().default(''), summary: text('summary').notNull().default(''), tags: json<string[]>('tags').notNull().default([]),
  appliesTo: json<{ phases: string[]; agents: string[] }>('applies_to').notNull().default({ phases: [], agents: [] }), priority: text('priority').notNull().default('always'),
  tokenCount: integer('token_count').notNull().default(0), artifactKey: text('artifact_key'), meta: json<Record<string, unknown>>('meta').notNull().default({}),
  version: integer('version').notNull().default(1), enabled: boolean('enabled').notNull().default(true), createdBy: text('created_by'), deletedAt: ts('deleted_at'),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('ctx_scope').on(t.layer, t.scopeId)]);

export const contextItemVersions = pgTable('context_item_versions', {
  id: id(), itemId: text('item_id').notNull(), version: integer('version').notNull(), title: text('title').notNull(), body: text('body').notNull(), changedBy: text('changed_by'), createdAt: createdAt(),
}, (t) => [index('ctxver_item').on(t.itemId, t.version)]);

export const workItemContextToggles = pgTable('work_item_context_toggles', {
  workItemId: text('work_item_id').notNull(), itemId: text('item_id').notNull(), enabled: boolean('enabled').notNull(),
}, (t) => [primaryKey({ columns: [t.workItemId, t.itemId] })]);

export const secrets = pgTable('secrets', {
  id: id(), scope: text('scope').notNull(), scopeId: text('scope_id').notNull().default(''), name: text('name').notNull(), last4: text('last4').notNull().default(''),
  ciphertext: text('ciphertext').notNull(), createdBy: text('created_by'), createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('secrets_scope_name').on(t.scope, t.scopeId, t.name)]);

export const connections = pgTable('connections', {
  id: id(), orgId: text('org_id').notNull(), type: text('type').notNull(), provider: text('provider').notNull(), displayName: text('display_name').notNull(),
  authKind: text('auth_kind').notNull(), secretId: text('secret_id'), config: json<Record<string, unknown>>('config').notNull().default({}), scopes: json<string[]>('scopes').notNull().default([]),
  status: text('status').notNull().default('not_connected'), // connected | needs_attention | expired | not_connected
  lastCheckedAt: ts('last_checked_at'), lastError: text('last_error'), expiresAt: ts('expires_at'), createdBy: text('created_by'),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index('conn_org').on(t.orgId)]);

export const factoryConnections = pgTable('factory_connections', {
  factoryId: text('factory_id').notNull(), connectionId: text('connection_id').notNull(), mapping: json<Record<string, unknown>>('mapping').notNull().default({}),
}, (t) => [primaryKey({ columns: [t.factoryId, t.connectionId] })]);

export const webhooks = pgTable('webhooks', {
  id: id(), orgId: text('org_id').notNull(), factoryId: text('factory_id'), name: text('name').notNull(), kind: text('kind').notNull().default('inbound'),
  secretHash: text('secret_hash').notNull(), secretLast4: text('secret_last4').notNull(), enabled: boolean('enabled').notNull().default(true),
  createdAt: createdAt(), updatedAt: updatedAt(),
});

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: id(), webhookId: text('webhook_id'), provider: text('provider').notNull(), event: text('event'), status: text('status').notNull(), detail: text('detail'),
  payloadHash: text('payload_hash'), createdAt: createdAt(),
}, (t) => [index('whd_hook').on(t.webhookId, t.createdAt)]);

export const modelPrices = pgTable('model_prices', {
  id: id(), model: text('model').notNull(), inputPerMtok: doublePrecision('input_per_mtok').notNull(), outputPerMtok: doublePrecision('output_per_mtok').notNull(),
  cachedPerMtok: doublePrecision('cached_per_mtok').notNull().default(0), perPremiumRequest: doublePrecision('per_premium_request'), effectiveFrom: ts('effective_from').notNull().defaultNow(),
  createdAt: createdAt(),
}, (t) => [index('prices_model').on(t.model, t.effectiveFrom)]);

export const scorers = pgTable('scorers', {
  id: id(), factoryId: text('factory_id').notNull(), name: text('name').notNull(), description: text('description').notNull().default(''), rubric: text('rubric').notNull().default(''),
  labels: json<string[]>('labels').notNull().default(['pass', 'fail']), passLabels: json<string[]>('pass_labels').notNull().default(['pass']), sampling: doublePrecision('sampling').notNull().default(0.2),
  appliesTo: json<{ phases: string[]; agents: string[] }>('applies_to').notNull().default({ phases: [], agents: [] }), harness: json<Record<string, unknown>>('harness'), enabled: boolean('enabled').notNull().default(true),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex('scorers_factory_name').on(t.factoryId, t.name)]);

export const scores = pgTable('scores', {
  id: id(), runId: text('run_id').notNull(), scorerId: text('scorer_id').notNull(), label: text('label').notNull(), score: doublePrecision('score').notNull(), rationale: text('rationale').notNull().default(''),
  judge: text('judge'), createdAt: createdAt(),
}, (t) => [uniqueIndex('scores_run_scorer').on(t.runId, t.scorerId)]);

export const auditLog = pgTable('audit_log', {
  id: id(), chain: text('chain').notNull(), seq: integer('seq').notNull(), factoryId: text('factory_id'), actor: text('actor').notNull(), action: text('action').notNull(), subject: text('subject').notNull(),
  payload: json<unknown>('payload'), payloadHash: text('payload_hash').notNull(), prevHash: text('prev_hash').notNull(), hash: text('hash').notNull(), ts: text('ts').notNull(),
}, (t) => [uniqueIndex('audit_chain_seq').on(t.chain, t.seq), index('audit_factory').on(t.factoryId, t.seq)]);

/** Postgres-backed job queue (spec 4 names pg-boss; see docs/DECISIONS.md). Claimed with FOR UPDATE SKIP LOCKED. */
export const jobs = pgTable('jobs', {
  id: id(), queue: text('queue').notNull(), payload: json<Record<string, unknown>>('payload').notNull().default({}), state: text('state').notNull().default('created'), // created|active|completed|failed|cancelled
  priority: integer('priority').notNull().default(0), runAfter: ts('run_after').notNull().defaultNow(), attempts: integer('attempts').notNull().default(0), maxAttempts: integer('max_attempts').notNull().default(1),
  lockedBy: text('locked_by'), lockedUntil: ts('locked_until'), singletonKey: text('singleton_key'), error: text('error'), startedAt: ts('started_at'), finishedAt: ts('finished_at'), createdAt: createdAt(),
}, (t) => [index('jobs_claim').on(t.queue, t.state, t.runAfter), index('jobs_singleton').on(t.queue, t.singletonKey)]);

export const kv = pgTable('kv', { key: text('key').primaryKey(), value: json<unknown>('value').notNull(), updatedAt: updatedAt() });
