import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "@careerhq/config";
import {
  imapConfigSchema, retentionSettingSchema,
  type ApplicationState, type ClassifyReplyResult, type ImapConfig, type RetentionSetting,
} from "@careerhq/contracts";
import { AUTO_ACK_CONFIDENCE } from "@careerhq/core";
import {
  buildOutboundIndex, buildSenderDomainIndex, companies, getConnectionSecrets, jobs,
  listEmailConnections, purgeExpiredBodies, setClassification, transitionApplication,
  updateConnectionHealth, updateSyncState, upsertInboundMessage,
  applications as applicationsTable, type Db, type EmailConnection,
} from "@careerhq/db";
import { eq } from "drizzle-orm";
import {
  makeImapClient, matchInboundToApplication, normalizeRawMessage, redactError,
  type ImapClientLike, type NormalizedInboundEmail,
} from "@careerhq/email";
import { classifyReply, type ClassifyReplyInput } from "@careerhq/ai";
import type { FallbackOptions, FallbackResult } from "@careerhq/ai";

/**
 * `makeImapClient` widened to its structural contract, mirroring `MakeTransport`
 * in the web submission orchestrator: tests inject a client that never opens a
 * socket, and the real factory (whose return type also carries imapflow's
 * options) satisfies this signature unchanged.
 */
export type MakeImapClient = (cfg: ImapConfig, password: string) => ImapClientLike;

/** `classifyReply` as this job consumes it, so a stub needs no imports from the AI client. */
export type ClassifyReplyFn = (
  msg: ClassifyReplyInput,
  opts: FallbackOptions,
) => Promise<FallbackResult<ClassifyReplyResult>>;

export interface EmailSyncOptions {
  makeClient?: MakeImapClient;
  classify?: ClassifyReplyFn;
}

export interface EmailSyncSummary {
  /** Connections with an IMAP config that this run attempted, failures included. */
  connections: number;
  fetched: number;
  /** New messages threaded onto an application. */
  linked: number;
  /** New messages left in the pending-suggestion queue for a human. */
  suggested: number;
  classified: number;
  autoAcked: number;
  /** Bodies whose retention window expired and whose files were unlinked. */
  purged: number;
}

/** What the classification prompt needs about the application a reply belongs to. */
interface ApplicationContext {
  state: ApplicationState;
  companyName: string;
  jobTitle: string;
}

function emptySummary(): EmailSyncSummary {
  return { connections: 0, fetched: 0, linked: 0, suggested: 0, classified: 0, autoAcked: 0, purged: 0 };
}

/**
 * Loads the prompt context for a matched application, memoised for the run:
 * several replies in one pass routinely land on the same application, and this
 * is three joined tables per lookup.
 */
async function loadApplicationContext(
  db: Db,
  cache: Map<string, ApplicationContext | null>,
  applicationId: string,
): Promise<ApplicationContext | null> {
  const cached = cache.get(applicationId);
  if (cached !== undefined) return cached;

  const [row] = await db.select({
    state: applicationsTable.state, jobTitle: jobs.title, companyName: companies.name,
  }).from(applicationsTable)
    .innerJoin(jobs, eq(jobs.id, applicationsTable.jobId))
    .leftJoin(companies, eq(companies.id, jobs.companyId))
    .where(eq(applicationsTable.id, applicationId));

  const context: ApplicationContext | null = row
    ? { state: row.state, jobTitle: row.jobTitle, companyName: row.companyName ?? "Unknown" }
    : null;
  cache.set(applicationId, context);
  return context;
}

/**
 * Writes the message body to the shared file tree when the connection's
 * retention keeps one, and returns its path. `metadata_only` stores nothing at
 * all; `days_limited` stores the same as `full_local` and is swept later by
 * `purgeExpiredBodies`.
 */
