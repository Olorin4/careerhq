import { z } from "zod";
import { documentKindSchema, generationResultSchema } from "@careerhq/contracts";
import { streamChatJson } from "@careerhq/ai";
import { loadConfig } from "@careerhq/config";
import { getDb } from "../../../../lib/db.js";
import { getActiveWorkspace } from "../../../../lib/workspace.js";
import {
  finalizeGeneration, prepareGeneration, runGeneration,
  type GenerationDeps, type GenerationArgs, type GenerationOutcome,
} from "../../../../lib/generation.js";

// The prelude and finalize steps read the database via `pg` (node-postgres),
// which has no edge runtime build — this route must run on Node.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ applicationId: z.string().uuid(), kind: documentKindSchema });

type StreamEvent =
  | { type: "delta"; answer: string }
  | { type: "fallback" }
  | { type: "done"; outcome: GenerationOutcome };

function sseLine(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Drives one generation attempt to completion, sending every event over
 * `send`. Never closes the controller itself — the caller owns that so a
 * thrown error still reaches a single, well-formed `close()`.
 */
async function runStream(
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
  // error): fall back to the full non-streaming chain, which retries across
  // every configured writing model.
  if (streamFailed) {
    send({ type: "fallback" });
    send({ type: "done", outcome: await runGeneration(deps, args) });
  }
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }

  const db = getDb();
  const config = loadConfig();
  const ws = await getActiveWorkspace(db);
  const deps: GenerationDeps = { db, config };
  const args: GenerationArgs = {
    workspaceId: ws.id,
    applicationId: parsed.data.applicationId,
    kind: parsed.data.kind,
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: StreamEvent) => controller.enqueue(encoder.encode(sseLine(event)));
      try {
        await runStream(deps, args, send);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown_error";
        send({ type: "done", outcome: { status: "failed", error: message } });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
