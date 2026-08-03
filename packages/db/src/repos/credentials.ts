import { eq } from "drizzle-orm";
import type { DbOrTx } from "../client.js";
import { openSecret, sealSecret } from "../crypto.js";
import { credentials } from "../schema/index.js";

export interface CreateCredentialInput {
  workspaceId: string;
  kind: string;
  masterKeyB64: string;
  secret: string;
}

/**
 * Seals `input.secret` under the master key and stores only the ciphertext —
 * the plaintext never reaches the database. Returns the new row's id so
 * callers (e.g. email connection setup) can reference it without ever
 * holding the secret themselves.
 *
 * Takes `DbOrTx` so `createEmailConnection` can seal both passwords and insert
 * the connection that references them in a single transaction.
 */
export async function createCredential(db: DbOrTx, input: CreateCredentialInput): Promise<string> {
  const sealed = await sealSecret(input.masterKeyB64, input.secret);
  const [row] = await db.insert(credentials).values({
    workspaceId: input.workspaceId,
    kind: input.kind,
    // The `bytea` customType's driverData is Buffer; the postgres-js driver
    // does not accept a bare Uint8Array for a bytea parameter.
    ciphertext: Buffer.from(sealed),
  }).returning({ id: credentials.id });
  return row!.id;
}

/**
 * Decrypts the credential's ciphertext with the given master key.
 * `CryptoError` from `openSecret` (wrong key, tampered row) propagates to the
 * caller unchanged — this function does not mask crypto failures.
 */
export async function readCredentialSecret(db: DbOrTx, id: string, masterKeyB64: string): Promise<string> {
  const [row] = await db.select({ ciphertext: credentials.ciphertext })
    .from(credentials)
    .where(eq(credentials.id, id))
    .limit(1);
  if (!row) {
    throw new Error(`credential not found: ${id}`);
  }
  return openSecret(masterKeyB64, row.ciphertext);
}

export async function deleteCredential(db: DbOrTx, id: string): Promise<void> {
  await db.delete(credentials).where(eq(credentials.id, id));
}
