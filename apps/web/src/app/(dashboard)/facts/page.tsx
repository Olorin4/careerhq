import { listFacts, isFactStale, type CandidateFact } from "@careerhq/db";
import { FACT_CATEGORIES } from "@careerhq/contracts";
import { getDb } from "../../../lib/db.js";
import { readWorkspaceSnapshot } from "../../../lib/workspace.js";
import { safeExternalHref } from "../../../lib/safe-url.js";
import { formatDate } from "../../../lib/time.js";
import { Badge } from "../../../components/badge.js";
import { EmptyState } from "../../../components/empty-state.js";
import { Row } from "../../../components/row.js";
import { Section } from "../../../components/section.js";
import { FactForm } from "./fact-form.js";
import { FactRowActions } from "./fact-row-actions.js";

// Every render reads the database, so there is nothing to prerender: without
// this Next would build these pages statically (baking in build-time data and
// requiring a reachable database at build time, which the container image has
// no reason to have).
export const dynamic = "force-dynamic";

function humanize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

function defaultReviewBy(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 12);
  return d.toISOString().slice(0, 10);
}

export default async function FactsPage() {
  // Resolving the workspace and reading its facts are two statements; one
  // snapshot is what stops a demo reset committing between them.
  const facts = await readWorkspaceSnapshot(getDb(), (tx, ws) => listFacts(tx, ws.id));
  const now = new Date();
  const reviewByDefault = defaultReviewBy();
  const categories = FACT_CATEGORIES.filter(
    (category) => facts.some((fact) => fact.category === category),
  );

  return (
    <main className="flex flex-col gap-8">
      <h1 className="text-2xl font-semibold text-ink">Fact bank</h1>
      <FactForm />
      {categories.length === 0 ? (
        <EmptyState
          title="No facts yet"
          hint="Add one above — reusable answers and generated documents draw from this bank."
        />
      ) : (
        categories.map((category) => {
          const categoryFacts = facts.filter((fact) => fact.category === category);
          return (
            <Section key={category} title={humanize(category)}>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {categoryFacts.map((fact) => (
                  <li key={fact.id}>
                    <FactRow
                      fact={fact}
                      stale={isFactStale(fact, now)}
                      reviewByDefault={reviewByDefault}
                    />
                  </li>
                ))}
              </ul>
            </Section>
          );
        })
      )}
    </main>
  );
}

function FactRow({
  fact,
  stale,
  reviewByDefault,
}: {
  fact: CandidateFact;
  stale: boolean;
  reviewByDefault: string;
}) {
  const safeEvidenceUrl = safeExternalHref(fact.evidenceUrl);
  return (
    <Row testId="facts-row">
      <div className="flex flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-ink">{fact.claim}</strong>
          {/* A stale fact is something the user must act on — that's what
              `warn` means in this vocabulary, not how the previous design
              happened to color it. */}
          {stale && <Badge tone="warn">Stale</Badge>}
          {/* Sensitivity is metadata, not a workflow state — none of the
              five state tones (in-progress/needs-action/done/failed) fits
              "this field is private", so it stays `neutral` regardless of
              value. See the gap list in task-5-report.md. */}
          <Badge tone="neutral">{humanize(fact.sensitivity)}</Badge>
        </div>
        {fact.detail && <p className="m-0 text-sm text-muted">{fact.detail}</p>}
        {fact.evidenceUrl && (
          safeEvidenceUrl ? (
            <a href={safeEvidenceUrl} target="_blank" rel="noreferrer" className="text-sm text-ink underline">
              Evidence
            </a>
          ) : (
            <span className="text-sm text-muted">{fact.evidenceUrl}</span>
          )
        )}
        <p className="m-0 text-xs text-soft">
          Verified {formatDate(fact.verifiedAt)} · Review by{" "}
          {formatDate(fact.reviewBy)}
        </p>
        <FactRowActions factId={fact.id} reviewByDefault={reviewByDefault} />
      </div>
    </Row>
  );
}
