import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { AddressObject } from "mailparser";
import type { ImapConfig } from "@careerhq/contracts";

const SNIPPET_MAX_LENGTH = 300;

export interface RawFetchedMessage {
  uid: number;
  source: Buffer; // full RFC822 source
}

export interface ImapClientLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  fetchNewMessages(folder: string, sinceUid: number): AsyncIterable<RawFetchedMessage>;
}

/**
 * What `makeImapClient` actually returns: an `ImapClientLike` backed by a real
 * ImapFlow instance, with its underlying `client.options` exposed so tests can
 * assert the host/port/secure/auth mapping without opening a socket (ImapFlow
 * only connects on `connect()`, never at construction time).
 */
export interface ImapClientWithOptions extends ImapClientLike {
  readonly client: { readonly options: Record<string, unknown> };
}

export interface NormalizedInboundEmail {
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  fromAddr: string;
  toAddrs: string[];
  subject: string;
  date: Date;
  textSnippet: string; // <=300 chars, whitespace-collapsed
  fullText: string; // complete text body (caller decides retention)
}

function flattenAddresses(addr: AddressObject | AddressObject[] | undefined): string[] {
  if (addr === undefined) return [];
  const objects = Array.isArray(addr) ? addr : [addr];
  const addresses: string[] = [];
  for (const object of objects) {
    for (const entry of object.value) {
      if (entry.address !== undefined) addresses.push(entry.address);
    }
  }
  return addresses;
}

function normalizeReferences(references: string | string[] | undefined): string[] {
  if (references === undefined) return [];
  return Array.isArray(references) ? references : [references];
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Parses a raw RFC822 message into the shape the rest of the pipeline works with.
 * Returns null when the message has no Message-ID — such a message can never be
 * threaded or de-duplicated, so it isn't worth normalizing further.
 */
export async function normalizeRawMessage(raw: RawFetchedMessage): Promise<NormalizedInboundEmail | null> {
  const parsed = await simpleParser(raw.source);
  if (parsed.messageId === undefined) return null;

  let date = parsed.date;
  if (date === undefined || Number.isNaN(date.getTime())) {
    // Unparseable/missing Date header: fall back to now rather than fail normalization.
    date = new Date();
  }

  const fullText = parsed.text ?? "";

  return {
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo ?? null,
    references: normalizeReferences(parsed.references),
    fromAddr: parsed.from?.value[0]?.address ?? "",
    toAddrs: flattenAddresses(parsed.to),
    subject: parsed.subject ?? "",
    date,
    textSnippet: collapseWhitespace(fullText).slice(0, SNIPPET_MAX_LENGTH),
    fullText,
  };
}

async function* fetchNewMessages(
  client: ImapFlow,
  folder: string,
  sinceUid: number,
): AsyncGenerator<RawFetchedMessage> {
  await client.mailboxOpen(folder);
  const range = `${sinceUid + 1}:*`;
  for await (const message of client.fetch(range, { source: true }, { uid: true })) {
    // ImapFlow returns the last message in the mailbox even when the requested
    // range is empty (sinceUid >= max uid); filter those spurious results out.
    if (message.uid > sinceUid && message.source !== undefined) {
      yield { uid: message.uid, source: message.source };
    }
  }
}

export function makeImapClient(cfg: ImapConfig, password: string): ImapClientWithOptions {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.tls === "implicit",
    auth: { user: cfg.username, pass: password },
    logger: false,
  });

  const result = {
    client,
    connect: () => client.connect(),
    logout: () => client.logout(),
    fetchNewMessages: (folder: string, sinceUid: number) => fetchNewMessages(client, folder, sinceUid),
  };
  // ImapFlow's public type doesn't declare `options`, but the constructor stores the
  // resolved options object on the instance at runtime (mirrors nodemailer's
  // transporter.options, asserted the same way in smtp.ts's makeSmtpTransport).
  return result as unknown as ImapClientWithOptions;
}
