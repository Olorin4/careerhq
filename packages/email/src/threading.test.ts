import { describe, expect, it } from "vitest";
import { matchInboundToApplication } from "./threading.js";

describe("matchInboundToApplication", () => {
  it("matches on In-Reply-To", () => {
    const outboundIndex = new Map([["<abc123@example.com>", "app-1"]]);
    const senderDomains = new Map<string, string[]>();
    const result = matchInboundToApplication(
      { inReplyTo: "<abc123@example.com>", references: [], fromAddr: "recruiter@acme.com" },
      outboundIndex,
      senderDomains,
    );
    expect(result).toEqual({ applicationId: "app-1", matchMethod: "headers" });
  });

  it("matches on the References chain, walking in order to find the first hit", () => {
    const outboundIndex = new Map([["<middle@example.com>", "app-2"]]);
    const senderDomains = new Map<string, string[]>();
    const result = matchInboundToApplication(
      {
        inReplyTo: null,
        references: ["<first@example.com>", "<middle@example.com>", "<last@example.com>"],
        fromAddr: "recruiter@acme.com",
      },
      outboundIndex,
      senderDomains,
    );
    expect(result).toEqual({ applicationId: "app-2", matchMethod: "headers" });
  });

  it("normalizes angle brackets and whitespace before comparing Message-IDs", () => {
    const outboundIndex = new Map([["  <abc@x>  ", "app-3"]]);
    const senderDomains = new Map<string, string[]>();
    const result = matchInboundToApplication(
      { inReplyTo: "abc@x", references: [], fromAddr: "recruiter@acme.com" },
      outboundIndex,
      senderDomains,
    );
    expect(result).toEqual({ applicationId: "app-3", matchMethod: "headers" });
  });

  it("falls back to sender domain when headers don't match and the domain maps to exactly one application", () => {
    const outboundIndex = new Map<string, string>();
    const senderDomains = new Map([["acme.com", ["app-4"]]]);
    const result = matchInboundToApplication(
      { inReplyTo: null, references: [], fromAddr: "recruiter@acme.com" },
      outboundIndex,
      senderDomains,
    );
    expect(result).toEqual({ applicationId: "app-4", matchMethod: "sender" });
  });

  it("returns null when the sender domain maps to more than one application (ambiguous, never guess)", () => {
    const outboundIndex = new Map<string, string>();
    const senderDomains = new Map([["acme.com", ["app-4", "app-5"]]]);
    const result = matchInboundToApplication(
      { inReplyTo: null, references: [], fromAddr: "recruiter@acme.com" },
      outboundIndex,
      senderDomains,
    );
    expect(result).toBeNull();
  });

  it("returns null when nothing matches", () => {
    const outboundIndex = new Map<string, string>();
    const senderDomains = new Map<string, string[]>();
    const result = matchInboundToApplication(
      { inReplyTo: "<nope@example.com>", references: ["<also-nope@example.com>"], fromAddr: "recruiter@acme.com" },
      outboundIndex,
      senderDomains,
    );
    expect(result).toBeNull();
  });

  it("prefers a header match over a sender-domain match when both would match", () => {
    const outboundIndex = new Map([["<abc123@example.com>", "app-1"]]);
    const senderDomains = new Map([["acme.com", ["app-6"]]]);
    const result = matchInboundToApplication(
      { inReplyTo: "<abc123@example.com>", references: [], fromAddr: "recruiter@acme.com" },
      outboundIndex,
      senderDomains,
    );
    expect(result).toEqual({ applicationId: "app-1", matchMethod: "headers" });
  });
});
