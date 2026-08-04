import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { ImapConfig, RetentionSetting, SmtpConfig } from "@careerhq/contracts";
import { createDb, type Db, workspaces } from "../index.js";
import { generateMasterKeyB64 } from "../crypto.js";
import { credentials, emailConnections } from "../schema/index.js";
import {
  createEmailConnection, deleteEmailConnection, getConnectionSecrets,
  listEmailConnections, updateConnectionHealth, updateSyncState,
} from "./email-connections.js";

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

const smtp: SmtpConfig = { host: "smtp.test", port: 587, username: "user@test", tls: "starttls" };
const imap: ImapConfig = { host: "imap.test", port: 993, username: "user@test", tls: "implicit", folders: ["INBOX"] };
const retention: RetentionSetting = { mode: "metadata_only" };

let db: Db;
let workspaceId: string;
let otherWorkspaceId: string;
let masterKeyB64: string;

beforeAll(async () => {
  if (!url) return;
  db = createDb(url);
  masterKeyB64 = await generateMasterKeyB64();
  const [ws] = await db.insert(workspaces).values({ name: `t-conn-${Date.now()}`, kind: "personal" }).returning();
  workspaceId = ws!.id;
  const [other] = await db.insert(workspaces).values({ name: `t-conn-o-${Date.now()}`, kind: "personal" }).returning();
  otherWorkspaceId = other!.id;
});

// email_connections → credentials is ON DELETE RESTRICT and Postgres does not
// promise an order when one DELETE cascades into several referencing tables, so
// a bare workspace delete could hit the credentials side first. Connections are
// cleared explicitly, mirroring the order deleteEmailConnection itself uses.
afterAll(async () => {
  if (!url) return;
  for (const id of [workspaceId, otherWorkspaceId]) {
    await db.delete(emailConnections).where(eq(emailConnections.workspaceId, id));
    await db.delete(workspaces).where(eq(workspaces.id, id));
  }
  await db.$client.end();
});

