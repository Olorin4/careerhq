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
