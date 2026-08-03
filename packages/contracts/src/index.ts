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
