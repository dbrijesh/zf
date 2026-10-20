-- Two OPEN work items for one source (a retried webhook, or two instances at once) would make the unique index fail:
-- keep the oldest and tag the later ones so they stay visible but no longer collide. Finished items are unaffected.
UPDATE "work_items" w SET "source_ref" = w."source_ref" || '#dup-' || w."id"
FROM (SELECT "id", row_number() OVER (PARTITION BY "factory_id", "source_type", "source_ref" ORDER BY "created_at", "id") AS rn FROM "work_items" WHERE "source_ref" IS NOT NULL AND "state" NOT IN ('COMPLETE', 'FAILED', 'CANCELLED')) d
WHERE d."id" = w."id" AND d.rn > 1;--> statement-breakpoint
DROP INDEX "wi_source";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sessions_valid_after" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "wi_source" ON "work_items" USING btree ("factory_id","source_type","source_ref") WHERE source_ref is not null and state not in ('COMPLETE', 'FAILED', 'CANCELLED');