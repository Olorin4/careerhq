CREATE TYPE "public"."ats_type" AS ENUM('greenhouse', 'lever', 'ashby');--> statement-breakpoint
CREATE TABLE "ingest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"fetched" integer DEFAULT 0 NOT NULL,
	"inserted" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"errors" jsonb
);
--> statement-breakpoint
CREATE TABLE "scoring_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"profile" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchlist_companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"company_name" text NOT NULL,
	"ats_type" "ats_type" NOT NULL,
	"board_slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "llm_score" real;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "llm_rationale" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "llm_red_flags" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "duplicate_of_job_id" uuid;--> statement-breakpoint
ALTER TABLE "ingest_runs" ADD CONSTRAINT "ingest_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_profiles" ADD CONSTRAINT "scoring_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_companies" ADD CONSTRAINT "watchlist_companies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingest_runs_workspace_started" ON "ingest_runs" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scoring_profiles_workspace" ON "scoring_profiles" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "watchlist_workspace_ats_slug" ON "watchlist_companies" USING btree ("workspace_id","ats_type","board_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_workspace_name" ON "companies" USING btree ("workspace_id","name");