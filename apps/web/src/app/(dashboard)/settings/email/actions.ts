"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  imapConfigSchema, retentionSettingSchema, smtpConfigSchema,
  type ImapConfig, type RetentionSetting, type SmtpConfig,
} from "@careerhq/contracts";
import {
  createEmailConnection, deleteEmailConnection, getConnectionSecrets,
  updateConnectionHealth, type Db,
} from "@careerhq/db";
import { makeSmtpTransport, verifySmtpConnection } from "@careerhq/email";
import { loadConfig } from "@careerhq/config";
import { getDb } from "../../../../lib/db.js";
import { getActiveWorkspace } from "../../../../lib/workspace.js";

type ActionResult = { ok: true } | { ok: false; reason: string };

const EMAIL_SETTINGS_PATH = "/settings/email";

/** The refusal both demo-gated actions return — never thrown, so the caller sees `{ok:false}`, not a 500. */
const DEMO_MODE_REFUSAL: ActionResult = { ok: false, reason: "disabled in the hosted demo" };

/**
 * The page only renders the create form and Test/Disconnect controls when a
 * master key is configured, but a server action is reachable independently of
 * what the client last rendered — this is the actual gate.
 */
function requireMasterKey(): string {
  const masterKey = loadConfig().masterKey;
  if (!masterKey) {
    throw new Error("CAREERHQ_MASTER_KEY is not configured — email connections are disabled");
  }
  return masterKey;
}

function describeZodError(error: z.ZodError, prefix: string): string {
  const issue = error.issues[0];
  if (!issue) return `invalid ${prefix}`;
  const field = issue.path.join(".");
  return `${prefix}${field ? `.${field}` : ""}: ${issue.message}`;
}

interface ParsedCreateForm {
  label: string;
  fromAddress: string;
  displayName?: string;
  smtp: SmtpConfig;
  smtpPassword: string;
  imap?: ImapConfig;
  imapPassword?: string;
  retention: RetentionSetting;
}

function str(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/**
 * Validates every field of the create-connection form via the contracts
 * schemas (smtp/imap/retention) plus a few plain checks for the fields those
 * schemas don't cover (label, from address, display name, passwords — never
 * part of a stored config object). Passwords are read once here and never
 * placed on the returned value's error path, so a failure below can't echo
 * one back to the caller.
 */
function parseCreateConnectionForm(formData: FormData): { ok: true; data: ParsedCreateForm } | { ok: false; reason: string } {
  const label = str(formData, "label").trim();
  if (!label) return { ok: false, reason: "label is required" };

  const fromAddress = str(formData, "fromAddress").trim();
  if (!z.string().email().safeParse(fromAddress).success) {
    return { ok: false, reason: "from address must be a valid email" };
  }

  const displayNameRaw = str(formData, "displayName").trim();
  const displayName = displayNameRaw.length > 0 ? displayNameRaw : undefined;

  const smtpPassword = str(formData, "smtpPassword");
  if (!smtpPassword) return { ok: false, reason: "SMTP password is required" };

  const smtpResult = smtpConfigSchema.safeParse({
    host: str(formData, "smtpHost"),
    port: str(formData, "smtpPort"),
    username: str(formData, "smtpUsername"),
    tls: str(formData, "smtpTls"),
  });
  if (!smtpResult.success) return { ok: false, reason: describeZodError(smtpResult.error, "smtp") };

  const imapEnabled = str(formData, "imapEnabled") === "on";
  let imap: ImapConfig | undefined;
  let imapPassword: string | undefined;
  if (imapEnabled) {
    imapPassword = str(formData, "imapPassword");
    if (!imapPassword) return { ok: false, reason: "IMAP password is required when IMAP is enabled" };

    const folders = str(formData, "imapFolders")
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f.length > 0);
    const imapResult = imapConfigSchema.safeParse({
      host: str(formData, "imapHost"),
      port: str(formData, "imapPort"),
      username: str(formData, "imapUsername"),
      tls: str(formData, "imapTls"),
      folders: folders.length > 0 ? folders : undefined,
    });
    if (!imapResult.success) return { ok: false, reason: describeZodError(imapResult.error, "imap") };
    imap = imapResult.data;
  }

  const retentionDaysRaw = str(formData, "retentionDays").trim();
  const retentionResult = retentionSettingSchema.safeParse({
    mode: str(formData, "retentionMode") || undefined,
    days: retentionDaysRaw ? Number(retentionDaysRaw) : undefined,
  });
  if (!retentionResult.success) return { ok: false, reason: describeZodError(retentionResult.error, "retention") };

  return {
    ok: true,
    data: {
      label, fromAddress, displayName, smtp: smtpResult.data, smtpPassword,
      imap, imapPassword, retention: retentionResult.data,
    },
  };
}

