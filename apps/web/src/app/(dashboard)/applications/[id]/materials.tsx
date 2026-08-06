"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DOCUMENT_KINDS, type DocumentKind } from "@careerhq/contracts";
import type { GeneratedDocument } from "@careerhq/db";
import { Badge } from "../../../../components/badge.js";
import { Button } from "../../../../components/button.js";
import { CONTROL_CLASSES, Field } from "../../../../components/field.js";
import { ProvenanceChips } from "../../../../components/provenance-chips.js";
import { Section } from "../../../../components/section.js";
import { APPROVAL_TONE } from "../../../../lib/application-state.js";
import type { GenerationOutcome } from "../../../../lib/generation.js";
import { REPLAY_MISS, replayMissMessage } from "../../../../lib/replay-miss.js";
import { formatTimestamp } from "../../../../lib/time.js";
import {
  approveDocumentAction, createManualDocumentAction, generateDocumentAction, rejectDocumentAction,
} from "./materials-actions.js";

type StreamEvent =
  | { type: "delta"; answer: string }
  | { type: "fallback" }
  | { type: "done"; outcome: GenerationOutcome };

const KIND_LABELS: Record<DocumentKind, string> = {
  cover_letter: "Cover letter",
  email_body: "Email body",
};

function humanize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

interface MaterialsProps {
  applicationId: string;
  documents: GeneratedDocument[];
  /** Every fact claim in the workspace (including archived), keyed by id, for provenance chip labels. */
  factClaims: Record<string, string>;
  /** Whether an OpenRouter key is configured — precomputed server-side so the manual-mode note shows immediately, with no wasted click. */
  aiAvailable: boolean;
  /** Whether this deployment is the hosted demo answering from recorded AI output — decides how a `replay_miss` is worded. */
  replayDemo: boolean;
}

export function Materials({
  applicationId, documents, factClaims, aiAvailable, replayDemo,
}: MaterialsProps) {
  return (
    <Section title="Materials">
      <div className="flex flex-col gap-4">
        {DOCUMENT_KINDS.map((kind) => (
          <MaterialSection
            key={kind}
            applicationId={applicationId}
            kind={kind}
            // `documents` is ordered newest-first across all kinds (see
            // listDocuments), so the first match for a kind is its latest version.
            document={documents.find((d) => d.kind === kind) ?? null}
            factClaims={factClaims}
            aiAvailable={aiAvailable}
            replayDemo={replayDemo}
          />
        ))}
      </div>
    </Section>
  );
}

