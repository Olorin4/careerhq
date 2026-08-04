"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DOCUMENT_KINDS, type DocumentKind } from "@careerhq/contracts";
import type { GeneratedDocument } from "@careerhq/db";
import { ProvenanceChips } from "../../../../components/provenance-chips.js";
import type { GenerationOutcome } from "../../../../lib/generation.js";
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
}

export function Materials({ applicationId, documents, factClaims, aiAvailable }: MaterialsProps) {
  return (
    <section className="materials">
      <h2>Materials</h2>
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
        />
      ))}
    </section>
  );
}

function OutcomePane({ outcome }: { outcome: GenerationOutcome }) {
  switch (outcome.status) {
    case "ok":
      // Handled by the caller (triggers a router.refresh() instead of ever
      // rendering this state) — kept for exhaustiveness.
      return null;
    case "needs_facts":
      return (
        <div className="materials-needs-facts">
          <p>Not enough verified facts to generate this confidently:</p>
          <ul>
            {outcome.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <p>
            <a href="/facts">Add a verified fact</a>, or write a draft manually below.
          </p>
        </div>
      );
    case "sensitive_blocked":
      return (
        <p className="materials-error">
          This touches a sensitive topic ({outcome.matchedTerms.join(", ")}) — please write it
          manually below.
        </p>
      );
    case "ai_unavailable":
      return <p className="materials-manual-note">AI is not configured — write a manual draft below.</p>;
    case "failed":
      return <p className="materials-error">Generation failed: {outcome.error}</p>;
  }
}

function MaterialSection({
  applicationId,
  kind,
  document,
  factClaims,
  aiAvailable,
}: {
  applicationId: string;
  kind: DocumentKind;
  document: GeneratedDocument | null;
  factClaims: Record<string, string>;
  aiAvailable: boolean;
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
  // limit) so it is never silently dropped.
  const [manualError, saveManualDraft] = useActionState(createManualDocumentAction, null);

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

  return (
    <div className="materials-section">
      <h3>{KIND_LABELS[kind]}</h3>

      {document ? (
        <div className="materials-doc">
          <div className="materials-doc-meta">
            {document.origin === "ai" && document.approval === "draft" && (
              <span className="badge badge-ai-draft">AI-generated — not yet approved</span>
            )}
            <span className="badge">{humanize(document.approval)}</span>
            <span className="materials-doc-date">{document.createdAt.toLocaleString()}</span>
          </div>
          <pre className="materials-doc-content">{document.contentMd}</pre>
          <ProvenanceChips factIds={document.sourceFactIds} factClaims={factClaims} />
          <div className="materials-doc-actions">
            <button
              type="button"
              disabled={isPending || document.approval === "approved"}
              onClick={handleApprove}
            >
              Approve
            </button>
            <button
              type="button"
              disabled={isPending || document.approval === "rejected"}
              onClick={handleReject}
            >
              Reject
            </button>
          </div>
        </div>
      ) : (
        <p className="materials-empty">No draft yet.</p>
      )}
      {error && <p className="materials-error">{error}</p>}

      <div className="materials-generate">
        {aiAvailable ? (
          <>
            <button type="button" disabled={streaming} onClick={handleGenerate}>
              {streaming ? "Generating…" : "Generate with AI"}
            </button>
            {streaming && (
              <div className="materials-stream">
                {fellBack && (
                  <p className="materials-fallback-note">
                    Streaming model unavailable — retrying without streaming…
                  </p>
                )}
                <pre>{streamText || "Waiting for model…"}</pre>
              </div>
            )}
            {outcome && <OutcomePane outcome={outcome} />}
          </>
        ) : (
          <p className="materials-manual-note">
            AI generation is not configured for this workspace — write a manual draft below.
          </p>
        )}
      </div>

      <form action={saveManualDraft} className="materials-manual-form">
        <input type="hidden" name="applicationId" value={applicationId} />
        <input type="hidden" name="kind" value={kind} />
        <label>
          Manual draft
          <textarea
            name="content"
            defaultValue={document?.origin === "user" ? document.contentMd : ""}
            rows={6}
            required
          />
        </label>
        <button type="submit">Save manual draft</button>
        {manualError && <p className="materials-error">{manualError}</p>}
      </form>
    </div>
  );
}
