import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { loadConfig, type AppConfig } from "@careerhq/config";
import type { EmailDraft, SmtpConfig } from "@careerhq/contracts";
import { hashConfirmationToken } from "@careerhq/core/gates";
import {
  applications, beginSubmission, completeSubmission, createApplication, createCvVariant, createDb,
  createEmailAttempt, createEmailConnection, generateMasterKeyB64, getActiveConfirmation,
  getApplicationDetail, getEmailAttempt, listMessagesForApplication, transitionApplication,
  updateEmailDraft, workspaces, type Db,
} from "@careerhq/db";
import type { SmtpTransportLike } from "@careerhq/email";
import { confirmAndSend, previewSubmission, type EmailSubmissionDeps } from "./email-submission";

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

/** The SMTP password the stub transport echoes back in its failure message. */
const SMTP_PASSWORD = "smtp-secret-pw";
/** The host the sandbox gate allows; the sandbox workspace's connection uses another. */
const SANDBOX_HOST = "mailpit";

const CV_BYTES = Buffer.from("%PDF-1.4 fake cv bytes for the orchestrator test\n");
const CV_SHA256 = createHash("sha256").update(CV_BYTES).digest("hex");

let db: Db;
let masterKey: string;
let workspaceId: string;
let connectionId: string;
let cvVariantId: string;
/** A connection on the PERSONAL workspace pointed at a non-sandbox host — used to prove SANDBOX_FORCE_SAFE alone. */
let otherHostConnectionId: string;
/** A sandbox-kind workspace whose connection points somewhere other than SANDBOX_HOST. */
let sandboxWorkspaceId: string;
let sandboxConnectionId: string;
let sandboxCvVariantId: string;

function config(over: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: url ?? "postgres://u:p@localhost:5432/careerhq",
    CAREERHQ_MASTER_KEY: masterKey,
    SUBMISSIONS_LIVE_EMAIL: "true",
    SANDBOX_SMTP_ALLOWED_HOST: SANDBOX_HOST,
    ...over,
  });
}

/** What the stub transport recorded — the shape nodemailer would have been handed. */
interface SentMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  attachments: Array<{ filename: string; content: Buffer }>;
}

type Behaviour = { kind: "sent"; messageId?: string } | { kind: "failed" } | { kind: "uncertain" };

/**
 * A transport that never opens a socket. `failed` throws a plain auth error
 * (which `sendApplicationEmail` maps to a hard failure) carrying the password,
 * so the redaction of the stored reason is testable; `uncertain` throws a
 * post-DATA error, the genuinely ambiguous case.
 */
function stubTransport(behaviour: Behaviour, sent: SentMail[]): SmtpTransportLike {
  return {
    verify: async (): Promise<true> => true,
    sendMail: async (opts: object) => {
      sent.push(opts as unknown as SentMail);
      if (behaviour.kind === "failed") {
        throw new Error(`535 authentication failed for user with password ${SMTP_PASSWORD}`);
      }
      if (behaviour.kind === "uncertain") {
        throw Object.assign(new Error("connection closed after payload"), { command: "DATA" });
      }
      const to = (opts as { to: string }).to;
      return { messageId: behaviour.messageId ?? "<sent-1@careerhq.test>", accepted: [to], rejected: [] };
    },
  };
}

function deps(over: Partial<EmailSubmissionDeps> = {}): EmailSubmissionDeps {
  return { db, config: config(), makeTransport: () => stubTransport({ kind: "sent" }, []), ...over };
}

function smtp(host: string): SmtpConfig {
  return { host, port: 1025, username: "careerhq", tls: "none" };
}

