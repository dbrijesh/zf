CREATE TABLE "agent_sessions" (
	"work_item_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"harness" text NOT NULL,
	"session_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_sessions_work_item_id_agent_name_pk" PRIMARY KEY("work_item_id","agent_name")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"chain" text NOT NULL,
	"seq" integer NOT NULL,
	"factory_id" text,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"subject" text NOT NULL,
	"payload" jsonb,
	"payload_hash" text NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	"ts" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"display_name" text NOT NULL,
	"auth_kind" text NOT NULL,
	"secret_id" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'not_connected' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"expires_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_item_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"changed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_items" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"layer" text NOT NULL,
	"scope_id" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT 'note' NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"applies_to" jsonb DEFAULT '{"phases":[],"agents":[]}'::jsonb NOT NULL,
	"priority" text DEFAULT 'always' NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"artifact_key" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "definition_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"factory_id" text NOT NULL,
	"commit" text NOT NULL,
	"seq" integer NOT NULL,
	"files" jsonb NOT NULL,
	"files_hash" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"applied_at" timestamp with time zone,
	"applied_by" text,
	"valid" boolean DEFAULT false NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "factories" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"alias" text,
	"short_prefix" text DEFAULT 'ZF' NOT NULL,
	"next_seq" integer DEFAULT 1 NOT NULL,
	"definition_source" text DEFAULT 'internal' NOT NULL,
	"definition_commit" text,
	"definition_repo" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "factory_connections" (
	"factory_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "factory_connections_factory_id_connection_id_pk" PRIMARY KEY("factory_id","connection_id")
);
--> statement-breakpoint
CREATE TABLE "gates" (
	"id" text PRIMARY KEY NOT NULL,
	"work_item_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"subject_hash" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"reason" text,
	"comments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reauthenticated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_items" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"factory_id" text,
	"user_id" text,
	"work_item_id" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ref_key" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'created' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"singleton_key" text,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"factory_id" text,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"work_item_id" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_id" text,
	"author_name" text,
	"body" text NOT NULL,
	"channel" text DEFAULT 'web' NOT NULL,
	"external_ref" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_prices" (
	"id" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"input_per_mtok" double precision NOT NULL,
	"output_per_mtok" double precision NOT NULL,
	"cached_per_mtok" double precision DEFAULT 0 NOT NULL,
	"per_premium_request" double precision,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orgs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "packs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"manifest" jsonb NOT NULL,
	"hash" text NOT NULL,
	"artifact_key" text NOT NULL,
	"skill_count" integer DEFAULT 0 NOT NULL,
	"agent_count" integer DEFAULT 0 NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_access_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_access_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" text PRIMARY KEY NOT NULL,
	"work_item_id" text NOT NULL,
	"run_id" text,
	"qid" text NOT NULL,
	"kind" text DEFAULT 'decision' NOT NULL,
	"text" text NOT NULL,
	"options" jsonb,
	"why" text,
	"asked_by" text,
	"phase" text,
	"answer" text,
	"answered_by" text,
	"answered_at" timestamp with time zone,
	"context_item_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"factory_id" text NOT NULL,
	"forge" text DEFAULT 'github' NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"install_id" text,
	"clone_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"work_item_id" text NOT NULL,
	"factory_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"phase" text NOT NULL,
	"harness" text NOT NULL,
	"model" text,
	"session_id" text,
	"runner" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"kind" text DEFAULT 'phase' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"exit_reason" text,
	"context_bundle_hash" text,
	"definition_version_id" text,
	"result_json" jsonb,
	"prompt" text,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"tokens_cached" bigint DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"premium_requests" integer,
	"event_count" integer DEFAULT 0 NOT NULL,
	"head_sha" text,
	"base_sha" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scorers" (
	"id" text PRIMARY KEY NOT NULL,
	"factory_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"rubric" text DEFAULT '' NOT NULL,
	"labels" jsonb DEFAULT '["pass","fail"]'::jsonb NOT NULL,
	"pass_labels" jsonb DEFAULT '["pass"]'::jsonb NOT NULL,
	"sampling" double precision DEFAULT 0.2 NOT NULL,
	"applies_to" jsonb DEFAULT '{"phases":[],"agents":[]}'::jsonb NOT NULL,
	"harness" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"scorer_id" text NOT NULL,
	"label" text NOT NULL,
	"score" double precision NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"judge" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"last4" text DEFAULT '' NOT NULL,
	"ciphertext" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text NOT NULL,
	"name" text NOT NULL,
	"version" text DEFAULT '0.0.0' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"content_hash" text NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"source_pack" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"external_id" text,
	"groups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"webhook_id" text,
	"provider" text NOT NULL,
	"event" text,
	"status" text NOT NULL,
	"detail" text,
	"payload_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"factory_id" text,
	"name" text NOT NULL,
	"kind" text DEFAULT 'inbound' NOT NULL,
	"secret_hash" text NOT NULL,
	"secret_last4" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_item_context_toggles" (
	"work_item_id" text NOT NULL,
	"item_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	CONSTRAINT "work_item_context_toggles_work_item_id_item_id_pk" PRIMARY KEY("work_item_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" text PRIMARY KEY NOT NULL,
	"factory_id" text NOT NULL,
	"short_id" text NOT NULL,
	"seq" integer NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"source_type" text DEFAULT 'web' NOT NULL,
	"source_ref" text,
	"source_url" text,
	"state" text DEFAULT 'INTAKE' NOT NULL,
	"phase" text,
	"paused_state" text,
	"gate" text,
	"loops" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"repo_id" text,
	"branch" text,
	"pr_url" text,
	"pr_number" integer,
	"requester_id" text,
	"budget_usd" double precision,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"triage" jsonb,
	"paths_touched" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"start_phase" text,
	"flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state_since" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "definition_versions" ADD CONSTRAINT "definition_versions_factory_id_factories_id_fk" FOREIGN KEY ("factory_id") REFERENCES "public"."factories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factories" ADD CONSTRAINT "factories_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_factory_id_factories_id_fk" FOREIGN KEY ("factory_id") REFERENCES "public"."factories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_factory_id_factories_id_fk" FOREIGN KEY ("factory_id") REFERENCES "public"."factories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_chain_seq" ON "audit_log" USING btree ("chain","seq");--> statement-breakpoint
CREATE INDEX "audit_factory" ON "audit_log" USING btree ("factory_id","seq");--> statement-breakpoint
CREATE INDEX "conn_org" ON "connections" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "ctxver_item" ON "context_item_versions" USING btree ("item_id","version");--> statement-breakpoint
CREATE INDEX "ctx_scope" ON "context_items" USING btree ("layer","scope_id");--> statement-breakpoint
CREATE INDEX "defver_factory" ON "definition_versions" USING btree ("factory_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "factories_org_name" ON "factories" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "gates_wi" ON "gates" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "inbox_open" ON "inbox_items" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "inbox_ref" ON "inbox_items" USING btree ("ref_key");--> statement-breakpoint
CREATE INDEX "jobs_claim" ON "jobs" USING btree ("queue","state","run_after");--> statement-breakpoint
CREATE INDEX "jobs_singleton" ON "jobs" USING btree ("queue","singleton_key");--> statement-breakpoint
CREATE INDEX "memberships_user" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "messages_wi" ON "messages" USING btree ("work_item_id","created_at");--> statement-breakpoint
CREATE INDEX "prices_model" ON "model_prices" USING btree ("model","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "packs_name_version" ON "packs" USING btree ("name","version");--> statement-breakpoint
CREATE INDEX "questions_wi" ON "questions" USING btree ("work_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repos_factory_slug" ON "repositories" USING btree ("factory_id","owner","name");--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_run_seq" ON "run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "runs_wi" ON "runs" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "runs_status" ON "runs" USING btree ("factory_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "scorers_factory_name" ON "scorers" USING btree ("factory_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "scores_run_scorer" ON "scores" USING btree ("run_id","scorer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_scope_name" ON "secrets" USING btree ("scope","scope_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_scope_name" ON "skills" USING btree ("scope","scope_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "users_org_email" ON "users" USING btree ("org_id","email");--> statement-breakpoint
CREATE INDEX "whd_hook" ON "webhook_deliveries" USING btree ("webhook_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wi_factory_short" ON "work_items" USING btree ("factory_id","short_id");--> statement-breakpoint
CREATE INDEX "wi_factory_state" ON "work_items" USING btree ("factory_id","state");--> statement-breakpoint
CREATE INDEX "wi_source" ON "work_items" USING btree ("factory_id","source_type","source_ref");