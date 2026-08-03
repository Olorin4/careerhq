import { z } from "zod";
import { documentKindSchema } from "@careerhq/contracts";
import { loadConfig } from "@careerhq/config";
import { getDb } from "../../../../lib/db.js";
import { getActiveWorkspace } from "../../../../lib/workspace.js";
import type { GenerationArgs, GenerationDeps } from "../../../../lib/generation.js";
import { createSseWriter } from "./sse-writer.js";
import { runStream, type StreamEvent } from "./run-stream.js";

// The prelude and finalize steps read the database via `pg` (node-postgres),
// which has no edge runtime build — this route must run on Node.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ applicationId: z.string().uuid(), kind: documentKindSchema });

function sseLine(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
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

  // Shared between `start` and `cancel` below (the same underlying source
  // gets both calls), so it's declared in the outer scope rather than
  // created inside `start`.
  let writer: ReturnType<typeof createSseWriter<StreamEvent>> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      writer = createSseWriter<StreamEvent>(controller, sseLine);
      try {
        await runStream(deps, args, writer.send);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown_error";
        writer.send({ type: "done", outcome: { status: "failed", error: message } });
      } finally {
        writer.close();
      }
    },
    // Fires when the client disconnects (e.g. navigates away, closes the
    // tab, or the fetch is aborted) before the stream ends. Marks the writer
    // closed so any `send`/`close` still in flight inside `start` becomes a
    // silent no-op instead of throwing on an already-closed controller —
    // `runStream`'s fallback generation keeps running and still persists.
    cancel() {
      writer?.cancel();
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
