/**
 * The hosted demo's workspace (spec P6 §3).
 *
 * Wipes and rebuilds the sandbox workspace named `DEMO_WORKSPACE_NAME`, which
 * is the workspace `getActiveWorkspace`/`getPersonalWorkspaceId` resolve when
 * `DEMO_MODE` is on. Unlike `seed.ts` (the quickstart's personal "Alex Demo"
 * workspace, run by hand) this one is called on a schedule by the worker's
 * `demo.reset` job, so it has to be safe to run against a database that also
 * holds real data:
 *
 *   - it deletes strictly by `kind = "sandbox" AND name = DEMO_WORKSPACE_NAME`,
 *     never "every sandbox workspace" — a self-hoster who misconfigures a demo
 *     worker must not lose a personal workspace, and the e2e suites' own
 *     sandbox fixtures must survive too;
 *   - every state it produces is replayed through the real repository calls
 *     and the real guards (`transitionApplication`, `recordPreview` →
 *     `beginSubmission` → `completeSubmission`), never by writing a `state` or
 *     `status` column directly, so the event log a visitor reads is genuine;
 *   - the "AI-generated" documents, answers and re-rank rationales are seeded
 *     content. The demo runs with no `OPENROUTER_API_KEY` (the deterministic
 *     floor), so nothing here may depend on a live model.
 *
 * Everything is fictional: the demo is public and holds zero real personal data.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import type {
  ApplicationState, CanonicalForm, CvFormat, FactCategory, NormalizedJob, PlannedAnswer,
  RemoteMode, ScoringProfile, Sensitivity, SmtpConfig, TransitionTrigger,
} from "@careerhq/contracts";
import { DEFAULT_SCORING_PROFILE } from "@careerhq/contracts";
import type { TransitionContext } from "@careerhq/core";
import {
  CONFIRMATION_TTL_MS, generateConfirmationToken, hashConfirmationToken, payloadFingerprint,
} from "@careerhq/core/gates";
import type { Db } from "./client.js";
import { candidateFacts, jobs, workspaces } from "./schema/index.js";
import { approveAnswer, createAnswer } from "./repos/answers.js";
import {
  beginSubmission, completeSubmission, createSiteAttempt, getActiveConfirmation, recordPreview,
} from "./repos/attempts.js";
import { createApplication, transitionApplication } from "./repos/applications.js";
import { createCvVariant } from "./repos/cv-variants.js";
import {
  applyRerank, promoteJob, recordIngestRun, saveScoringProfile, scoreInboxJobs,
  upsertNormalizedJobs,
} from "./repos/discovery.js";
import { createDocument, setDocumentApproval } from "./repos/documents.js";
import { createEmailConnection } from "./repos/email-connections.js";
import { recordOutboundMessage, setClassification, upsertInboundMessage } from "./repos/email-messages.js";
import { createFact } from "./repos/facts.js";
import { saveFormSnapshot } from "./repos/form-snapshots.js";

/**
 * The demo workspace's name. Load-bearing, not cosmetic: it is half of the
 * predicate that both selects the demo workspace (apps/web and apps/worker's
 * `workspace.ts`) and scopes this seed's delete. Changing it orphans the
 * existing demo workspace rather than resetting it.
 */
export const DEMO_WORKSPACE_NAME = "CareerHQ Demo";

/** The compose service name of the local mail sink — mirrors the config default. */
const DEFAULT_SANDBOX_SMTP_HOST = "mailpit";
/** The compose service name of the fictional ATS — mirrors the config default. */
const DEFAULT_DEMO_ATS_URL = "http://demo-ats:3001";

export interface SeedDemoWorkspaceOptions {
  /** Absolute FILE_STORAGE_DIR: CV files and the submission screenshot are written under it. */
  fileStorageDir: string;
  /**
   * base64 32-byte master key. When absent the mailbox and its message thread
   * are skipped entirely rather than faked: the seeded credential goes through
   * the same libsodium seal path as a user-configured one, and an unopenable
   * credential would be worse than no mailbox at all.
   */
  masterKeyB64?: string | null;
  /** The only SMTP host a sandbox workspace may submit to; defaults to Mailpit's service name. */
  sandboxSmtpHost?: string;
  /** Base URL of the fictional ATS the seeded auto-apply receipt points at. */
  demoAtsUrl?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY_MS);
const daysFromNow = (n: number): Date => new Date(Date.now() + n * DAY_MS);

/** Throws on a refused transition: the seed's own scripts must never be illegal. */
async function transition(
  db: Db,
  applicationId: string,
  to: ApplicationState,
  trigger: TransitionTrigger,
  ctx?: TransitionContext,
): Promise<string> {
  const result = await transitionApplication(db, { applicationId, to, trigger, ctx });
  if (!result.ok) throw new Error(`demo seed: ${applicationId} → ${to} refused: ${result.reason}`);
  return result.application.id;
}

// ---------------------------------------------------------------------------
// The Alex Demo persona
// ---------------------------------------------------------------------------

interface DemoFact {
  category: FactCategory;
  claim: string;
  detail?: string;
  sensitivity?: Sensitivity;
  reviewBy: Date;
}

