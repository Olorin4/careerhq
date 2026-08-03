import { asc, eq, sql } from "drizzle-orm";
import type { ApplicationState, TransitionTrigger } from "@careerhq/contracts";
import { canTransition, computeNextAction, type TransitionContext } from "@careerhq/core";
import type { Db } from "../client.js";
import {
  applicationAttempts, applicationEvents, applications, jobs,
} from "../schema/index.js";
import type { Application, ApplicationEvent, Job } from "../index.js";
import { getOrCreateCompany } from "./companies.js";

export interface CreateApplicationInput {
  workspaceId: string; companyName: string; jobTitle: string;
  jobUrl?: string; notes?: string;
  asExternalSubmitted?: boolean; submittedAt?: Date;
}

export async function createApplication(db: Db, input: CreateApplicationInput): Promise<Application> {
  return db.transaction(async (tx) => {
    // Companies are UNIQUE(workspace_id, name) since migration 0001 and discovery
    // ingest fills that table en masse, so a bare insert here would 23505 the
    // moment the user files against a company the inbox already knows.
    const companyId = await getOrCreateCompany(tx, input.workspaceId, input.companyName);
    const [job] = await tx.insert(jobs).values({
      workspaceId: input.workspaceId, companyId,
      title: input.jobTitle, url: input.jobUrl, source: "manual", status: "promoted",
    }).returning();

    const external = input.asExternalSubmitted === true;
    const state: ApplicationState = external ? "SUBMITTED" : "DISCOVERED";
    const submittedAt = external ? (input.submittedAt ?? new Date()) : null;
    const next = computeNextAction({ state, submittedAt });

    const [app] = await tx.insert(applications).values({
      workspaceId: input.workspaceId, jobId: job!.id, state,
      channel: external ? "external" : null, notes: input.notes,
      nextAction: next?.label ?? null, nextActionDue: next?.due ?? null, submittedAt,
    }).returning();

    await tx.insert(applicationEvents).values({
      applicationId: app!.id, fromState: null, toState: state, trigger: "user",
      payload: external ? { origin: "manual", note: "logged external application" } : null,
    });
    if (external) {
      await tx.insert(applicationAttempts).values({
        applicationId: app!.id, channel: "external", origin: "manual",
        status: "SUBMITTED", submittedAt,
      });
    }
    return app!;
  });
}

export type TransitionOutcome = { ok: true; application: Application } | { ok: false; reason: string };

export async function transitionApplication(db: Db, args: {
  applicationId: string; to: ApplicationState; trigger: TransitionTrigger;
  ctx?: TransitionContext; actor?: string; followUpDays?: number;
}): Promise<TransitionOutcome> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(applications)
      .where(eq(applications.id, args.applicationId)).for("update");
    if (!current) return { ok: false, reason: "application not found" };

    const check = canTransition(current.state, args.to, args.trigger, args.ctx ?? {});
    if (!check.ok) return check;

    const submittedAt = args.to === "SUBMITTED" ? new Date() : current.submittedAt;
    const next = computeNextAction({
      state: args.to, submittedAt, lastEventAt: new Date(), followUpDays: args.followUpDays,
    });
    await tx.insert(applicationEvents).values({
      applicationId: current.id, fromState: current.state, toState: args.to,
      trigger: args.trigger, actor: args.actor ?? "owner",
    });
    const [updated] = await tx.update(applications).set({
      state: args.to, submittedAt,
      nextAction: next?.label ?? null, nextActionDue: next?.due ?? null,
      updatedAt: sql`now()`,
    }).where(eq(applications.id, current.id)).returning();
    return { ok: true, application: updated! };
  });
}

export async function listApplications(db: Db, workspaceId: string): Promise<Application[]> {
  return db.select().from(applications)
    .where(eq(applications.workspaceId, workspaceId))
    .orderBy(asc(applications.createdAt));
}

export async function getApplicationDetail(db: Db, applicationId: string) {
  const [app] = await db.select().from(applications).where(eq(applications.id, applicationId));
  if (!app) return null;
  const [job] = await db.select().from(jobs).where(eq(jobs.id, app.jobId));
  const events = await db.select().from(applicationEvents)
    .where(eq(applicationEvents.applicationId, applicationId))
    .orderBy(asc(applicationEvents.createdAt));
  return { application: app, job: job as Job, events: events as ApplicationEvent[] };
}
