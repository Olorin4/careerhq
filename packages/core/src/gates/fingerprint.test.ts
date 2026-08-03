import { describe, expect, it } from "vitest";
import { canonicalJson, payloadFingerprint } from "./fingerprint.js";
import type { EmailSubmissionPayload } from "./fingerprint.js";

describe("canonicalJson (spec §11)", () => {
  it("is stable across key order — objects sorted by key", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });

  it("preserves array element order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it("recurses into nested objects and arrays, sorting only object keys", () => {
    const value = { z: [{ y: 1, x: 2 }, "s"], a: { nested: true } };
    expect(canonicalJson(value)).toBe('{"a":{"nested":true},"z":[{"x":2,"y":1},"s"]}');
  });

  it("stringifies primitives directly", () => {
    expect(canonicalJson("hello")).toBe('"hello"');
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(null)).toBe("null");
  });

  it("throws TypeError on a bare undefined value", () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });

  it("throws TypeError on a nested undefined value", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalJson([1, undefined])).toThrow(TypeError);
  });

  it("throws TypeError on a function value", () => {
    expect(() => canonicalJson({ a: () => 1 })).toThrow(TypeError);
  });

  it("throws TypeError on a symbol value", () => {
    expect(() => canonicalJson({ a: Symbol("x") })).toThrow(TypeError);
  });

  it("throws TypeError on a cyclic object", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => canonicalJson(obj)).toThrow(TypeError);
  });

  it("does not falsely flag a shared (non-cyclic) reference used twice as a cycle", () => {
    const shared = { x: 1 };
    expect(() => canonicalJson({ left: shared, right: shared })).not.toThrow();
    expect(canonicalJson({ left: shared, right: shared })).toBe('{"left":{"x":1},"right":{"x":1}}');
  });
});

describe("payloadFingerprint (spec §11)", () => {
  const base: EmailSubmissionPayload = {
    applicationId: "app-1",
    connectionId: "conn-1",
    to: "hr@acme.example",
    subject: "Application for Engineer",
    body: "Dear hiring team, ...",
    attachments: [{ filename: "resume.pdf", sha256: "a".repeat(64) }],
  };

  it("is a sha256 hex digest of the canonical JSON", () => {
    expect(payloadFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for equivalent payloads regardless of key order", () => {
    const reordered = { ...base, subject: base.subject, to: base.to };
    expect(payloadFingerprint(base)).toBe(payloadFingerprint(reordered));
  });

  it("changes when a single body character changes", () => {
    expect(payloadFingerprint(base)).not.toBe(payloadFingerprint({ ...base, body: base.body + "!" }));
  });

  it("changes when an attachment sha256 changes", () => {
    expect(payloadFingerprint(base)).not.toBe(
      payloadFingerprint({ ...base, attachments: [{ filename: "resume.pdf", sha256: "b".repeat(64) }] }),
    );
  });

  it("changes when only the recipient case changes (exact-bytes fingerprint, not normalized)", () => {
    expect(payloadFingerprint(base)).not.toBe(payloadFingerprint({ ...base, to: "HR@Acme.example" }));
  });

  it("changes when an attachment is added", () => {
    expect(payloadFingerprint(base)).not.toBe(
      payloadFingerprint({
        ...base,
        attachments: [...base.attachments, { filename: "cover.pdf", sha256: "c".repeat(64) }],
      }),
    );
  });
});