function demoFacts(): DemoFact[] {
  return [
    { category: "identity", claim: "Full legal name: Alex Demo", reviewBy: daysFromNow(180) },
    { category: "identity", claim: "Preferred name: Alex", reviewBy: daysFromNow(180) },
    { category: "contact", claim: "Email: alex.demo@example.com", reviewBy: daysFromNow(180) },
    { category: "contact", claim: "Phone: +1-555-0100", reviewBy: daysFromNow(180) },
    { category: "contact", claim: "Portfolio: https://alex.example.com", reviewBy: daysFromNow(365) },
    {
      category: "experience",
      claim: "6 years as a backend engineer at Northwind Robotics",
      detail: "Owned the order-routing service: TypeScript on Node, PostgreSQL, ~2M events/day.",
      reviewBy: daysFromNow(180),
    },
    {
      category: "experience",
      claim: "2 years as engineering lead at Vertex Logistics",
      detail: "Led a team of five across the dispatch and billing product lines.",
      reviewBy: daysFromNow(180),
    },
    {
      category: "experience",
      claim: "Migrated a monolith to event-driven services with zero customer-visible downtime",
      detail: "Strangler-fig migration over nine months; cut p99 checkout latency from 1.9s to 340ms.",
      reviewBy: daysFromNow(180),
    },
    { category: "education", claim: "B.Sc. Computer Science, Riverbank University", reviewBy: daysFromNow(365) },
    { category: "skill", claim: "TypeScript and Node.js, production, six years", reviewBy: daysFromNow(180) },
    { category: "skill", claim: "PostgreSQL: schema design, query tuning, logical replication", reviewBy: daysFromNow(180) },
    { category: "skill", claim: "Kubernetes and Terraform for service deployment", reviewBy: daysFromNow(180) },
    { category: "preference", claim: "Prefers remote-first teams in European time zones", reviewBy: daysFromNow(180) },
    { category: "preference", claim: "Open to relocation for a Series B or later company", reviewBy: daysFromNow(180) },
    {
      category: "authorization",
      claim: "EU work authorization: citizen, no sponsorship required",
      sensitivity: "sensitive",
      reviewBy: daysFromNow(365),
    },
    {
      category: "compensation",
      claim: "Target base: €110k",
      sensitivity: "sensitive",
      reviewBy: daysFromNow(90),
    },
    { category: "availability", claim: "Available four weeks after signing", reviewBy: daysFromNow(180) },
    // Deliberately the one STALE fact: `review_by` is in the past, so the demo
    // shows the fact bank's staleness badge and the re-verify flow.
    { category: "availability", claim: "Notice period: 4 weeks", reviewBy: daysAgo(21) },
  ];
}

async function seedFacts(db: Db, workspaceId: string): Promise<void> {
  for (const fact of demoFacts()) await createFact(db, { workspaceId, ...fact });
}

/** Minimal valid PDF literal — enough to satisfy "is a real PDF" checks. */
const PLACEHOLDER_PDF = "%PDF-1.4\n"
  + "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
  + "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
  + "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n"
  + "trailer<</Root 1 0 R>>\n"
  + "%%EOF";

/**
 * A 1×1 PNG. The submission receipt's evidence link has to resolve to a real
 * file for the attempt to look genuine; the readable screenshots the README
 * ships are captured from the running demo by `pnpm demo:media`, not from here.
 */
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** Fixed filenames, so six-hourly resets rewrite the same files instead of piling up. */
async function seedCvVariants(db: Db, workspaceId: string, fileStorageDir: string): Promise<string> {
  const cvDir = path.join(fileStorageDir, "cvs");
  await mkdir(cvDir, { recursive: true });

  const specs: Array<{ label: string; format: CvFormat; filename: string }> = [
    { label: "Alex Demo — Designed", format: "designed", filename: "alex-demo-designed.pdf" },
    { label: "Alex Demo — ATS-safe", format: "ats", filename: "alex-demo-ats.pdf" },
  ];

  const sha256 = createHash("sha256").update(PLACEHOLDER_PDF, "utf-8").digest("hex");
  let atsVariantId = "";
  for (const spec of specs) {
    const filePath = path.join(cvDir, spec.filename);
    await writeFile(filePath, PLACEHOLDER_PDF, "utf-8");
    const variant = await createCvVariant(db, {
      workspaceId, label: spec.label, format: spec.format, filePath, sha256,
    });
    if (spec.format === "ats") atsVariantId = variant.id;
  }
  return atsVariantId;
}

// ---------------------------------------------------------------------------
// Discovery inbox
// ---------------------------------------------------------------------------

const DEMO_SCORING_PROFILE: ScoringProfile = {
  ...DEFAULT_SCORING_PROFILE,
  roles: ["backend engineer", "platform engineer", "staff engineer", "founding engineer", "full-stack"],
  stack: ["typescript", "node", "postgres", "kubernetes"],
  boost: ["remote-first", "developer tools", "event-driven"],
  exclude: ["security clearance", "onsite only"],
};

/** `[company, title, location, remoteMode, salary, description]`. */
type JobSeed = readonly [string, string, string, RemoteMode, string, string];

