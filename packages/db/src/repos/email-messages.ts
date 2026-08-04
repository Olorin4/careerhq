import { and, asc, desc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import {
  retentionSettingSchema,
  type ApplicationState, type MatchMethod, type ReplyClassification, type SuggestionState,
} from "@careerhq/contracts";
import type { Db, DbOrTx } from "../client.js";
import {
  applications, companies, emailConnections, emailMessages, jobs,
} from "../schema/index.js";
import type { EmailMessage } from "../index.js";

/**
 * The inbound-message shape this repo persists. Structurally identical to
 * `NormalizedInboundEmail` from `@careerhq/email`, restated here so `db` needs
 * no dependency on the mail adapters (imapflow/mailparser) for a type alone.
 * The worker imports both and hands one straight to the other, so any drift
 * between the two shows up as a typecheck failure there.
 */
export interface InboundMessageInput {
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  fromAddr: string;
  toAddrs: string[];
  subject: string;
  date: Date;
  textSnippet: string;
}

/** The application states an outbound thread can still receive replies for. */
const SUBMITTED_OR_BEYOND: readonly ApplicationState[] = [
  "SUBMITTED", "ACKNOWLEDGED", "INTERVIEW", "OFFER",
];

export interface RecordOutboundMessageInput {
  workspaceId: string;
  connectionId: string;
  /** The Message-ID the SMTP server accepted — the key inbound replies thread onto. */
  messageId: string;
  toAddrs: string[];
  subject: string;
  applicationId: string;
  /**
   * When the message left. Defaults to now, which is right for every real send
   * — the caller runs moments after SMTP accepted it. Only backdated by the
   * demo seed, which builds a thread whose reply must sort after the message it
   * replies to (`listMessagesForApplication` orders by `received_at`).
   */
  sentAt?: Date;
}

/**
 * Indexes a sent application email so a later reply can be threaded onto it.
 * The match is "manual" because nothing was inferred: this row *is* the
 * application's own outgoing message.
 *
 * Idempotent on (workspace, messageId): the caller runs right after a send it
 * has already recorded a receipt for, and a retry there must never 23505.
 */
export async function recordOutboundMessage(db: DbOrTx, input: RecordOutboundMessageInput): Promise<void> {
  const [connection] = await db.select({ fromAddress: emailConnections.fromAddress })
    .from(emailConnections).where(eq(emailConnections.id, input.connectionId));

  await db.insert(emailMessages).values({
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    direction: "outbound",
    messageId: input.messageId,
    fromAddr: connection?.fromAddress ?? "",
    toAddrs: input.toAddrs,
    subject: input.subject,
    applicationId: input.applicationId,
    matchMethod: "manual",
    receivedAt: input.sentAt ?? new Date(),
  }).onConflictDoNothing({ target: [emailMessages.workspaceId, emailMessages.messageId] });
}

export interface UpsertInboundMessageInput {
  workspaceId: string;
  connectionId: string;
  msg: InboundMessageInput;
  applicationId: string | null;
  matchMethod: MatchMethod | null;
  /** Path of the stored body file, or null when retention keeps metadata only. */
  bodyRef: string | null;
  /** Set when the match alone already warrants a human decision (sender-domain matches). */
  suggestionSeed?: { suggestionState: "pending" };
}

/**
 * Stores an inbound message, keyed by `email_messages_workspace_message_id`.
 * A message already seen — the same mail fetched twice, or delivered to two
 * synced folders — is left exactly as it is and reported with
 * `inserted: false`, so the caller can skip the classification (and the body
 * file) it would otherwise pay for again.
 */
export async function upsertInboundMessage(
  db: DbOrTx,
  input: UpsertInboundMessageInput,
): Promise<{ inserted: boolean; id: string }> {
  const { msg } = input;
  const [inserted] = await db.insert(emailMessages).values({
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    direction: "inbound",
    messageId: msg.messageId,
    inReplyTo: msg.inReplyTo,
    referencesIds: msg.references,
    fromAddr: msg.fromAddr,
    toAddrs: msg.toAddrs,
    subject: msg.subject,
    snippet: msg.textSnippet,
    bodyRef: input.bodyRef,
    applicationId: input.applicationId,
    matchMethod: input.matchMethod,
    suggestionState: input.suggestionSeed?.suggestionState ?? null,
    receivedAt: msg.date,
  }).onConflictDoNothing({ target: [emailMessages.workspaceId, emailMessages.messageId] })
    .returning({ id: emailMessages.id });

  if (inserted) return { inserted: true, id: inserted.id };

  const [existing] = await db.select({ id: emailMessages.id }).from(emailMessages).where(and(
    eq(emailMessages.workspaceId, input.workspaceId),
    eq(emailMessages.messageId, msg.messageId),
  ));
  return { inserted: false, id: existing!.id };
}

/** Message-ID → application id for everything this workspace has sent out. */
export async function buildOutboundIndex(db: Db, workspaceId: string): Promise<Map<string, string>> {
  const rows = await db.select({
    messageId: emailMessages.messageId, applicationId: emailMessages.applicationId,
  }).from(emailMessages).where(and(
    eq(emailMessages.workspaceId, workspaceId),
    eq(emailMessages.direction, "outbound"),
    isNotNull(emailMessages.applicationId),
  ));

  const index = new Map<string, string>();
  for (const row of rows) {
    if (row.applicationId !== null) index.set(row.messageId, row.applicationId);
  }
  return index;
}

/**
 * Lowercased host of a job posting URL, or null when there isn't a usable one.
 * A leading `www.` is dropped: mail from `careers@acme.test` should still reach
 * an application whose posting lives at `https://www.acme.test/jobs/1`.
 */
function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host || null;
  } catch {
    return null;
  }
}