/**
 * Opens an SMTP transport with the given plaintext password, verifies it, and
 * records the (already-redacted, per `verifySmtpConnection`) outcome as the
 * connection's health. Shared by `createConnectionAction` (verify right after
 * creating) and `testConnectionAction` (verify on demand).
 */
async function verifyAndRecordHealth(
  db: Db,
  connectionId: string,
  smtp: SmtpConfig,
  smtpPassword: string,
): Promise<ActionResult> {
  const transport = makeSmtpTransport(smtp, smtpPassword);
  const result = await verifySmtpConnection(transport, [smtpPassword]);
  await updateConnectionHealth(db, connectionId, result.ok ? "ok" : "error", result.ok ? null : result.reason);
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

export async function createConnectionAction(formData: FormData): Promise<ActionResult> {
  // Server-side enforcement (spec P6 §3): the page's disabled panel is only
  // presentation, so this action must refuse independently of it — a direct
  // call (a stale client, a replayed request) must not create real
  // credentials in the hosted demo.
  if (loadConfig().demoMode) return DEMO_MODE_REFUSAL;

  const masterKeyB64 = requireMasterKey();
  const parsed = parseCreateConnectionForm(formData);
  if (!parsed.ok) return parsed;

  const db = getDb();
  const ws = await getActiveWorkspace(db);
  const connection = await createEmailConnection(db, {
    workspaceId: ws.id,
    label: parsed.data.label,
    fromAddress: parsed.data.fromAddress,
    displayName: parsed.data.displayName,
    smtp: parsed.data.smtp,
    smtpPassword: parsed.data.smtpPassword,
    imap: parsed.data.imap,
    imapPassword: parsed.data.imapPassword,
    retention: parsed.data.retention,
    masterKeyB64,
  });

  const result = await verifyAndRecordHealth(db, connection.id, parsed.data.smtp, parsed.data.smtpPassword);
  revalidatePath(EMAIL_SETTINGS_PATH);
  return result;
}

const connectionIdSchema = z.object({ connectionId: z.string().uuid() });

export async function testConnectionAction(raw: { connectionId: string }): Promise<ActionResult> {
  // Same server-side gate as createConnectionAction: testing a connection
  // opens a real SMTP transport, which the demo must never do.
  if (loadConfig().demoMode) return DEMO_MODE_REFUSAL;

  const { connectionId } = connectionIdSchema.parse(raw);
  const masterKeyB64 = requireMasterKey();

  const db = getDb();
  const { connection, smtpPassword } = await getConnectionSecrets(db, connectionId, masterKeyB64);
  const smtp = smtpConfigSchema.parse(connection.smtp);
  const result = await verifyAndRecordHealth(db, connectionId, smtp, smtpPassword);
  revalidatePath(EMAIL_SETTINGS_PATH);
  return result;
}

export async function disconnectAction(raw: { connectionId: string }): Promise<void> {
  const { connectionId } = connectionIdSchema.parse(raw);
  await deleteEmailConnection(getDb(), connectionId);
  revalidatePath(EMAIL_SETTINGS_PATH);
}
