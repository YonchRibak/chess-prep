CREATE TABLE "explorer_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fen_key" text NOT NULL,
	"source" text NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"moves" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_explorer_fen_source" UNIQUE("fen_key","source")
);
