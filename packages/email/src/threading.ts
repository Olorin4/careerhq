import type { NormalizedInboundEmail } from "./imap.js";

export interface OutboundIndexEntry {
  messageId: string;
  applicationId: string;
}

export interface SenderDomainEntry {
  domain: string;
  applicationId: string;
}

export type ThreadMatch = { applicationId: string; matchMethod: "headers" | "sender" } | null;

/** Strips surrounding angle brackets and whitespace so Message-IDs compare equal regardless of formatting. */
function normalizeMessageId(raw: string): string {
  let id = raw.trim();
  if (id.startsWith("<")) id = id.slice(1);
  if (id.endsWith(">")) id = id.slice(0, -1);
  return id.trim();
}

/** Lowercase, trimmed domain portion of an address, or null when there isn't one. */
function extractDomain(fromAddr: string): string | null {
  const at = fromAddr.lastIndexOf("@");
  if (at === -1 || at === fromAddr.length - 1) return null;
  return fromAddr.slice(at + 1).trim().toLowerCase();
}

/**
 * Header-first threading: an In-Reply-To hit wins outright; otherwise the References
 * chain is walked in order and the first hit is used; otherwise the sender's domain is
 * consulted but only trusted when it maps to exactly one application (an ambiguous
 * domain never guesses); otherwise there is no match.
 */
export function matchInboundToApplication(
  msg: Pick<NormalizedInboundEmail, "inReplyTo" | "references" | "fromAddr">,
  outboundIndex: ReadonlyMap<string, string>,
  senderDomains: ReadonlyMap<string, string[]>,
): ThreadMatch {
  const normalizedOutbound = new Map<string, string>();
  for (const [messageId, applicationId] of outboundIndex) {
    normalizedOutbound.set(normalizeMessageId(messageId), applicationId);
  }

  if (msg.inReplyTo !== null) {
    const applicationId = normalizedOutbound.get(normalizeMessageId(msg.inReplyTo));
    if (applicationId !== undefined) {
      return { applicationId, matchMethod: "headers" };
    }
  }

  for (const reference of msg.references) {
    const applicationId = normalizedOutbound.get(normalizeMessageId(reference));
    if (applicationId !== undefined) {
      return { applicationId, matchMethod: "headers" };
    }
  }

  const domain = extractDomain(msg.fromAddr);
  if (domain !== null) {
    const normalizedDomains = new Map<string, string[]>();
    for (const [key, applicationIds] of senderDomains) {
      normalizedDomains.set(key.trim().toLowerCase(), applicationIds);
    }
    const applicationIds = normalizedDomains.get(domain);
    if (applicationIds !== undefined && applicationIds.length === 1) {
      const [applicationId] = applicationIds;
      if (applicationId !== undefined) {
        return { applicationId, matchMethod: "sender" };
      }
    }
  }

  return null;
}