async function writeBodyFile(
  config: AppConfig,
  retention: RetentionSetting,
  fullText: string,
): Promise<string | null> {
  if (retention.mode === "metadata_only") return null;

  const dir = path.join(config.fileStorageDir, "mail");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${randomUUID()}.txt`);
  await writeFile(file, fullText, "utf8");
  return file;
}

/** Best-effort unlink: a body file that is already gone is not a failure. */
async function removeFile(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") {
      console.error(`[email-sync] could not remove body file ${file}: ${String(err)}`);
    }
  }
}

interface ConnectionRunDeps {
  db: Db;
  workspaceId: string;
  config: AppConfig;
  /** Narrowed once by `runEmailSyncOnce`; every stored IMAP password opens with it. */
  masterKey: string;
  classify: ClassifyReplyFn;
  makeClient: MakeImapClient;
  outboundIndex: ReadonlyMap<string, string>;
  senderDomains: ReadonlyMap<string, string[]>;
  contextCache: Map<string, ApplicationContext | null>;
  summary: EmailSyncSummary;
}

/**
 * Classifies one newly stored, application-matched message and applies the
 * auto-acknowledge rule. The suggestion is left "pending" for a human unless
 * the machine is allowed to move the application itself: an `ack` at or above
 * `AUTO_ACK_CONFIDENCE` on a SUBMITTED application, which is the only edge the
 * state machine grants the "classification" trigger.
 *
 * A refused transition (a racing manual move, a guard change) falls back to a
 * pending suggestion rather than being lost.
 */
async function classifyAndSuggest(
  deps: ConnectionRunDeps,
  messageRowId: string,
  msg: NormalizedInboundEmail,
  applicationId: string,
): Promise<"pending" | "accepted" | null> {
  const { db, config, summary } = deps;
  const apiKey = config.openrouterApiKey;
  // No key is the deterministic floor: the message is stored, just unclassified.
  if (apiKey === null) return null;

  const context = await loadApplicationContext(db, deps.contextCache, applicationId);
  if (!context) return null;

  const result = await deps.classify({
    subject: msg.subject,
    snippet: msg.textSnippet,
    companyName: context.companyName,
    jobTitle: context.jobTitle,
    applicationState: context.state,
  }, { models: config.aiFastModels, apiKey });

  if (!result.ok || !result.value) {
    // The next scheduled pass will not retry this message (it is no longer
    // new), so record why the floor was kept rather than failing silently.
    console.error(
      `[email-sync] classification failed for message ${messageRowId}: `
      + `${result.error ?? "unknown_error"} (model=${result.model})`,
    );
    return null;
  }
  summary.classified += 1;
  const verdict = result.value;

  const autoAck = verdict.classification === "ack"
    && verdict.confidence >= AUTO_ACK_CONFIDENCE
    && context.state === "SUBMITTED";

  let suggestionState: "pending" | "accepted" = "pending";
  let suggestedTransition = verdict.suggestedState ?? null;

  if (autoAck) {
    const moved = await transitionApplication(db, {
      applicationId,
      to: "ACKNOWLEDGED",
      trigger: "classification",
      ctx: { classificationConfidence: verdict.confidence },
      actor: "system",
      followUpDays: config.followUpDays,
    });
    if (moved.ok) {
      suggestionState = "accepted";
      suggestedTransition = "ACKNOWLEDGED";
      summary.autoAcked += 1;
      // The cached state is now stale, and a second reply in the same run must
      // not auto-ack an application that has already moved.
      deps.contextCache.set(applicationId, { ...context, state: "ACKNOWLEDGED" });
    } else {
      console.error(`[email-sync] auto-ack refused for application ${applicationId}: ${moved.reason}`);
    }
  }

  await setClassification(db, messageRowId, {
    classification: verdict.classification,
    confidence: verdict.confidence,
    suggestedTransition,
    suggestionState,
  });
  return suggestionState;
}

/** Fetches, normalizes, threads, stores and classifies one folder's new mail. Returns the new high-water uid. */
async function syncFolder(
  deps: ConnectionRunDeps,
  client: ImapClientLike,
  connection: EmailConnection,
  retention: RetentionSetting,
  folder: string,
  sinceUid: number,
): Promise<number> {
  const { db, config, summary } = deps;
  let maxUid = sinceUid;

  for await (const raw of client.fetchNewMessages(folder, sinceUid)) {
    summary.fetched += 1;
    // Advanced even for messages that never become rows: a mail with no
    // Message-ID is unusable, and re-reading it every pass would be a
    // permanent stall on this folder.
    if (raw.uid > maxUid) maxUid = raw.uid;

    const msg = await normalizeRawMessage(raw);
    if (!msg) continue;

    const match = matchInboundToApplication(msg, deps.outboundIndex, deps.senderDomains);
    const applicationId = match?.applicationId ?? null;

    const bodyRef = await writeBodyFile(config, retention, msg.fullText);
    const stored = await upsertInboundMessage(db, {
      workspaceId: deps.workspaceId,
      connectionId: connection.id,
      msg,
      applicationId,
      matchMethod: match?.matchMethod ?? null,
      bodyRef,
      // A sender-domain match is a guess the human should confirm even before a
      // model has looked at it; a header match is certain and needs no seed.
      ...(match?.matchMethod === "sender" ? { suggestionSeed: { suggestionState: "pending" as const } } : {}),
    });

    if (!stored.inserted) {
      // Already seen (a second folder, or a re-fetch): nothing to link, nothing
      // to classify, and the body just written is a duplicate of the stored one.
      if (bodyRef !== null) await removeFile(bodyRef);
      continue;
    }
    if (applicationId === null) continue;
    summary.linked += 1;

    const classified = await classifyAndSuggest(deps, stored.id, msg, applicationId);
    const suggestionState = classified ?? (match?.matchMethod === "sender" ? "pending" : null);
    if (suggestionState === "pending") summary.suggested += 1;
  }

  return maxUid;
}

async function syncConnection(deps: ConnectionRunDeps, connection: EmailConnection): Promise<void> {
  const { db, masterKey } = deps;
  const secrets = [masterKey];

  try {
    const imapConfig = imapConfigSchema.parse(connection.imap);
    const retention = retentionSettingSchema.parse(connection.retention);

    const { imapPassword } = await getConnectionSecrets(db, connection.id, masterKey);
    if (imapPassword === null) {
      throw new Error("this connection has an IMAP config but no stored IMAP password");
    }
    secrets.push(imapPassword);

    const client = deps.makeClient(imapConfig, imapPassword);
    await client.connect();
    try {
      const syncState: Record<string, number> = { ...(connection.syncState as Record<string, number> | null) };
      for (const folder of imapConfig.folders) {
        syncState[folder] = await syncFolder(
          deps, client, connection, retention, folder, syncState[folder] ?? 0,
        );
      }
      await updateSyncState(db, connection.id, syncState);
    } finally {
      // A logout failure must not undo a completed sync, nor mask a real error
      // from the fetch above.
      await client.logout().catch(() => {});
    }

    await updateConnectionHealth(db, connection.id, "ok");
  } catch (err) {
    // One unreachable or misconfigured mailbox must not stop the others. The
    // detail is rendered verbatim in the settings UI, so it is redacted here.
    await updateConnectionHealth(db, connection.id, "error", redactError(err, secrets));
  }
}

/**
 * One polling pass over every IMAP-capable mailbox in a workspace: fetch what
 * is new since the stored per-folder uid, thread each reply onto the
 * application it answers, store it under the connection's retention setting,
 * and — only when a key is configured — classify it and apply the auto-ack rule.
 *
 * Without `CAREERHQ_MASTER_KEY` there is no way to open a stored IMAP password,
 * so the run is a no-op rather than a failure.
 */
export async function runEmailSyncOnce(
  db: Db,
  workspaceId: string,
  config: AppConfig,
  opts: EmailSyncOptions = {},
): Promise<EmailSyncSummary> {
  const summary = emptySummary();
  const masterKey = config.masterKey;
  if (masterKey === null) {
    console.log("[email-sync] CAREERHQ_MASTER_KEY is not configured; skipping");
    return summary;
  }

  const connections = (await listEmailConnections(db, workspaceId)).filter((c) => c.imap !== null);
  if (connections.length > 0) {
    // The indexes describe what has already been sent, which this run never
    // changes, so they are built once and shared across every connection.
    const deps: ConnectionRunDeps = {
      db,
      workspaceId,
      config,
      masterKey,
      classify: opts.classify ?? classifyReply,
      makeClient: opts.makeClient ?? makeImapClient,
      outboundIndex: await buildOutboundIndex(db, workspaceId),
      senderDomains: await buildSenderDomainIndex(db, workspaceId),
      contextCache: new Map(),
      summary,
    };

    for (const connection of connections) {
      summary.connections += 1;
      await syncConnection(deps, connection);
    }
  }

  // Retention sweep last, so bodies stored moments ago by a days_limited
  // connection are already candidates. It is workspace-wide, only touches
  // days_limited connections, and runs even when nothing was fetched — a
  // mailbox that has since lost its IMAP config must still expire its bodies.
  const expired = await purgeExpiredBodies(db, workspaceId);
  for (const file of expired) await removeFile(file);
  summary.purged = expired.length;

  return summary;
}
