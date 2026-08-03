import _sodium from "libsodium-wrappers";

/**
 * Raised whenever a sealed credential cannot be trusted: the master key is
 * the wrong length, the ciphertext was tampered with, or it was opened with
 * the wrong key. Callers must never fall back to plaintext on this error —
 * see `openSecret`.
 */
export class CryptoError extends Error {}

// libsodium-wrappers loads its WASM module asynchronously; `ready` must be
// awaited exactly once before any crypto_* call. A module-level promise
// memoizes that wait so concurrent callers share one initialization instead
// of racing separate `ready` awaits.
let sodiumP: Promise<typeof _sodium> | null = null;

async function getSodium(): Promise<typeof _sodium> {
  sodiumP ??= _sodium.ready.then(() => _sodium);
  return sodiumP;
}

/**
 * Decodes the base64 master key and enforces the exact length
 * `crypto_secretbox` requires. A key of any other length is a configuration
 * error, not a crypto failure, but it is surfaced as `CryptoError` here so
 * every caller of `sealSecret`/`openSecret` has one error type to handle.
 */
function decodeKey(sodium: typeof _sodium, masterKeyB64: string): Uint8Array {
  const key = Buffer.from(masterKeyB64, "base64");
  if (key.length !== sodium.crypto_secretbox_KEYBYTES) {
    throw new CryptoError(
      `master key must decode to ${sodium.crypto_secretbox_KEYBYTES} bytes (got ${key.length})`,
    );
  }
  return key;
}

/**
 * Seals `plaintext` under `masterKeyB64` using `crypto_secretbox`. The
 * returned bytes are `nonce (crypto_secretbox_NONCEBYTES) || box` — a single
 * self-contained blob suitable for storing as-is in the `credentials.ciphertext`
 * bytea column.
 */
export async function sealSecret(masterKeyB64: string, plaintext: string): Promise<Uint8Array> {
  const sodium = await getSodium();
  const key = decodeKey(sodium, masterKeyB64);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const box = sodium.crypto_secretbox_easy(plaintext, nonce, key);
  const sealed = new Uint8Array(nonce.length + box.length);
  sealed.set(nonce, 0);
  sealed.set(box, nonce.length);
  return sealed;
}

/**
 * Reverses `sealSecret`. Throws `CryptoError` (never returns garbage) when
 * the key is the wrong length, the sealed payload is too short to contain a
 * nonce, or libsodium rejects the box — which covers both tampering and a
 * wrong-but-well-formed key, since `crypto_secretbox_open_easy` cannot tell
 * those apart.
 */
export async function openSecret(masterKeyB64: string, sealed: Uint8Array): Promise<string> {
  const sodium = await getSodium();
  const key = decodeKey(sodium, masterKeyB64);
  const nonceBytes = sodium.crypto_secretbox_NONCEBYTES;
  if (sealed.length < nonceBytes) {
    throw new CryptoError("sealed payload is shorter than the nonce");
  }
  const nonce = sealed.subarray(0, nonceBytes);
  const box = sealed.subarray(nonceBytes);
  try {
    const plaintext = sodium.crypto_secretbox_open_easy(box, nonce, key);
    return sodium.to_string(plaintext);
  } catch {
    throw new CryptoError("failed to open sealed secret: wrong key or tampered ciphertext");
  }
}

/** Generates a fresh 32-byte `crypto_secretbox` key, base64-encoded for CAREERHQ_MASTER_KEY. */
export async function generateMasterKeyB64(): Promise<string> {
  const sodium = await getSodium();
  const key = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  return Buffer.from(key).toString("base64");
}
