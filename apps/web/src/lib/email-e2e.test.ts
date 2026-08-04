/**
 * The full-stack proof for the email channel (spec §11 DoD): a REAL db, a
 * REAL nodemailer transport (`makeSmtpTransport`, the orchestrator's
 * default — no `makeTransport` override anywhere in this file) against the
 * compose Mailpit (`localhost:1025`, tls "none"), and REAL libsodium crypto
 * on the connection's SMTP credential (a freshly generated master key, not a
 * fixture constant). Everything `email-submission.test.ts` proves with a
 * stub transport, this file proves once with the real one, then adds the
 * negative gate paths a stub can't distinguish from a real send: the mail
 * either did or didn't land in Mailpit.
 *
 * Skips cleanly (not a failure) when either dependency is missing:
 *   - no `TEST_DATABASE_URL` → no db to run against.
 *   - Mailpit unreachable → probed once at module load via `GET /api/v1/info`
 *     with a short timeout. This has to happen before `describe.skipIf` is
 *     evaluated (it needs a plain boolean before any `it` is registered, and
 *     a `beforeAll` only gates hooks *inside* an already-built suite — it
 *     can't retroactively skip the suite itself), so the probe is a
 *     top-level `await` rather than living inside `beforeAll`. Vitest test
 *     files are ESM and support this.
 *
 * The skip path was verified by pointing `MAILPIT_HTTP_URL` at a closed port
 * (`http://localhost:19999`) — see task-14-report.md for the transcript; the
 * shared compose Mailpit was never stopped, since other work may depend on
 * it staying up.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { loadConfig, type AppConfig } from "@careerhq/config";
import type { EmailDraft, SmtpConfig } from "@careerhq/contracts";
import {
  createApplication, createCvVariant, createDb, createDocument, createEmailAttempt,
  createEmailConnection, generateMasterKeyB64, getEmailAttempt, setApplicationCvVariant,
  setDocumentApproval, transitionApplication, updateEmailDraft, workspaces, type Db,
} from "@careerhq/db";
import { confirmAndSend, previewSubmission, type EmailSubmissionDeps } from "./email-submission";

const url = process.env.TEST_DATABASE_URL;

/**
 * Overridable only so the "Mailpit down → clean skip" path can be
 * demonstrated without stopping the shared compose Mailpit (other tasks'
 * manual verification may depend on it staying up): point this at a dead
 * port instead. Not wired into `.env.example`/compose — it is a test-only
 * escape hatch, not an application config knob.
 */
const MAILPIT_HTTP = process.env.MAILPIT_HTTP_URL ?? "http://localhost:8025";
const MAILPIT_SMTP_HOST = "localhost";
const MAILPIT_SMTP_PORT = 1025;

