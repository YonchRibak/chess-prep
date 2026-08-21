CREATE TABLE "drill_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"move_id" uuid NOT NULL,
	"repertoire_id" uuid NOT NULL,
	"played_san" text NOT NULL,
	"was_correct" boolean NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drill_attempts" ADD CONSTRAINT "drill_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drill_attempts" ADD CONSTRAINT "drill_attempts_move_id_moves_id_fk" FOREIGN KEY ("move_id") REFERENCES "public"."moves"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drill_attempts" ADD CONSTRAINT "drill_attempts_repertoire_id_repertoires_id_fk" FOREIGN KEY ("repertoire_id") REFERENCES "public"."repertoires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_attempts_user_at" ON "drill_attempts" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "idx_attempts_move" ON "drill_attempts" USING btree ("move_id");