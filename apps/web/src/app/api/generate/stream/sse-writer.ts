/**
 * Minimal shape of `ReadableStreamDefaultController` this module actually
 * uses — narrowed so a plain object stub can stand in for the real
 * controller in tests without constructing a real `ReadableStream`.
 */
export interface SseController {
  enqueue(chunk: Uint8Array): void;
  close(): void;
}

export interface SseWriter<T> {
  /**
   * Writes one SSE event. Never throws: a client that has already
   * disconnected makes `controller.enqueue` throw ("Controller is already
   * closed" or similar), and the caller (`runStream`) always has more work
   * to do after a `send` — most importantly the non-streaming fallback that
   * must still persist a draft even though nobody is listening for it
   * anymore. A `send` that could throw would silently cut that work short.
   */
  send(event: T): void;
  /** Idempotent: closes the underlying controller at most once. */
  close(): void;
  /**
   * Marks the writer closed without touching the controller — call this from
   * the stream's `cancel()` callback (fired on client disconnect) so any
   * `send`/`close` still in flight becomes a no-op instead of throwing.
   */
  cancel(): void;
  /** True once `cancel()` fired or a `send`/`close` attempt has failed. */
  readonly closed: boolean;
}

/**
 * Wraps a `ReadableStreamDefaultController` so every write is best-effort.
 * Once the client disconnects (via `cancel()`, or discovered lazily when an
 * `enqueue`/`close` call throws), every subsequent `send`/`close` is a
 * silent no-op — the caller's own control flow is never interrupted by the
 * write itself failing.
 */
export function createSseWriter<T>(
  controller: SseController,
  serialize: (event: T) => string,
): SseWriter<T> {
  const encoder = new TextEncoder();
  let closed = false;

  return {
    get closed() {
      return closed;
    },
    send(event) {
      if (closed) return;
      try {
        controller.enqueue(encoder.encode(serialize(event)));
      } catch {
        closed = true;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        controller.close();
      } catch {
        // Already closed/errored — nothing left to do.
      }
    },
    cancel() {
      closed = true;
    },
  };
}
