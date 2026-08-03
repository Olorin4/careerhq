import { z } from "zod";

export const APPLICATION_STATES = [
  "DISCOVERED", "SHORTLISTED", "PREPARING", "READY_FOR_REVIEW", "SUBMITTED",
  "ACKNOWLEDGED", "INTERVIEW", "OFFER", "REJECTED", "WITHDRAWN", "EXPIRED",
] as const;
export type ApplicationState = (typeof APPLICATION_STATES)[number];
export const applicationStateSchema = z.enum(APPLICATION_STATES);

export const ATTEMPT_STATUSES = [
  "DRAFT", "READY", "PENDING_CONFIRMATION", "SUBMITTING",
  "SUBMITTED", "FAILED", "BLOCKED", "NEEDS_RECONCILE",
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export const attemptStatusSchema = z.enum(ATTEMPT_STATUSES);

export const TRANSITION_TRIGGERS = ["user", "attempt", "classification", "system"] as const;
export type TransitionTrigger = (typeof TRANSITION_TRIGGERS)[number];
export const transitionTriggerSchema = z.enum(TRANSITION_TRIGGERS);

export const CHANNELS = ["email", "company_site", "external"] as const;
export type Channel = (typeof CHANNELS)[number];
export const channelSchema = z.enum(CHANNELS);

export const FACT_CATEGORIES = [
  "identity", "contact", "experience", "education", "skill",
  "preference", "authorization", "compensation", "availability",
] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];
export const factCategorySchema = z.enum(FACT_CATEGORIES);

export const SENSITIVITIES = ["normal", "sensitive"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];
export const sensitivitySchema = z.enum(SENSITIVITIES);

export const CV_FORMATS = ["designed", "ats"] as const;
export type CvFormat = (typeof CV_FORMATS)[number];
export const cvFormatSchema = z.enum(CV_FORMATS);

export const WORKSPACE_KINDS = ["personal", "sandbox"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];
export const workspaceKindSchema = z.enum(WORKSPACE_KINDS);

export const JOB_STATUSES = ["inbox", "promoted", "dismissed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const jobStatusSchema = z.enum(JOB_STATUSES);

export const REMOTE_MODES = ["remote", "hybrid", "onsite", "unknown"] as const;
export type RemoteMode = (typeof REMOTE_MODES)[number];
export const remoteModeSchema = z.enum(REMOTE_MODES);

export const ATS_TYPES = ["greenhouse", "lever", "ashby"] as const;
export type AtsType = (typeof ATS_TYPES)[number];
export const atsTypeSchema = z.enum(ATS_TYPES);

export const normalizedJobSchema = z.object({
  source: z.string().min(1),
  externalId: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  companyName: z.string().min(1),
  location: z.string().optional(),
  remoteMode: remoteModeSchema.default("unknown"),
  salaryRaw: z.string().optional(),
  descriptionMd: z.string().optional(),
  postedAt: z.coerce.date().optional(),
});
export type NormalizedJob = z.infer<typeof normalizedJobSchema>;

export const scoringProfileSchema = z.object({
  roles: z.array(z.string()).default([]),
  stack: z.array(z.string()).default([]),
  boost: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  requireRemote: z.boolean().default(true),
  includeUnknownRemote: z.boolean().default(true),
  minRoleHits: z.number().int().min(0).default(1),
  minStackHits: z.number().int().min(0).default(1),
  topNForLlm: z.number().int().positive().default(25),
});
export type ScoringProfile = z.infer<typeof scoringProfileSchema>;
export const DEFAULT_SCORING_PROFILE: ScoringProfile = scoringProfileSchema.parse({});

export const rerankResultSchema = z.object({
  results: z.array(z.object({
    jobId: z.string(),
    score: z.number().min(0).max(100),
    rationale: z.string().min(1),
    redFlags: z.array(z.string()).default([]),
  })),
});
export type RerankResult = z.infer<typeof rerankResultSchema>;

export const DOCUMENT_KINDS = ["cover_letter", "email_body"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const documentKindSchema = z.enum(DOCUMENT_KINDS);

export const APPROVAL_STATES = ["draft", "approved", "rejected"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];
export const approvalStateSchema = z.enum(APPROVAL_STATES);

export const ANSWER_ORIGINS = ["deterministic", "ai", "user"] as const;
export type AnswerOrigin = (typeof ANSWER_ORIGINS)[number];
export const answerOriginSchema = z.enum(ANSWER_ORIGINS);

export const generationResultSchema = z.object({
  answer: z.string().min(1),
  factIds: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  unsupportedClaims: z.array(z.string()).default([]),
  clarificationNeeded: z.string().optional(),
});
export type GenerationResult = z.infer<typeof generationResultSchema>;

export const AI_MODES = ["live", "record", "replay"] as const;
export type AiMode = (typeof AI_MODES)[number];

export const EMAIL_DIRECTIONS = ["inbound", "outbound"] as const;
export type EmailDirection = (typeof EMAIL_DIRECTIONS)[number];
export const emailDirectionSchema = z.enum(EMAIL_DIRECTIONS);

export const MATCH_METHODS = ["headers", "sender", "semantic", "manual"] as const;
export type MatchMethod = (typeof MATCH_METHODS)[number];
export const matchMethodSchema = z.enum(MATCH_METHODS);

export const REPLY_CLASSIFICATIONS = ["ack", "recruiter", "interview", "rejection", "offer", "unrelated"] as const;
export type ReplyClassification = (typeof REPLY_CLASSIFICATIONS)[number];
export const replyClassificationSchema = z.enum(REPLY_CLASSIFICATIONS);

export const SUGGESTION_STATES = ["pending", "accepted", "dismissed"] as const;
export type SuggestionState = (typeof SUGGESTION_STATES)[number];
export const suggestionStateSchema = z.enum(SUGGESTION_STATES);

export const RETENTION_MODES = ["metadata_only", "full_local", "days_limited"] as const;
export type RetentionMode = (typeof RETENTION_MODES)[number];
export const retentionSettingSchema = z.object({
  mode: z.enum(RETENTION_MODES).default("metadata_only"),
  days: z.number().int().positive().optional(),
}).refine((r) => r.mode !== "days_limited" || r.days != null, { message: "days required for days_limited" });
export type RetentionSetting = z.infer<typeof retentionSettingSchema>;

export const TLS_MODES = ["starttls", "implicit", "none"] as const;
export const smtpConfigSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  username: z.string().min(1),
  tls: z.enum(TLS_MODES).default("starttls"),
});
export type SmtpConfig = z.infer<typeof smtpConfigSchema>;
export const imapConfigSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  username: z.string().min(1),
  tls: z.enum(TLS_MODES).default("implicit"),
  folders: z.array(z.string().min(1)).min(1).default(["INBOX"]),
});
export type ImapConfig = z.infer<typeof imapConfigSchema>;

