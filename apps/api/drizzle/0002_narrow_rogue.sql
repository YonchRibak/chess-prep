CREATE TABLE "opening_book_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"eco" text NOT NULL,
	"name" text NOT NULL,
	"variation" text,
	"fen_key" text NOT NULL,
	"full_fen" text NOT NULL,
	"pgn_moves" text NOT NULL,
	CONSTRAINT "uniq_opening_fen_key" UNIQUE("fen_key")
);
--> statement-breakpoint
CREATE INDEX "idx_opening_eco" ON "opening_book_entries" USING btree ("eco");--> statement-breakpoint
CREATE INDEX "idx_opening_name" ON "opening_book_entries" USING btree ("name");