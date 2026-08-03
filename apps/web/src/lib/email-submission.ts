import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppConfig } from "@careerhq/config";
import { canTransition } from "@careerhq/core";
import {
  emailDraftSchema, smtpConfigSchema, type ApplicationState, type EmailDraft, type SmtpConfig,
} from "@careerhq/contracts";
import {
  CONFIRMATION_TTL_MS, evaluateSubmissionGates, generateConfirmationToken, hashConfirmationToken,
  payloadFingerprint, type EmailSubmissionPayload, type GateCheckInput,
} from "@careerhq/core/gates";
import {
  beginSubmission, completeSubmission, cvVariants as cvVariantsTable,
  emailConnections as emailConnectionsTable, failSubmission, getApplicationDetail,
  getConnectionSecrets, getEmailAttempt, getLatestConfirmation, hasBlockingAttempt,
  markNeedsReconcile, recordOutboundMessage, recordPreview, workspaces as workspacesTable,
  type ApplicationAttempt, type Db, type EmailConnection,
} from "@careerhq/db";
import {
  makeSmtpTransport, redactError, sendApplicationEmail, type SmtpTransportLike,
} from "@careerhq/email";

/**
 * `makeSmtpTransport` widened to its structural contract: tests inject a
 * transport that never opens a socket, and the real factory (whose return type
 * also carries nodemailer's options) satisfies this signature unchanged.
 */
export type MakeTransport = (cfg: SmtpConfig, password: string) => SmtpTransportLike;

export interface EmailSubmissionDeps {
  db: Db;
  config: AppConfig;
  /** Injected in tests; defaults to the real nodemailer-backed transport. */
  makeTransport?: MakeTransport;
}

export type PreviewOutcome =
  | {
      status: "ok";
      attemptId: string;
      fingerprint: string;
      payload: EmailSubmissionPayload;
      expiresAt: string;
      /** Shown to the user once and never persisted — only its hash is stored. */
      token: string;
    }
  | { status: "blocked"; reason: string };

export type ConfirmOutcome =
  | { status: "submitted"; messageId: string }
  /** `code` is the `GateDecision` code when a gate denied, or one of the load/begin codes below. */
  | { status: "blocked"; code: string; reason: string }
  | { status: "failed"; reason: string }
  | { status: "needs_reconcile"; reason: string };

export interface PreviewArgs {
  workspaceId: string;
  attemptId: string;
}

export interface ConfirmArgs {
  workspaceId: string;
  attemptId: string;
  presentedToken: string;
  retypedTarget: string;
}

/** Statuses an email attempt may still be previewed from (mirrors the repo's editable set). */
const PREVIEWABLE = new Set(["DRAFT", "READY", "PENDING_CONFIRMATION"]);

/** What `createEmailAttempt` writes into `draft_payload`; re-validated, never trusted. */
const attemptDraftSchema = z.object({
  draft: emailDraftSchema,
  connectionId: z.string().uuid(),
});

/**
 * Everything both halves of the flow need, loaded and validated once: the
 * attempt, its draft, the connection it will go out through, and the CV bytes
 * that will actually be attached.
 */
interface LoadedSubmission {
  attempt: ApplicationAttempt;
  applicationId: string;
  /** Current state of the parent application — re-read fresh, never trusted from before the preview. */
  applicationState: ApplicationState;
  draft: EmailDraft;
  connection: EmailConnection;
  smtp: SmtpConfig;
  /** The bytes on the wire; `payload.attachments[].sha256` is this buffer's digest. */
  attachment: { filename: string; sha256: string; content: Buffer };
  payload: EmailSubmissionPayload;
  fingerprint: string;
}

type LoadResult =
  | { ok: true; value: LoadedSubmission }
  | { ok: false; code: string; reason: string };

function fail(code: string, reason: string): { ok: false; code: string; reason: string } {
  return { ok: false, code, reason };
}

/**
 * A stable, human-readable attachment name derived from the variant label.
 * It is part of the fingerprinted payload, so it must be a pure function of
 * stored data — never a timestamp or a random id.
 */
function attachmentFilename(label: string, filePath: string): string {
  const extension = path.extname(filePath) || ".pdf";
  const base = label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "");
  return `${base || "cv"}${extension}`;
}

