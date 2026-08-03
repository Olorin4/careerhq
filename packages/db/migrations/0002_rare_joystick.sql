CREATE TYPE "public"."answer_origin" AS ENUM('deterministic', 'ai', 'user');--> statement-breakpoint
CREATE TYPE "public"."approval_state" AS ENUM('draft', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('cover_letter', 'email_body');--> statement-breakpoint
CREATE TABLE "application_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"question_raw" text NOT NULL,
	"question_norm" text NOT NULL,
	"answer" text NOT NULL,
	"origin" "answer_origin" NOT NULL,
	"source_fact_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"confidence" real,
	"sensitivity" "sensitivity" DEFAULT 'normal' NOT NULL,
	"approval" "approval_state" DEFAULT 'draft' NOT NULL,
	"approved_at" timestamp with time zone,
	"reusable" boolean DEFAULT false NOT NULL,
	"review_by" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generated_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"kind" "document_kind" NOT NULL,
	"content_md" text NOT NULL,
	"source_fact_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"model" text,
	"origin" "answer_origin" DEFAULT 'ai' NOT NULL,
	"approval" "approval_state" DEFAULT 'draft' NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "salary_raw" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "posted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "application_answers" ADD CONSTRAINT "application_answers_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_answers_application" ON "application_answers" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE INDEX "application_answers_reusable" ON "application_answers" USING btree ("reusable","question_norm");--> statement-breakpoint
CREATE INDEX "generated_documents_application" ON "generated_documents" USING btree ("application_id","created_at");