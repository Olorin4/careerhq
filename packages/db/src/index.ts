export * from "./client.js";
export * from "./schema/index.js";
export * from "./repos/applications.js";
export * from "./repos/facts.js";
export * from "./repos/cv-variants.js";
export * from "./repos/discovery.js";
import type {
  applicationAttempts, applicationEvents, applications, candidateFacts, cvVariants, ingestRuns,
  jobs, scoringProfiles, watchlistCompanies, workspaces,
} from "./schema/index.js";
export type Application = typeof applications.$inferSelect;
export type NewApplication = typeof applications.$inferInsert;
export type ApplicationEvent = typeof applicationEvents.$inferSelect;
export type NewApplicationEvent = typeof applicationEvents.$inferInsert;
export type ApplicationAttempt = typeof applicationAttempts.$inferSelect;
export type NewApplicationAttempt = typeof applicationAttempts.$inferInsert;
export type CandidateFact = typeof candidateFacts.$inferSelect;
export type NewCandidateFact = typeof candidateFacts.$inferInsert;
export type CvVariant = typeof cvVariants.$inferSelect;
export type NewCvVariant = typeof cvVariants.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type IngestRun = typeof ingestRuns.$inferSelect;
export type NewIngestRun = typeof ingestRuns.$inferInsert;
export type ScoringProfile = typeof scoringProfiles.$inferSelect;
export type NewScoringProfile = typeof scoringProfiles.$inferInsert;
export type WatchlistCompany = typeof watchlistCompanies.$inferSelect;
export type NewWatchlistCompany = typeof watchlistCompanies.$inferInsert;
