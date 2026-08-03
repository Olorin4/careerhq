import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createApplication, createDb, type Db, workspaces } from "../index.js";
import { createDocument, listDocuments, setDocumentApproval } from "./documents.js";

const url = process.env.TEST_DATABASE_URL;
const d = describe.skipIf(!url);

let db: Db;
let workspaceId: string;
let applicationId: string;

beforeAll(async () => {
  if (!url) return;
  db = createDb(url);
  const [ws] = await db.insert(workspaces).values({ name: `t-${Date.now()}`, kind: "personal" }).returning();
  workspaceId = ws!.id;
  const app = await createApplication(db, {
    workspaceId, companyName: "Acme Corp", jobTitle: "Engineer",
  });
  applicationId = app.id;
});

afterAll(async () => {
  if (!url) return;
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await db.$client.end();
});

d("documents repo", () => {
  it("creates a draft and approves it with timestamp", async () => {
    const doc = await createDocument(db, {
      applicationId, kind: "cover_letter", contentMd: "Dear team", sourceFactIds: [],
    });
    expect(doc.approval).toBe("draft");
    expect(doc.origin).toBe("ai");
    const approved = await setDocumentApproval(db, doc.id, "approved");
    expect(approved?.approvedAt).toBeInstanceOf(Date);
    const rejected = await setDocumentApproval(db, doc.id, "rejected");
    expect(rejected?.approvedAt).toBeNull();
  });

  it("lists documents for an application newest first", async () => {
    const first = await createDocument(db, {
      applicationId, kind: "cover_letter", contentMd: "First draft", sourceFactIds: [],
    });
    const second = await createDocument(db, {
      applicationId, kind: "email_body", contentMd: "Second draft", sourceFactIds: [],
    });
    const docs = await listDocuments(db, applicationId);
    const firstIdx = docs.findIndex((doc) => doc.id === first.id);
    const secondIdx = docs.findIndex((doc) => doc.id === second.id);
    expect(secondIdx).toBeLessThan(firstIdx);
  });
});
