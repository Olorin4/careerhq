import { describe, expect, it } from "vitest";
import type { ImapConfig } from "@careerhq/contracts";
import { makeImapClient, normalizeRawMessage, type RawFetchedMessage } from "./imap.js";

/** Hand-authored RFC822 source: a plain-text reply threaded via In-Reply-To/References,
 * with an intentionally long, irregularly-whitespaced body to exercise snippet truncation. */
const REPLY_WITH_HEADERS = [
  "From: Jane Recruiter <jane@acme-corp.com>",
  "To: dev-team@iron-wing-dispatching.com",
  "Subject: Re: Application for Senior Engineer",
  "Message-ID: <reply-001@acme-corp.com>",
  "In-Reply-To: <outbound-abc123@iron-wing-dispatching.com>",
  "References: <outbound-abc123@iron-wing-dispatching.com>",
  "Date: Mon, 03 Aug 2026 10:15:00 +0000",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Thanks   for applying to the Senior Engineer role. ".repeat(10) +
    "\n\nWe would like to schedule   an interview\tnext week.\n",
].join("\r\n");

/** Hand-authored RFC822 source with no Message-ID header at all. */
const MESSAGE_WITHOUT_MESSAGE_ID = [
  "From: noreply@acme-corp.com",
  "To: dev-team@iron-wing-dispatching.com",
  "Subject: Auto-Reply",
  "Date: Mon, 03 Aug 2026 09:00:00 +0000",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "This is an automated response.",
].join("\r\n");

function fixture(uid: number, source: string): RawFetchedMessage {
  return { uid, source: Buffer.from(source) };
}

describe("normalizeRawMessage", () => {
  it("normalizes a threaded reply, keeping Message-IDs verbatim and collapsing the snippet", async () => {
    const result = await normalizeRawMessage(fixture(42, REPLY_WITH_HEADERS));

    expect(result).not.toBeNull();
    expect(result?.messageId).toBe("<reply-001@acme-corp.com>");
    expect(result?.inReplyTo).toBe("<outbound-abc123@iron-wing-dispatching.com>");
    expect(result?.references).toEqual(["<outbound-abc123@iron-wing-dispatching.com>"]);
    expect(result?.fromAddr).toBe("jane@acme-corp.com");
    expect(result?.toAddrs).toEqual(["dev-team@iron-wing-dispatching.com"]);
    expect(result?.subject).toBe("Re: Application for Senior Engineer");
    expect(result?.date.toISOString()).toBe("2026-08-03T10:15:00.000Z");

    expect(result?.textSnippet.length).toBeLessThanOrEqual(300);
    expect(result?.textSnippet).not.toMatch(/\s{2,}/);
    expect(result?.textSnippet).not.toContain("\n");
    expect(result?.fullText.length).toBeGreaterThan(300);
    expect(result?.fullText).toContain("\n\n");
  });

  it("returns null when the message has no Message-ID header", async () => {
    const result = await normalizeRawMessage(fixture(43, MESSAGE_WITHOUT_MESSAGE_ID));
    expect(result).toBeNull();
  });
});

describe("makeImapClient config mapping", () => {
  const baseCfg: ImapConfig = {
    host: "imap.example.com",
    port: 993,
    username: "jane@example.com",
    tls: "implicit",
    folders: ["INBOX"],
  };

  it("maps tls=implicit to a secure connection with the configured host/port/user", () => {
    const client = makeImapClient(baseCfg, "password");
    const options = client.client.options as {
      host?: string;
      port?: number;
      secure?: boolean;
      auth?: { user?: string };
    };
    expect(options.host).toBe("imap.example.com");
    expect(options.port).toBe(993);
    expect(options.secure).toBe(true);
    expect(options.auth?.user).toBe("jane@example.com");
  });

  it("maps tls=starttls to a non-secure connection", () => {
    const client = makeImapClient({ ...baseCfg, tls: "starttls", port: 143 }, "password");
    const options = client.client.options as { secure?: boolean };
    expect(options.secure).toBe(false);
  });
});