const DEMO_JOB_SEEDS: readonly JobSeed[] = [
  ["Aurora Robotics", "Senior Backend Engineer", "Remote (EU)", "remote", "€95k–€120k", "TypeScript and Node services on Postgres. Event-driven fleet telemetry at scale."],
  ["Kingsley Logistics", "Platform Engineer", "Remote (EU)", "remote", "€90k–€110k", "Kubernetes, Terraform and a TypeScript control plane for a remote-first team."],
  ["Halcyon Data", "Staff Engineer, Data Platform", "Remote (EU)", "remote", "€120k–€140k", "Postgres, streaming ingest and developer tools for analytics engineers."],
  ["Lumen Health", "Founding Engineer", "Berlin / Remote", "remote", "€100k–€130k + equity", "Greenfield TypeScript stack. Event-driven clinical workflows, Postgres of record."],
  ["Ostrich Payments", "Backend Engineer, Ledger", "Remote (EU)", "remote", "€85k–€105k", "Double-entry ledger in Node and Postgres. Correctness over throughput."],
  ["Brightline Labs", "Full-Stack Engineer", "Remote (EU)", "remote", "€80k–€100k", "Next.js and Node, Postgres, developer tools for research teams."],
  ["Cobalt Freight", "Senior Platform Engineer", "Rotterdam / Remote", "remote", "€95k–€115k", "Kubernetes platform, TypeScript tooling, event-driven dispatch."],
  ["Meridian Studio", "Backend Engineer", "Remote (EU)", "remote", "€75k–€95k", "Node and Postgres behind a design collaboration product."],
  ["Fathom Analytics Co", "Staff Backend Engineer", "Remote (Global)", "remote", "$140k–$170k", "TypeScript services, Postgres, remote-first culture and async writing."],
  ["Pinewood Systems", "Platform Engineer", "Remote (EU)", "remote", "€88k–€108k", "Terraform, Kubernetes and a Node control plane. Developer tools focus."],
  ["Kestrel Mobility", "Senior Software Engineer", "Amsterdam / Remote", "remote", "€92k–€112k", "Event-driven routing services in TypeScript on Postgres."],
  ["Solace Commerce", "Backend Engineer, Checkout", "Remote (EU)", "remote", "€82k–€102k", "Node, Postgres, idempotent payment flows."],
  ["Thornbury AI", "Founding Engineer", "London / Remote", "remote", "£90k–£115k + equity", "TypeScript end to end. Developer tools for model evaluation."],
  ["Granite Ledger", "Staff Engineer", "Remote (EU)", "remote", "€115k–€135k", "Postgres, event sourcing, Kubernetes. Remote-first since day one."],
  ["Orchard Retail", "Full-Stack Engineer", "Dublin / Remote", "remote", "€78k–€96k", "Next.js, Node and Postgres for a multi-tenant storefront."],
  ["Bluewave Energy", "Backend Engineer", "Remote (EU)", "remote", "€84k–€104k", "Time-series ingest in Node, Postgres and TimescaleDB."],
  ["Juniper Legal", "Senior Backend Engineer", "Remote (EU)", "remote", "€90k–€108k", "TypeScript document pipeline on Postgres. Strong review culture."],
  ["Aster Biotech", "Platform Engineer", "Zurich / Remote", "remote", "CHF 120k–140k", "Kubernetes, Terraform, internal developer tools."],
  ["Redwood Insurance", "Backend Engineer", "Remote (EU)", "remote", "€80k–€98k", "Node services, Postgres, event-driven claims processing."],
  ["Quill Publishing", "Full-Stack Engineer", "Remote (EU)", "remote", "€72k–€90k", "TypeScript, Next.js and Postgres for an editorial platform."],
  ["Sentinel Grid", "Senior Backend Engineer", "Remote (US)", "unknown", "$150k–$180k", "Distributed systems in Node. Requires an active security clearance."],
  ["Ironclad Defence", "Platform Engineer", "Bristol", "onsite", "£75k–£95k", "Onsite only. Kubernetes and Terraform for classified workloads."],
  ["Copper Kitchen", "Software Engineer", "Lisbon", "hybrid", "€55k–€70k", "PHP and MySQL for a restaurant booking product."],
  ["Alder Robotics", "Embedded Engineer", "Munich", "onsite", "€70k–€88k", "C++ firmware for warehouse robots. Onsite only."],
  ["Nimbus Travel", "Frontend Engineer", "Remote (EU)", "remote", "€70k–€88k", "React and TypeScript. Design-system heavy, little backend work."],
  ["Foxglove Media", "Data Engineer", "Remote (EU)", "remote", "€78k–€95k", "Python, dbt and Snowflake. Some Postgres."],
  ["Beacon Education", "Backend Engineer", "Remote (EU)", "remote", "€76k–€94k", "Ruby on Rails with Postgres. Migrating parts to Node."],
  ["Marlowe Fintech", "Senior Engineer, Core Banking", "Remote (EU)", "remote", "€100k–€125k", "Kotlin and Postgres. Event-driven ledger, remote-first."],
  ["Harborview Games", "Backend Engineer", "Remote (Global)", "remote", "$110k–$135k", "Go services on Postgres for live multiplayer."],
  ["Wren Accounting", "Full-Stack Engineer", "Remote (EU)", "remote", "€74k–€92k", "TypeScript, Node, Postgres. Small remote-first team."],
];

function normalizedJobs(): Array<{ job: NormalizedJob; contentHash: string }> {
  return DEMO_JOB_SEEDS.map(([companyName, title, location, remoteMode, salaryRaw, descriptionMd], index) => {
    const externalId = `demo-${String(index + 1).padStart(3, "0")}`;
    const job: NormalizedJob = {
      source: "demo",
      externalId,
      url: `https://boards.example.com/${externalId}`,
      title,
      companyName,
      location,
      remoteMode,
      salaryRaw,
      descriptionMd,
      postedAt: daysAgo((index % 14) + 1),
    };
    return {
      job,
      contentHash: createHash("sha256").update(`${companyName}\n${title}\n${descriptionMd}`).digest("hex"),
    };
  });
}

