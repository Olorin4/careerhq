import { describe, expect, it } from "vitest";
import { CryptoError, generateMasterKeyB64, openSecret, sealSecret } from "./crypto.js";

describe("crypto", () => {
  it("round-trips a secret through seal/open", async () => {
    const key = await generateMasterKeyB64();
    const sealed = await sealSecret(key, "hunter2");
    const opened = await openSecret(key, sealed);
    expect(opened).toBe("hunter2");
  });

  it("seals to bytes that do not contain the plaintext", async () => {
    const key = await generateMasterKeyB64();
    const secret = "hunter2-app-password";
    const sealed = await sealSecret(key, secret);
    expect(Buffer.from(sealed).includes(secret)).toBe(false);
  });

  it("generates a fresh 32-byte key, base64-encoded, on every call", async () => {
    const a = await generateMasterKeyB64();
    const b = await generateMasterKeyB64();
    expect(Buffer.from(a, "base64").length).toBe(32);
    expect(a).not.toBe(b);
  });

  it("throws CryptoError when the sealed payload is tampered with", async () => {
    const key = await generateMasterKeyB64();
    const sealed = await sealSecret(key, "hunter2");
    const tampered = Uint8Array.from(sealed);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1]! ^ 0xff) & 0xff;
    await expect(openSecret(key, tampered)).rejects.toThrow(CryptoError);
  });

  it("throws CryptoError when opened with the wrong key", async () => {
    const key = await generateMasterKeyB64();
    const wrongKey = await generateMasterKeyB64();
    const sealed = await sealSecret(key, "hunter2");
    await expect(openSecret(wrongKey, sealed)).rejects.toThrow(CryptoError);
  });

  it("throws CryptoError sealing with a master key of the wrong length", async () => {
    const shortKey = Buffer.from("too-short-not-32-bytes").toString("base64");
    await expect(sealSecret(shortKey, "hunter2")).rejects.toThrow(CryptoError);
  });

  it("throws CryptoError opening with a master key of the wrong length", async () => {
    const key = await generateMasterKeyB64();
    const sealed = await sealSecret(key, "hunter2");
    const shortKey = Buffer.from("too-short-not-32-bytes").toString("base64");
    await expect(openSecret(shortKey, sealed)).rejects.toThrow(CryptoError);
  });
});