async function probeMailpit(): Promise<boolean> {
  try {
    const res = await fetch(`${MAILPIT_HTTP}/api/v1/info`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// Resolved once, at module load — see the file-level doc comment for why
// this can't be a `beforeAll`.
const mailpitUp = url ? await probeMailpit() : false;
if (url && !mailpitUp) {
  console.warn(`[email-e2e] Mailpit not reachable at ${MAILPIT_HTTP} — skipping the Mailpit e2e suite`);
}
const d = describe.skipIf(!url || !mailpitUp);

/** A run-scoped tag folded into every subject line, so this run's Mailpit message is unambiguous to find and to delete — never touching whatever else (pre-existing or concurrent) is sitting in the shared inbox. */
const RUN_TAG = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** A syntactically valid minimal one-page PDF, built (not hand-typed) so its xref byte offsets are actually correct. */
function buildTinyPdf(): Buffer {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(body));
    body += obj;
  }
  const xrefStart = Buffer.byteLength(body);
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${off.toString().padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(body + xref + trailer);
}

const CV_BYTES = buildTinyPdf();
const CV_SHA256 = createHash("sha256").update(CV_BYTES).digest("hex");

let db: Db;
let masterKey: string;
let workspaceId: string;
let connectionId: string;
let cvVariantId: string;
/** Mailpit message IDs created by this run, deleted individually in `afterAll` — see the file-level comment on cleanup strategy. */
const mailpitMessageIds: string[] = [];

function config(over: Record<string, string> = {}): AppConfig {
  return loadConfig({
    DATABASE_URL: url ?? "postgres://u:p@localhost:5432/careerhq",
    CAREERHQ_MASTER_KEY: masterKey,
    SUBMISSIONS_LIVE_EMAIL: "true",
    ...over,
  });
}

function deps(over: Partial<EmailSubmissionDeps> = {}): EmailSubmissionDeps {
  // Deliberately no `makeTransport` override anywhere in this file: this is
  // the one suite that exercises `email-submission.ts`'s real default,
  // `makeSmtpTransport` from `@careerhq/email`, against a real SMTP server.
  return { db, config: config(), ...over };
}

function smtpConfig(): SmtpConfig {
  return { host: MAILPIT_SMTP_HOST, port: MAILPIT_SMTP_PORT, username: "careerhq-e2e", tls: "none" };
}

function draftFor(cvId: string, subjectSuffix: string): EmailDraft {
  return {
    to: "careers@acme.test",
    subject: `Application: Senior Platform Engineer [${RUN_TAG}${subjectSuffix}]`,
    body: "Dear hiring team, please find my application attached.",
    cvVariantId: cvId,
  };
}

interface Fixture { applicationId: string; attemptId: string }

/**
 * Builds one email attempt through the real, guarded pipeline: an
 * application walked to READY_FOR_REVIEW with an actually-approved
 * `generated_documents` row and a selected CV variant (the two halves of the
 * "materials exist" gate — spec §6.2), then a drafted email attempt against
 * the Mailpit connection.
 */
async function draftedAttempt(companyName: string, subjectSuffix: string): Promise<Fixture> {
  const app = await createApplication(db, {
    workspaceId, companyName, jobTitle: "Senior Platform Engineer",
  });
  const doc = await createDocument(db, {
    applicationId: app.id, kind: "email_body",
    contentMd: "Dear hiring team, please find my application attached.",
    sourceFactIds: [],
  });
  expect(await setDocumentApproval(db, workspaceId, doc.id, "approved")).not.toBeNull();
  expect(await setApplicationCvVariant(db, app.id, cvVariantId)).not.toBeNull();

  for (const to of ["SHORTLISTED", "PREPARING"] as const) {
    expect((await transitionApplication(db, { applicationId: app.id, to, trigger: "user" })).ok).toBe(true);
  }
  const ready = await transitionApplication(db, {
    applicationId: app.id, to: "READY_FOR_REVIEW", trigger: "user", ctx: { hasMaterials: true },
  });
  expect(ready.ok).toBe(true);

  const attempt = await createEmailAttempt(db, {
    applicationId: app.id, draft: draftFor(cvVariantId, subjectSuffix), connectionId,
  });
  return { applicationId: app.id, attemptId: attempt.id };
}

/** Preview an attempt, asserting the preview itself succeeded, and hand back the plaintext token. */
async function preview(fixture: Fixture): Promise<string> {
  const outcome = await previewSubmission(deps(), { workspaceId, attemptId: fixture.attemptId });
  expect(outcome.status).toBe("ok");
  if (outcome.status !== "ok") throw new Error("unreachable");
  return outcome.token;
}

interface MailpitSummary { ID: string; Subject: string; Attachments: number }
interface MailpitAttachment { FileName: string }
interface MailpitDetail { Subject: string; Attachments: MailpitAttachment[] }

/** Polls Mailpit's message list for a subject containing `needle` — the SMTP round trip is synchronous by the time `sendMail` resolves, but this absorbs any indexing lag rather than racing it. */
async function findMailpitMessage(needle: string): Promise<MailpitSummary> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await fetch(`${MAILPIT_HTTP}/api/v1/messages?limit=50`);
    const body = (await res.json()) as { messages: MailpitSummary[] };
    const found = body.messages.find((m) => m.Subject.includes(needle));
    if (found) return found;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`no Mailpit message found with subject containing "${needle}"`);
}

async function mailpitDetail(id: string): Promise<MailpitDetail> {
  const res = await fetch(`${MAILPIT_HTTP}/api/v1/message/${id}`);
  return (await res.json()) as MailpitDetail;
}

beforeAll(async () => {
  if (!url || !mailpitUp) return;
  db = createDb(url);
  masterKey = await generateMasterKeyB64();

  const dir = mkdtempSync(path.join(tmpdir(), "careerhq-e2e-cv-"));
  const cvPath = path.join(dir, "alex-cv.pdf");
  writeFileSync(cvPath, CV_BYTES);

  const [ws] = await db.insert(workspaces).values({ name: `t-e2e-${Date.now()}`, kind: "personal" }).returning();
  workspaceId = ws!.id;
  cvVariantId = (await createCvVariant(db, {
    workspaceId, label: "ATS CV", format: "ats", filePath: cvPath, sha256: CV_SHA256,
  })).id;
  connectionId = (await createEmailConnection(db, {
    workspaceId, label: "Mailpit", fromAddress: "alex@careerhq.test", displayName: "Alex Demo",
    smtp: smtpConfig(), smtpPassword: "mailpit-does-not-check-this",
    retention: { mode: "metadata_only" }, masterKeyB64: masterKey,
  })).id;
});

afterAll(async () => {
  if (!url || !mailpitUp) return;
  // Scoped deletion, not `DELETE /api/v1/messages` (which wipes every
  // message in the shared compose Mailpit, including anything unrelated
  // left by other work): `DELETE /api/v1/messages` with an `IDs` body only
  // removes the listed messages, so only what this run actually sent is
  // cleaned up.
  if (mailpitMessageIds.length > 0) {
    await fetch(`${MAILPIT_HTTP}/api/v1/messages`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ IDs: mailpitMessageIds }),
    });
  }
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.$client.end();
});