/** Seeded, not generated: the demo deploys with no OpenRouter key. */
const RERANK_NOTES: readonly (readonly [string, readonly string[]])[] = [
  ["Strong match: remote-first, TypeScript and Postgres in the core stack, and the ownership level matches six years of backend work.", []],
  ["Good match on stack and seniority. The platform remit is broader than Alex's last role, which is the stated direction of travel.", []],
  ["Close match. Staff scope and event-driven Postgres work line up with the Northwind migration story.", ["salary band is above the target, so expect a levelling conversation"]],
  ["Founding-engineer scope with a TypeScript stack; equity-heavy package needs weighing against the €110k base target.", ["compensation is partly equity"]],
  ["Ledger correctness work is a good fit for the Postgres depth, though the domain is new.", []],
  ["Solid full-stack match, but the seniority reads a step below the current role.", ["level may be junior to the target"]],
  ["Kubernetes platform work with an event-driven core — a direct match for the dispatch experience.", []],
  ["Reasonable match on stack; the product domain is further from anything in the fact bank.", []],
  ["Remote-global and TypeScript-first with an explicit async-writing culture, which matches the stated preference.", []],
  ["Developer-tools focus and a Terraform/Kubernetes platform; slightly less backend depth than the target role.", []],
];

/** Kingsley Logistics, Brightline Labs, Kestrel Mobility — see `seedDiscovery`. */
const PROMOTED_EXTERNAL_IDS = ["demo-002", "demo-006", "demo-011"] as const;

async function seedDiscovery(db: Db, workspaceId: string): Promise<string[]> {
  await saveScoringProfile(db, workspaceId, DEMO_SCORING_PROFILE);

  const items = normalizedJobs();
  const startedAt = new Date(Date.now() - 90_000);
  const result = await upsertNormalizedJobs(db, workspaceId, items);
  await scoreInboxJobs(db, workspaceId, DEMO_SCORING_PROFILE);
  await recordIngestRun(db, {
    workspaceId, source: "demo", startedAt, finishedAt: new Date(Date.now() - 60_000),
    fetched: items.length, inserted: result.inserted, updated: result.updated, duplicates: result.duplicates,
  });

  // The re-rank the demo shows is a recorded one. `applyRerank` clears the LLM
  // columns for every inbox job outside the batch, so this runs before any job
  // is promoted out of the inbox — otherwise the promoted rows would keep a
  // score the inbox no longer explains.
  const scored = await db.select({
    id: jobs.id, externalId: jobs.externalId, keywordScore: jobs.keywordScore,
  }).from(jobs)
    .where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.status, "inbox")))
    // `external_id` is a stable, zero-padded ordinal, so ties in the keyword
    // score resolve the same way on every reset — the demo tells one story.
    .orderBy(asc(jobs.externalId));
  const top = [...scored]
    .sort((a, b) => (b.keywordScore ?? 0) - (a.keywordScore ?? 0))
    .slice(0, RERANK_NOTES.length);
  await applyRerank(db, workspaceId, top.map((row, i) => {
    const [rationale, redFlags] = RERANK_NOTES[i]!;
    return { jobId: row.id, score: 96 - i * 4, rationale, redFlags: [...redFlags] };
  }));

  // These three listings become applications, so the demo shows the discovery →
  // promote hand-off with its `promotedFrom: "discovery"` event. Chosen by
  // external id rather than by rank so the reset is reproducible, and no
  // company here appears in `seedApplications` — a listing sitting in the inbox
  // while an application for the same role exists reads as a bug on camera.
  return PROMOTED_EXTERNAL_IDS.map((externalId) => {
    const row = scored.find((job) => job.externalId === externalId);
    if (!row) throw new Error(`demo seed: no discovery job ${externalId} to promote`);
    return row.id;
  });
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

/** Named once: the cover letter, the parsed form and the receipt must all agree. */
const SITE_SUBMISSION_COMPANY = "Wexford Health";

/** Everything downstream steps need to attach documents, answers and attempts to. */
interface SeededApplications {
  readyForReview: string;
  siteSubmission: string;
  overdueFollowUp: string;
  acknowledged: string;
}

