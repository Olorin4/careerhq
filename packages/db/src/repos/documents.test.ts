import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createApplication, createDb, type Db, workspaces } from "../index.js";
import { createDocument, hasApprovedMaterials, listDocuments, setDocumentApproval } from "./documents.js";

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
    const approved = await setDocumentApproval(db, workspaceId, doc.id, "approved");
    expect(approved?.approvedAt).toBeInstanceOf(Date);
    const rejected = await setDocumentApproval(db, workspaceId, doc.id, "rejected");
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

  it("hasApprovedMaterials is false with no documents, and false while every document is still draft/rejected", async () => {
    const app = await createApplication(db, { workspaceId, companyName: "Materials Co", jobTitle: "Eng" });
    expect(await hasApprovedMaterials(db, app.id)).toBe(false);

    const draft = await createDocument(db, {
      applicationId: app.id, kind: "cover_letter", contentMd: "Draft", sourceFactIds: [],
    });
    expect(await hasApprovedMaterials(db, app.id)).toBe(false);

    await setDocumentApproval(db, workspaceId, draft.id, "rejected");
    expect(await hasApprovedMaterials(db, app.id)).toBe(false);
  });

  it("hasApprovedMaterials is true once at least one document for the application is approved", async () => {
    const app = await createApplication(db, { workspaceId, companyName: "Materials Co Two", jobTitle: "Eng" });
    const doc = await createDocument(db, {
      applicationId: app.id, kind: "email_body", contentMd: "Draft", sourceFactIds: [],
    });
    await setDocumentApproval(db, workspaceId, doc.id, "approved");
    expect(await hasApprovedMaterials(db, app.id)).toBe(true);
  });

  it("hasApprovedMaterials does not leak an approved document from a different application", async () => {
    const appA = await createApplication(db, { workspaceId, companyName: "Iso A", jobTitle: "Eng" });
    const appB = await createApplication(db, { workspaceId, companyName: "Iso B", jobTitle: "Eng" });
    const doc = await createDocument(db, {
      applicationId: appA.id, kind: "cover_letter", contentMd: "Draft", sourceFactIds: [],
    });
    await setDocumentApproval(db, workspaceId, doc.id, "approved");
    expect(await hasApprovedMaterials(db, appA.id)).toBe(true);
    expect(await hasApprovedMaterials(db, appB.id)).toBe(false);
  });

  it("refuses to approve a document belonging to another workspace", async () => {
    const other = await db.insert(workspaces).values({ name: `t-other-${Date.now()}`, kind: "personal" }).returning();
    const otherId = other[0]!.id;
    try {
      const otherApp = await createApplication(db, { workspaceId: otherId, companyName: "Other Corp", jobTitle: "Eng" });
      const doc = await createDocument(db, {
        applicationId: otherApp.id, kind: "cover_letter", contentMd: "Other workspace draft", sourceFactIds: [],
      });
      const result = await setDocumentApproval(db, workspaceId, doc.id, "approved"); // wrong workspace
      expect(result).toBeNull();
      expect(await hasApprovedMaterials(db, otherApp.id)).toBe(false); // untouched
    } finally {
      await db.delete(workspaces).where(eq(workspaces.id, otherId));
    }
  });
});
