import { generationResultSchema } from "@careerhq/contracts";
import { streamChatJson } from "@careerhq/ai";
import {
  finalizeGeneration, prepareGeneration, runGeneration,
  type GenerationArgs, type GenerationDeps, type GenerationOutcome,
} from "../../../../lib/generation.js";

export type StreamEvent =
  | { type: "delta"; answer: string }
  | { type: "fallback" }
  | { type: "done"; outcome: GenerationOutcome };

/**
 * Drives one generation attempt to completion, sending every event through
 * `send`. `send` (see `createSseWriter`) is expected to never throw, even
 * after the client has disconnected — that guarantee is what lets this
 * function's fallback branch below always run to completion (and persist a
 * draft) regardless of whether anyone is still listening for the SSE
 * events. Never closes anything itself; the caller owns the stream's
 * lifecycle.
 */
export async function runStream(
  deps: GenerationDeps,
  args: GenerationArgs,
  send: (event: StreamEvent) => void,
): Promise<void> {
  const prepared = await prepareGeneration(deps, args);
  if (!prepared.ready) {
    send({ type: "done", outcome: prepared.outcome });
    return;
  }

  // Replay mode is instant (it never touches the network), so there is
  // nothing to stream: `runGeneration` re-runs the (cheap, deterministic)
  // prelude and hands back the replayed outcome directly.
  if (deps.config.aiMode === "replay") {
    send({ type: "done", outcome: await runGeneration(deps, args) });
    return;
  }

  // prepareGeneration already returned ai_unavailable for a null key; this
  // is for type narrowing only; unreachable in practice.
  const apiKey = deps.config.openrouterApiKey;
  if (apiKey === null) {
    send({ type: "done", outcome: { status: "ai_unavailable" } });
    return;
  }

  const model = deps.config.aiWritingModels[0];
  if (!model) {
    // No writing model configured at all — nothing to stream from. Fall
    // through to the full non-streaming chain, which reports
    // `no_models_configured` via its normal failure path.
    send({ type: "fallback" });
    send({ type: "done", outcome: await runGeneration(deps, args) });
    return;
  }

  const factIds = new Set(prepared.factIds);
  let streamFailed: boolean;
  try {
    const result = await streamChatJson(
      {
        system: prepared.prompt.system,
        user: prepared.prompt.user,
        schema: generationResultSchema,
        model,
        apiKey,
        isUseful: (value) => value.factIds.every((id) => factIds.has(id)),
      },
      { onAnswerDelta: (answerSoFar) => send({ type: "delta", answer: answerSoFar }) },
    );

    if (result.ok && result.value) {
      const outcome = await finalizeGeneration(
        deps, args, result.value, prepared.factIds, result.model || null,
      );
      send({ type: "done", outcome });
      return;
    }
    streamFailed = true;
  } catch {
    streamFailed = true;
  }

  // Stream attempt failed (timeout, malformed/hallucinated JSON, transport
  // error, or the client disconnecting mid-stream): fall back to the full
  // non-streaming chain, which retries across every configured writing
  // model. This runs unconditionally — `send` never throws, so a client
  // that vanished before this point does not stop the draft from being
  // generated and persisted; it will simply be there on reload.
  if (streamFailed) {
    send({ type: "fallback" });
    send({ type: "done", outcome: await runGeneration(deps, args) });
  }
}
