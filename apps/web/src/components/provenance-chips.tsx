import { Chip } from "./chip.js";

/**
 * Renders the fact ids a generated document/answer cited as small chips,
 * labeled with the fact's claim (or "fact removed" if the fact no longer
 * exists in `factClaims` — e.g. it was hard-deleted rather than archived).
 * Shared by the materials and Q&A panels so both stay visually and
 * behaviorally identical instead of drifting apart as two local copies.
 *
 * Built on the shared `Chip` primitive — the `data-testid`s below are two of
 * the 36 hooks `scripts/capture-demo-media.ts` depends on (shot 05's
 * provenance-chip assertion), so they stay exactly as they were before this
 * screen's redesign even though the visual styling now comes from `Chip`.
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
    <div className="flex flex-wrap gap-1.5" data-testid="chip-list">
      {factIds.map((id) => (
        <Chip key={id} testId="chip" title={id}>
          {factClaims[id] ?? "fact removed"}
        </Chip>
      ))}
    </div>
  );
}
