import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../client.js";
import { generateMasterKeyB64 } from "../crypto.js";
import { companies, emailConnections, emailMessages, jobs, workspaces } from "../schema/index.js";
import { createApplication, transitionApplication } from "./applications.js";
import { createEmailConnection } from "./email-connections.js";
import {
  buildOutboundIndex, buildSenderDomainIndex, listMessagesForApplication, listPendingSuggestions,
  purgeExpiredBodies, recordOutboundMessage, setClassification, setSuggestionState,
  upsertInboundMessage, type InboundMessageInput,
} from "./email-messages.js";

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

let db: Db;
let workspaceId: string;
let masterKeyB64: string;
/** metadata_only connection — the default one every test uses unless it needs retention. */
let connectionId: string;
/** days_limited (7 days) — only `purgeExpiredBodies` cares. */
let limitedConnectionId: string;

/** Counter so each inbound fixture gets a unique Message-ID unless a test wants a collision. */
let seq = 0;

function inbound(over: Partial<InboundMessageInput> = {}): InboundMessageInput {
  seq += 1;
  return {
    messageId: `<inbound-${seq}@example.test>`,
    inReplyTo: null,
    references: [],
    fromAddr: "recruiter@example.test",
    toAddrs: ["alex@careerhq.test"],
    subject: "Re: Application",
    date: new Date("2026-01-01T10:00:00Z"),
    textSnippet: "Thanks for applying.",
    ...over,
  };
}

async function submittedApplication(companyName: string, jobUrl?: string): Promise<string> {
  const app = await createApplication(db, {
    workspaceId, companyName, jobTitle: "Backend Engineer", jobUrl,
    asExternalSubmitted: true,
  });
  return app.id;
}

beforeAll(async () => {
  if (!url) return;
  db = createDb(url);
  masterKeyB64 = await generateMasterKeyB64();
  const [ws] = await db.insert(workspaces).values({ name: `t-msg-${Date.now()}`, kind: "personal" }).returning();
  workspaceId = ws!.id;

  connectionId = (await createEmailConnection(db, {
    workspaceId, label: "Primary", fromAddress: "alex@careerhq.test",
    smtp: { host: "smtp.test", port: 587, username: "u", tls: "starttls" }, smtpPassword: "pw",
    retention: { mode: "metadata_only" }, masterKeyB64,
  })).id;
  limitedConnectionId = (await createEmailConnection(db, {
    workspaceId, label: "Limited", fromAddress: "alex@careerhq.test",
    smtp: { host: "smtp.test", port: 587, username: "u", tls: "starttls" }, smtpPassword: "pw",
    retention: { mode: "days_limited", days: 7 }, masterKeyB64,
  })).id;
});

// Connections reference credentials ON DELETE RESTRICT, so they go before the
// workspace cascade (same reasoning as email-connections.test.ts).
afterAll(async () => {
  if (!url) return;
  await db.delete(emailMessages).where(eq(emailMessages.workspaceId, workspaceId));
  await db.delete(emailConnections).where(eq(emailConnections.workspaceId, workspaceId));
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.$client.end();
});

