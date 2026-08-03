CREATE TABLE "form_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"ats_type" text NOT NULL,
	"url" text NOT NULL,
	"requisition_key" text NOT NULL,
	"parser_version" text NOT NULL,
	"canonical_form" jsonb NOT NULL,
	"planned_answers" jsonb NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"recovery_state" jsonb,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "form_snapshots" ADD CONSTRAINT "form_snapshots_attempt_id_application_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."application_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_snapshots_attempt" ON "form_snapshots" USING btree ("attempt_id","captured_at");