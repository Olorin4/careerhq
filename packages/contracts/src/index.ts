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
