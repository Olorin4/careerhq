"use client";

import type { ApplicationState } from "@careerhq/contracts";
import { APPLICATION_STATES } from "@careerhq/contracts";
import { formatDate } from "../../../lib/time.js";
import { STATE_TONE } from "../../../lib/application-state.js";
import { Badge } from "../../../components/badge.js";
import { TransitionButtons } from "./transition-buttons.js";

export interface ApplicationCard {
  id: string;
  state: ApplicationState;
  title: string;
  company: string;
  nextAction: string | null;
  nextActionDue: string | null;
}

const CLOSED_STATES: readonly ApplicationState[] = ["REJECTED", "WITHDRAWN", "EXPIRED"];
const ACTIVE_STATES = APPLICATION_STATES.filter((s) => !CLOSED_STATES.includes(s));

function humanize(state: string): string {
  return state.charAt(0) + state.slice(1).toLowerCase().replace(/_/g, " ");
}

interface Column {
  key: string;
  label: string;
  states: readonly ApplicationState[];
}

const COLUMNS: Column[] = [
  ...ACTIVE_STATES.map((s): Column => ({ key: s, label: humanize(s), states: [s] })),
  { key: "CLOSED", label: "Closed", states: CLOSED_STATES },
];

/**
 * One column per active state plus a trailing "Closed" column that groups
 * REJECTED/WITHDRAWN/EXPIRED — nine columns total, wider than the app's
 * 960px content column, so this scrolls sideways by design (see
 * `capture-demo-media.ts`'s own comment on shot 02). The `minmax(180px,…)`
 * arbitrary value keeps every column readable rather than letting `1fr`
 * crush the later ones once nine columns compete for the width.
 */
export function Board({ cards }: { cards: ApplicationCard[] }) {
  return (
    <div className="grid grid-cols-[repeat(9,minmax(180px,1fr))] gap-3 overflow-x-auto" data-testid="board">
      {COLUMNS.map((col) => {
        const colCards = cards.filter((c) => col.states.includes(c.state));
        return (
          <section className="flex flex-col gap-2" key={col.key}>
            <h2 className="m-0 text-xs font-medium uppercase tracking-wide text-muted">
              {col.label} <span className="tabular-nums text-soft">({colCards.length})</span>
            </h2>
            {colCards.length === 0 ? (
              <p className="m-0 text-xs text-soft">No applications</p>
            ) : (
              colCards.map((card) => <ApplicationCardView key={card.id} card={card} />)
            )}
          </section>
        );
      })}
    </div>
  );
}

function ApplicationCardView({ card }: { card: ApplicationCard }) {
  return (
    <article
      className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3 text-sm shadow-card"
      data-testid="board-card"
    >
      <a
        href={`/applications/${card.id}`}
        className="text-ink no-underline hover:underline"
        data-testid="board-card-link"
      >
        <strong>{card.company}</strong> · {card.title}
      </a>
      <Badge tone={STATE_TONE[card.state]}>{humanize(card.state)}</Badge>
      {card.nextAction && (
        <p className="m-0 text-xs text-muted">
          {card.nextAction}
          {card.nextActionDue ? ` — due ${formatDate(card.nextActionDue)}` : ""}
        </p>
      )}
      <TransitionButtons applicationId={card.id} state={card.state} />
    </article>
  );
}
