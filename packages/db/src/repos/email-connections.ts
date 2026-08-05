import { and, asc, eq, sql } from "drizzle-orm";
import type { ImapConfig, RetentionSetting, SmtpConfig } from "@careerhq/contracts";
import type { Db, DbOrTx } from "../client.js";
import { credentials, emailConnections } from "../schema/index.js";
import type { EmailConnection } from "../index.js";
import { createCredential, readCredentialSecret } from "./credentials.js";

export interface CreateEmailConnectionInput {
  workspaceId: string;
  label: string;
  fromAddress: string;
  displayName?: string;
  smtp: SmtpConfig;
  smtpPassword: string;
  imap?: ImapConfig;
  imapPassword?: string;
  retention: RetentionSetting;
  masterKeyB64: string;
}

/**
 * Seals both passwords into `credentials` rows and stores the connection that
 * references them — one transaction, so a crypto failure or a bad insert never
 * leaves an orphan credential behind.
 *
 * `imapPassword` is required *iff* `imap` is given: an IMAP config without a
 * password could never connect, and a password without a config would be an
 * unreferenced secret sitting in the database forever.
 */
export async function createEmailConnection(
  db: DbOrTx,
  input: CreateEmailConnectionInput,
): Promise<EmailConnection> {
  if (input.imap && !input.imapPassword) {
    throw new Error("imapPassword is required when an imap config is given");
  }
  if (!input.imap && input.imapPassword) {
    throw new Error("imapPassword was given without an imap config");
  }

  return db.transaction(async (tx) => {
    const smtpCredentialId = await createCredential(tx, {
      workspaceId: input.workspaceId, kind: "smtp",
      masterKeyB64: input.masterKeyB64, secret: input.smtpPassword,
    });
    const imapCredentialId = input.imap
      ? await createCredential(tx, {
        workspaceId: input.workspaceId, kind: "imap",
        masterKeyB64: input.masterKeyB64, secret: input.imapPassword!,
      })
      : null;

    const [row] = await tx.insert(emailConnections).values({
      workspaceId: input.workspaceId,
      label: input.label,
      fromAddress: input.fromAddress,
      displayName: input.displayName ?? null,
      smtp: input.smtp,
      imap: input.imap ?? null,
      retention: input.retention,
      smtpCredentialId,
      imapCredentialId,
    }).returning();
    return row!;
  });
}

/**
 * Opens the connection's sealed passwords. Callers hold the plaintext only for
 * as long as a transport needs it — nothing here caches or logs it, and
 * `CryptoError` from a wrong/rotated master key propagates unchanged.
 */
export async function getConnectionSecrets(
  db: Db,
  connectionId: string,
  masterKeyB64: string,
): Promise<{ connection: EmailConnection; smtpPassword: string; imapPassword: string | null }> {
  const [connection] = await db.select().from(emailConnections)
    .where(eq(emailConnections.id, connectionId));
  if (!connection) {
    throw new Error(`email connection not found: ${connectionId}`);
  }
  const smtpPassword = await readCredentialSecret(db, connection.smtpCredentialId, masterKeyB64);
  const imapPassword = connection.imapCredentialId
    ? await readCredentialSecret(db, connection.imapCredentialId, masterKeyB64)
    : null;
  return { connection, smtpPassword, imapPassword };
}

export async function listEmailConnections(db: DbOrTx, workspaceId: string): Promise<EmailConnection[]> {
  return db.select().from(emailConnections)
    .where(eq(emailConnections.workspaceId, workspaceId))
    .orderBy(asc(emailConnections.createdAt), asc(emailConnections.id));
}

/**
 * Records the outcome of a connection test. `detail` must already be redacted
 * by the caller (`redactError` in `@careerhq/email`) — it is rendered in the
 * settings UI verbatim.
 */
export async function updateConnectionHealth(
  db: Db,
  id: string,
  health: "ok" | "error",
  detail?: string | null,
): Promise<void> {
  await db.update(emailConnections)
    .set({ health, healthDetail: detail ?? null, lastCheckedAt: sql`clock_timestamp()` })
    .where(eq(emailConnections.id, id));
}

/** Persists the per-folder high-water marks the IMAP poller resumes from. */
export async function updateSyncState(
  db: Db,
  id: string,
  syncState: Record<string, number>,
): Promise<void> {
  await db.update(emailConnections).set({ syncState }).where(eq(emailConnections.id, id));
}

/**
 * Disconnects a mailbox and removes its secrets.
 *
 * Order is load-bearing: `email_connections.smtp_credential_id` /
 * `imap_credential_id` are ON DELETE RESTRICT, so the credential rows can only
 * go once nothing references them. The connection is deleted first and the
 * credentials second, inside one transaction — a failure anywhere rolls back
 * to a connection that still has its secrets rather than one that cannot log in.
 *
 * Scoped to `workspaceId` for the same reason the fact/document/answer
 * mutations are: a bare id is guessable, and this one destroys credentials.
 * Returns whether anything was deleted, so a caller can tell "not yours" from
 * "already gone" without a second read.
 */
export async function deleteEmailConnection(db: Db, workspaceId: string, id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [connection] = await tx.select().from(emailConnections)
      .where(and(eq(emailConnections.id, id), eq(emailConnections.workspaceId, workspaceId)));
    if (!connection) return false;

    await tx.delete(emailConnections).where(eq(emailConnections.id, id));
    await tx.delete(credentials).where(eq(credentials.id, connection.smtpCredentialId));
    if (connection.imapCredentialId) {
      await tx.delete(credentials).where(eq(credentials.id, connection.imapCredentialId));
    }
    return true;
  });
}
