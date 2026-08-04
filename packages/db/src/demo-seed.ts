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
import { and, eq, sql } from "drizzle-orm";
import type {
  ApplicationState, CanonicalForm, CvFormat, FactCategory, NormalizedJob, PlannedAnswer,
  RemoteMode, ScoringProfile, Sensitivity, SmtpConfig, TransitionTrigger,
} from "@careerhq/contracts";
import { DEFAULT_SCORING_PROFILE } from "@careerhq/contracts";
import type { TransitionContext } from "@careerhq/core";
import {
  CONFIRMATION_TTL_MS, generateConfirmationToken, hashConfirmationToken, payloadFingerprint,
} from "@careerhq/core/gates";
import type { Db, DbOrTx } from "./client.js";
import { jobs, workspaces } from "./schema/index.js";
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

/**
 * Advisory-lock key guarding the demo workspace singleton.
 *
 * The delete predicate below (`kind = "sandbox" AND name = DEMO_WORKSPACE_NAME`)
 * is database-GLOBAL, not scoped to a caller: two overlapping `seedDemoWorkspace`
 * calls destroy each other's in-flight rows, and the cascade takes out
 * applications the other run is mid-transition on — which surfaces as
 * `<id> → SHORTLISTED refused: application not found`. Wrapping the seed in a
 * transaction (so nothing partial is ever visible) does not on its own stop two
 * transactions interleaving, so the seed takes this lock as its first statement
 * inside the transaction: `pg_advisory_xact_lock` is released by COMMIT/ROLLBACK,
 * so a crashed or abandoned seed cannot leave it held.
 *
 * Tests that need to observe the demo workspace's row set without a concurrent
 * reset moving it underneath them take the same lock via {@link lockDemoSeed}.
 * Always acquire it BEFORE any row lock, so every holder orders its locks the
 * same way and no pair can deadlock.
 */
export const DEMO_SEED_LOCK_KEY = 6_202_603_040_000;

/**
 * Takes {@link DEMO_SEED_LOCK_KEY} for the rest of `tx`. Must be called on a
 * transaction handle: on a plain `Db` the implicit single-statement transaction
 * commits immediately and the lock is released again before it is any use.
 */
export async function lockDemoSeed(tx: DbOrTx): Promise<void> {
  // `sql.raw` on a module constant, not a bound parameter: `pg_advisory_xact_lock`
  // is overloaded on (bigint) and (int, int), and a driver-inferred int4
  // parameter picks the wrong arity for a key this size.
  await tx.execute(sql.raw(`select pg_advisory_xact_lock(${DEMO_SEED_LOCK_KEY})`));
}

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
const minutesAgo = (n: number): Date => new Date(Date.now() - n * 60_000);