export const emailDraftSchema = z.object({
  to: z.string().email(),
  subject: z.string().trim().min(1),
  body: z.string().trim().min(1),
  cvVariantId: z.string().uuid().optional(),
});
export type EmailDraft = z.infer<typeof emailDraftSchema>;

export const classifyReplyResultSchema = z.object({
  classification: replyClassificationSchema,
  confidence: z.number().min(0).max(1),
  suggestedState: applicationStateSchema.optional(),
  quotedEvidence: z.string().default(""),
});
export type ClassifyReplyResult = z.infer<typeof classifyReplyResultSchema>;

export const FIELD_KINDS = ["text", "textarea", "email", "tel", "url", "select", "multiselect", "checkbox", "radio", "file", "date", "hidden"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];
export const fieldKindSchema = z.enum(FIELD_KINDS);

export const CANONICAL_FIELDS = [
  "full_name", "first_name", "last_name", "email", "phone",
  "location", "remote_preference", "relocation", "travel",
  "linkedin_url", "github_url", "portfolio_url", "website_url",
  "current_company", "current_title", "years_experience", "education",
  "work_authorization", "visa_sponsorship", "availability", "notice_period",
  "desired_salary", "demographics", "criminal_history", "legal_attestation",
  "resume_file", "cover_letter_file", "cover_letter_text", "screening_question", "unknown",
] as const;
export type CanonicalField = (typeof CANONICAL_FIELDS)[number];
export const canonicalFieldSchema = z.enum(CANONICAL_FIELDS);

export const BLOCKER_KINDS = ["captcha", "login_required", "identity_verification", "assessment", "unsupported_file_control", "legal_attestation", "parse_failure"] as const;
export type BlockerKind = (typeof BLOCKER_KINDS)[number];
export const blockerKindSchema = z.enum(BLOCKER_KINDS);

export const canonicalFormFieldSchema = z.object({
  id: z.string().min(1),                       // stable per-field id assigned by the parser (selectorHash)
  kind: fieldKindSchema,
  label: z.string().default(""),
  helpText: z.string().default(""),
  required: z.boolean().default(false),
  options: z.array(z.object({ value: z.string(), label: z.string() })).default([]),
  maxLength: z.number().int().positive().optional(),
  accept: z.string().optional(),               // file inputs
  step: z.number().int().min(0).default(0),    // multi-step forms
  canonicalField: canonicalFieldSchema.default("unknown"),
  mappingConfidence: z.number().min(0).max(1).default(0),
  sensitive: z.boolean().default(false),
});
export type CanonicalFormField = z.infer<typeof canonicalFormFieldSchema>;

export const canonicalFormSchema = z.object({
  atsType: z.enum(["greenhouse", "lever", "generic"]),
  parserVersion: z.string().min(1),
  url: z.string().url(),
  requisitionKey: z.string().min(1),            // stable id for duplicate detection
  title: z.string().default(""),
  companyName: z.string().default(""),
  totalSteps: z.number().int().min(1).default(1),
  fields: z.array(canonicalFormFieldSchema),
  blockers: z.array(z.object({ kind: blockerKindSchema, detail: z.string().default("") })).default([]),
  parseConfidence: z.number().min(0).max(1),
});
export type CanonicalForm = z.infer<typeof canonicalFormSchema>;

export const ANSWER_SOURCES = ["fact", "saved_answer", "profile", "ai", "user", "document"] as const;
export type AnswerSource = (typeof ANSWER_SOURCES)[number];
export const answerSourceSchema = z.enum(ANSWER_SOURCES);

export const plannedAnswerSchema = z.object({
  fieldId: z.string().min(1),
  value: z.string(),                            // for file fields: the cv_variant/document id
  source: answerSourceSchema,
  sourceFactIds: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  needsUser: z.boolean().default(false),        // unanswered, low-confidence, or sensitive-without-a-fact
  differsFromApproved: z.boolean().default(false),
  note: z.string().default(""),
});
export type PlannedAnswer = z.infer<typeof plannedAnswerSchema>;

export const interpretFieldResultSchema = z.object({
  canonicalField: canonicalFieldSchema,
  confidence: z.number().min(0).max(1),
});
export type InterpretFieldResult = z.infer<typeof interpretFieldResultSchema>;