beforeAll(async () => {
  if (!url) return;
  db = createDb(url);
  masterKey = await generateMasterKeyB64();

  const dir = mkdtempSync(path.join(tmpdir(), "careerhq-cv-"));
  const cvPath = path.join(dir, "alex-cv.pdf");
  writeFileSync(cvPath, CV_BYTES);

  const [ws] = await db.insert(workspaces).values({ name: `t-sub-${Date.now()}`, kind: "personal" }).returning();
  workspaceId = ws!.id;
  cvVariantId = (await createCvVariant(db, {
    workspaceId, label: "ATS CV", format: "ats", filePath: cvPath, sha256: CV_SHA256,
  })).id;
  connectionId = (await createEmailConnection(db, {
    workspaceId, label: "Mailpit", fromAddress: "alex@careerhq.test", displayName: "Alex Demo",
    smtp: smtp(SANDBOX_HOST), smtpPassword: SMTP_PASSWORD,
    retention: { mode: "metadata_only" }, masterKeyB64: masterKey,
  })).id;
  otherHostConnectionId = (await createEmailConnection(db, {
    workspaceId, label: "Real mail on a personal workspace", fromAddress: "alex@careerhq.test",
    smtp: smtp("smtp.production.example"), smtpPassword: SMTP_PASSWORD,
    retention: { mode: "metadata_only" }, masterKeyB64: masterKey,
  })).id;

  const [sandboxWs] = await db.insert(workspaces)
    .values({ name: `t-sub-sandbox-${Date.now()}`, kind: "sandbox" }).returning();
  sandboxWorkspaceId = sandboxWs!.id;
  sandboxCvVariantId = (await createCvVariant(db, {
    workspaceId: sandboxWorkspaceId, label: "ATS CV", format: "ats", filePath: cvPath, sha256: CV_SHA256,
  })).id;
  sandboxConnectionId = (await createEmailConnection(db, {
    workspaceId: sandboxWorkspaceId, label: "Real mail", fromAddress: "alex@careerhq.test",
    smtp: smtp("smtp.production.example"), smtpPassword: SMTP_PASSWORD,
    retention: { mode: "metadata_only" }, masterKeyB64: masterKey,
  })).id;
});

afterAll(async () => {
  if (!url) return;
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.delete(workspaces).where(eq(workspaces.id, sandboxWorkspaceId));
  await db.$client.end();
});

function draftFor(cvId: string | undefined): EmailDraft {
  return {
    to: "careers@acme.test",
    subject: "Application: Senior Platform Engineer",
    body: "Dear hiring team, please find my application attached.",
    ...(cvId ? { cvVariantId: cvId } : {}),
  };
}

/** An application walked to READY_FOR_REVIEW through the real guarded transitions. */
async function readyApplication(ws: string, companyName: string): Promise<string> {
  const app = await createApplication(db, { workspaceId: ws, companyName, jobTitle: "Senior Platform Engineer" });
  for (const to of ["SHORTLISTED", "PREPARING"] as const) {
    expect((await transitionApplication(db, { applicationId: app.id, to, trigger: "user" })).ok).toBe(true);
  }
  const ready = await transitionApplication(db, {
    applicationId: app.id, to: "READY_FOR_REVIEW", trigger: "user", ctx: { hasMaterials: true },
  });
  expect(ready.ok).toBe(true);
  return app.id;
}

interface Fixture { applicationId: string; attemptId: string }

async function draftedAttempt(companyName: string, over: {
  ws?: string; connection?: string; cvId?: string | undefined; hasCv?: boolean;
} = {}): Promise<Fixture> {
  const ws = over.ws ?? workspaceId;
  const applicationId = await readyApplication(ws, companyName);
  const cvId = over.hasCv === false ? undefined : (over.cvId ?? cvVariantId);
  const attempt = await createEmailAttempt(db, {
    applicationId, draft: draftFor(cvId), connectionId: over.connection ?? connectionId,
  });
  return { applicationId, attemptId: attempt.id };
}

/** Preview an attempt, asserting the preview itself succeeded, and hand back the plaintext token. */
async function preview(fixture: Fixture, ws = workspaceId, over: Partial<EmailSubmissionDeps> = {}): Promise<string> {
  const outcome = await previewSubmission(deps(over), { workspaceId: ws, attemptId: fixture.attemptId });
  expect(outcome.status).toBe("ok");
  if (outcome.status !== "ok") throw new Error("unreachable");
  return outcome.token;
}

