import { sql } from "drizzle-orm";
import {
  index, jsonb, pgEnum, pgTable, real, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import {
  APPLICATION_STATES, ATTEMPT_STATUSES, CHANNELS, CV_FORMATS,
  FACT_CATEGORIES, SENSITIVITIES, TRANSITION_TRIGGERS, WORKSPACE_KINDS,
} from "@careerhq/contracts";

export const workspaceKind = pgEnum("workspace_kind", WORKSPACE_KINDS);
export const applicationState = pgEnum("application_state", APPLICATION_STATES);
export const attemptStatus = pgEnum("attempt_status", ATTEMPT_STATUSES);
export const transitionTrigger = pgEnum("transition_trigger", TRANSITION_TRIGGERS);
export const channel = pgEnum("channel", CHANNELS);
export const factCategory = pgEnum("fact_category", FACT_CATEGORIES);
export const sensitivity = pgEnum("sensitivity", SENSITIVITIES);
export const cvFormat = pgEnum("cv_format", CV_FORMATS);
export const attemptOrigin = pgEnum("attempt_origin", ["app", "manual"]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: workspaceKind("kind").notNull().default("personal"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  domain: text("domain"),
  atsHint: text("ats_hint"),
});

export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
  source: text("source").notNull().default("manual"),
  externalId: text("external_id"),
  url: text("url"),
  title: text("title").notNull(),
  location: text("location"),
  remoteMode: text("remote_mode"),
  descriptionMd: text("description_md"),
  contentHash: text("content_hash"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  expiredAt: timestamp("expired_at", { withTimezone: true }),
  keywordScore: real("keyword_score"),
  keywordBreakdown: jsonb("keyword_breakdown"),
  status: text("status").notNull().default("inbox"),
}, (t) => [
  uniqueIndex("jobs_workspace_source_external").on(t.workspaceId, t.source, t.externalId),
]);

export const applications = pgTable("applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull().references(() => jobs.id, { onDelete: "restrict" }),
  state: applicationState("state").notNull().default("DISCOVERED"),
  channel: channel("channel"),
  cvVariantId: uuid("cv_variant_id"),
  notes: text("notes"),
  nextAction: text("next_action"),
  nextActionDue: timestamp("next_action_due", { withTimezone: true }),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("applications_workspace_state").on(t.workspaceId, t.state)]);

export const applicationEvents = pgTable("application_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: uuid("application_id").notNull().references(() => applications.id, { onDelete: "cascade" }),
  fromState: applicationState("from_state"),
  toState: applicationState("to_state").notNull(),
  trigger: transitionTrigger("trigger").notNull(),
  actor: text("actor").notNull().default("owner"),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("application_events_application").on(t.applicationId, t.createdAt)]);

export const applicationAttempts = pgTable("application_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: uuid("application_id").notNull().references(() => applications.id, { onDelete: "cascade" }),
  channel: channel("channel").notNull(),
  origin: attemptOrigin("origin").notNull().default("app"),
  status: attemptStatus("status").notNull().default("DRAFT"),
  targetFingerprint: text("target_fingerprint"),
  payloadFingerprint: text("payload_fingerprint"),
  pendingReceipt: jsonb("pending_receipt"),
  confirmedReceipt: jsonb("confirmed_receipt"),
  failureReason: text("failure_reason"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("attempts_one_submitted_per_application")
    .on(t.applicationId)
    .where(sql`${t.status} = 'SUBMITTED'`),
]);

export const candidateFacts = pgTable("candidate_facts", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  category: factCategory("category").notNull(),
  claim: text("claim").notNull(),
  detail: text("detail"),
  evidenceUrl: text("evidence_url"),
  sensitivity: sensitivity("sensitivity").notNull().default("normal"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  reviewBy: timestamp("review_by", { withTimezone: true }).notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cvVariants = pgTable("cv_variants", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  format: cvFormat("format").notNull(),
  filePath: text("file_path").notNull(),
  sha256: text("sha256").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
