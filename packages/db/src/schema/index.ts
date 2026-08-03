import { sql } from "drizzle-orm";
import {
  boolean, index, integer, jsonb, pgEnum, pgTable, real, text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import {
  ANSWER_ORIGINS, APPLICATION_STATES, APPROVAL_STATES, ATS_TYPES, ATTEMPT_STATUSES, CHANNELS,
  CV_FORMATS, DOCUMENT_KINDS, FACT_CATEGORIES, SENSITIVITIES, TRANSITION_TRIGGERS, WORKSPACE_KINDS,
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
export const atsType = pgEnum("ats_type", ATS_TYPES);
export const documentKind = pgEnum("document_kind", DOCUMENT_KINDS);
export const approvalState = pgEnum("approval_state", APPROVAL_STATES);
export const answerOrigin = pgEnum("answer_origin", ANSWER_ORIGINS);

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
}, (t) => [uniqueIndex("companies_workspace_name").on(t.workspaceId, t.name)]);

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
  salaryRaw: text("salary_raw"),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  contentHash: text("content_hash"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  expiredAt: timestamp("expired_at", { withTimezone: true }),
  keywordScore: real("keyword_score"),
  keywordBreakdown: jsonb("keyword_breakdown"),
  status: text("status").notNull().default("inbox"),
  llmScore: real("llm_score"),
  llmRationale: text("llm_rationale"),
  llmRedFlags: jsonb("llm_red_flags"),
  duplicateOfJobId: uuid("duplicate_of_job_id"),
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

export const ingestRuns = pgTable("ingest_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  fetched: integer("fetched").notNull().default(0),
  inserted: integer("inserted").notNull().default(0),
  updated: integer("updated").notNull().default(0),
  duplicates: integer("duplicates").notNull().default(0),
  errors: jsonb("errors"),
}, (t) => [index("ingest_runs_workspace_started").on(t.workspaceId, t.startedAt)]);

export const scoringProfiles = pgTable("scoring_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  profile: jsonb("profile").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("scoring_profiles_workspace").on(t.workspaceId)]);

export const watchlistCompanies = pgTable("watchlist_companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  companyName: text("company_name").notNull(),
  atsType: atsType("ats_type").notNull(),
  boardSlug: text("board_slug").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("watchlist_workspace_ats_slug").on(t.workspaceId, t.atsType, t.boardSlug)]);

export const generatedDocuments = pgTable("generated_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: uuid("application_id").notNull().references(() => applications.id, { onDelete: "cascade" }),
  kind: documentKind("kind").notNull(),
  contentMd: text("content_md").notNull(),
  sourceFactIds: uuid("source_fact_ids").array().notNull().default(sql`'{}'::uuid[]`),
  model: text("model"),
  origin: answerOrigin("origin").notNull().default("ai"),
  approval: approvalState("approval").notNull().default("draft"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("generated_documents_application").on(t.applicationId, t.createdAt)]);

export const applicationAnswers = pgTable("application_answers", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: uuid("application_id").notNull().references(() => applications.id, { onDelete: "cascade" }),
  questionRaw: text("question_raw").notNull(),
  questionNorm: text("question_norm").notNull(),
  answer: text("answer").notNull(),
  origin: answerOrigin("origin").notNull(),
  sourceFactIds: uuid("source_fact_ids").array().notNull().default(sql`'{}'::uuid[]`),
  confidence: real("confidence"),
  sensitivity: sensitivity("sensitivity").notNull().default("normal"),
  approval: approvalState("approval").notNull().default("draft"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  reusable: boolean("reusable").notNull().default(false),
  reviewBy: timestamp("review_by", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("application_answers_application").on(t.applicationId, t.createdAt),
  index("application_answers_reusable").on(t.reusable, t.questionNorm),
]);
