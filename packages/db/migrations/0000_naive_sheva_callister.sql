CREATE TYPE "public"."application_state" AS ENUM('DISCOVERED', 'SHORTLISTED', 'PREPARING', 'READY_FOR_REVIEW', 'SUBMITTED', 'ACKNOWLEDGED', 'INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."attempt_origin" AS ENUM('app', 'manual');--> statement-breakpoint
CREATE TYPE "public"."attempt_status" AS ENUM('DRAFT', 'READY', 'PENDING_CONFIRMATION', 'SUBMITTING', 'SUBMITTED', 'FAILED', 'BLOCKED', 'NEEDS_RECONCILE');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('email', 'company_site', 'external');--> statement-breakpoint
CREATE TYPE "public"."cv_format" AS ENUM('designed', 'ats');--> statement-breakpoint
CREATE TYPE "public"."fact_category" AS ENUM('identity', 'contact', 'experience', 'education', 'skill', 'preference', 'authorization', 'compensation', 'availability');--> statement-breakpoint
CREATE TYPE "public"."sensitivity" AS ENUM('normal', 'sensitive');--> statement-breakpoint
CREATE TYPE "public"."transition_trigger" AS ENUM('user', 'attempt', 'classification', 'system');--> statement-breakpoint
CREATE TYPE "public"."workspace_kind" AS ENUM('personal', 'sandbox');--> statement-breakpoint
CREATE TABLE "application_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"origin" "attempt_origin" DEFAULT 'app' NOT NULL,
	"status" "attempt_status" DEFAULT 'DRAFT' NOT NULL,
	"target_fingerprint" text,
	"payload_fingerprint" text,
	"pending_receipt" jsonb,
	"confirmed_receipt" jsonb,
	"failure_reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "application_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"from_state" "application_state",
	"to_state" "application_state" NOT NULL,
	"trigger" "transition_trigger" NOT NULL,
	"actor" text DEFAULT 'owner' NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"state" "application_state" DEFAULT 'DISCOVERED' NOT NULL,
	"channel" "channel",
	"cv_variant_id" uuid,
	"notes" text,
	"next_action" text,
	"next_action_due" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidate_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"category" "fact_category" NOT NULL,
	"claim" text NOT NULL,
	"detail" text,
	"evidence_url" text,
	"sensitivity" "sensitivity" DEFAULT 'normal' NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"review_by" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"ats_hint" text
);
--> statement-breakpoint
CREATE TABLE "cv_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"label" text NOT NULL,
	"format" "cv_format" NOT NULL,
	"file_path" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"company_id" uuid,
	"source" text DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"url" text,
	"title" text NOT NULL,
	"location" text,
	"remote_mode" text,
	"description_md" text,
	"content_hash" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expired_at" timestamp with time zone,
	"keyword_score" real,
	"keyword_breakdown" jsonb,
	"status" text DEFAULT 'inbox' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "workspace_kind" DEFAULT 'personal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_attempts" ADD CONSTRAINT "application_attempts_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_facts" ADD CONSTRAINT "candidate_facts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cv_variants" ADD CONSTRAINT "cv_variants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_one_submitted_per_application" ON "application_attempts" USING btree ("application_id") WHERE "application_attempts"."status" = 'SUBMITTED';--> statement-breakpoint
CREATE INDEX "application_events_application" ON "application_events" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE INDEX "applications_workspace_state" ON "applications" USING btree ("workspace_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_workspace_source_external" ON "jobs" USING btree ("workspace_id","source","external_id");