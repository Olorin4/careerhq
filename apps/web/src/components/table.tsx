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

export function Td({ children }: { children?: ReactNode }): JSX.Element {
  return <td className={BODY_CELL}>{children}</td>;
}