/**
 * Loads and re-validates the whole submission from stored state. Called by
 * both `previewSubmission` and `confirmAndSend`, so the fingerprint the user
 * confirms and the fingerprint checked at send time are computed by the same
 * code from the same sources — an edit, a swapped CV file or a deleted
 * connection between the two shows up as a mismatch or a refusal, never as a
 * silent difference in what gets sent.
 */
async function loadSubmission(deps: EmailSubmissionDeps, args: PreviewArgs): Promise<LoadResult> {
  const { db } = deps;

  const attempt = await getEmailAttempt(db, args.attemptId);
  if (!attempt) return fail("attempt_not_found", "this submission attempt no longer exists");

  // Workspace scoping runs through the application, the only row that carries
  // a workspace id: an attempt id from another workspace must never resolve.
  const detail = await getApplicationDetail(db, attempt.applicationId);
  if (!detail || detail.application.workspaceId !== args.workspaceId) {
    return fail("attempt_not_found", "this submission attempt no longer exists");
  }
  if (attempt.channel !== "email") {
    return fail("draft_unavailable", `this attempt is not an email attempt (channel ${attempt.channel})`);
  }

  const parsed = attemptDraftSchema.safeParse(attempt.draftPayload);
  if (!parsed.success) {
    return fail("draft_unavailable", "this attempt has no usable email draft — edit and save it first");
  }
  const { draft, connectionId } = parsed.data;

  const [connection] = await db.select().from(emailConnectionsTable).where(and(
    eq(emailConnectionsTable.id, connectionId),
    eq(emailConnectionsTable.workspaceId, args.workspaceId),
  ));
  if (!connection) {
    return fail("connection_unavailable", "the mailbox this draft was written for is no longer connected");
  }
  const smtp = smtpConfigSchema.safeParse(connection.smtp);
  if (!smtp.success) {
    return fail("connection_unavailable", "the mailbox connection has an unusable SMTP configuration");
  }

  if (!draft.cvVariantId) {
    return fail("cv_unavailable", "choose a CV variant to attach before submitting");
  }
  const [variant] = await db.select().from(cvVariantsTable).where(and(
    eq(cvVariantsTable.id, draft.cvVariantId),
    eq(cvVariantsTable.workspaceId, args.workspaceId),
  ));
  if (!variant) return fail("cv_unavailable", "the selected CV variant no longer exists");

  let content: Buffer;
  try {
    content = await readFile(variant.filePath);
  } catch {
    return fail("cv_unavailable", `the CV file for "${variant.label}" is missing from storage`);
  }
  const sha256 = createHash("sha256").update(content).digest("hex");
  // The recorded digest is what the user reviewed the variant as. A file that
  // changed underneath it is not the CV they approved.
  if (sha256 !== variant.sha256) {
    return fail("cv_unavailable", `the CV file for "${variant.label}" no longer matches its recorded checksum`);
  }

  const attachment = { filename: attachmentFilename(variant.label, variant.filePath), sha256, content };
  const payload: EmailSubmissionPayload = {
    applicationId: attempt.applicationId,
    connectionId,
    to: draft.to,
    subject: draft.subject,
    body: draft.body,
    attachments: [{ filename: attachment.filename, sha256 }],
  };

  return {
    ok: true,
    value: {
      attempt,
      applicationId: attempt.applicationId,
      applicationState: detail.application.state,
      draft,
      connection,
      smtp: smtp.data,
      attachment,
      payload,
      fingerprint: payloadFingerprint(payload),
    },
  };
}

/**
 * Step 1 of the gated flow (spec §11): render exactly what would be sent, pin
 * its fingerprint to the attempt, and mint a single-use confirmation token.
 * The plaintext token is returned to the caller once, for the confirm dialog;
 * only its hash reaches the database.
 */
export async function previewSubmission(
  deps: EmailSubmissionDeps,
  args: PreviewArgs,
): Promise<PreviewOutcome> {
  const loaded = await loadSubmission(deps, args);
  if (!loaded.ok) return { status: "blocked", reason: loaded.reason };
  const { attempt, draft, payload, fingerprint } = loaded.value;

  if (!PREVIEWABLE.has(attempt.status)) {
    return { status: "blocked", reason: `this attempt can no longer be previewed (status ${attempt.status})` };
  }

  const token = generateConfirmationToken();
  const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS);
  const recorded = await recordPreview(deps.db, {
    attemptId: attempt.id,
    payloadFingerprint: fingerprint,
    target: draft.to,
    tokenHash: hashConfirmationToken(token),
    expiresAt,
  });
  if (!recorded.ok) return { status: "blocked", reason: recorded.reason };

  return {
    status: "ok",
    attemptId: attempt.id,
    fingerprint,
    payload,
    expiresAt: expiresAt.toISOString(),
    token,
  };
}

