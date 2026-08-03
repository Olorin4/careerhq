import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db, workspaces } from "../index.js";
import { CryptoError, generateMasterKeyB64 } from "../crypto.js";
import { credentials } from "../schema/index.js";
import { createCredential, deleteCredential, readCredentialSecret } from "./credentials.js";

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

let db: Db;
let workspaceId: string;
let masterKeyB64: string;

beforeAll(async () => {
  if (!url) return;
  db = createDb(url);
  masterKeyB64 = await generateMasterKeyB64();
  const [ws] = await db.insert(workspaces).values({ name: `t-${Date.now()}`, kind: "personal" }).returning();
  workspaceId = ws!.id;
});

afterAll(async () => {
  if (!url) return;
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.$client.end();
});

d("credentials repo", () => {
  it("round-trips a secret and never stores the plaintext bytes", async () => {
    const secret = "smtp-app-password-123";
    const id = await createCredential(db, { workspaceId, kind: "smtp", masterKeyB64, secret });

    const [row] = await db.select().from(credentials).where(eq(credentials.id, id));
    expect(row).toBeDefined();
    const stored = Buffer.from(row!.ciphertext);
    expect(stored.equals(Buffer.from(secret))).toBe(false);
    expect(stored.includes(secret)).toBe(false);

    const read = await readCredentialSecret(db, id, masterKeyB64);
    expect(read).toBe(secret);
  });

  it("removes the row on delete", async () => {
    const id = await createCredential(db, { workspaceId, kind: "imap", masterKeyB64, secret: "s3cr3t" });
    await deleteCredential(db, id);
    const [row] = await db.select().from(credentials).where(eq(credentials.id, id));
    expect(row).toBeUndefined();
  });

  it("propagates CryptoError from readCredentialSecret when given the wrong master key", async () => {
    const id = await createCredential(db, { workspaceId, kind: "smtp", masterKeyB64, secret: "another-secret" });
    const wrongKey = await generateMasterKeyB64();
    await expect(readCredentialSecret(db, id, wrongKey)).rejects.toThrow(CryptoError);
  });
});