/** The shared "the pipeline refused, here's why, here's the way out" treatment — matches `qa.tsx`'s `OutcomePane`. */
function OutcomePane({ outcome, replayDemo }: { outcome: GenerationOutcome; replayDemo: boolean }) {
  switch (outcome.status) {
    case "ok":
      // Handled by the caller (triggers a router.refresh() instead of ever
      // rendering this state) — kept for exhaustiveness.
      return null;
    case "needs_facts":
      return (
        <div
          className="flex flex-col gap-2 rounded-md border-l-4 border-warn bg-warn-soft p-3 text-sm text-ink"
          data-testid="materials-needs-facts"
        >
          <p className="m-0 font-medium">Not enough verified facts to generate this confidently:</p>
          <ul className="m-0 flex flex-col gap-1 pl-5">
            {outcome.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p className="m-0">
            <a href="/facts" className="font-medium text-ink underline">Add a verified fact</a>, or write a draft
            manually below.
          </p>
        </div>
      );
    case "sensitive_blocked":
      return (
        <p className="m-0 text-sm text-bad" role="alert">
          This touches a sensitive topic ({outcome.matchedTerms.join(", ")}) — please write it manually below.
        </p>
      );
    case "ai_unavailable":
      return <p className="m-0 text-sm text-soft italic">AI is not configured — write a manual draft below.</p>;
    case "failed":
      // `replay_miss` is an internal token, not something to put in front of a
      // stranger: on the hosted demo it is the expected answer for a prompt
      // nobody recorded, so it is explained rather than printed.
      if (replayDemo && outcome.error === REPLAY_MISS) {
        return <p className="m-0 text-sm text-soft italic">{replayMissMessage("document")}</p>;
      }
      return (
        <p className="m-0 text-sm text-bad" role="alert">
          Generation failed: {outcome.error}
        </p>
      );
  }
}

function MaterialSection({
  applicationId,
  kind,
  document,
  factClaims,
  aiAvailable,
  replayDemo,
}: {
  applicationId: string;
  kind: DocumentKind;
  document: GeneratedDocument | null;
  factClaims: Record<string, string>;
  aiAvailable: boolean;
  replayDemo: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [fellBack, setFellBack] = useState(false);
  const [outcome, setOutcome] = useState<GenerationOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The manual form posts straight to the server action; `useActionState`
  // carries back the reason a save did nothing (currently only the demo rate
  // limit) AND the text that was submitted, so a refusal neither goes
  // unreported nor costs the user the draft they just typed — React resets an
  // uncontrolled form once its action resolves, and the textarea's
  // `defaultValue` below re-seeds from this.
  const [manualDraft, saveManualDraft] = useActionState(createManualDocumentAction, null);

  async function runNonStreamingFallback() {
    setFellBack(true);
    const result = await generateDocumentAction({ applicationId, kind });
    if (result.status === "ok") {
      router.refresh();
    } else {
      setOutcome(result);
    }
  }

  async function handleGenerate() {
    setError(null);
    setOutcome(null);
    setStreamText("");
    setFellBack(false);
    setStreaming(true);
    try {
      const res = await fetch("/api/generate/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationId, kind }),
      });
      if (!res.ok || !res.body) {
        await runNonStreamingFallback();
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;

      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const rawEvent of events) {
          const line = rawEvent.trim();
          if (!line.startsWith("data:")) continue;
          let event: StreamEvent;
          try {
            event = JSON.parse(line.slice(5).trim()) as StreamEvent;
          } catch {
            continue;
          }

          if (event.type === "delta") {
            setStreamText(event.answer);
          } else if (event.type === "fallback") {
            setFellBack(true);
          } else {
            done = true;
            if (event.outcome.status === "ok") {
              router.refresh();
            } else {
              setOutcome(event.outcome);
            }
          }
        }
      }

      // The route always ends with a "done" event before closing the
      // stream; a reader that ends without one means the connection was cut
      // mid-flight (proxy timeout, server crash) rather than a clean finish.
      if (!done) await runNonStreamingFallback();
    } catch {
      await runNonStreamingFallback();
    } finally {
      setStreaming(false);
    }
  }

  function handleApprove() {
    if (!document) return;
    startTransition(async () => {
      const result = await approveDocumentAction({ id: document.id });
      if (result.ok) router.refresh();
      else setError(`Could not approve this document: ${result.reason}`);
    });
  }

  function handleReject() {
    if (!document) return;
    startTransition(async () => {
      const result = await rejectDocumentAction({ id: document.id });
      if (result.ok) router.refresh();
      else setError(`Could not reject this document: ${result.reason}`);
    });
  }

  // The AI-generated-and-not-yet-approved warning is the design vocabulary's
  // own named example of `warn` — a distinct badge from the general approval
  // badge below it, which stays `neutral` for every draft regardless of who
  // wrote it (see `APPROVAL_TONE`).
  const aiDraft = document?.origin === "ai" && document.approval === "draft";

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 shadow-card"
      data-testid="materials-section"
    >
      <h3 className="m-0 text-sm font-semibold text-ink">{KIND_LABELS[kind]}</h3>

      {document ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {aiDraft && (
              <Badge tone="warn" testId="badge-ai-draft">AI-generated — not yet approved</Badge>
            )}
            <Badge tone={APPROVAL_TONE[document.approval]}>{humanize(document.approval)}</Badge>
            <span className="text-xs text-soft">{formatTimestamp(document.createdAt)}</span>
          </div>
          <pre className="m-0 whitespace-pre-wrap rounded-md border border-line bg-canvas p-3 font-sans text-sm text-ink">
            {document.contentMd}
          </pre>
          <ProvenanceChips factIds={document.sourceFactIds} factClaims={factClaims} />
          <div className="flex gap-2" data-testid="materials-doc-actions">
            <Button
              type="button"
              tone="primary"
              disabled={isPending || document.approval === "approved"}
              onClick={handleApprove}
            >
              Approve
            </Button>
            <Button
              type="button"
              disabled={isPending || document.approval === "rejected"}
              onClick={handleReject}
            >
              Reject
            </Button>
          </div>
        </div>
      ) : (
        <p className="m-0 text-sm text-soft">No draft yet.</p>
      )}
      {error && (
        <p className="m-0 text-sm text-bad" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2">
        {aiAvailable ? (
          <>
            <div>
              <Button type="button" disabled={streaming} onClick={handleGenerate}>
                {streaming ? "Generating…" : "Generate with AI"}
              </Button>
            </div>
            {streaming && (
              <div className="rounded-md border border-dashed border-line bg-canvas p-3 text-sm text-ink">
                {fellBack && (
                  <p className="m-0 mb-2 text-xs text-warn">
                    Streaming model unavailable — retrying without streaming…
                  </p>
                )}
                <pre className="m-0 whitespace-pre-wrap font-sans">{streamText || "Waiting for model…"}</pre>
              </div>
            )}
            {outcome && <OutcomePane outcome={outcome} replayDemo={replayDemo} />}
          </>
        ) : (
          <p className="m-0 text-xs text-soft italic">
            AI generation is not configured for this workspace — write a manual draft below.
          </p>
        )}
      </div>

      <form action={saveManualDraft} className="flex flex-col gap-2 border-t border-line pt-3">
        <input type="hidden" name="applicationId" value={applicationId} />
        <input type="hidden" name="kind" value={kind} />
        <Field label="Manual draft">
          <textarea
            name="content"
            defaultValue={manualDraft?.content ?? (document?.origin === "user" ? document.contentMd : "")}
            rows={6}
            required
            className={CONTROL_CLASSES}
          />
        </Field>
        <div>
          <Button type="submit">Save manual draft</Button>
        </div>
        {manualDraft && (
          <p className="m-0 text-sm text-bad" role="alert">
            Not saved — {manualDraft.reason}. Your draft is still here; try again.
          </p>
        )}
      </form>
    </div>
  );
}
