import { listFacts, isFactStale, type CandidateFact } from "@careerhq/db";
import { FACT_CATEGORIES } from "@careerhq/contracts";
import { getDb } from "../../../lib/db.js";
import { readWorkspaceSnapshot } from "../../../lib/workspace.js";
import { safeExternalHref } from "../../../lib/safe-url.js";
import { formatDate } from "../../../lib/time.js";
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

  return (
    <main>
      <h1>Fact bank</h1>
      <FactForm />
      {FACT_CATEGORIES.map((category) => {
        const categoryFacts = facts.filter((fact) => fact.category === category);
        if (categoryFacts.length === 0) return null;
        return (
          <section key={category} className="fact-category">
            <h2>{humanize(category)}</h2>
            <ul className="fact-list">
              {categoryFacts.map((fact) => (
                <FactRow
                  key={fact.id}
                  fact={fact}
                  stale={isFactStale(fact, now)}
                  reviewByDefault={reviewByDefault}
                />
              ))}
            </ul>
          </section>
        );
      })}
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
    <li className="fact-row">
      <div className="fact-row-main">
        <strong>{fact.claim}</strong>
        {stale && <span className="badge badge-stale">STALE</span>}
        <span
          className={
            fact.sensitivity === "sensitive" ? "badge badge-sensitivity" : "badge"
          }
        >
          {humanize(fact.sensitivity)}
        </span>
      </div>
      {fact.detail && <p className="fact-row-detail">{fact.detail}</p>}
      {fact.evidenceUrl && (
        safeEvidenceUrl ? (
          <a href={safeEvidenceUrl} target="_blank" rel="noreferrer">
            Evidence
          </a>
        ) : (
          <span className="fact-row-detail">{fact.evidenceUrl}</span>
        )
      )}
      <p className="fact-row-dates">
        Verified {formatDate(fact.verifiedAt)} · Review by{" "}
        {formatDate(fact.reviewBy)}
      </p>
      <FactRowActions factId={fact.id} reviewByDefault={reviewByDefault} />
    </li>
  );
}