/**
 * Steps 2 and 3 of the gated flow (spec §11): every gate is re-evaluated
 * against freshly loaded state, and only then does exactly one send happen,
 * bracketed by a pending receipt written before it and a confirmed receipt
 * after it.
 *
 * Order is load-bearing. Everything that can fail without touching the outside
 * world — loading, the gate matrix, the application-readiness check, opening
 * the SMTP credential, building the transport — happens before
 * `beginSubmission`, so a blocked confirm leaves the attempt
 * PENDING_CONFIRMATION with its token unburned and the user can simply fix
 * the problem and confirm again.
 */
export async function confirmAndSend(
  deps: EmailSubmissionDeps,
  args: ConfirmArgs,
): Promise<ConfirmOutcome> {
  const { db, config } = deps;

  const loaded = await loadSubmission(deps, { workspaceId: args.workspaceId, attemptId: args.attemptId });
  if (!loaded.ok) return { status: "blocked", code: loaded.code, reason: loaded.reason };
  const {
    attempt, applicationId, applicationState, draft, connection, smtp, attachment, payload, fingerprint,
  } = loaded.value;

  const masterKey = config.masterKey;
  if (!masterKey) {
    return {
      status: "blocked",
      code: "email_disabled",
      reason: "CAREERHQ_MASTER_KEY is not configured — email submission is disabled",
    };
  }

  const [workspace] = await db.select().from(workspacesTable)
    .where(eq(workspacesTable.id, args.workspaceId));
  if (!workspace) {
    return { status: "blocked", code: "workspace_not_found", reason: "this workspace no longer exists" };
  }

  // The latest confirmation whatever its state — a consumed or expired row
  // must reach the matrix as itself, not as "no token at all".
  const confirmation = await getLatestConfirmation(db, attempt.id);
  const blocking = await hasBlockingAttempt(db, applicationId);

  const gateInput: GateCheckInput = {
    envGateOpen: config.submissionsLiveEmail,
    workspaceKind: workspace.kind,
    // Only consulted for sandbox workspaces; a sandbox may reach exactly one host.
    sandboxTargetAllowed: smtp.host === config.sandboxSmtpAllowedHost,
    tokenRecord: confirmation
      ? {
          tokenHash: confirmation.tokenHash,
          payloadFingerprint: confirmation.payloadFingerprint,
          expiresAt: confirmation.expiresAt,
          consumedAt: confirmation.consumedAt,
        }
      : null,
    presentedToken: args.presentedToken,
    now: new Date(),
    currentFingerprint: fingerprint,
    retypedTarget: args.retypedTarget,
    expectedTarget: draft.to,
    hasConfirmedAttempt: blocking.confirmed,
    attemptInFlight: blocking.inFlight,
  };

  const decision = evaluateSubmissionGates(gateInput);
  if (!decision.allowed) {
    return { status: "blocked", code: decision.code, reason: decision.reason };
  }
  // `allowed` implies a token record; this narrows it for the redemption below.
  if (!confirmation) {
    return { status: "blocked", code: "token_missing", reason: "no active confirmation token exists" };
  }

  // The application must still be exactly one guarded step from SUBMITTED.
  // Without this, an application that drifted elsewhere (e.g. still
  // PREPARING) could clear every gate above, really send, and only then have
  // completeSubmission's own transition refuse — parking a genuinely sent
  // email as NEEDS_RECONCILE for a problem the human can't resolve until they
  // separately walk the application forward. Checked after the gate matrix
  // (so an already-SUBMITTED application still reports duplicate_submission,
  // not this) but before anything that burns the token or touches the
  // network, so the fix (advance the application) and the retry both just work.
  const readiness = canTransition(applicationState, "SUBMITTED", "attempt", { hasConfirmedAttempt: true });
  if (!readiness.ok) {
    return { status: "blocked", code: "application_not_ready", reason: readiness.reason };
  }

  // Opening the credential and building the transport are the last things that
  // can fail harmlessly: both happen before the attempt leaves PENDING_CONFIRMATION.
  let smtpPassword: string;
  try {
    ({ smtpPassword } = await getConnectionSecrets(db, connection.id, masterKey));
  } catch (err) {
    return {
      status: "blocked",
      code: "connection_unavailable",
      reason: `the mailbox credentials could not be opened: ${redactError(err, [masterKey])}`,
    };
  }
  const secrets = [smtpPassword, masterKey];
  let transport: SmtpTransportLike;
  try {
    transport = (deps.makeTransport ?? makeSmtpTransport)(smtp, smtpPassword);
  } catch (err) {
    return {
      status: "blocked",
      code: "connection_unavailable",
      reason: `the mail transport could not be built: ${redactError(err, secrets)}`,
    };
  }

  // The write that happens BEFORE the mutation: token burned, attempt
  // SUBMITTING, pending receipt recording exactly what is about to go out. If
  // the process dies past this line the attempt is left SUBMITTING with the
  // evidence a human needs.
  const begun = await beginSubmission(db, {
    attemptId: attempt.id,
    confirmationId: confirmation.id,
    pendingReceipt: { channel: "email", payload, fingerprint, startedAt: new Date().toISOString() },
  });
  if (!begun.ok) return { status: "blocked", code: "begin_refused", reason: begun.reason };

  const from = connection.displayName
    ? `${connection.displayName} <${connection.fromAddress}>`
    : connection.fromAddress;

  let outcome: Awaited<ReturnType<typeof sendApplicationEmail>>;
  try {
    outcome = await sendApplicationEmail(transport, {
      from,
      to: draft.to,
      subject: draft.subject,
      text: draft.body,
      attachments: [{ filename: attachment.filename, content: attachment.content }],
      messageIdDomain: connection.fromAddress.split("@")[1] ?? "",
    }, secrets);
  } catch (err) {
    // sendApplicationEmail maps its own SMTP errors; anything escaping it is
    // unclassified, and the attempt has already begun — assume the worst
    // (the mail may be out) and park it for a human rather than guessing.
    const reason = `the send failed in an unexpected way: ${redactError(err, secrets)}`;
    await markNeedsReconcile(db, attempt.id, reason);
    return { status: "needs_reconcile", reason };
  }

  if (outcome.status === "failed") {
    await failSubmission(db, attempt.id, outcome.reason);
    return { status: "failed", reason: outcome.reason };
  }
  if (outcome.status === "uncertain") {
    await markNeedsReconcile(db, attempt.id, outcome.reason);
    return { status: "needs_reconcile", reason: outcome.reason };
  }

  const confirmedReceipt = {
    channel: "email",
    messageId: outcome.messageId,
    acceptedAt: new Date().toISOString(),
    fingerprint,
    to: draft.to,
    subject: draft.subject,
    attachments: payload.attachments,
  };
  const completed = await completeSubmission(db, {
    attemptId: attempt.id,
    confirmedReceipt,
  });
  if (!completed.ok) {
    // The mail IS out. A refused receipt (the one-submitted-per-application
    // index, a rejected application transition) must never be reported as a
    // failure — that would lose a real send. Park it with the message id.
    const reason = `sent as ${outcome.messageId} but the receipt was refused: ${completed.reason}`;
    await markNeedsReconcile(db, attempt.id, reason);
    return { status: "needs_reconcile", reason };
  }

  // Index the sent message so the IMAP sync job can thread a reply's
  // In-Reply-To/References back onto this application. Deliberately outside the
  // receipt transaction and non-fatal: the mail is out and the receipt is
  // written, so a failure here costs header-based threading (the sender-domain
  // fallback still applies), and reporting it as a failed submission would be a
  // far worse lie. It is logged rather than swallowed.
  try {
    await recordOutboundMessage(db, {
      workspaceId: args.workspaceId,
      connectionId: connection.id,
      messageId: outcome.messageId,
      toAddrs: [draft.to],
      subject: draft.subject,
      applicationId,
    });
  } catch (err) {
    console.error(
      `[email-submission] sent ${outcome.messageId} but could not index it for threading: `
      + redactError(err, secrets),
    );
  }

  return { status: "submitted", messageId: outcome.messageId };
}
