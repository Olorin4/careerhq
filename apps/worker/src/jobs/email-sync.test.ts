import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { loadConfig, type AppConfig } from "@careerhq/config";
import type { ClassifyReplyResult, ImapConfig, RetentionSetting } from "@careerhq/contracts";
import {
  applicationEvents, createApplication, createDb, createEmailConnection, emailConnections,
  emailMessages, generateMasterKeyB64, getApplication, recordOutboundMessage, workspaces,
  type Db,
} from "@careerhq/db";
import type { ImapClientLike, RawFetchedMessage } from "@careerhq/email";
import { runEmailSyncOnce, type ClassifyReplyFn, type MakeImapClient } from "./email-sync.js";

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

const IMAP_PASSWORD = "imap-secret-pw";
const OWN_ADDRESS = "alex@careerhq.test";

const imap: ImapConfig = {
  host: "imap.test", port: 993, username: "alex", tls: "implicit", folders: ["INBOX"],
};

let db: Db;
let masterKey: string;
/** Every workspace the suite created, torn down in afterAll. */
const workspaceIds: string[] = [];

/**
 * A throwaway workspace per test. `runEmailSyncOnce` walks *every* connection
 * in the workspace it is given, so tests that shared one would sync each
 * other's mailboxes and make the per-run counters meaningless.
 */
async function newWorkspace(name: string): Promise<string> {
  const [ws] = await db.insert(workspaces)
    .values({ name: `t-sync-${name}-${Date.now()}`, kind: "personal" }).returning();
  workspaceIds.push(ws!.id);
  return ws!.id;
}

/** A fresh absolute FILE_STORAGE_DIR per config, so `${dir}/mail` can be counted exactly. */
function config(over: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: url ?? "postgres://u:p@localhost:5432/careerhq",
    CAREERHQ_MASTER_KEY: masterKey,
    FILE_STORAGE_DIR: mkdtempSync(path.join(tmpdir(), "careerhq-mail-")),
    OPENROUTER_API_KEY: "sk-or-test",
    ...over,
  });
}

interface MessageFields {
  messageId: string;
  from: string;
  subject: string;
  date?: Date;
  inReplyTo?: string;
  body?: string;
}

/** A minimal but genuinely parseable RFC822 message — mailparser does the rest. */
function rfc822(fields: MessageFields): Buffer {
  const lines = [
    `From: ${fields.from}`,
    `To: ${OWN_ADDRESS}`,
    `Subject: ${fields.subject}`,
    `Date: ${(fields.date ?? new Date("2026-04-01T09:00:00Z")).toUTCString()}`,
    `Message-ID: ${fields.messageId}`,
  ];
  if (fields.inReplyTo) lines.push(`In-Reply-To: ${fields.inReplyTo}`, `References: ${fields.inReplyTo}`);
  lines.push("", fields.body ?? "Thank you for your application.");
  return Buffer.from(lines.join("\r\n"), "utf8");
}

interface StubClient extends ImapClientLike {
  connects: number;
  logouts: number;
  /** Every (folder, sinceUid) pair the job asked for, in order. */
  requests: Array<{ folder: string; sinceUid: number }>;
}

/**
 * An IMAP client that never opens a socket. It honours `sinceUid` exactly as a
 * real server does, so a second run over an advanced sync state genuinely
 * fetches nothing rather than merely being asserted not to.
 */
function stubClient(messages: RawFetchedMessage[]): StubClient {
  const client: StubClient = {
    connects: 0,
    logouts: 0,
    requests: [],
    connect: async () => {
      client.connects += 1;
    },
    logout: async () => {
      client.logouts += 1;
    },
    fetchNewMessages: (folder: string, sinceUid: number) => {
      client.requests.push({ folder, sinceUid });
      const pending = messages.filter((m) => m.uid > sinceUid);
      return (async function* () {
        for (const message of pending) yield message;
      })();
    },
  };
  return client;
}

function makeClientReturning(client: ImapClientLike): MakeImapClient {
  return () => client;
}

interface Classifier {
  classify: ClassifyReplyFn;
  /** Subjects the job actually sent to the model, in call order. */
  subjects: string[];
}