async function seedApplications(
  db: Db,
  workspaceId: string,
  promotableJobIds: string[],
): Promise<SeededApplications> {
  // 1–3: promoted straight out of the discovery inbox.
  const promoted: string[] = [];
  for (const jobId of promotableJobIds) {
    const outcome = await promoteJob(db, workspaceId, jobId);
    if (!outcome.ok) throw new Error(`demo seed: promote refused: ${outcome.reason}`);
    promoted.push(outcome.applicationId);
  }
  if (promoted.length < 3) throw new Error("demo seed: expected three promotable discovery jobs");
  // promoted[0] stays DISCOVERED.
  await transition(db, promoted[1]!, "SHORTLISTED", "user");
  await transition(db, promoted[2]!, "SHORTLISTED", "user");
  await transition(db, promoted[2]!, "PREPARING", "user");

  // 4–12 are applications Alex logged before the discovery inbox existed, so
  // every company below is deliberately absent from `DEMO_JOB_SEEDS`: a listing
  // sitting in the inbox beside an application for the same role would read as
  // a duplicate-detection bug rather than as two halves of one story.

  // 4: READY_FOR_REVIEW, email channel — the approved email body is added by
  // `seedMaterials` before the guarded transition that requires materials.
  const readyForReview = (await createApplication(db, {
    workspaceId, companyName: "Silvermark Labs", jobTitle: "Staff Engineer, Data Platform",
    jobUrl: "https://careers.silvermark.example.com/staff-data-platform",
  })).id;
  await transition(db, readyForReview, "SHORTLISTED", "user");
  await transition(db, readyForReview, "PREPARING", "user");

  // 5: the auto-apply story — driven all the way to SUBMITTED by `seedSiteAttempt`.
  const siteSubmission = (await createApplication(db, {
    workspaceId, companyName: SITE_SUBMISSION_COMPANY, jobTitle: "Founding Engineer",
    jobUrl: "https://careers.wexford-health.example.com/founding-engineer",
  })).id;
  await transition(db, siteSubmission, "SHORTLISTED", "user");
  await transition(db, siteSubmission, "PREPARING", "user");

  // 6: submitted 9 days ago — past the follow-up window, so the overview's
  // "due follow-ups" panel has something in it.
  const overdueFollowUp = (await createApplication(db, {
    workspaceId, companyName: "Tideline Freight", jobTitle: "Senior Platform Engineer",
    asExternalSubmitted: true, submittedAt: daysAgo(9),
  })).id;

  // 7: submitted, then acknowledged.
  const acknowledged = (await createApplication(db, {
    workspaceId, companyName: "Larkspur Payments", jobTitle: "Backend Engineer, Ledger",
    asExternalSubmitted: true, submittedAt: daysAgo(18),
  })).id;
  await transition(db, acknowledged, "ACKNOWLEDGED", "user");

  // 8: interviewing.
  const interviewing = (await createApplication(db, {
    workspaceId, companyName: "Ashgrove Systems", jobTitle: "Staff Engineer",
    asExternalSubmitted: true, submittedAt: daysAgo(26),
  })).id;
  await transition(db, interviewing, "INTERVIEW", "user");

  // 9: offer in hand.
  const offered = (await createApplication(db, {
    workspaceId, companyName: "Hollis Bank", jobTitle: "Senior Engineer, Core Banking",
    asExternalSubmitted: true, submittedAt: daysAgo(41),
  })).id;
  await transition(db, offered, "INTERVIEW", "user");
  await transition(db, offered, "OFFER", "user");

  // 10: rejected.
  const rejected = (await createApplication(db, {
    workspaceId, companyName: "Ridgeway Defence", jobTitle: "Senior Backend Engineer",
  })).id;
  await transition(db, rejected, "REJECTED", "user");

  // 11: withdrawn after shortlisting.
  const withdrawn = (await createApplication(db, {
    workspaceId, companyName: "Saffron Bistro Group", jobTitle: "Software Engineer",
  })).id;
  await transition(db, withdrawn, "SHORTLISTED", "user");
  await transition(db, withdrawn, "WITHDRAWN", "user");

  // 12: expired by the system while still sitting in the pipeline.
  const expired = (await createApplication(db, {
    workspaceId, companyName: "Windrose Travel", jobTitle: "Frontend Engineer",
  })).id;
  await transition(db, expired, "EXPIRED", "system");

  return { readyForReview, siteSubmission, overdueFollowUp, acknowledged };
}

// ---------------------------------------------------------------------------
// Materials, answers
// ---------------------------------------------------------------------------

const COVER_LETTER_MD = `Dear Wexford Health team,

I have spent six years building backend systems in TypeScript and Node, most
recently owning Northwind Robotics' order-routing service — roughly two million
events a day on PostgreSQL. The part of that work I would bring here is the
migration itself: a strangler-fig move from a monolith to event-driven services
over nine months, with no customer-visible downtime and p99 checkout latency
down from 1.9s to 340ms.

Your founding-engineer role reads as greenfield TypeScript with PostgreSQL as
the record of truth and event-driven clinical workflows on top. That is the
shape of system I have spent the last two years unpicking and rebuilding, and I
would rather build the second version than maintain the first.

I am remote-first in a European time zone and can start four weeks after
signing.

Alex Demo`;

const EMAIL_BODY_MD = `Hello,

I am applying for the Staff Engineer, Data Platform role. My background is six
years of backend engineering in TypeScript and Node on PostgreSQL, including two
years leading a team of five at Vertex Logistics.

The closest match to your posting is the streaming-ingest work I did at
Northwind Robotics: an event-driven pipeline handling about two million events a
day, with the analytics tooling that let non-platform engineers query it safely.

My CV is attached. I am happy to walk through any of the above.

Alex Demo`;

/**
 * Documents and reusable answers carry `sourceFactIds` because the UI renders a
 * provenance chip per source fact — an approved document with no sources would
 * render as ungrounded, which is exactly what the fact bank exists to prevent.
 */
