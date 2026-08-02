/**
 * Idempotent seed for the "Alex Demo" persona.
 *
 * Deletes and recreates a workspace named "Alex Demo" (cascades to all its
 * data), then rebuilds candidate facts, CV variants, and a spread of
 * applications across the tracker's states. Application histories are built
 * exclusively by replaying real `transitionApplication` calls (never by
 * writing `state` directly) so the resulting event log is genuine.
 *
 * Run with: DATABASE_URL=postgres://... pnpm --filter @careerhq/db seed
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { ApplicationState, CvFormat, FactCategory, Sensitivity, TransitionTrigger } from "@careerhq/contracts";
import type { TransitionContext } from "@careerhq/core";
import { createApplication, createCvVariant, createDb, createFact, transitionApplication, workspaces } from "./index.js";
import type { Application, Db } from "./index.js";

const DAY_MS = 24 * 60 * 60 * 1000;
function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY_MS);
}
function daysFromNow(n: number): Date {
  return new Date(Date.now() + n * DAY_MS);
}

async function transition(
  db: Db,
  applicationId: string,
  to: ApplicationState,
  trigger: TransitionTrigger,
  ctx?: TransitionContext,
): Promise<Application> {
  const r = await transitionApplication(db, { applicationId, to, trigger, ctx });
  if (!r.ok) throw new Error(r.reason);
  return r.application;
}

function logApp(company: string, title: string, state: ApplicationState): void {
  console.log(`  application: ${company} — ${title} — ${state}`);
}

async function seedFacts(db: Db, workspaceId: string): Promise<void> {
  const facts: Array<{
    category: FactCategory;
    claim: string;
    detail?: string;
    sensitivity?: Sensitivity;
    reviewBy: Date;
  }> = [
    { category: "identity", claim: "Full legal name: Alex Rivera", reviewBy: daysFromNow(180) },
    { category: "identity", claim: "Preferred name: Alex", reviewBy: daysFromNow(180) },
    { category: "contact", claim: "Email: alex.rivera@example.com", reviewBy: daysFromNow(180) },
    { category: "contact", claim: "Phone: +1-555-0142", reviewBy: daysFromNow(180) },
    {
      category: "experience",
      claim: "5 years as backend engineer at Initrode Corp",
      detail: "Led migration to an event-driven architecture serving 2M+ users",
      reviewBy: daysFromNow(180),
    },
    {
      category: "experience",
      claim: "2 years as engineering lead at Hooli",
      detail: "Managed a team of 6 engineers across two product lines",
      reviewBy: daysFromNow(180),
    },
    { category: "education", claim: "B.S. Computer Science, State University", reviewBy: daysFromNow(365) },
    { category: "skill", claim: "Proficient in TypeScript and Node.js", reviewBy: daysFromNow(180) },
    { category: "skill", claim: "Experienced with PostgreSQL and distributed systems", reviewBy: daysFromNow(180) },
    { category: "preference", claim: "Prefers remote-first roles", reviewBy: daysFromNow(180) },
    { category: "preference", claim: "Open to relocation for Series B+ startups", reviewBy: daysFromNow(180) },
    {
      category: "authorization",
      claim: "US work authorization: citizen",
      sensitivity: "sensitive",
      reviewBy: daysFromNow(365),
    },
    {
      category: "compensation",
      claim: "Target base: $140k",
      sensitivity: "sensitive",
      reviewBy: daysFromNow(90),
    },
    { category: "availability", claim: "Available to start within 2 weeks of offer", reviewBy: daysFromNow(180) },
    // Deliberately the one STALE fact: review_by is in the past.
    { category: "availability", claim: "Notice period: 2 weeks", reviewBy: daysAgo(30) },
  ];

  for (const fact of facts) await createFact(db, { workspaceId, ...fact });

  const staleCount = facts.filter((f) => f.reviewBy.getTime() < Date.now()).length;
  const sensitiveCount = facts.filter((f) => f.sensitivity === "sensitive").length;
  console.log(`facts: ${facts.length} seeded (${staleCount} stale, ${sensitiveCount} sensitive)`);
}

async function seedCvVariants(db: Db, workspaceId: string): Promise<void> {
  // The seed runs from packages/db (pnpm --filter runs scripts in the
  // package's own directory), but files should live under the repo root's
  // shared file-storage volume, not inside packages/db. Resolve the repo
  // root from this module's own location rather than trusting cwd.
  const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
  const storageDir = process.env.FILE_STORAGE_DIR ?? "var/files";
  const cvDir = path.join(repoRoot, storageDir, "cvs");
  await mkdir(cvDir, { recursive: true });

  // Minimal valid PDF literal — enough to satisfy "is a real PDF" checks.
  const placeholderPdf = "%PDF-1.4\n"
    + "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    + "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    + "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n"
    + "trailer<</Root 1 0 R>>\n"
    + "%%EOF";

  const specs: Array<{ label: string; format: CvFormat; filename: string }> = [
    { label: "Alex Rivera — Designed", format: "designed", filename: "alex-demo-designed.pdf" },
    { label: "Alex Rivera — ATS", format: "ats", filename: "alex-demo-ats.pdf" },
  ];

  for (const spec of specs) {
    const filePath = path.join(cvDir, spec.filename);
    await writeFile(filePath, placeholderPdf, "utf-8");
    const sha256 = createHash("sha256").update(placeholderPdf, "utf-8").digest("hex");
    await createCvVariant(db, { workspaceId, label: spec.label, format: spec.format, filePath, sha256 });
  }
  console.log(`cv variants: ${specs.length} seeded under ${cvDir}`);
}

async function seedApplications(db: Db, workspaceId: string): Promise<void> {
  // 1. DISCOVERED — create only.
  {
    const company = "Lumon Industries";
    const title = "Senior Software Engineer";
    await createApplication(db, { workspaceId, companyName: company, jobTitle: title });
    logApp(company, title, "DISCOVERED");
  }

  // 2. SHORTLISTED — 1 transition.
  {
    const company = "Initech";
    const title = "Platform Engineer";
    let app = await createApplication(db, { workspaceId, companyName: company, jobTitle: title });
    app = await transition(db, app.id, "SHORTLISTED", "user");
    logApp(company, title, app.state);
  }

  // 3 & 4. PREPARING — 2 transitions each.
  for (const [company, title] of [
    ["Hooli", "Backend Engineer"],
    ["Pied Piper", "Founding Engineer"],
  ] as const) {
    let app = await createApplication(db, { workspaceId, companyName: company, jobTitle: title });
    app = await transition(db, app.id, "SHORTLISTED", "user");
    app = await transition(db, app.id, "PREPARING", "user");
    logApp(company, title, app.state);
  }

  // 5. READY_FOR_REVIEW — 3 transitions, last requires materials.
  {
    const company = "Globex";
    const title = "Staff Engineer";
    let app = await createApplication(db, { workspaceId, companyName: company, jobTitle: title });
    app = await transition(db, app.id, "SHORTLISTED", "user");
    app = await transition(db, app.id, "PREPARING", "user");
    app = await transition(db, app.id, "READY_FOR_REVIEW", "user", { hasMaterials: true });
    logApp(company, title, app.state);
  }

  // 6. SUBMITTED (recent) — external/manual submission.
  {
    const company = "Wonka Data";
    const title = "Data Engineer";
    const app = await createApplication(db, {
      workspaceId, companyName: company, jobTitle: title,
      asExternalSubmitted: true, submittedAt: daysAgo(1),
    });
    logApp(company, title, app.state);
  }

  // 7. SUBMITTED (8 days ago) — overdue follow-up.
  {
    const company = "Stark Cloud";
    const title = "Cloud Infrastructure Engineer";
    const app = await createApplication(db, {
      workspaceId, companyName: company, jobTitle: title,
      asExternalSubmitted: true, submittedAt: daysAgo(8),
    });
    logApp(company, title, app.state);
  }

  // 8. INTERVIEW — external-submitted, then SUBMITTED → INTERVIEW.
  {
    const company = "Acme Analytics";
    const title = "Analytics Engineer";
    let app = await createApplication(db, {
      workspaceId, companyName: company, jobTitle: title,
      asExternalSubmitted: true, submittedAt: daysAgo(20),
    });
    app = await transition(db, app.id, "INTERVIEW", "user");
    logApp(company, title, app.state);
  }

  // 9. OFFER — external-submitted → INTERVIEW → OFFER.
  {
    const company = "Umbrella Health";
    const title = "Principal Engineer";
    let app = await createApplication(db, {
      workspaceId, companyName: company, jobTitle: title,
      asExternalSubmitted: true, submittedAt: daysAgo(35),
    });
    app = await transition(db, app.id, "INTERVIEW", "user");
    app = await transition(db, app.id, "OFFER", "user");
    logApp(company, title, app.state);
  }

  // 10. REJECTED — create then user REJECTED.
  {
    const company = "Vandelay Systems";
    const title = "Import/Export Systems Engineer";
    let app = await createApplication(db, { workspaceId, companyName: company, jobTitle: title });
    app = await transition(db, app.id, "REJECTED", "user");
    logApp(company, title, app.state);
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Refusing to seed. Example:");
    console.error('  DATABASE_URL=postgres://careerhq:careerhq@localhost:5432/careerhq pnpm seed');
    process.exitCode = 1;
    return;
  }

  const db = createDb(url);
  try {
    await db.delete(workspaces).where(eq(workspaces.name, "Alex Demo"));
    const [ws] = await db.insert(workspaces).values({ name: "Alex Demo", kind: "personal" }).returning();
    if (!ws) throw new Error("failed to create the Alex Demo workspace");
    console.log(`workspace: Alex Demo (${ws.id})`);

    await seedFacts(db, ws.id);
    await seedCvVariants(db, ws.id);
    console.log("applications:");
    await seedApplications(db, ws.id);

    console.log("seed complete.");
  } finally {
    await db.$client.end();
  }
}

main().catch((err: unknown) => {
  console.error("seed failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