/**
 * Sender domain → the applications a mail from that domain could belong to,
 * for the threading matcher's last resort. Only applications that have actually
 * been sent (SUBMITTED and beyond) are indexed: a DISCOVERED job the user never
 * applied to has no thread for a reply to belong to, and indexing it would only
 * make real domains ambiguous — which the matcher answers by not guessing.
 *
 * The domain is the company's recorded one when there is one, and the posting
 * URL's host otherwise.
 */
export async function buildSenderDomainIndex(db: Db, workspaceId: string): Promise<Map<string, string[]>> {
  const rows = await db.select({
    applicationId: applications.id, domain: companies.domain, jobUrl: jobs.url,
  }).from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .leftJoin(companies, eq(companies.id, jobs.companyId))
    .where(and(
      eq(applications.workspaceId, workspaceId),
      inArray(applications.state, [...SUBMITTED_OR_BEYOND]),
    ));

  const index = new Map<string, string[]>();
  for (const row of rows) {
    const domain = row.domain?.trim().toLowerCase() || hostOf(row.jobUrl);
    if (!domain) continue;
    const existing = index.get(domain);
    if (existing) {
      if (!existing.includes(row.applicationId)) existing.push(row.applicationId);
    } else {
      index.set(domain, [row.applicationId]);
    }
  }
  return index;
}

/** An application's whole mail thread, oldest first — both directions. */
export async function listMessagesForApplication(db: Db, applicationId: string): Promise<EmailMessage[]> {
  return db.select().from(emailMessages)
    .where(eq(emailMessages.applicationId, applicationId))
    .orderBy(asc(emailMessages.receivedAt));
}

/** The suggestion queue: everything still awaiting a human accept/dismiss, newest first. */
export async function listPendingSuggestions(db: Db, workspaceId: string): Promise<EmailMessage[]> {
  return db.select().from(emailMessages)
    .where(and(
      eq(emailMessages.workspaceId, workspaceId),
      eq(emailMessages.suggestionState, "pending"),
    ))
    .orderBy(desc(emailMessages.receivedAt));
}

export interface SetClassificationInput {
  classification: ReplyClassification;
  confidence: number;
  suggestedTransition: ApplicationState | null;
  /** null when the classification implies nothing a human needs to act on. */
  suggestionState: SuggestionState | null;
  /** The verbatim phrase the model quoted as justification; omitted or null when there is none. */
  quotedEvidence?: string | null;
}

/** Records a model verdict against a stored message. `id` is the `email_messages` row id. */
export async function setClassification(
  db: DbOrTx,
  id: string,
  input: SetClassificationInput,
): Promise<void> {
  await db.update(emailMessages).set({
    classification: input.classification,
    classificationConfidence: input.confidence,
    suggestedTransition: input.suggestedTransition,
    suggestionState: input.suggestionState,
    quotedEvidence: input.quotedEvidence ?? null,
  }).where(eq(emailMessages.id, id));
}

/** Moves a suggestion out of (or into) the pending queue. `id` is the `email_messages` row id. */
export async function setSuggestionState(db: Db, id: string, state: SuggestionState): Promise<void> {
  await db.update(emailMessages).set({ suggestionState: state }).where(eq(emailMessages.id, id));
}

/**
 * Enforces `days_limited` retention: for every connection configured that way,
 * clears `body_ref` on messages older than its window and returns the paths it
 * cleared, so the caller can unlink the files themselves.
 *
 * The database is updated first and the files deleted after: a crash in between
 * leaves an orphaned file on disk (harmless, and re-purged by nothing), whereas
 * the reverse order would leave a row pointing at a body that no longer exists.
 * Connections on `metadata_only` never wrote a body, and `full_local` keeps
 * them indefinitely — neither is touched.
 */
export async function purgeExpiredBodies(db: Db, workspaceId: string, now = new Date()): Promise<string[]> {
  const connections = await db.select({ id: emailConnections.id, retention: emailConnections.retention })
    .from(emailConnections).where(eq(emailConnections.workspaceId, workspaceId));

  const cleared: string[] = [];
  for (const connection of connections) {
    const retention = retentionSettingSchema.safeParse(connection.retention);
    if (!retention.success || retention.data.mode !== "days_limited") continue;
    // The schema guarantees `days` for this mode, but a stored row predating a
    // schema change would not — skip rather than purge everything.
    const days = retention.data.days;
    if (days === undefined) continue;

    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const expired = await db.select({ id: emailMessages.id, bodyRef: emailMessages.bodyRef })
      .from(emailMessages).where(and(
        eq(emailMessages.connectionId, connection.id),
        isNotNull(emailMessages.bodyRef),
        lt(emailMessages.receivedAt, cutoff),
      ));
    if (expired.length === 0) continue;

    await db.update(emailMessages).set({ bodyRef: null })
      .where(inArray(emailMessages.id, expired.map((row) => row.id)));
    for (const row of expired) {
      if (row.bodyRef !== null) cleared.push(row.bodyRef);
    }
  }
  return cleared;
}