/** A classify stub keyed by inbound subject; an unlisted subject fails like a bad model reply. */
function classifierFor(bySubject: Record<string, ClassifyReplyResult>): Classifier {
  const subjects: string[] = [];
  return {
    subjects,
    classify: async (msg) => {
      subjects.push(msg.subject);
      const value = bySubject[msg.subject];
      return {
        ok: value !== undefined,
        value: value ?? null,
        model: "stub-fast",
        latencyMs: 1,
        status: 200,
        error: value === undefined ? "not_useful" : null,
        attempts: [{ model: "stub-fast", error: null, status: 200 }],
      };
    },
  };
}

async function newConnection(
  workspaceId: string, label: string, retention: RetentionSetting,
): Promise<string> {
  const conn = await createEmailConnection(db, {
    workspaceId, label, fromAddress: OWN_ADDRESS,
    smtp: { host: "smtp.test", port: 587, username: "alex", tls: "starttls" }, smtpPassword: "smtp-pw",
    imap, imapPassword: IMAP_PASSWORD,
    retention, masterKeyB64: masterKey,
  });
  return conn.id;
}

/** A SUBMITTED application plus the outbound message a reply can thread onto. */
async function submittedWithOutbound(
  workspaceId: string, connectionId: string, companyName: string,
  outboundMessageId: string, jobUrl?: string,
): Promise<string> {
  const app = await createApplication(db, {
    workspaceId, companyName, jobTitle: "Backend Engineer", jobUrl, asExternalSubmitted: true,
  });
  await recordOutboundMessage(db, {
    workspaceId, connectionId, messageId: outboundMessageId,
    toAddrs: ["jobs@example.test"], subject: "Application: Backend Engineer", applicationId: app.id,
  });
  return app.id;
}

function messageBy(workspaceId: string, messageId: string) {
  return db.select().from(emailMessages)
    .where(and(eq(emailMessages.workspaceId, workspaceId), eq(emailMessages.messageId, messageId)));
}

beforeAll(async () => {
  if (!url) return;
  db = createDb(url);
  masterKey = await generateMasterKeyB64();
});

// Connections reference credentials ON DELETE RESTRICT, so they go before the
// workspace cascade (same reasoning as email-connections.test.ts).
afterAll(async () => {
  if (!url) return;
  for (const id of workspaceIds) {
    await db.delete(emailMessages).where(eq(emailMessages.workspaceId, id));
    await db.delete(emailConnections).where(eq(emailConnections.workspaceId, id));
    await db.delete(workspaces).where(eq(workspaces.id, id));
  }
  await db.$client.end();
});

