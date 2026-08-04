import { sql } from "drizzle-orm";
import {
  boolean, customType, index, integer, jsonb, pgEnum, pgTable, real, text, timestamp, uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  ANSWER_ORIGINS, APPLICATION_STATES, APPROVAL_STATES, ATS_TYPES, ATTEMPT_STATUSES, CHANNELS,
  CV_FORMATS, DOCUMENT_KINDS, EMAIL_DIRECTIONS, FACT_CATEGORIES, MATCH_METHODS,
  REPLY_CLASSIFICATIONS, SENSITIVITIES, SUGGESTION_STATES, TRANSITION_TRIGGERS, WORKSPACE_KINDS,
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
export const emailDirection = pgEnum("email_direction", EMAIL_DIRECTIONS);
export const matchMethod = pgEnum("match_method", MATCH_METHODS);
export const replyClassification = pgEnum("reply_classification", REPLY_CLASSIFICATIONS);
export const suggestionState = pgEnum("suggestion_state", SUGGESTION_STATES);

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: workspaceKind("kind").notNull().default("personal"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
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
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, (t) => [index("applications_workspace_state").on(t.workspaceId, t.state)]);

export const applicationEvents = pgTable("application_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: uuid("application_id").notNull().references(() => applications.id, { onDelete: "cascade" }),
  fromState: applicationState("from_state"),
  toState: applicationState("to_state").notNull(),
  trigger: transitionTrigger("trigger").notNull(),
  actor: text("actor").notNull().default("owner"),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, (t) => [index("application_events_application").on(t.applicationId, t.createdAt)]);

export const applicationAttempts = pgTable("application_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: uuid("application_id").notNull().references(() => applications.id, { onDelete: "cascade" }),
  channel: channel("channel").notNull(),
  origin: attemptOrigin("origin").notNull().default("app"),
  status: attemptStatus("status").notNull().default("DRAFT"),
  targetFingerprint: text("target_fingerprint"),
  payloadFingerprint: text("payload_fingerprint"),
  draftPayload: jsonb("draft_payload"),
  pendingReceipt: jsonb("pending_receipt"),
  confirmedReceipt: jsonb("confirmed_receipt"),
  failureReason: text("failure_reason"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
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
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  reviewBy: timestamp("review_by", { withTimezone: true }).notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
});

export const cvVariants = pgTable("cv_variants", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  format: cvFormat("format").notNull(),
  filePath: text("file_path").notNull(),
  sha256: text("sha256").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
});

export const ingestRuns = pgTable("ingest_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
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
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, (t) => [uniqueIndex("scoring_profiles_workspace").on(t.workspaceId)]);

export const watchlistCompanies = pgTable("watchlist_companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  companyName: text("company_name").notNull(),
  atsType: atsType("ats_type").notNull(),
  boardSlug: text("board_slug").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, (t) => [
  index("application_answers_application").on(t.applicationId, t.createdAt),
  index("application_answers_reusable").on(t.reusable, t.questionNorm),
]);

export const credentials = pgTable("credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),                       // "smtp" | "imap" (free text; app-level)
  ciphertext: bytea("ciphertext").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
});

export const emailConnections = pgTable("email_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  fromAddress: text("from_address").notNull(),
  displayName: text("display_name"),
  smtp: jsonb("smtp").notNull(),                      // SmtpConfig (no password)
  imap: jsonb("imap"),                                // ImapConfig | null
  retention: jsonb("retention").notNull(),            // RetentionSetting
  smtpCredentialId: uuid("smtp_credential_id").notNull().references(() => credentials.id, { onDelete: "restrict" }),
  imapCredentialId: uuid("imap_credential_id").references(() => credentials.id, { onDelete: "restrict" }),
  health: text("health").notNull().default("untested"), // "untested" | "ok" | "error"
  healthDetail: text("health_detail"),                // redacted reason
  syncState: jsonb("sync_state"),                     // { [folder]: lastUid }
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
});

export const emailMessages = pgTable("email_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").references(() => emailConnections.id, { onDelete: "set null" }),
  direction: emailDirection("direction").notNull(),
  messageId: text("message_id").notNull(),
  inReplyTo: text("in_reply_to"),
  referencesIds: text("references_ids").array().notNull().default(sql`'{}'::text[]`),
  fromAddr: text("from_addr").notNull(),
  toAddrs: text("to_addrs").array().notNull().default(sql`'{}'::text[]`),
  subject: text("subject").notNull().default(""),
  snippet: text("snippet").notNull().default(""),
  bodyRef: text("body_ref"),
  applicationId: uuid("application_id").references(() => applications.id, { onDelete: "set null" }),
  matchMethod: matchMethod("match_method"),
  classification: replyClassification("classification"),
  classificationConfidence: real("classification_confidence"),
  quotedEvidence: text("quoted_evidence"),
  suggestedTransition: applicationState("suggested_transition"),
  suggestionState: suggestionState("suggestion_state"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, (t) => [
  uniqueIndex("email_messages_workspace_message_id").on(t.workspaceId, t.messageId),
  index("email_messages_application").on(t.applicationId, t.receivedAt),
  index("email_messages_suggestions").on(t.suggestionState, t.receivedAt),
]);

export const attemptConfirmations = pgTable("attempt_confirmations", {
  id: uuid("id").primaryKey().defaultRandom(),
  attemptId: uuid("attempt_id").notNull().references(() => applicationAttempts.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  payloadFingerprint: text("payload_fingerprint").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, (t) => [index("attempt_confirmations_attempt").on(t.attemptId, t.createdAt)]);

export const formSnapshots = pgTable("form_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  attemptId: uuid("attempt_id").notNull().references(() => applicationAttempts.id, { onDelete: "cascade" }),
  atsType: text("ats_type").notNull(),                   // greenhouse|lever|generic
  url: text("url").notNull(),
  requisitionKey: text("requisition_key").notNull(),
  parserVersion: text("parser_version").notNull(),
  canonicalForm: jsonb("canonical_form").notNull(),      // CanonicalForm
  plannedAnswers: jsonb("planned_answers").notNull(),    // PlannedAnswer[]
  currentStep: integer("current_step").notNull().default(0),
  recoveryState: jsonb("recovery_state"),                // non-secret per-step progress
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, (t) => [index("form_snapshots_attempt").on(t.attemptId, t.capturedAt)]);
