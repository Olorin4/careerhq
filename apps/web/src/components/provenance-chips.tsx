/**
 * Renders the fact ids a generated document/answer cited as small chips,
 * labeled with the fact's claim (or "fact removed" if the fact no longer
 * exists in `factClaims` — e.g. it was hard-deleted rather than archived).
 * Shared by the materials and Q&A panels so both stay visually and
 * behaviorally identical instead of drifting apart as two local copies.
 */
export function ProvenanceChips({
  factIds,
  factClaims,
}: {
  factIds: string[];
  factClaims: Record<string, string>;
}) {
  if (factIds.length === 0) return null;
  return (
    <div className="chip-list">
      {factIds.map((id) => (
        <span key={id} className="chip" title={id}>
          {factClaims[id] ?? "fact removed"}
        </span>
      ))}
    </div>
  );
}
