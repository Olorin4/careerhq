CREATE TYPE "public"."email_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."match_method" AS ENUM('headers', 'sender', 'semantic', 'manual');--> statement-breakpoint
CREATE TYPE "public"."reply_classification" AS ENUM('ack', 'recruiter', 'interview', 'rejection', 'offer', 'unrelated');--> statement-breakpoint
CREATE TYPE "public"."suggestion_state" AS ENUM('pending', 'accepted', 'dismissed');--> statement-breakpoint
CREATE TABLE "attempt_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"payload_fingerprint" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"label" text NOT NULL,
	"from_address" text NOT NULL,
	"display_name" text,
	"smtp" jsonb NOT NULL,
	"imap" jsonb,
	"retention" jsonb NOT NULL,
	"smtp_credential_id" uuid NOT NULL,
	"imap_credential_id" uuid,
	"health" text DEFAULT 'untested' NOT NULL,
	"health_detail" text,
	"sync_state" jsonb,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid,
	"direction" "email_direction" NOT NULL,
	"message_id" text NOT NULL,
	"in_reply_to" text,
	"references_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"from_addr" text NOT NULL,
	"to_addrs" text[] DEFAULT '{}'::text[] NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"snippet" text DEFAULT '' NOT NULL,
	"body_ref" text,
	"application_id" uuid,
	"match_method" "match_method",
	"classification" "reply_classification",
	"classification_confidence" real,
	"suggested_transition" "application_state",
	"suggestion_state" "suggestion_state",
	"received_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_attempts" ADD COLUMN "draft_payload" jsonb;--> statement-breakpoint
ALTER TABLE "attempt_confirmations" ADD CONSTRAINT "attempt_confirmations_attempt_id_application_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."application_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_connections" ADD CONSTRAINT "email_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_connections" ADD CONSTRAINT "email_connections_smtp_credential_id_credentials_id_fk" FOREIGN KEY ("smtp_credential_id") REFERENCES "public"."credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_connections" ADD CONSTRAINT "email_connections_imap_credential_id_credentials_id_fk" FOREIGN KEY ("imap_credential_id") REFERENCES "public"."credentials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_connection_id_email_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."email_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attempt_confirmations_attempt" ON "attempt_confirmations" USING btree ("attempt_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_messages_workspace_message_id" ON "email_messages" USING btree ("workspace_id","message_id");--> statement-breakpoint
CREATE INDEX "email_messages_application" ON "email_messages" USING btree ("application_id","received_at");--> statement-breakpoint
CREATE INDEX "email_messages_suggestions" ON "email_messages" USING btree ("suggestion_state","received_at");