d("runEmailSyncOnce", () => {
  it("links, suggests and skips across a header / sender / unmatched message matrix", async () => {
    const workspaceId = await newWorkspace("matrix");
    const connectionId = await newConnection(workspaceId, "Matrix", { mode: "metadata_only" });
    const outboundId = "<out-matrix@careerhq.test>";
    const threadedApp = await submittedWithOutbound(workspaceId, connectionId, "Matrix Threaded", outboundId);
    const senderApp = await submittedWithOutbound(
      workspaceId, connectionId, "Matrix Sender", "<out-sender@careerhq.test>",
      "https://careers.sender.test/1",
    );

    const client = stubClient([
      { uid: 11, source: rfc822({
        messageId: "<in-thread@acme.test>", from: "hiring@acme.test",
        subject: "Threaded reply", inReplyTo: outboundId,
      }) },
      { uid: 12, source: rfc822({
        messageId: "<in-sender@sender.test>", from: "talent@careers.sender.test",
        subject: "Sender-matched reply",
      }) },
      { uid: 13, source: rfc822({
        messageId: "<in-stray@stray.test>", from: "noreply@stray.test",
        subject: "Unmatched newsletter",
      }) },
    ]);
    const { classify, subjects } = classifierFor({
      "Threaded reply": {
        classification: "interview", confidence: 0.8, suggestedState: "INTERVIEW",
        quotedEvidence: "schedule a call",
      },
      "Sender-matched reply": { classification: "recruiter", confidence: 0.6, quotedEvidence: "quick chat" },
    });

    const summary = await runEmailSyncOnce(db, workspaceId, config(), {
      makeClient: makeClientReturning(client), classify,
    });

    expect(summary.connections).toBe(1);
    expect(summary.fetched).toBe(3);
    expect(summary.linked).toBe(2);
    expect(summary.classified).toBe(2);
    expect(summary.suggested).toBe(2);
    expect(summary.autoAcked).toBe(0);
    expect(client.connects).toBe(1);
    expect(client.logouts).toBe(1);

    // The unmatched message is stored, but never reaches the model.
    expect([...subjects].sort()).toEqual(["Sender-matched reply", "Threaded reply"]);

    const [threaded] = await messageBy(workspaceId, "<in-thread@acme.test>");
    expect(threaded!.applicationId).toBe(threadedApp);
    expect(threaded!.matchMethod).toBe("headers");
    expect(threaded!.direction).toBe("inbound");
    expect(threaded!.classification).toBe("interview");
    expect(threaded!.suggestedTransition).toBe("INTERVIEW");
    expect(threaded!.suggestionState).toBe("pending");
    expect(threaded!.quotedEvidence).toBe("schedule a call");
    expect(threaded!.bodyRef).toBeNull(); // metadata_only keeps no body

    const [sender] = await messageBy(workspaceId, "<in-sender@sender.test>");
    expect(sender!.applicationId).toBe(senderApp);
    expect(sender!.matchMethod).toBe("sender");
    expect(sender!.suggestionState).toBe("pending");

    const [stray] = await messageBy(workspaceId, "<in-stray@stray.test>");
    expect(stray!.applicationId).toBeNull();
    expect(stray!.matchMethod).toBeNull();
    expect(stray!.classification).toBeNull();
    expect(stray!.suggestionState).toBeNull();
  });

  it("advances the per-folder sync state and fetches nothing on a second run", async () => {
    const workspaceId = await newWorkspace("resume");
    const connectionId = await newConnection(workspaceId, "Resume", { mode: "metadata_only" });
    const client = stubClient([
      { uid: 41, source: rfc822({ messageId: "<in-resume-a@x.test>", from: "a@resume.test", subject: "A" }) },
      { uid: 57, source: rfc822({ messageId: "<in-resume-b@x.test>", from: "b@resume.test", subject: "B" }) },
    ]);
    const opts = { makeClient: makeClientReturning(client) };

    const first = await runEmailSyncOnce(db, workspaceId, config(), opts);
    expect(first.fetched).toBe(2);
    expect(client.requests[0]).toEqual({ folder: "INBOX", sinceUid: 0 });

    const [afterFirst] = await db.select().from(emailConnections).where(eq(emailConnections.id, connectionId));
    expect(afterFirst!.syncState).toEqual({ INBOX: 57 });
    expect(afterFirst!.health).toBe("ok");

    const second = await runEmailSyncOnce(db, workspaceId, config(), opts);
    expect(second.fetched).toBe(0);
    expect(client.requests.at(-1)).toEqual({ folder: "INBOX", sinceUid: 57 });
  });

  it("auto-acknowledges a high-confidence ack on a SUBMITTED application and logs the transition", async () => {
    const workspaceId = await newWorkspace("autoack");
    const connectionId = await newConnection(workspaceId, "AutoAck", { mode: "metadata_only" });
    const outboundId = "<out-ack@careerhq.test>";
    const applicationId = await submittedWithOutbound(workspaceId, connectionId, "AutoAck Co", outboundId);

    const client = stubClient([
      { uid: 5, source: rfc822({
        messageId: "<in-ack@ackco.test>", from: "noreply@ackco.test",
        subject: "We received your application", inReplyTo: outboundId,
      }) },
    ]);
    const { classify } = classifierFor({
      "We received your application": {
        classification: "ack", confidence: 0.95, suggestedState: "ACKNOWLEDGED",
        quotedEvidence: "we have received your application",
      },
    });

    const summary = await runEmailSyncOnce(db, workspaceId, config(), {
      makeClient: makeClientReturning(client), classify,
    });

    expect(summary.autoAcked).toBe(1);
    expect(summary.classified).toBe(1);
    // An auto-accepted suggestion is not left for the human to approve.
    expect(summary.suggested).toBe(0);

    expect((await getApplication(db, applicationId))!.state).toBe("ACKNOWLEDGED");

    const events = await db.select().from(applicationEvents).where(and(
      eq(applicationEvents.applicationId, applicationId),
      eq(applicationEvents.toState, "ACKNOWLEDGED"),
    ));
    expect(events).toHaveLength(1);
    expect(events[0]!.trigger).toBe("classification");
    expect(events[0]!.fromState).toBe("SUBMITTED");

    const [message] = await messageBy(workspaceId, "<in-ack@ackco.test>");
    expect(message!.suggestionState).toBe("accepted");
    expect(message!.suggestedTransition).toBe("ACKNOWLEDGED");
    expect(message!.classificationConfidence).toBeCloseTo(0.95, 5);
    expect(message!.quotedEvidence).toBe("we have received your application");
  });

  it("leaves an ack below the auto-ack threshold as a pending suggestion", async () => {
    const workspaceId = await newWorkspace("lowconf");
    const connectionId = await newConnection(workspaceId, "LowConfidence", { mode: "metadata_only" });
    const outboundId = "<out-low@careerhq.test>";
    const applicationId = await submittedWithOutbound(workspaceId, connectionId, "LowConf Co", outboundId);

    const client = stubClient([
      { uid: 7, source: rfc822({
        messageId: "<in-low@lowco.test>", from: "noreply@lowco.test",
        subject: "Possibly an ack", inReplyTo: outboundId,
      }) },
    ]);
    const { classify } = classifierFor({
      "Possibly an ack": {
        classification: "ack", confidence: 0.7, suggestedState: "ACKNOWLEDGED", quotedEvidence: "received",
      },
    });

    const summary = await runEmailSyncOnce(db, workspaceId, config(), {
      makeClient: makeClientReturning(client), classify,
    });

    expect(summary.autoAcked).toBe(0);
    expect(summary.suggested).toBe(1);
    expect((await getApplication(db, applicationId))!.state).toBe("SUBMITTED");

    const [message] = await messageBy(workspaceId, "<in-low@lowco.test>");
    expect(message!.suggestionState).toBe("pending");
  });

  it("stores messages unclassified when no API key is configured (deterministic floor)", async () => {
    const workspaceId = await newWorkspace("nokey");
    const connectionId = await newConnection(workspaceId, "NoKey", { mode: "metadata_only" });
    const outboundId = "<out-nokey@careerhq.test>";
    const applicationId = await submittedWithOutbound(workspaceId, connectionId, "NoKey Co", outboundId);

    const client = stubClient([
      { uid: 3, source: rfc822({
        messageId: "<in-nokey@nokey.test>", from: "hr@nokey.test",
        subject: "Reply without a key", inReplyTo: outboundId,
      }) },
    ]);
    const { classify, subjects } = classifierFor({});

    const summary = await runEmailSyncOnce(db, workspaceId, config({ OPENROUTER_API_KEY: "" }), {
      makeClient: makeClientReturning(client), classify,
    });

    expect(summary.fetched).toBe(1);
    expect(summary.linked).toBe(1);
    expect(summary.classified).toBe(0);
    expect(subjects).toEqual([]);

    const [message] = await messageBy(workspaceId, "<in-nokey@nokey.test>");
    expect(message!.applicationId).toBe(applicationId);
    expect(message!.classification).toBeNull();
    expect(message!.classificationConfidence).toBeNull();
  });

  it("writes one body file per new message for a full_local connection and drops duplicates' files", async () => {
    const workspaceId = await newWorkspace("fulllocal");
    await newConnection(workspaceId, "FullLocal", { mode: "full_local" });
    const cfg = config();
    const duplicateId = "<in-dup@dup.test>";
    const copy = (uid: number): RawFetchedMessage => ({
      uid,
      source: rfc822({
        messageId: duplicateId, from: "hr@dup.test", subject: "Kept", body: "The retained body text.",
      }),
    });
    // The same Message-ID arriving twice (a Cc'd copy): the row is skipped, and
    // the body file written for the duplicate must not be left behind.
    const client = stubClient([copy(21), copy(22)]);

    const summary = await runEmailSyncOnce(db, workspaceId, cfg, { makeClient: makeClientReturning(client) });
    expect(summary.fetched).toBe(2);

    const [message] = await messageBy(workspaceId, duplicateId);
    expect(message!.bodyRef).toBeTruthy();
    expect(readFileSync(message!.bodyRef!, "utf8")).toContain("The retained body text.");
    expect(readdirSync(path.join(cfg.fileStorageDir, "mail"))).toHaveLength(1);
  });

  it("purges and unlinks bodies past the retention window for a days_limited connection", async () => {
    const workspaceId = await newWorkspace("dayslimited");
    await newConnection(workspaceId, "DaysLimited", { mode: "days_limited", days: 1 });
    const cfg = config();
    const client = stubClient([
      { uid: 31, source: rfc822({
        messageId: "<in-old@old.test>", from: "hr@old.test", subject: "Old",
        date: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), body: "Long-expired body.",
      }) },
    ]);

    const summary = await runEmailSyncOnce(db, workspaceId, cfg, { makeClient: makeClientReturning(client) });

    expect(summary.purged).toBe(1);
    const [message] = await messageBy(workspaceId, "<in-old@old.test>");
    expect(message!.bodyRef).toBeNull();
    expect(readdirSync(path.join(cfg.fileStorageDir, "mail"))).toHaveLength(0);
  });

  it("persists the first folder's advanced uid even when a later folder in the same connection fails", async () => {
    const workspaceId = await newWorkspace("perfolder");
    const twoFolderImap: ImapConfig = {
      host: "imap.test", port: 993, username: "alex", tls: "implicit", folders: ["INBOX", "ARCHIVE"],
    };
    const connection = await createEmailConnection(db, {
      workspaceId, label: "PerFolder", fromAddress: OWN_ADDRESS,
      smtp: { host: "smtp.test", port: 587, username: "alex", tls: "starttls" }, smtpPassword: "smtp-pw",
      imap: twoFolderImap, imapPassword: IMAP_PASSWORD,
      retention: { mode: "metadata_only" }, masterKeyB64: masterKey,
    });
    const connectionId = connection.id;

    const client: ImapClientLike = {
      connect: async () => {},
      logout: async () => {},
      fetchNewMessages: (folder: string) => {
        if (folder === "ARCHIVE") {
          throw new Error("ARCHIVE folder is unreachable");
        }
        const messages: RawFetchedMessage[] = [
          { uid: 9, source: rfc822({ messageId: "<in-perfolder@x.test>", from: "a@perfolder.test", subject: "A" }) },
        ];
        return (async function* () {
          for (const message of messages) yield message;
        })();
      },
    };

    const summary = await runEmailSyncOnce(db, workspaceId, config(), {
      makeClient: makeClientReturning(client),
    });
    expect(summary.fetched).toBe(1);

    const [afterRun] = await db.select().from(emailConnections).where(eq(emailConnections.id, connectionId));
    // INBOX's progress must survive ARCHIVE's failure — not discarded by a
    // single post-loop write that never runs.
    expect(afterRun!.syncState).toEqual({ INBOX: 9 });
    expect(afterRun!.health).toBe("error");
  });

  it("records a redacted health error for a failing connection and keeps syncing the others", async () => {
    const workspaceId = await newWorkspace("broken");
    const brokenId = await newConnection(workspaceId, "Broken", { mode: "metadata_only" });
    const healthyId = await newConnection(workspaceId, "Healthy", { mode: "metadata_only" });

    const healthy = stubClient([
      { uid: 61, source: rfc822({ messageId: "<in-healthy@ok.test>", from: "hr@ok.test", subject: "Fine" }) },
    ]);
    let brokenSeen = false;
    // Only the first connection blows up, and its error carries the password —
    // the stored detail is the proof that redaction happened.
    const makeClient: MakeImapClient = (_cfg, password) => {
      if (!brokenSeen) {
        brokenSeen = true;
        throw new Error(`IMAP login rejected for password ${password}`);
      }
      return healthy;
    };

    const summary = await runEmailSyncOnce(db, workspaceId, config(), { makeClient });

    expect(summary.connections).toBe(2);
    expect(summary.fetched).toBe(1);

    const [broken] = await db.select().from(emailConnections).where(eq(emailConnections.id, brokenId));
    expect(broken!.health).toBe("error");
    expect(broken!.healthDetail).toContain("[redacted]");
    expect(broken!.healthDetail).not.toContain(IMAP_PASSWORD);

    const [ok] = await db.select().from(emailConnections).where(eq(emailConnections.id, healthyId));
    expect(ok!.health).toBe("ok");
  });
});

