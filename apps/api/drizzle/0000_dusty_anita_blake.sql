CREATE TABLE "moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repertoire_id" uuid NOT NULL,
	"parent_position_id" uuid NOT NULL,
	"child_position_id" uuid NOT NULL,
	"san" text NOT NULL,
	"uci" text NOT NULL,
	"comment" text,
	"annotation" text,
	"is_main_line" boolean DEFAULT false NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "uniq_parent_san" UNIQUE("repertoire_id","parent_position_id","san")
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repertoire_id" uuid NOT NULL,
	"fen_key" text NOT NULL,
	"full_fen" text NOT NULL,
	CONSTRAINT "uniq_repertoire_fen" UNIQUE("repertoire_id","fen_key")
);
--> statement-breakpoint
CREATE TABLE "repertoires" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"root_fen_key" text NOT NULL,
	"root_full_fen" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "moves" ADD CONSTRAINT "moves_repertoire_id_repertoires_id_fk" FOREIGN KEY ("repertoire_id") REFERENCES "public"."repertoires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moves" ADD CONSTRAINT "moves_parent_position_id_positions_id_fk" FOREIGN KEY ("parent_position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moves" ADD CONSTRAINT "moves_child_position_id_positions_id_fk" FOREIGN KEY ("child_position_id") REFERENCES "public"."positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_repertoire_id_repertoires_id_fk" FOREIGN KEY ("repertoire_id") REFERENCES "public"."repertoires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repertoires" ADD CONSTRAINT "repertoires_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;