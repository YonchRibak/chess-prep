ALTER TABLE "moves" ADD COLUMN "origin" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
-- Backfill: every move that already exists on a study-sourced repertoire was
-- put there by an import (or by an in-app addition that, before this column,
-- was lost on the next re-import anyway). Treat them all as the study's, so
-- the next re-import behaves exactly as it did before — nothing regresses.
UPDATE "moves" SET "origin" = 'study'
WHERE "repertoire_id" IN (SELECT "id" FROM "repertoires" WHERE "source" IS NOT NULL);