d("email messages repo", () => {
  it("records an outbound message as direction outbound with a manual match", async () => {
    const applicationId = await submittedApplication(`Outbound Co ${Date.now()}`);
    await recordOutboundMessage(db, {
      workspaceId, connectionId, messageId: "<out-1@careerhq.test>",
      toAddrs: ["jobs@outbound.test"], subject: "Application: Backend Engineer", applicationId,
    });

    const [row] = await db.select().from(emailMessages)
      .where(eq(emailMessages.messageId, "<out-1@careerhq.test>"));
    expect(row!.direction).toBe("outbound");
    expect(row!.matchMethod).toBe("manual");
    expect(row!.applicationId).toBe(applicationId);
    expect(row!.toAddrs).toEqual(["jobs@outbound.test"]);
    expect(row!.subject).toBe("Application: Backend Engineer");
    // The connection's own from-address, so a threaded reply's index has a sender.
    expect(row!.fromAddr).toBe("alex@careerhq.test");
  });

  it("skips an inbound message whose (workspace, messageId) already exists", async () => {
    const msg = inbound();
    const first = await upsertInboundMessage(db, {
      workspaceId, connectionId, msg, applicationId: null, matchMethod: null, bodyRef: null,
    });
    expect(first.inserted).toBe(true);

    const second = await upsertInboundMessage(db, {
      workspaceId, connectionId, msg, applicationId: null, matchMethod: null, bodyRef: null,
    });
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);

    const rows = await db.select().from(emailMessages).where(eq(emailMessages.messageId, msg.messageId));
    expect(rows).toHaveLength(1);
  });

  it("stores the seeded pending suggestion state for a sender-matched message", async () => {
    const applicationId = await submittedApplication(`Seeded Co ${Date.now()}`);
    const msg = inbound({ subject: "Re: your application" });
    const { id } = await upsertInboundMessage(db, {
      workspaceId, connectionId, msg, applicationId, matchMethod: "sender", bodyRef: null,
      suggestionSeed: { suggestionState: "pending" },
    });

    const [row] = await db.select().from(emailMessages).where(eq(emailMessages.id, id));
    expect(row!.suggestionState).toBe("pending");
    expect(row!.matchMethod).toBe("sender");
    expect(row!.direction).toBe("inbound");
    expect(row!.snippet).toBe(msg.textSnippet);
  });

  it("builds the outbound index from recorded outbound messages only", async () => {
    const applicationId = await submittedApplication(`Index Co ${Date.now()}`);
    await recordOutboundMessage(db, {
      workspaceId, connectionId, messageId: "<out-index@careerhq.test>",
      toAddrs: ["jobs@index.test"], subject: "Application", applicationId,
    });
    await upsertInboundMessage(db, {
      workspaceId, connectionId, msg: inbound({ messageId: "<in-index@example.test>" }),
      applicationId, matchMethod: "headers", bodyRef: null,
    });

    const index = await buildOutboundIndex(db, workspaceId);
    expect(index.get("<out-index@careerhq.test>")).toBe(applicationId);
    expect(index.has("<in-index@example.test>")).toBe(false);
  });

  it("indexes sender domains only for SUBMITTED-and-beyond applications", async () => {
    const submittedId = await submittedApplication(`Domain Sub ${Date.now()}`, "https://jobs.domainsub.test/1");
    await createApplication(db, {
      workspaceId, companyName: `Domain Disc ${Date.now()}`, jobTitle: "Backend Engineer",
      jobUrl: "https://jobs.domaindisc.test/1",
    });

    const index = await buildSenderDomainIndex(db, workspaceId);
    expect(index.get("jobs.domainsub.test")).toEqual([submittedId]);
    expect(index.has("jobs.domaindisc.test")).toBe(false);
  });

  it("prefers companies.domain over the job URL host and keeps ACKNOWLEDGED applications", async () => {
    const applicationId = await submittedApplication(`Domain Ack ${Date.now()}`, "https://boards.ats.test/ack");
    const [job] = await db.select().from(jobs).where(eq(jobs.url, "https://boards.ats.test/ack"));
    await db.update(companies).set({ domain: "ackcorp.test" }).where(eq(companies.id, job!.companyId!));
    const moved = await transitionApplication(db, { applicationId, to: "ACKNOWLEDGED", trigger: "user" });
    expect(moved.ok).toBe(true);

    const index = await buildSenderDomainIndex(db, workspaceId);
    expect(index.get("ackcorp.test")).toEqual([applicationId]);
    expect(index.has("boards.ats.test")).toBe(false);
  });

  it("maps one domain to every application that shares it", async () => {
    const stamp = Date.now();
    const first = await submittedApplication(`Shared A ${stamp}`, "https://careers.shared.test/1");
    const second = await submittedApplication(`Shared B ${stamp}`, "https://careers.shared.test/2");

    const index = await buildSenderDomainIndex(db, workspaceId);
    expect(index.get("careers.shared.test")?.sort()).toEqual([first, second].sort());
  });

  it("lists an application's messages oldest first and its pending suggestions workspace-wide", async () => {
    const applicationId = await submittedApplication(`Listing Co ${Date.now()}`);
    const older = inbound({ date: new Date("2026-02-01T09:00:00Z"), subject: "First" });
    const newer = inbound({ date: new Date("2026-02-02T09:00:00Z"), subject: "Second" });
    await upsertInboundMessage(db, {
      workspaceId, connectionId, msg: newer, applicationId, matchMethod: "headers", bodyRef: null,
      suggestionSeed: { suggestionState: "pending" },
    });
    await upsertInboundMessage(db, {
      workspaceId, connectionId, msg: older, applicationId, matchMethod: "headers", bodyRef: null,
    });

    const messages = await listMessagesForApplication(db, applicationId);
    expect(messages.map((m) => m.subject)).toEqual(["First", "Second"]);

    const pending = await listPendingSuggestions(db, workspaceId);
    expect(pending.map((m) => m.messageId)).toContain(newer.messageId);
    expect(pending.map((m) => m.messageId)).not.toContain(older.messageId);
  });

  it("writes a classification and then moves the suggestion out of the pending queue", async () => {
    const applicationId = await submittedApplication(`Classify Co ${Date.now()}`);
    const msg = inbound();
    const { id } = await upsertInboundMessage(db, {
      workspaceId, connectionId, msg, applicationId, matchMethod: "headers", bodyRef: null,
    });

    await setClassification(db, id, {
      classification: "interview", confidence: 0.82,
      suggestedTransition: "INTERVIEW", suggestionState: "pending",
      quotedEvidence: "we would like to schedule a call",
    });
    const [classified] = await db.select().from(emailMessages).where(eq(emailMessages.id, id));
    expect(classified!.classification).toBe("interview");
    expect(classified!.classificationConfidence).toBeCloseTo(0.82, 5);
    expect(classified!.suggestedTransition).toBe("INTERVIEW");
    expect(classified!.suggestionState).toBe("pending");
    expect(classified!.quotedEvidence).toBe("we would like to schedule a call");

    await setSuggestionState(db, id, "dismissed");
    const [dismissed] = await db.select().from(emailMessages).where(eq(emailMessages.id, id));
    expect(dismissed!.suggestionState).toBe("dismissed");
    const pending = await listPendingSuggestions(db, workspaceId);
    expect(pending.map((m) => m.id)).not.toContain(id);
  });

  it("purges bodies past the cutoff for days_limited connections only", async () => {
    const now = new Date("2026-03-20T00:00:00Z");
    const stale = inbound({ date: new Date("2026-03-01T00:00:00Z") }); // 19 days old
    const fresh = inbound({ date: new Date("2026-03-19T00:00:00Z") }); // 1 day old
    const otherConnection = inbound({ date: new Date("2026-03-01T00:00:00Z") });

    const staleRow = await upsertInboundMessage(db, {
      workspaceId, connectionId: limitedConnectionId, msg: stale,
      applicationId: null, matchMethod: null, bodyRef: "/tmp/mail/stale.txt",
    });
    const freshRow = await upsertInboundMessage(db, {
      workspaceId, connectionId: limitedConnectionId, msg: fresh,
      applicationId: null, matchMethod: null, bodyRef: "/tmp/mail/fresh.txt",
    });
    const keptRow = await upsertInboundMessage(db, {
      workspaceId, connectionId, msg: otherConnection,
      applicationId: null, matchMethod: null, bodyRef: "/tmp/mail/kept.txt",
    });

    const cleared = await purgeExpiredBodies(db, workspaceId, now);
    expect(cleared).toEqual(["/tmp/mail/stale.txt"]);

    const [staleAfter] = await db.select().from(emailMessages).where(eq(emailMessages.id, staleRow.id));
    const [freshAfter] = await db.select().from(emailMessages).where(eq(emailMessages.id, freshRow.id));
    const [keptAfter] = await db.select().from(emailMessages).where(eq(emailMessages.id, keptRow.id));
    expect(staleAfter!.bodyRef).toBeNull();
    expect(freshAfter!.bodyRef).toBe("/tmp/mail/fresh.txt");
    expect(keptAfter!.bodyRef).toBe("/tmp/mail/kept.txt");

    // Idempotent: a second pass has nothing left to clear.
    expect(await purgeExpiredBodies(db, workspaceId, now)).toEqual([]);
  });
});