async function seedMaterials(
  db: Db,
  workspaceId: string,
  apps: SeededApplications,
  factIds: string[],
): Promise<void> {
  const sources = factIds.slice(0, 4);

  const emailBody = await createDocument(db, {
    applicationId: apps.readyForReview, kind: "email_body", contentMd: EMAIL_BODY_MD,
    sourceFactIds: sources, model: "seeded/demo", origin: "ai",
  });
  await setDocumentApproval(db, workspaceId, emailBody.id, "approved");
  // A second, still-unapproved draft so the materials panel shows both states.
  await createDocument(db, {
    applicationId: apps.readyForReview, kind: "cover_letter",
    contentMd: "A shorter cover letter, still in draft — approve or reject it from the materials panel.",
    sourceFactIds: sources.slice(0, 2), model: "seeded/demo", origin: "ai",
  });

  const coverLetter = await createDocument(db, {
    applicationId: apps.siteSubmission, kind: "cover_letter", contentMd: COVER_LETTER_MD,
    sourceFactIds: sources, model: "seeded/demo", origin: "ai",
  });
  await setDocumentApproval(db, workspaceId, coverLetter.id, "approved");

  // The approved email body is what makes PREPARING → READY_FOR_REVIEW legal.
  await transition(db, apps.readyForReview, "READY_FOR_REVIEW", "user", { hasMaterials: true });
}

async function seedAnswers(db: Db, workspaceId: string, apps: SeededApplications, factIds: string[]): Promise<void> {
  const reusable = [
    {
      questionRaw: "Why do you want to work here?",
      answer: "I want to build the second version of a system rather than maintain the first. "
        + "Your posting describes greenfield TypeScript with PostgreSQL as the record of truth, "
        + "which is the shape of system I spent nine months migrating towards at Northwind Robotics.",
    },
    {
      questionRaw: "Do you require visa sponsorship?",
      answer: "No — I hold EU citizenship and require no sponsorship.",
    },
  ];

  for (const [index, spec] of reusable.entries()) {
    const answer = await createAnswer(db, {
      applicationId: apps.siteSubmission,
      questionRaw: spec.questionRaw,
      answer: spec.answer,
      origin: index === 1 ? "deterministic" : "ai",
      sourceFactIds: factIds.slice(index, index + 2),
      confidence: index === 1 ? 1 : 0.82,
      sensitivity: index === 1 ? "sensitive" : "normal",
    });
    await approveAnswer(db, workspaceId, answer.id, { reusable: true });
  }

  // One answer still awaiting a decision, so the review queue is not empty.
  await createAnswer(db, {
    applicationId: apps.readyForReview,
    questionRaw: "Describe a system you designed end to end.",
    answer: "The order-routing service at Northwind Robotics: event-driven, PostgreSQL of record, "
      + "roughly two million events a day. I owned it from design through to on-call.",
    origin: "ai",
    sourceFactIds: factIds.slice(0, 2),
    confidence: 0.74,
  });
}

// ---------------------------------------------------------------------------
// Mailbox (Mailpit only)
// ---------------------------------------------------------------------------

const DEMO_MAILBOX_PASSWORD = "mailpit-has-no-auth";

/**
 * A send-only connection pointing at Mailpit, the only SMTP host a sandbox
 * workspace may reach. There is deliberately no IMAP config: Mailpit speaks
 * SMTP and POP3, not IMAP, so a configured mailbox would leave the worker's
 * `email.sync` job failing every 15 minutes and the connection's health badge
 * red. The inbound thread below is written through the same repo calls the
 * sync job uses, so the inbox panel is explorable regardless.
 */
async function seedMailbox(
  db: Db,
  workspaceId: string,
  apps: SeededApplications,
  smtpHost: string,
  masterKeyB64: string,
): Promise<void> {
  const smtp: SmtpConfig = { host: smtpHost, port: 1025, username: "alex.demo@example.com", tls: "none" };
  const connection = await createEmailConnection(db, {
    workspaceId,
    label: "Demo mailbox (Mailpit)",
    fromAddress: "alex.demo@example.com",
    displayName: "Alex Demo",
    smtp,
    smtpPassword: DEMO_MAILBOX_PASSWORD,
    retention: { mode: "metadata_only" },
    masterKeyB64,
  });

  const threads = [
    {
      applicationId: apps.overdueFollowUp,
      outboundId: "<demo-tideline-application@careerhq.example.com>",
      outboundSubject: "Application: Senior Platform Engineer — Alex Demo",
      to: "careers@tideline-freight.example.com",
      sentAt: daysAgo(9),
      reply: {
        messageId: "<demo-tideline-reply@tideline-freight.example.com>",
        from: "hiring@tideline-freight.example.com",
        subject: "Re: Application: Senior Platform Engineer — Alex Demo",
        snippet: "Thanks for applying. We would like to set up a first call next week — "
          + "are you free Tuesday or Thursday afternoon?",
        receivedAt: daysAgo(1),
      },
      classification: {
        classification: "interview" as const,
        confidence: 0.86,
        suggestedTransition: "INTERVIEW" as const,
        suggestionState: "pending" as const,
        quotedEvidence: "we would like to set up a first call next week",
      },
    },
    {
      applicationId: apps.acknowledged,
      outboundId: "<demo-larkspur-application@careerhq.example.com>",
      outboundSubject: "Application: Backend Engineer, Ledger — Alex Demo",
      to: "jobs@larkspur-payments.example.com",
      sentAt: daysAgo(18),
      reply: {
        messageId: "<demo-larkspur-reply@larkspur-payments.example.com>",
        from: "jobs@larkspur-payments.example.com",
        subject: "Re: Application: Backend Engineer, Ledger — Alex Demo",
        snippet: "We have received your application and passed it to the hiring team.",
        receivedAt: daysAgo(17),
      },
      classification: {
        classification: "ack" as const,
        confidence: 0.94,
        suggestedTransition: "ACKNOWLEDGED" as const,
        suggestionState: "accepted" as const,
        quotedEvidence: "We have received your application",
      },
    },
  ];

  for (const thread of threads) {
    await recordOutboundMessage(db, {
      workspaceId, connectionId: connection.id, messageId: thread.outboundId,
      toAddrs: [thread.to], subject: thread.outboundSubject, applicationId: thread.applicationId,
      // Backdated to the day the application was submitted, so the thread reads
      // in order: `listMessagesForApplication` sorts on `received_at`, and a
      // reply that predates the message it answers looks broken on screen.
      sentAt: thread.sentAt,
    });
    const { id } = await upsertInboundMessage(db, {
      workspaceId,
      connectionId: connection.id,
      msg: {
        messageId: thread.reply.messageId,
        inReplyTo: thread.outboundId,
        references: [thread.outboundId],
        fromAddr: thread.reply.from,
        toAddrs: ["alex.demo@example.com"],
        subject: thread.reply.subject,
        date: thread.reply.receivedAt,
        textSnippet: thread.reply.snippet,
      },
      applicationId: thread.applicationId,
      matchMethod: "headers",
      bodyRef: null,
      ...(thread.classification.suggestionState === "pending" ? { suggestionSeed: { suggestionState: "pending" as const } } : {}),
    });
    await setClassification(db, id, thread.classification);
  }
}