d("email connections repo", () => {
  it("creates two credential rows when IMAP is configured and stores no plaintext", async () => {
    const conn = await createEmailConnection(db, {
      workspaceId, label: "Primary", fromAddress: "me@test", displayName: "Me",
      smtp, smtpPassword: "smtp-pw-1", imap, imapPassword: "imap-pw-1",
      retention, masterKeyB64,
    });

    expect(conn.smtpCredentialId).toBeTruthy();
    expect(conn.imapCredentialId).toBeTruthy();
    expect(conn.health).toBe("untested");

    const rows = await db.select().from(credentials)
      .where(inArray(credentials.id, [conn.smtpCredentialId, conn.imapCredentialId!]));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind).sort()).toEqual(["imap", "smtp"]);
    for (const row of rows) {
      const stored = Buffer.from(row.ciphertext);
      expect(stored.includes("smtp-pw-1")).toBe(false);
      expect(stored.includes("imap-pw-1")).toBe(false);
    }
  });

  it("round-trips both secrets through the master key", async () => {
    const conn = await createEmailConnection(db, {
      workspaceId, label: "Round trip", fromAddress: "rt@test",
      smtp, smtpPassword: "smtp-pw-2", imap, imapPassword: "imap-pw-2",
      retention, masterKeyB64,
    });

    const secrets = await getConnectionSecrets(db, conn.id, masterKeyB64);
    expect(secrets.connection.id).toBe(conn.id);
    expect(secrets.smtpPassword).toBe("smtp-pw-2");
    expect(secrets.imapPassword).toBe("imap-pw-2");
  });

  it("creates a single credential and a null imap password when IMAP is omitted", async () => {
    const conn = await createEmailConnection(db, {
      workspaceId, label: "Send only", fromAddress: "so@test",
      smtp, smtpPassword: "smtp-only", retention, masterKeyB64,
    });

    expect(conn.imapCredentialId).toBeNull();
    const secrets = await getConnectionSecrets(db, conn.id, masterKeyB64);
    expect(secrets.smtpPassword).toBe("smtp-only");
    expect(secrets.imapPassword).toBeNull();
  });

  it("refuses an IMAP config without a password, and a password without a config", async () => {
    await expect(createEmailConnection(db, {
      workspaceId, label: "Bad 1", fromAddress: "b1@test",
      smtp, smtpPassword: "pw", imap, retention, masterKeyB64,
    })).rejects.toThrow(/imap/i);

    await expect(createEmailConnection(db, {
      workspaceId, label: "Bad 2", fromAddress: "b2@test",
      smtp, smtpPassword: "pw", imapPassword: "orphan", retention, masterKeyB64,
    })).rejects.toThrow(/imap/i);

    const rows = await db.select().from(emailConnections)
      .where(eq(emailConnections.workspaceId, workspaceId));
    expect(rows.map((r) => r.label)).not.toContain("Bad 1");
    expect(rows.map((r) => r.label)).not.toContain("Bad 2");
  });

  it("lists only the given workspace's connections", async () => {
    await createEmailConnection(db, {
      workspaceId: otherWorkspaceId, label: "Other workspace", fromAddress: "other@test",
      smtp, smtpPassword: "pw", retention, masterKeyB64,
    });

    const mine = await listEmailConnections(db, workspaceId);
    const theirs = await listEmailConnections(db, otherWorkspaceId);
    expect(mine.every((c) => c.workspaceId === workspaceId)).toBe(true);
    expect(mine.map((c) => c.label)).not.toContain("Other workspace");
    expect(theirs.map((c) => c.label)).toEqual(["Other workspace"]);
  });

  it("records health with a redacted detail and stamps lastCheckedAt", async () => {
    const conn = await createEmailConnection(db, {
      workspaceId, label: "Health", fromAddress: "h@test",
      smtp, smtpPassword: "pw", retention, masterKeyB64,
    });
    expect(conn.lastCheckedAt).toBeNull();

    await updateConnectionHealth(db, conn.id, "error", "authentication failed");
    const [errored] = await db.select().from(emailConnections).where(eq(emailConnections.id, conn.id));
    expect(errored!.health).toBe("error");
    expect(errored!.healthDetail).toBe("authentication failed");
    expect(errored!.lastCheckedAt).toBeInstanceOf(Date);

    await updateConnectionHealth(db, conn.id, "ok");
    const [okRow] = await db.select().from(emailConnections).where(eq(emailConnections.id, conn.id));
    expect(okRow!.health).toBe("ok");
    expect(okRow!.healthDetail).toBeNull();
  });

  it("stores the per-folder sync state", async () => {
    const conn = await createEmailConnection(db, {
      workspaceId, label: "Sync", fromAddress: "s@test",
      smtp, smtpPassword: "pw", imap, imapPassword: "pw2", retention, masterKeyB64,
    });

    await updateSyncState(db, conn.id, { INBOX: 42 });
    const [row] = await db.select().from(emailConnections).where(eq(emailConnections.id, conn.id));
    expect(row!.syncState).toEqual({ INBOX: 42 });
  });

  it("deletes the connection and both credential rows despite the RESTRICT foreign keys", async () => {
    const conn = await createEmailConnection(db, {
      workspaceId, label: "Disposable", fromAddress: "d@test",
      smtp, smtpPassword: "pw", imap, imapPassword: "pw2", retention, masterKeyB64,
    });

    expect(await deleteEmailConnection(db, workspaceId, conn.id)).toBe(true);

    const [gone] = await db.select().from(emailConnections).where(eq(emailConnections.id, conn.id));
    expect(gone).toBeUndefined();
    const creds = await db.select().from(credentials)
      .where(inArray(credentials.id, [conn.smtpCredentialId, conn.imapCredentialId!]));
    expect(creds).toHaveLength(0);
  });

  it("refuses to delete another workspace's connection, credentials included", async () => {
    const conn = await createEmailConnection(db, {
      workspaceId: otherWorkspaceId, label: "Not Yours", fromAddress: "ny@test",
      smtp, smtpPassword: "pw", imap, imapPassword: "pw2", retention, masterKeyB64,
    });

    expect(await deleteEmailConnection(db, workspaceId, conn.id)).toBe(false);

    const [survivor] = await db.select().from(emailConnections).where(eq(emailConnections.id, conn.id));
    expect(survivor?.label).toBe("Not Yours");
    const creds = await db.select().from(credentials)
      .where(inArray(credentials.id, [conn.smtpCredentialId, conn.imapCredentialId!]));
    expect(creds).toHaveLength(2);
  });
});
