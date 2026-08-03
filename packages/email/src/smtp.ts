import nodemailer from "nodemailer";
import type { SmtpConfig } from "@careerhq/contracts";
import { redactError } from "./redact.js";

export interface SmtpSendRequest {
  from: string; // "Display Name <addr>" formatted by caller
  to: string;
  subject: string;
  text: string;
  attachments: Array<{ filename: string; content: Buffer }>;
  messageIdDomain: string; // e.g. from-address domain; nodemailer's own messageId generation is left on, we just read the returned one
}

export type SendOutcome =
  | { status: "sent"; messageId: string }
  | { status: "failed"; reason: string } // redacted
  | { status: "uncertain"; reason: string }; // redacted; post-DATA ambiguity

export interface SmtpTransportLike {
  verify(): Promise<true>;
  sendMail(opts: object): Promise<{ messageId: string; accepted: string[]; rejected: string[] }>;
}

/**
 * What `makeSmtpTransport` actually returns: a `SmtpTransportLike` backed by
 * a real nodemailer transporter, with its underlying `transporter.options`
 * exposed so tests can assert the tls/secure/requireTLS/ignoreTLS flag
 * mapping without opening a socket (nodemailer only connects on
 * `verify`/`sendMail`, never at construction time).
 */
export interface SmtpTransportWithOptions extends SmtpTransportLike {
  readonly transporter: { readonly options: Record<string, unknown> };
}

/** Error shape nodemailer's SMTP transport rejects with: SMTP reply `command` plus a `code` such as EAUTH/ETIMEDOUT. */
interface SmtpErrorLike {
  command?: string;
  code?: string;
}

function asSmtpError(err: unknown): SmtpErrorLike {
  return err !== null && typeof err === "object" ? (err as SmtpErrorLike) : {};
}

/**
 * A failure past the DATA command leaves delivery genuinely ambiguous: the
 * server may have accepted the message body before dropping the connection,
 * so the caller cannot safely treat it as a hard failure (e.g. retrying
 * could double-send). Everything else is a clean failure.
 */
function isDataPhaseAmbiguity(err: SmtpErrorLike): boolean {
  if (err.command === "DATA" || err.command === "end DATA") return true;
  return err.code === "ETIMEDOUT" && (err.command?.startsWith("DATA") ?? false);
}

export function makeSmtpTransport(cfg: SmtpConfig, password: string): SmtpTransportWithOptions {
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.tls === "implicit",
    requireTLS: cfg.tls === "starttls",
    ignoreTLS: cfg.tls === "none",
    auth: { user: cfg.username, pass: password },
  });
  return transport as unknown as SmtpTransportWithOptions;
}

export async function verifySmtpConnection(
  t: SmtpTransportLike,
  secrets: string[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await t.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: redactError(err, secrets) };
  }
}

export async function sendApplicationEmail(
  t: SmtpTransportLike,
  req: SmtpSendRequest,
  secrets: string[],
): Promise<SendOutcome> {
  let result: { messageId: string; accepted: string[]; rejected: string[] };
  try {
    result = await t.sendMail({
      from: req.from,
      to: req.to,
      subject: req.subject,
      text: req.text,
      attachments: req.attachments,
    });
  } catch (err) {
    const reason = redactError(err, secrets);
    return isDataPhaseAmbiguity(asSmtpError(err))
      ? { status: "uncertain", reason }
      : { status: "failed", reason };
  }

  if (result.rejected.includes(req.to)) {
    return { status: "failed", reason: redactError("recipient rejected", secrets) };
  }
  if (result.accepted.includes(req.to)) {
    return { status: "sent", messageId: result.messageId };
  }
  return {
    status: "uncertain",
    reason: redactError("recipient neither accepted nor rejected", secrets),
  };
}
