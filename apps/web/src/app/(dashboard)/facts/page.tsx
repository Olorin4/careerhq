import { listFacts, isFactStale, type CandidateFact } from "@careerhq/db";
import { FACT_CATEGORIES } from "@careerhq/contracts";
import { getDb } from "../../../lib/db.js";
import { getActiveWorkspace } from "../../../lib/workspace.js";
import { FactForm } from "./fact-form.js";
import { reverifyFactAction, archiveFactAction } from "./actions.js";

function humanize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

function defaultReviewBy(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 12);
  return d.toISOString().slice(0, 10);
}

export default async function FactsPage() {
  const db = getDb();
  const ws = await getActiveWorkspace(db);
  const facts = await listFacts(db, ws.id);
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
        <a href={fact.evidenceUrl} target="_blank" rel="noreferrer">
          Evidence
        </a>
      )}
      <p className="fact-row-dates">
        Verified {fact.verifiedAt.toLocaleDateString()} · Review by{" "}
        {fact.reviewBy.toLocaleDateString()}
      </p>
      <div className="fact-row-actions">
        <form action={reverifyFactAction} className="fact-reverify-form">
          <input type="hidden" name="id" value={fact.id} />
          <input type="date" name="reviewBy" defaultValue={reviewByDefault} required />
          <button type="submit">Re-verify</button>
        </form>
        <form action={archiveFactAction}>
          <input type="hidden" name="id" value={fact.id} />
          <button type="submit">Archive</button>
        </form>
      </div>
    </li>
  );
}