/**
 * This compose Mailpit takes ~8s to send its SMTP greeting banner after
 * accepting the TCP connection (observed directly with nodemailer's
 * protocol logger: `Connection established` then an 8s gap before `S: 220
 * ... Mailpit ESMTP Service ready`) — consistent with a reverse-DNS lookup
 * on the client address stalling until it times out. That is real Mailpit
 * behaviour in this environment, not something `email-submission.ts` or
 * this test controls, so only the two tests that actually open an SMTP
 * connection (as opposed to being blocked by a gate before one is built)
 * get a longer timeout instead of the vitest default 5s.
 */
const SMTP_ROUND_TRIP_TIMEOUT_MS = 20_000;

d("Mailpit end-to-end submission round trip", () => {
  it(
    "sends a real message through Mailpit: subject + exactly one attachment, application SUBMITTED",
    async () => {
      const fixture = await draftedAttempt("Mailpit Round Trip Co", "-roundtrip");
      const token = await preview(fixture);

      const outcome = await confirmAndSend(deps(), {
        workspaceId, attemptId: fixture.attemptId, presentedToken: token, retypedTarget: "careers@acme.test",
      });
      expect(outcome.status).toBe("submitted");
      if (outcome.status !== "submitted") return;
      expect(outcome.messageId).toEqual(expect.any(String));

      const attempt = await getEmailAttempt(db, fixture.attemptId);
      expect(attempt?.status).toBe("SUBMITTED");

      const found = await findMailpitMessage(`${RUN_TAG}-roundtrip`);
      mailpitMessageIds.push(found.ID);
      expect(found.Subject).toContain("Application: Senior Platform Engineer");
      expect(found.Attachments).toBe(1);

      const detail = await mailpitDetail(found.ID);
      expect(detail.Attachments).toHaveLength(1);
      expect(detail.Attachments[0]!.FileName).toBe("ATS-CV.pdf");
    },
    SMTP_ROUND_TRIP_TIMEOUT_MS,
  );

  it("blocks a confirm while the env gate is off → gate_closed", async () => {
    const fixture = await draftedAttempt("Gated E2E Co", "-gate");
    const token = await preview(fixture);

    const outcome = await confirmAndSend(deps({ config: config({ SUBMISSIONS_LIVE_EMAIL: "false" }) }), {
      workspaceId, attemptId: fixture.attemptId, presentedToken: token, retypedTarget: "careers@acme.test",
    });
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") return;
    expect(outcome.code).toBe("gate_closed");

    // Nothing sent, nothing burned: the attempt is exactly where it was.
    expect((await getEmailAttempt(db, fixture.attemptId))?.status).toBe("PENDING_CONFIRMATION");
  });

  it("blocks a confirm whose draft was edited after the preview → fingerprint_mismatch", async () => {
    const fixture = await draftedAttempt("Tampered E2E Co", "-tamper");
    const token = await preview(fixture);

    const edited: EmailDraft = { ...draftFor(cvVariantId, "-tamper"), subject: "Application: Staff Engineer (edited)" };
    expect(await updateEmailDraft(db, fixture.attemptId, edited, connectionId)).not.toBeNull();

    const outcome = await confirmAndSend(deps(), {
      workspaceId, attemptId: fixture.attemptId, presentedToken: token, retypedTarget: "careers@acme.test",
    });
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") return;
    expect(outcome.code).toBe("fingerprint_mismatch");
  });

  it("blocks a confirm whose retyped target does not match → target_mismatch", async () => {
    const fixture = await draftedAttempt("Mistyped E2E Co", "-mistyped");
    const token = await preview(fixture);

    const outcome = await confirmAndSend(deps(), {
      workspaceId, attemptId: fixture.attemptId, presentedToken: token, retypedTarget: "careers@wrong.test",
    });
    expect(outcome.status).toBe("blocked");
    if (outcome.status !== "blocked") return;
    expect(outcome.code).toBe("target_mismatch");
    expect((await getEmailAttempt(db, fixture.attemptId))?.status).toBe("PENDING_CONFIRMATION");
  });

  it("blocks a second confirm on an already-submitted attempt → duplicate_submission", async () => {
    const fixture = await draftedAttempt("Duplicate E2E Co", "-dup");
    const token = await preview(fixture);

    const first = await confirmAndSend(deps(), {
      workspaceId, attemptId: fixture.attemptId, presentedToken: token, retypedTarget: "careers@acme.test",
    });
    expect(first.status).toBe("submitted");

    const found = await findMailpitMessage(`${RUN_TAG}-dup`);
    mailpitMessageIds.push(found.ID);

    // The same attempt, same (already-consumed) token, presented again.
    const second = await confirmAndSend(deps(), {
      workspaceId, attemptId: fixture.attemptId, presentedToken: token, retypedTarget: "careers@acme.test",
    });
    expect(second.status).toBe("blocked");
    if (second.status !== "blocked") return;
    expect(second.code).toBe("duplicate_submission");
  }, SMTP_ROUND_TRIP_TIMEOUT_MS);
});
