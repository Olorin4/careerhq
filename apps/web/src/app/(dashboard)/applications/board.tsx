"use client";

import type { ApplicationState } from "@careerhq/contracts";
import { APPLICATION_STATES } from "@careerhq/contracts";
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

export function Board({ cards }: { cards: ApplicationCard[] }) {
  return (
    <div className="board">
      {COLUMNS.map((col) => {
        const colCards = cards.filter((c) => col.states.includes(c.state));
        return (
          <section className="board-column" key={col.key}>
            <h2>{col.label}</h2>
            {colCards.length === 0 ? (
              <p className="board-empty">No applications</p>
            ) : (
              colCards.map((card) => <Card key={card.id} card={card} />)
            )}
          </section>
        );
      })}
    </div>
  );
}

function Card({ card }: { card: ApplicationCard }) {
  return (
    <article className="board-card">
      <a href={`/applications/${card.id}`} className="board-card-link">
        <strong>{card.company}</strong> · {card.title}
      </a>
      {card.nextAction && (
        <p className="board-card-next">
          {card.nextAction}
          {card.nextActionDue ? ` — due ${new Date(card.nextActionDue).toLocaleDateString()}` : ""}
        </p>
      )}
      <TransitionButtons applicationId={card.id} state={card.state} />
    </article>
  );
}