// ---------------------------------------------------------------------------
// The auto-apply receipt
// ---------------------------------------------------------------------------

function demoCanonicalForm(url: string): CanonicalForm {
  return {
    atsType: "generic",
    parserVersion: "generic-1",
    url,
    requisitionKey: "demo-ats:founding-engineer",
    title: "Founding Engineer",
    companyName: SITE_SUBMISSION_COMPANY,
    totalSteps: 3,
    parseConfidence: 0.93,
    blockers: [],
    fields: [
      { id: "f-name", kind: "text", label: "Full name", helpText: "", required: true, options: [], step: 0, canonicalField: "full_name", mappingConfidence: 0.98, sensitive: false },
      { id: "f-email", kind: "email", label: "Email", helpText: "", required: true, options: [], step: 0, canonicalField: "email", mappingConfidence: 0.99, sensitive: false },
      { id: "f-phone", kind: "tel", label: "Phone", helpText: "", required: false, options: [], step: 0, canonicalField: "phone", mappingConfidence: 0.95, sensitive: false },
      { id: "f-cv", kind: "file", label: "Résumé / CV", helpText: "PDF only", required: true, options: [], accept: ".pdf", step: 1, canonicalField: "resume_file", mappingConfidence: 0.97, sensitive: false },
      { id: "f-cover", kind: "textarea", label: "Cover letter", helpText: "", required: false, options: [], step: 1, canonicalField: "cover_letter_text", mappingConfidence: 0.91, sensitive: false },
      { id: "f-auth", kind: "select", label: "Do you require visa sponsorship?", helpText: "", required: true, options: [{ value: "no", label: "No" }, { value: "yes", label: "Yes" }], step: 2, canonicalField: "visa_sponsorship", mappingConfidence: 0.93, sensitive: true },
      { id: "f-why", kind: "textarea", label: "Why do you want to work here?", helpText: "", required: true, options: [], step: 2, canonicalField: "screening_question", mappingConfidence: 0.88, sensitive: false },
    ],
  };
}

function demoPlannedAnswers(cvVariantId: string): PlannedAnswer[] {
  return [
    { fieldId: "f-name", value: "Alex Demo", source: "fact", sourceFactIds: [], confidence: 0.98, needsUser: false, differsFromApproved: false, note: "" },
    { fieldId: "f-email", value: "alex.demo@example.com", source: "fact", sourceFactIds: [], confidence: 0.98, needsUser: false, differsFromApproved: false, note: "" },
    { fieldId: "f-phone", value: "+1-555-0100", source: "fact", sourceFactIds: [], confidence: 0.95, needsUser: false, differsFromApproved: false, note: "" },
    { fieldId: "f-cv", value: cvVariantId, source: "document", sourceFactIds: [], confidence: 1, needsUser: false, differsFromApproved: false, note: "ATS-safe variant" },
    { fieldId: "f-cover", value: COVER_LETTER_MD, source: "document", sourceFactIds: [], confidence: 1, needsUser: false, differsFromApproved: false, note: "approved cover letter" },
    { fieldId: "f-auth", value: "no", source: "saved_answer", sourceFactIds: [], confidence: 1, needsUser: false, differsFromApproved: false, note: "sensitive: answered from an approved fact" },
    { fieldId: "f-why", value: "I want to build the second version of a system rather than maintain the first.", source: "saved_answer", sourceFactIds: [], confidence: 0.82, needsUser: false, differsFromApproved: false, note: "" },
  ];
}

/**
 * Drives one company-site attempt through the whole gated path — snapshot,
 * preview (which mints and hashes a single-use confirmation token), the
 * pre-mutation `beginSubmission` write, then the receipt — so the demo's
 * evidence panel shows a real attempt history rather than a fabricated row.
 */
