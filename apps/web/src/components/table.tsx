import type { JSX, ReactNode } from "react";

const HEAD_CELL = "border-b border-line px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted";
const BODY_CELL = "border-b border-line px-3 py-2 text-left align-top text-sm text-ink";

/**
 * The token-styled data table CVs, the ATS watchlist and email connections
 * all need — found converting `/cvs` (Task 5), a gap `Row` doesn't cover
 * since a table's header/body semantics don't fit a flex-row primitive.
 * `Table`/`Th`/`Td` are deliberately thin: real markup (`<thead>`, `<tbody>`,
 * `<tr>`) stays in the caller so it composes with actions in the last cell
 * (e.g. a `WatchlistRemoveForm`) without this component knowing about them.
 */
export function Table({ children }: { children: ReactNode }): JSX.Element {
  return <table className="w-full border-collapse text-sm">{children}</table>;
}

export function Th({ children }: { children?: ReactNode }): JSX.Element {
  return <th className={HEAD_CELL}>{children}</th>;
}

/**
 * `className` is optional and additive (same pattern as `Card`) — found
 * converting the ingest health table (Task 6): its Fetched/Inserted/Updated/
 * Duplicates columns are counts stacked in a column, exactly what
 * `tabular-nums` is for, and there was no way to reach the cell from the
 * caller without it.
 */
export function Td({ children, className }: { children?: ReactNode; className?: string }): JSX.Element {
  const classes = className ? `${BODY_CELL} ${className}` : BODY_CELL;
  return <td className={classes}>{children}</td>;
}