/** Throws on a refused transition: the seed's own scripts must never be illegal. */
async function transition(
  db: DbOrTx,
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

/**
 * Stable handles for the seeded facts. Documents, reusable answers and the
 * auto-apply form plan all cite facts BY KEY rather than by position in the
 * insert order: a provenance chip that names the wrong fact is worse than no
 * chip, because grounded citation is the claim the fact bank exists to make.
 */
type DemoFactKey =
  | "legalName" | "preferredName" | "email" | "phone" | "portfolio"
  | "northwind" | "vertexLead" | "migration" | "degree"
  | "typescript" | "postgres" | "kubernetes"
  | "remotePreference" | "relocation" | "workAuthorization" | "targetSalary"
  | "availability" | "noticePeriod";

interface DemoFact {
  key: DemoFactKey;
  category: FactCategory;
  claim: string;
  detail?: string;
  sensitivity?: Sensitivity;
  reviewBy: Date;
}

/** The seeded facts' ids, by key — what `sourceFactIds` is built from. */
type DemoFactIds = Record<DemoFactKey, string>;

function demoFacts(): DemoFact[] {
  return [
    { key: "legalName", category: "identity", claim: "Full legal name: Alex Demo", reviewBy: daysFromNow(180) },
    { key: "preferredName", category: "identity", claim: "Preferred name: Alex", reviewBy: daysFromNow(180) },
    { key: "email", category: "contact", claim: "Email: alex.demo@example.com", reviewBy: daysFromNow(180) },
    { key: "phone", category: "contact", claim: "Phone: +1-555-0100", reviewBy: daysFromNow(180) },
    { key: "portfolio", category: "contact", claim: "Portfolio: https://alex.example.com", reviewBy: daysFromNow(365) },
    {
      key: "northwind",
      category: "experience",
      claim: "6 years as a backend engineer at Northwind Robotics",
      detail: "Owned the order-routing service: TypeScript on Node, PostgreSQL, ~2M events/day.",
      reviewBy: daysFromNow(180),
    },
    {
      key: "vertexLead",
      category: "experience",
      claim: "2 years as engineering lead at Vertex Logistics",
      detail: "Led a team of five across the dispatch and billing product lines.",
      reviewBy: daysFromNow(180),
    },
    {
      key: "migration",
      category: "experience",
      claim: "Migrated a monolith to event-driven services with zero customer-visible downtime",
      detail: "Strangler-fig migration over nine months; cut p99 checkout latency from 1.9s to 340ms.",
      reviewBy: daysFromNow(180),
    },
    { key: "degree", category: "education", claim: "B.Sc. Computer Science, Riverbank University", reviewBy: daysFromNow(365) },
    { key: "typescript", category: "skill", claim: "TypeScript and Node.js, production, six years", reviewBy: daysFromNow(180) },
    { key: "postgres", category: "skill", claim: "PostgreSQL: schema design, query tuning, logical replication", reviewBy: daysFromNow(180) },
    { key: "kubernetes", category: "skill", claim: "Kubernetes and Terraform for service deployment", reviewBy: daysFromNow(180) },
    { key: "remotePreference", category: "preference", claim: "Prefers remote-first teams in European time zones", reviewBy: daysFromNow(180) },
    { key: "relocation", category: "preference", claim: "Open to relocation for a Series B or later company", reviewBy: daysFromNow(180) },
    {
      key: "workAuthorization",
      category: "authorization",
      claim: "EU work authorization: citizen, no sponsorship required",
      sensitivity: "sensitive",
      reviewBy: daysFromNow(365),
    },
    {
      key: "targetSalary",
      category: "compensation",
      claim: "Target base: €110k",
      sensitivity: "sensitive",
      reviewBy: daysFromNow(90),
    },
    { key: "availability", category: "availability", claim: "Available four weeks after signing", reviewBy: daysFromNow(180) },
    // Deliberately the one STALE fact: `review_by` is in the past, so the demo
    // shows the fact bank's staleness badge and the re-verify flow.
    { key: "noticePeriod", category: "availability", claim: "Notice period: 4 weeks", reviewBy: daysAgo(21) },
  ];
}

async function seedFacts(db: DbOrTx, workspaceId: string): Promise<DemoFactIds> {
  const ids = {} as DemoFactIds;
  for (const { key, ...fact } of demoFacts()) {
    ids[key] = (await createFact(db, { workspaceId, ...fact })).id;
  }
  return ids;
}

/**
 * Minimal valid PDF literal — enough to satisfy "is a real PDF" checks. The
 * label goes in a PDF comment so the two seeded variants are genuinely
 * different files with different digests: the CV picker distinguishes them by
 * `sha256`, and two byte-identical variants would make the "designed vs
 * ATS-safe" choice the demo shows a label with nothing behind it.
 */
function placeholderPdf(label: string): string {
  return "%PDF-1.4\n"
    + `% ${label}\n`
    + "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    + "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    + "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n"
    + "trailer<</Root 1 0 R>>\n"
    + "%%EOF";
}

/**
 * A 1×1 PNG. The submission receipt's evidence link has to resolve to a real
 * file for the attempt to look genuine; the readable screenshots the README
 * ships are captured from the running demo by `pnpm demo:media`, not from here.
 */
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** The ATS-safe variant, which is the one the auto-apply attempt uploads. */
interface SeededCv {
  variantId: string;
  filename: string;
  sha256: string;
}

/** Fixed filenames, so six-hourly resets rewrite the same files instead of piling up. */
async function seedCvVariants(db: DbOrTx, workspaceId: string, fileStorageDir: string): Promise<SeededCv> {
  const cvDir = path.join(fileStorageDir, "cvs");
  await mkdir(cvDir, { recursive: true });

  const specs: Array<{ label: string; format: CvFormat; filename: string }> = [
    { label: "Alex Demo — Designed", format: "designed", filename: "alex-demo-designed.pdf" },
    { label: "Alex Demo — ATS-safe", format: "ats", filename: "alex-demo-ats.pdf" },
  ];

  let ats: SeededCv | null = null;
  for (const spec of specs) {
    const filePath = path.join(cvDir, spec.filename);
    const bytes = placeholderPdf(spec.label);
    const sha256 = createHash("sha256").update(bytes, "utf-8").digest("hex");
    await writeFile(filePath, bytes, "utf-8");
    const variant = await createCvVariant(db, {
      workspaceId, label: spec.label, format: spec.format, filePath, sha256,
    });
    if (spec.format === "ats") ats = { variantId: variant.id, filename: spec.filename, sha256 };
  }
  if (!ats) throw new Error("demo seed: no ATS-safe CV variant");
  return ats;
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

/**
 * The recorded re-rank: seeded, not generated (the demo deploys with no
 * OpenRouter key).
 *
 * Keyed by `external_id`, NOT by position. An earlier version was authored
 * against `DEMO_JOB_SEEDS`' order but applied in the keyword ranking's order,
 * so nine of the ten rationales described a different listing than the one they
 * were attached to — Kingsley Logistics' €90k–€110k Platform Engineer carried
 * "salary band is above the target", and Cobalt Freight's SENIOR Platform
 * Engineer carried "the seniority reads a step below". Each note below states
 * something checkable about its job's title, salary or description, and
 * `demo-reset.test.ts` asserts exactly that.
 */
interface RerankNote {
  /** `demo-0NN`, the stable external id assigned in `normalizedJobs`. */
  externalId: string;
  /** The re-ranked score, authored per note so the batch's order is a real ranking. */
  score: number;
  rationale: string;
  redFlags: readonly string[];
}

const RERANK_NOTES: readonly RerankNote[] = [
  {
    externalId: "demo-001", score: 95, // Aurora Robotics — Senior Backend Engineer, €95k–€120k
    rationale: "Strong match: remote-first, TypeScript and Postgres in the core stack, and the ownership level matches six years of backend work.",
    redFlags: [],
  },
  {
    externalId: "demo-007", score: 93, // Cobalt Freight — Senior Platform Engineer, event-driven dispatch
    rationale: "Kubernetes platform work with an event-driven core — a direct match for the dispatch experience.",
    redFlags: [],
  },
  {
    externalId: "demo-003", score: 91, // Halcyon Data — Staff Engineer, Data Platform, €120k–€140k
    rationale: "Close match. Staff scope and event-driven Postgres work line up with the Northwind migration story.",
    redFlags: ["salary band is above the target, so expect a levelling conversation"],
  },
  {
    externalId: "demo-002", score: 88, // Kingsley Logistics — Platform Engineer, Kubernetes/Terraform control plane
    rationale: "Good match on stack and seniority. The platform remit is broader than Alex's last role, which is the stated direction of travel.",
    redFlags: [],
  },
  {
    externalId: "demo-009", score: 86, // Fathom Analytics Co — Remote (Global), async writing
    rationale: "Remote-global and TypeScript-first with an explicit async-writing culture, which matches the stated preference.",
    redFlags: [],
  },
  {
    externalId: "demo-004", score: 82, // Lumen Health — Founding Engineer, €100k–€130k + equity
    rationale: "Founding-engineer scope with a TypeScript stack; equity-heavy package needs weighing against the €110k base target.",
    redFlags: ["compensation is partly equity"],
  },
  {
    externalId: "demo-005", score: 74, // Ostrich Payments — Backend Engineer, Ledger
    rationale: "Ledger correctness work is a good fit for the Postgres depth, though the domain is new.",
    redFlags: [],
  },
  {
    externalId: "demo-010", score: 71, // Pinewood Systems — Platform Engineer, developer tools focus
    rationale: "Developer-tools focus and a Terraform/Kubernetes platform; slightly less backend depth than the target role.",
    redFlags: [],
  },
  {
    externalId: "demo-008", score: 68, // Meridian Studio — Backend Engineer, design collaboration product
    rationale: "Reasonable match on stack; the product domain is further from anything in the fact bank.",
    redFlags: [],
  },
  {
    externalId: "demo-006", score: 63, // Brightline Labs — Full-Stack Engineer (no seniority prefix)
    rationale: "Solid full-stack match, but the seniority reads a step below the current role.",
    redFlags: ["level may be junior to the target"],
  },
];

/** Kingsley Logistics, Brightline Labs, Kestrel Mobility — see `seedDiscovery`. */
const PROMOTED_EXTERNAL_IDS = ["demo-002", "demo-006", "demo-011"] as const;

async function seedDiscovery(db: DbOrTx, workspaceId: string): Promise<string[]> {
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
    id: jobs.id, externalId: jobs.externalId,
  }).from(jobs)
    .where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.status, "inbox")));
  const byExternalId = new Map(scored.map((row) => [row.externalId, row.id]));
  // Each note names the listing it was written about, so the batch is exactly
  // the set of listings that have a rationale — never "whatever the keyword
  // ranking put in the top ten", which is a different ordering and attached
  // every rationale to the wrong job.
  await applyRerank(db, workspaceId, RERANK_NOTES.map((note) => {
    const jobId = byExternalId.get(note.externalId);
    if (!jobId) throw new Error(`demo seed: no discovery job ${note.externalId} to re-rank`);
    return { jobId, score: note.score, rationale: note.rationale, redFlags: [...note.redFlags] };
  }));

  // These three listings become applications, so the demo shows the discovery →
  // promote hand-off with its `promotedFrom: "discovery"` event. Chosen by
  // external id rather than by rank so the reset is reproducible, and no
  // company here appears in `seedApplications` — a listing sitting in the inbox
  // while an application for the same role exists reads as a bug on camera.
  return PROMOTED_EXTERNAL_IDS.map((externalId) => {
    const jobId = byExternalId.get(externalId);
    if (!jobId) throw new Error(`demo seed: no discovery job ${externalId} to promote`);
    return jobId;
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
  db: DbOrTx,
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

const DRAFT_COVER_LETTER_MD = `Dear Silvermark Labs team,

Six years of backend engineering in TypeScript and Node, most of it on
PostgreSQL, and two years leading a team of five at Vertex Logistics. That is
the short version of why the Staff Engineer, Data Platform role reads as the
next step rather than a sideways one.

Alex Demo`;

/**
 * Documents and reusable answers carry `sourceFactIds` because the UI renders a
 * provenance chip per source fact — an approved document with no sources would
 * render as ungrounded, which is exactly what the fact bank exists to prevent.
 *
 * Which facts is load-bearing, not decorative. Every id below is the fact the
 * neighbouring sentence actually restates: an earlier version took
 * `factIds.slice(0, 4)` — name, name, email, phone — so a cover letter about a
 * strangler-fig migration rendered chips reading "Preferred name: Alex". The
 * demo exists to show grounded citation; citing the wrong fact demonstrates the
 * opposite. `demo-reset.test.ts` asserts each artifact's sources against the
 * claims its own text contains.
 */
async function seedMaterials(
  db: DbOrTx,
  workspaceId: string,
  apps: SeededApplications,
  facts: DemoFactIds,
): Promise<void> {
  // "six years of backend engineering in TypeScript and Node on PostgreSQL,
  // including two years leading a team of five at Vertex Logistics … the
  // streaming-ingest work I did at Northwind Robotics".
  const emailBody = await createDocument(db, {
    applicationId: apps.readyForReview, kind: "email_body", contentMd: EMAIL_BODY_MD,
    sourceFactIds: [facts.northwind, facts.vertexLead, facts.typescript, facts.postgres],
    model: "seeded/demo", origin: "ai",
  });
  await setDocumentApproval(db, workspaceId, emailBody.id, "approved");
  // A second, still-unapproved draft so the materials panel shows both states.
  await createDocument(db, {
    applicationId: apps.readyForReview, kind: "cover_letter", contentMd: DRAFT_COVER_LETTER_MD,
    sourceFactIds: [facts.northwind, facts.vertexLead, facts.typescript, facts.postgres],
    model: "seeded/demo", origin: "ai",
  });

  // "six years building backend systems in TypeScript and Node … Northwind
  // Robotics' order-routing service … on PostgreSQL … a strangler-fig move …
  // I am remote-first in a European time zone and can start four weeks after
  // signing."
  const coverLetter = await createDocument(db, {
    applicationId: apps.siteSubmission, kind: "cover_letter", contentMd: COVER_LETTER_MD,
    sourceFactIds: [
      facts.northwind, facts.migration, facts.typescript, facts.postgres,
      facts.remotePreference, facts.availability,
    ],
    model: "seeded/demo", origin: "ai",
  });
  await setDocumentApproval(db, workspaceId, coverLetter.id, "approved");

  // The approved email body is what makes PREPARING → READY_FOR_REVIEW legal.
  await transition(db, apps.readyForReview, "READY_FOR_REVIEW", "user", { hasMaterials: true });
}

async function seedAnswers(
  db: DbOrTx,
  workspaceId: string,
  apps: SeededApplications,
  facts: DemoFactIds,
): Promise<void> {
  const reusable = [
    {
      questionRaw: "Why do you want to work here?",
      answer: "I want to build the second version of a system rather than maintain the first. "
        + "Your posting describes greenfield TypeScript with PostgreSQL as the record of truth, "
        + "which is the shape of system I spent nine months migrating towards at Northwind Robotics.",
      // The nine-month migration, the stack it was built on, and where it happened.
      sourceFactIds: [facts.migration, facts.northwind, facts.typescript, facts.postgres],
      origin: "ai" as const,
      confidence: 0.82,
      sensitivity: "normal" as const,
    },
    {
      questionRaw: "Do you require visa sponsorship?",
      answer: "No — I hold EU citizenship and require no sponsorship.",
      // Word for word the `authorization` fact, and the reason this answer is
      // marked sensitive. Citing anything else here was the review's headline
      // example of a provenance chip that undermines its own claim.
      sourceFactIds: [facts.workAuthorization],
      origin: "deterministic" as const,
      confidence: 1,
      sensitivity: "sensitive" as const,
    },
  ];

  for (const spec of reusable) {
    const answer = await createAnswer(db, { applicationId: apps.siteSubmission, ...spec });
    await approveAnswer(db, workspaceId, answer.id, { reusable: true });
  }

  // One answer still awaiting a decision, so the review queue is not empty.
  await createAnswer(db, {
    applicationId: apps.readyForReview,
    questionRaw: "Describe a system you designed end to end.",
    answer: "The order-routing service at Northwind Robotics: event-driven, PostgreSQL of record, "
      + "roughly two million events a day. I owned it from design through to on-call.",
    origin: "ai",
    // The order-routing service is the `northwind` fact's detail, down to the
    // ~2M events a day; "PostgreSQL of record" is the Postgres skill.
    sourceFactIds: [facts.northwind, facts.postgres],
    confidence: 0.74,
  });
}

// ---------------------------------------------------------------------------
// Mailbox (Mailpit only)
// ---------------------------------------------------------------------------

/** Exported so the seal test can assert the ciphertext against the real plaintext. */
export const DEMO_MAILBOX_PASSWORD = "mailpit-has-no-auth";

/**
 * A send-only connection pointing at Mailpit, the only SMTP host a sandbox
 * workspace may reach. There is deliberately no IMAP config: Mailpit speaks
 * SMTP and POP3, not IMAP, so a configured mailbox would leave the worker's
 * `email.sync` job failing every 15 minutes and the connection's health badge
 * red. The inbound thread below is written through the same repo calls the
 * sync job uses, so the inbox panel is explorable regardless.
 */
async function seedMailbox(
  db: DbOrTx,
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

/**
 * The form plan behind the auto-apply receipt. Every `fact`- and
 * `saved_answer`-sourced field names the fact it was filled from: the form
 * snapshot's evidence panel renders those ids, and a field claiming to be
 * "answered from an approved fact" with an empty source list says the opposite
 * of what it means to.
 */
function demoPlannedAnswers(cvVariantId: string, facts: DemoFactIds): PlannedAnswer[] {
  return [
    { fieldId: "f-name", value: "Alex Demo", source: "fact", sourceFactIds: [facts.legalName], confidence: 0.98, needsUser: false, differsFromApproved: false, note: "" },
    { fieldId: "f-email", value: "alex.demo@example.com", source: "fact", sourceFactIds: [facts.email], confidence: 0.98, needsUser: false, differsFromApproved: false, note: "" },
    { fieldId: "f-phone", value: "+1-555-0100", source: "fact", sourceFactIds: [facts.phone], confidence: 0.95, needsUser: false, differsFromApproved: false, note: "" },
    // Document-sourced fields cite the document, not a fact: the approved
    // cover letter carries its own provenance.
    { fieldId: "f-cv", value: cvVariantId, source: "document", sourceFactIds: [], confidence: 1, needsUser: false, differsFromApproved: false, note: "ATS-safe variant" },
    { fieldId: "f-cover", value: COVER_LETTER_MD, source: "document", sourceFactIds: [], confidence: 1, needsUser: false, differsFromApproved: false, note: "approved cover letter" },
    { fieldId: "f-auth", value: "no", source: "saved_answer", sourceFactIds: [facts.workAuthorization], confidence: 1, needsUser: false, differsFromApproved: false, note: "sensitive: answered from an approved fact" },
    { fieldId: "f-why", value: "I want to build the second version of a system rather than maintain the first.", source: "saved_answer", sourceFactIds: [facts.migration, facts.northwind], confidence: 0.82, needsUser: false, differsFromApproved: false, note: "" },
  ];
}

/**
 * Drives one company-site attempt through the whole gated path — snapshot,
 * preview (which mints and hashes a single-use confirmation token), the
 * pre-mutation `beginSubmission` write, then the receipt — so the demo's
 * evidence panel shows a real attempt history rather than a fabricated row.
 */
async function seedSiteAttempt(
  db: DbOrTx,
  apps: SeededApplications,
  cv: SeededCv,
  facts: DemoFactIds,
  demoAtsUrl: string,
  fileStorageDir: string,
): Promise<void> {
  // The approved cover letter already exists, so this transition is honest.
  await transition(db, apps.siteSubmission, "READY_FOR_REVIEW", "user", { hasMaterials: true });

  const url = `${demoAtsUrl}/apply/founding-engineer`;
  const host = new URL(url).hostname;
  const form = demoCanonicalForm(url);
  const answers = demoPlannedAnswers(cv.variantId, facts);

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
    attachments: [{ fieldId: "f-cv", filename: cv.filename, sha256: cv.sha256 }],
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
    // Minutes, not days. `completeSubmission` transitions the application to
    // SUBMITTED through the real guard, which stamps `submitted_at = now()` —
    // a receipt claiming the ATS accepted this four days before the
    // application says it was sent contradicts itself on the same screen.
    pendingReceipt: { channel: "company_site", payload, fingerprint, startedAt: minutesAgo(3).toISOString() },
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
      acceptedAt: minutesAgo(2).toISOString(),
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
 *
 * The whole rebuild is ONE transaction, and it takes {@link DEMO_SEED_LOCK_KEY}
 * before it touches a row. Both halves are load-bearing:
 *
 *   - Without the transaction, the demo workspace does not exist for the ~half
 *     second between the delete and the insert. `getActiveWorkspace` bootstraps
 *     a demo workspace when it finds none, so a single visitor request in that
 *     window creates a SECOND `sandbox`/`CareerHQ Demo` row — measured at 12
 *     resets out of 12. If the visitor's row wins the `asc(createdAt)`
 *     tie-break, the app serves an empty demo until the next reset, up to six
 *     hours later. The same window also served ~150 reads of a half-built
 *     workspace. Inside a transaction the old row stays visible until the new
 *     one commits, so there is no window and nothing to bootstrap; a mid-seed
 *     failure rolls back rather than leaving a partial demo.
 *   - Without the lock, two overlapping seeds still interleave: the delete
 *     predicate is database-global, so each run's cascade removes rows the
 *     other is mid-transition on.
 */
export async function seedDemoWorkspace(
  db: Db,
  opts: SeedDemoWorkspaceOptions,
): Promise<{ workspaceId: string }> {
  const smtpHost = opts.sandboxSmtpHost?.trim() || DEFAULT_SANDBOX_SMTP_HOST;
  const demoAtsUrl = opts.demoAtsUrl?.trim().replace(/\/+$/, "") || DEFAULT_DEMO_ATS_URL;
  const masterKeyB64 = opts.masterKeyB64?.trim() || null;

  const workspaceId = await db.transaction(async (tx) => {
    await lockDemoSeed(tx);

    // `delete`, not `delete where id = <the one we found>`: if a previous run
    // ever left two rows matching the predicate, resolution would be ambiguous —
    // clearing all of them and inserting one is the only self-healing shape.
    await tx.delete(workspaces)
      .where(and(eq(workspaces.kind, "sandbox"), eq(workspaces.name, DEMO_WORKSPACE_NAME)));
    const [workspace] = await tx.insert(workspaces)
      .values({ name: DEMO_WORKSPACE_NAME, kind: "sandbox" }).returning();
    if (!workspace) throw new Error("demo seed: failed to create the demo workspace");

    const facts = await seedFacts(tx, workspace.id);
    const cv = await seedCvVariants(tx, workspace.id, opts.fileStorageDir);
    const promotableJobIds = await seedDiscovery(tx, workspace.id);
    const apps = await seedApplications(tx, workspace.id, promotableJobIds);

    await seedMaterials(tx, workspace.id, apps, facts);
    await seedAnswers(tx, workspace.id, apps, facts);
    await seedSiteAttempt(tx, apps, cv, facts, demoAtsUrl, opts.fileStorageDir);
    if (masterKeyB64) await seedMailbox(tx, workspace.id, apps, smtpHost, masterKeyB64);

    return workspace.id;
  });

  return { workspaceId };
}