d("email submission orchestrator", () => {
  it("previews a draft: real CV sha256 in the payload, and only the token HASH is persisted", async () => {
    const fixture = await draftedAttempt("Preview Co");
    const outcome = await previewSubmission(deps(), { workspaceId, attemptId: fixture.attemptId });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.payload).toEqual({
      applicationId: fixture.applicationId,
      connectionId,
      to: "careers@acme.test",
      subject: "Application: Senior Platform Engineer",
      body: "Dear hiring team, please find my application attached.",
      attachments: [{ filename: "ATS-CV.pdf", sha256: CV_SHA256 }],
    });
    expect(outcome.token).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(outcome.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const attempt = await getEmailAttempt(db, fixture.attemptId);
    expect(attempt?.status).toBe("PENDING_CONFIRMATION");
    expect(attempt?.payloadFingerprint).toBe(outcome.fingerprint);

    const confirmation = await getActiveConfirmation(db, fixture.attemptId);
    expect(confirmation?.tokenHash).toBe(hashConfirmationToken(outcome.token));
    // The plaintext token exists in exactly one place: the returned value.
    expect(confirmation?.tokenHash).not.toBe(outcome.token);
    expect(confirmation?.payloadFingerprint).toBe(outcome.fingerprint);
  });

  it("refuses to preview a draft with no CV attached — nothing to fingerprint the attachment from", async () => {
    const fixture = await draftedAttempt("No CV Co", { hasCv: false });
    const outcome = await previewSubmission(deps(), { workspaceId, attemptId: fixture.attemptId });
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") return;
    expect(outcome.reason).toMatch(/cv/i);
    expect((await getEmailAttempt(db, fixture.attemptId))?.status).toBe("DRAFT");
  });

  it("refuses to preview an attempt belonging to another workspace", async () => {
    const fixture = await draftedAttempt("Other Workspace Co");
    const outcome = await previewSubmission(deps(), { workspaceId: sandboxWorkspaceId, attemptId: fixture.attemptId });
    expect(outcome.status).toBe("blocked");
  });

  it("blocks a confirm whose draft was edited after the preview → fingerprint_mismatch", async () => {
    const fixture = await draftedAttempt("Tampered Co");
    const token = await preview(fixture);

    const edited: EmailDraft = { ...draftFor(cvVariantId), subject: "Application: Staff Engineer" };
    expect(await updateEmailDraft(db, fixture.attemptId, edited, connectionId)).not.toBeNull();

    const outcome = await confirmAndSend(deps(), {
      workspaceId, attemptId: fixture.attemptId, presentedToken: token, retypedTarget: "careers@acme.test",
    });
    expect(outcome).toEqual({
      status: "blocked", code: "fingerprint_mismatch", reason: expect.any(String) as unknown as string,
    });
  });

  it("blocks a confirm whose retyped target does not match → target_mismatch", async () => {
    const fixture = await draftedAttempt("Mistyped Co");
    const token = await preview(fixture);

    const outcome = await confirmAndSend(deps(), {
      workspaceId, attemptId: fixture.attemptId, presentedToken: token, retypedTarget: "careers@other.test",
    });
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") return;
    expect(outcome.code).toBe("target_mismatch");
    expect((await getEmailAttempt(db, fixture.attemptId))?.status).toBe("PENDING_CONFIRMATION");
  });

  it("blocks a confirm while the env gate is off, leaving the preview intact → gate_closed", async () => {
    const fixture = await draftedAttempt("Gated Co");
    const token = await preview(fixture);

    const outcome = await confirmAndSend(deps({ config: config({ SUBMISSIONS_LIVE_EMAIL: "false" }) }), {
      workspaceId, attemptId: fixture.attemptId, presentedToken: token, retypedTarget: "careers@acme.test",
    });
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") return;
    expect(outcome.code).toBe("gate_closed");

    // Nothing was burned: the same token still works once the gate opens.
    const attempt = await getEmailAttempt(db, fixture.attemptId);
    expect(attempt?.status).toBe("PENDING_CONFIRMATION");
    expect(attempt?.pendingReceipt).toBeNull();
    const confirmation = await getActiveConfirmation(db, fixture.attemptId);
    expect(confirmation?.consumedAt ?? null).toBeNull();

    const retried = await confirmAndSend(deps(), {
      workspaceId, attemptId: fixture.attemptId, presentedToken: token, retypedTarget: "careers@acme.test",
    });
    expect(retried.status).toBe("submitted");
  });

  it("blocks a sandbox workspace sending to a host outside the sandbox allow-list → sandbox_blocked", async () => {
    const fixture = await draftedAttempt("Sandbox Co", {
      ws: sandboxWorkspaceId, connection: sandboxConnectionId, cvId: sandboxCvVariantId,
    });
    const token = await preview(fixture, sandboxWorkspaceId);

    const outcome = await confirmAndSend(deps(), {
      workspaceId: sandboxWorkspaceId, attemptId: fixture.attemptId,
      presentedToken: token, retypedTarget: "careers@acme.test",
    });
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") return;
    expect(outcome.code).toBe("sandbox_blocked");
    expect((await getEmailAttempt(db, fixture.attemptId))?.status).toBe("PENDING_CONFIRMATION");
  });

  // Belt-and-braces (spec P6 §3): SANDBOX_FORCE_SAFE is an independent hard
  // switch, not a DEMO_MODE alias — it must sandbox-block a PERSONAL
  // workspace's live-looking send, proving the gate input's workspaceKind is
  // actually forced rather than merely read from the (personal) workspace row.
  it("forces the sandbox path for a PERSONAL workspace when SANDBOX_FORCE_SAFE is set → sandbox_blocked, nothing sent, token unburned", async () => {
    const fixture = await draftedAttempt("Force Safe Co", { connection: otherHostConnectionId });
    const token = await preview(fixture);

    const sent: SentMail[] = [];
    const outcome = await confirmAndSend(deps({
      config: config({ SANDBOX_FORCE_SAFE: "true" }),
      makeTransport: () => stubTransport({ kind: "sent" }, sent),
    }), {
      workspaceId, attemptId: fixture.attemptId, presentedToken: token, retypedTarget: "careers@acme.test",
    });

    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") return;
    expect(outcome.code).toBe("sandbox_blocked");
    expect(sent).toHaveLength(0); // the transport was never opened

    // Nothing was burned: the token still works once the flag is off (below).
    const attempt = await getEmailAttempt(db, fixture.attemptId);
    expect(attempt?.status).toBe("PENDING_CONFIRMATION");
    const confirmation = await getActiveConfirmation(db, fixture.attemptId);
    expect(confirmation?.consumedAt ?? null).toBeNull();
  });

  // Guard: the exact same PERSONAL-workspace + off-allow-list-host case must
  // NOT be sandbox-blocked with the flag off — proving the flag, not
  // something else about the fixture, is what blocked the test above.
  it("does not sandbox-block the same personal-workspace case when SANDBOX_FORCE_SAFE is false", async () => {
    const fixture = await draftedAttempt("Not Forced Co", { connection: otherHostConnectionId });
    const token = await preview(fixture);

    const outcome = await confirmAndSend(deps({ config: config({ SANDBOX_FORCE_SAFE: "false" }) }), {
      workspaceId, attemptId: fixture.attemptId, presentedToken: token, retypedTarget: "careers@acme.test",
    });

    expect(outcome.status).toBe("submitted");
  });

  it("blocks a confirm when the application has drifted out of READY_FOR_REVIEW → application_not_ready, nothing sent, token unburned", async () => {
    const fixture = await draftedAttempt("Drifted Co");
    const token = await preview(fixture);

    // Simulate the application having moved on (e.g. a human or another
    // process walked it back to PREPARING) between preview and confirm —
    // bypassing the guarded transition helper on purpose, since that's
    // exactly the drift this check exists to catch.
    await db.update(applications).set({ state: "PREPARING" }).where(eq(applications.id, fixture.applicationId));

    const sent: SentMail[] = [];
    const outcome = await confirmAndSend(
      deps({ makeTransport: () => stubTransport({ kind: "sent" }, sent) }),
      { workspaceId, attemptId: fixture.attemptId, presentedToken: token, retypedTarget: "careers@acme.test" },
    );
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") return;
    expect(outcome.code).toBe("application_not_ready");

    // Nothing was sent, and the token/attempt are exactly as they were before the attempt.
    expect(sent).toHaveLength(0);
    const attempt = await getEmailAttempt(db, fixture.attemptId);
    expect(attempt?.status).toBe("PENDING_CONFIRMATION");
    expect(attempt?.pendingReceipt).toBeNull();
    const confirmation = await getActiveConfirmation(db, fixture.attemptId);
    expect(confirmation?.consumedAt ?? null).toBeNull();
  });

  it("sends on a clean confirm: real CV bytes on the wire, receipts recorded, application SUBMITTED", async () => {
    const fixture = await draftedAttempt("Happy Co");
    const token = await preview(fixture);
    const sent: SentMail[] = [];

    const outcome = await confirmAndSend(
      deps({ makeTransport: () => stubTransport({ kind: "sent", messageId: "<happy@careerhq.test>" }, sent) }),
      { workspaceId, attemptId: fixture.attemptId, presentedToken: token, retypedTarget: " Careers@Acme.test " },
    );
    expect(outcome).toEqual({ status: "submitted", messageId: "<happy@careerhq.test>" });

    // Exactly one send, carrying the actual file bytes (not just their hash).
    expect(sent).toHaveLength(1);
    expect(sent[0]!.from).toBe("Alex Demo <alex@careerhq.test>");
    expect(sent[0]!.to).toBe("careers@acme.test");
    expect(sent[0]!.subject).toBe("Application: Senior Platform Engineer");
    expect(sent[0]!.attachments).toHaveLength(1);
    expect(sent[0]!.attachments[0]!.filename).toBe("ATS-CV.pdf");
    expect(Buffer.compare(sent[0]!.attachments[0]!.content, CV_BYTES)).toBe(0);

    const attempt = await getEmailAttempt(db, fixture.attemptId);
    expect(attempt?.status).toBe("SUBMITTED");
    expect(attempt?.submittedAt).toBeInstanceOf(Date);
    const pending = attempt?.pendingReceipt as { fingerprint: string; startedAt: string };
    expect(pending.startedAt).toEqual(expect.any(String));
    const receipt = attempt?.confirmedReceipt as {
      messageId: string; acceptedAt: string; fingerprint: string;
      attachments: Array<{ filename: string; sha256: string }>;
    };
    expect(receipt.messageId).toBe("<happy@careerhq.test>");
    expect(receipt.fingerprint).toBe(pending.fingerprint);
    expect(receipt.attachments).toEqual([{ filename: "ATS-CV.pdf", sha256: CV_SHA256 }]);
    expect(new Date(receipt.acceptedAt).getTime()).toBeLessThanOrEqual(Date.now());

    const detail = await getApplicationDetail(db, fixture.applicationId);
    expect(detail?.application.state).toBe("SUBMITTED");
    expect(detail?.events.at(-1)?.trigger).toBe("attempt");

    // The sent message is indexed for threading: the IMAP sync job matches a
    // reply's In-Reply-To against exactly this row.
    const outbound = await listMessagesForApplication(db, fixture.applicationId);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.direction).toBe("outbound");
    expect(outbound[0]!.messageId).toBe("<happy@careerhq.test>");
    expect(outbound[0]!.matchMethod).toBe("manual");
    expect(outbound[0]!.toAddrs).toEqual(["careers@acme.test"]);
    expect(outbound[0]!.subject).toBe("Application: Senior Platform Engineer");

    // The token is single-use: a second confirm on a submitted attempt is a duplicate.
    const again = await confirmAndSend(deps(), {
      workspaceId, attemptId: fixture.attemptId, presentedToken: token, retypedTarget: "careers@acme.test",
    });
    expect(again.status).toBe("blocked");
    if (again.status !== "blocked") return;
    expect(again.code).toBe("duplicate_submission");
  });

  it("records a hard send failure as FAILED with a redacted reason, and burns the token", async () => {
    const fixture = await draftedAttempt("Failing Co");
    const token = await preview(fixture);

    const outcome = await confirmAndSend(deps({ makeTransport: () => stubTransport({ kind: "failed" }, []) }), {
      workspaceId, attemptId: fixture.attemptId, presentedToken: token, retypedTarget: "careers@acme.test",
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.reason).not.toContain(SMTP_PASSWORD);
    expect(outcome.reason).toContain("[redacted]");

    const attempt = await getEmailAttempt(db, fixture.attemptId);
    expect(attempt?.status).toBe("FAILED");
    expect(attempt?.failureReason).not.toContain(SMTP_PASSWORD);
    expect(attempt?.confirmedReceipt).toBeNull();

    const detail = await getApplicationDetail(db, fixture.applicationId);
    expect(detail?.application.state).toBe("READY_FOR_REVIEW");

    // Re-presenting the consumed token is refused by the gate, not by the repo.
    const replay = await confirmAndSend(deps(), {
      workspaceId, attemptId: fixture.attemptId, presentedToken: token, retypedTarget: "careers@acme.test",
    });
    expect(replay.status).toBe("blocked");
    if (replay.status !== "blocked") return;
    expect(replay.code).toBe("token_consumed");
  });

  it("parks an ambiguous post-DATA send as NEEDS_RECONCILE rather than guessing", async () => {
    const fixture = await draftedAttempt("Ambiguous Co");
    const token = await preview(fixture);

    const outcome = await confirmAndSend(deps({ makeTransport: () => stubTransport({ kind: "uncertain" }, []) }), {
      workspaceId, attemptId: fixture.attemptId, presentedToken: token, retypedTarget: "careers@acme.test",
    });
    expect(outcome.status).toBe("needs_reconcile");

    const attempt = await getEmailAttempt(db, fixture.attemptId);
    expect(attempt?.status).toBe("NEEDS_RECONCILE");
    expect(attempt?.failureReason).not.toContain(SMTP_PASSWORD);
    // The pending receipt written before the send is what a human reconciles from.
    expect(attempt?.pendingReceipt).not.toBeNull();

    const detail = await getApplicationDetail(db, fixture.applicationId);
    expect(detail?.application.state).toBe("READY_FOR_REVIEW");
  });

  it("keeps a successful send when the receipt is refused: NEEDS_RECONCILE, never a silent loss", async () => {
    // The real race: two attempts on one application both clear the gate, and
    // the sibling lands SUBMITTED while this one is mid-send, so the
    // one-submitted-per-application index refuses completeSubmission AFTER the
    // mail is already delivered. The send must not vanish from the record.
    const sibling = await draftedAttempt("Reconcile Co");
    const racing = await createEmailAttempt(db, {
      applicationId: sibling.applicationId, draft: draftFor(cvVariantId), connectionId,
    });
    await preview(sibling);
    const racingToken = await preview({ applicationId: sibling.applicationId, attemptId: racing.id });

    // Both attempts are PENDING_CONFIRMATION when the gate runs; the sibling
    // only completes from inside the send, once this attempt is SUBMITTING.
    const siblingConfirmation = await getActiveConfirmation(db, sibling.attemptId);
    const raceTransport: SmtpTransportLike = {
      verify: async (): Promise<true> => true,
      sendMail: async (opts: object) => {
        expect(await beginSubmission(db, {
          attemptId: sibling.attemptId, confirmationId: siblingConfirmation!.id, pendingReceipt: {},
        })).toEqual({ ok: true });
        expect(await completeSubmission(db, {
          attemptId: sibling.attemptId, confirmedReceipt: { messageId: "<sibling@careerhq.test>" },
        })).toEqual({ ok: true });
        return { messageId: "<race@careerhq.test>", accepted: [(opts as { to: string }).to], rejected: [] };
      },
    };

    const outcome = await confirmAndSend(deps({ makeTransport: () => raceTransport }), {
      workspaceId, attemptId: racing.id, presentedToken: racingToken, retypedTarget: "careers@acme.test",
    });
    expect(outcome.status).toBe("needs_reconcile");
    if (outcome.status !== "needs_reconcile") return;
    expect(outcome.reason).toContain("<race@careerhq.test>");

    const attempt = await getEmailAttempt(db, racing.id);
    expect(attempt?.status).toBe("NEEDS_RECONCILE");
    expect(attempt?.failureReason).toContain("<race@careerhq.test>");
  });

  it("serializes two concurrent confirms on the SAME attempt/token: exactly one send", async () => {
    // The genuinely concurrent case: two callers both hold the same
    // still-unconsumed token and race `confirmAndSend` via Promise.all.
    // `beginSubmission` takes a row lock on the attempt/confirmation and
    // burns the token with a conditional UPDATE, so exactly one of the two
    // transactions can advance PENDING_CONFIRMATION -> SUBMITTING; the other
    // is refused before it ever reaches the transport.
    const fixture = await draftedAttempt("Concurrent Co");
    const token = await preview(fixture);
    const sent: SentMail[] = [];

    const [first, second] = await Promise.all([
      confirmAndSend(
        deps({ makeTransport: () => stubTransport({ kind: "sent" }, sent) }),
        { workspaceId, attemptId: fixture.attemptId, presentedToken: token, retypedTarget: "careers@acme.test" },
      ),
      confirmAndSend(
        deps({ makeTransport: () => stubTransport({ kind: "sent" }, sent) }),
        { workspaceId, attemptId: fixture.attemptId, presentedToken: token, retypedTarget: "careers@acme.test" },
      ),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((o) => o.status === "submitted")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status !== "submitted")).toHaveLength(1);
    // The loser never reached the transport at all.
    expect(sent).toHaveLength(1);

    const attempt = await getEmailAttempt(db, fixture.attemptId);
    expect(attempt?.status).toBe("SUBMITTED");
  });
});