async function seedSiteAttempt(
  db: Db,
  apps: SeededApplications,
  cvVariantId: string,
  demoAtsUrl: string,
  fileStorageDir: string,
): Promise<void> {
  // The approved cover letter already exists, so this transition is honest.
  await transition(db, apps.siteSubmission, "READY_FOR_REVIEW", "user", { hasMaterials: true });

  const url = `${demoAtsUrl}/apply/founding-engineer`;
  const host = new URL(url).hostname;
  const form = demoCanonicalForm(url);
  const answers = demoPlannedAnswers(cvVariantId);

  const attempt = await createSiteAttempt(db, { applicationId: apps.siteSubmission, url });
  await saveFormSnapshot(db, { attemptId: attempt.id, form, answers });

  const payload = {
    applicationId: apps.siteSubmission,
    url,
    host,
    requisitionKey: form.requisitionKey,
    parserVersion: form.parserVersion,
    formHash: payloadFingerprint(form.fields.map((f) => f.id)),
    answers: answers.map((a) => ({ fieldId: a.fieldId, value: a.value, source: a.source })),
    attachments: [{ fieldId: "f-cv", filename: "alex-demo-ats.pdf", sha256: createHash("sha256").update(PLACEHOLDER_PDF).digest("hex") }],
  };
  const fingerprint = payloadFingerprint(payload);

  const preview = await recordPreview(db, {
    attemptId: attempt.id,
    payloadFingerprint: fingerprint,
    target: host,
    // Generated and hashed exactly as the real preview does; the plaintext is
    // discarded here because nothing is going to redeem it interactively.
    tokenHash: hashConfirmationToken(generateConfirmationToken()),
    expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS),
  });
  if (!preview.ok) throw new Error(`demo seed: preview refused: ${preview.reason}`);

  const confirmation = await getActiveConfirmation(db, attempt.id);
  if (!confirmation) throw new Error("demo seed: no active confirmation after preview");

  const begun = await beginSubmission(db, {
    attemptId: attempt.id,
    confirmationId: confirmation.id,
    pendingReceipt: { channel: "company_site", payload, fingerprint, startedAt: daysAgo(4).toISOString() },
  });
  if (!begun.ok) throw new Error(`demo seed: beginSubmission refused: ${begun.reason}`);

  const shotDir = path.join(fileStorageDir, "site-screenshots");
  await mkdir(shotDir, { recursive: true });
  // Fixed filename: a six-hourly reset must not grow the volume without bound.
  const screenshotPath = path.join(shotDir, "demo-seed-confirmation.png");
  await writeFile(screenshotPath, PLACEHOLDER_PNG);

  const completed = await completeSubmission(db, {
    attemptId: attempt.id,
    confirmedReceipt: {
      channel: "company_site",
      confirmationId: "DEMO-ATS-4821",
      finalUrl: `${url}/confirmation`,
      screenshotPath,
      pageTextExcerpt: "Application received. Your reference is DEMO-ATS-4821. "
        + "We will be in touch within ten working days.",
      acceptedAt: daysAgo(4).toISOString(),
      fingerprint,
      host,
      url,
      attachments: payload.attachments,
    },
  });
  if (!completed.ok) throw new Error(`demo seed: completeSubmission refused: ${completed.reason}`);
}

// ---------------------------------------------------------------------------

/**
 * Rebuilds the demo workspace from scratch. Safe to run repeatedly: the delete
 * is scoped to `kind = "sandbox" AND name = DEMO_WORKSPACE_NAME` and cascades,
 * so every run leaves exactly one demo workspace and nothing else is touched.
 */
export async function seedDemoWorkspace(
  db: Db,
  opts: SeedDemoWorkspaceOptions,
): Promise<{ workspaceId: string }> {
  const smtpHost = opts.sandboxSmtpHost?.trim() || DEFAULT_SANDBOX_SMTP_HOST;
  const demoAtsUrl = opts.demoAtsUrl?.trim().replace(/\/+$/, "") || DEFAULT_DEMO_ATS_URL;
  const masterKeyB64 = opts.masterKeyB64?.trim() || null;

  // `delete`, not `delete where id = <the one we found>`: if a previous run
  // ever left two rows matching the predicate, resolution would be ambiguous —
  // clearing all of them and inserting one is the only self-healing shape.
  await db.delete(workspaces)
    .where(and(eq(workspaces.kind, "sandbox"), eq(workspaces.name, DEMO_WORKSPACE_NAME)));
  const [workspace] = await db.insert(workspaces)
    .values({ name: DEMO_WORKSPACE_NAME, kind: "sandbox" }).returning();
  if (!workspace) throw new Error("demo seed: failed to create the demo workspace");
  const workspaceId = workspace.id;

  await seedFacts(db, workspaceId);
  const cvVariantId = await seedCvVariants(db, workspaceId, opts.fileStorageDir);
  const promotableJobIds = await seedDiscovery(db, workspaceId);
  const apps = await seedApplications(db, workspaceId, promotableJobIds);

  const factRows = await db.select({ id: candidateFacts.id }).from(candidateFacts)
    .where(eq(candidateFacts.workspaceId, workspaceId))
    .orderBy(asc(candidateFacts.createdAt));
  const factIds = factRows.map((row) => row.id);

  await seedMaterials(db, workspaceId, apps, factIds);
  await seedAnswers(db, workspaceId, apps, factIds);
  await seedSiteAttempt(db, apps, cvVariantId, demoAtsUrl, opts.fileStorageDir);
  if (masterKeyB64) await seedMailbox(db, workspaceId, apps, smtpHost, masterKeyB64);

  return { workspaceId };
}
