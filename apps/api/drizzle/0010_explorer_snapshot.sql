CREATE TABLE "explorer_snapshot_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fen_key" text NOT NULL,
	"source" text NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"moves" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uniq_snapshot_fen" UNIQUE("fen_key")
);