/**
 * Reply classification through the record/replay layer (ADR-0004's follow-on,
 * wired in P6 Task 8). The point is the *keyless* half: `AI_MODE=replay` opens
 * no socket, so a deployment with no `OPENROUTER_API_KEY` — which is what the
 * hosted demo is — can still classify, from a fixture, instead of storing every
 * reply unclassified.
 *
 * Recorded in one mailbox and replayed in a second, identical one: the fixture
 * key is a hash of the prompt (company, role, application state, subject,
 * body), so two mailboxes that differ only in Message-ID hit the same key. That
 * is a stronger check than writing a fixture by hand, which would only prove
 * the key this test computed matches the key this test wrote.
 */
d("runEmailSyncOnce classification via the replay layer", () => {
  /** Same company, role, subject and body in both halves — so, the same prompt. */
  const SUBJECT = "Re: Application: Backend Engineer";
  const BODY = "We would like to invite you to a first interview next Tuesday.";
  const VERDICT: ClassifyReplyResult = {
    classification: "interview",
    confidence: 0.91,
    suggestedState: "INTERVIEW",
    quotedEvidence: "invite you to a first interview",
  };

  async function syncOne(
    name: string, cfg: AppConfig, classify: ClassifyReplyFn,
  ): Promise<{ workspaceId: string; messageId: string }> {
    const workspaceId = await newWorkspace(name);
    const connectionId = await newConnection(workspaceId, name, { mode: "metadata_only" });
    const outboundId = `<out-${name}@careerhq.test>`;
    await submittedWithOutbound(workspaceId, connectionId, "Replay Health", outboundId);
    const messageId = `<in-${name}@replay.test>`;
    const client = stubClient([
      { uid: 1, source: rfc822({ messageId, from: "hiring@replay.test", subject: SUBJECT, inReplyTo: outboundId, body: BODY }) },
    ]);
    await runEmailSyncOnce(db, workspaceId, cfg, {
      makeClient: makeClientReturning(client), classify,
    });
    return { workspaceId, messageId };
  }

  it("records a live classification and replays it for a mailbox with no api key", async () => {
    // One store for both halves: the recording is what the replay reads.
    const replayDir = mkdtempSync(path.join(tmpdir(), "careerhq-classify-replay-"));

    const recorded = await syncOne(
      "record",
      config({ AI_MODE: "record", AI_REPLAY_DIR: replayDir }),
      classifierFor({ [SUBJECT]: VERDICT }).classify,
    );
    const [recordedRow] = await messageBy(recorded.workspaceId, recorded.messageId);
    expect(recordedRow?.classification).toBe("interview");

    // The demo's shape exactly: replay mode, no key at all.
    const keyless = config({ AI_MODE: "replay", AI_REPLAY_DIR: replayDir, OPENROUTER_API_KEY: "" });
    expect(keyless.openrouterApiKey).toBeNull();
    const replayed = await syncOne("replay", keyless, async () => {
      throw new Error("replay mode must never call the model");
    });

    const [replayedRow] = await messageBy(replayed.workspaceId, replayed.messageId);
    expect(replayedRow?.classification).toBe("interview");
    expect(replayedRow?.suggestedTransition).toBe("INTERVIEW");
    expect(replayedRow?.quotedEvidence).toBe(VERDICT.quotedEvidence);
  });
});
