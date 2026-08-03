import { describe, expect, it, vi } from "vitest";
import { createSseWriter, type SseController } from "./sse-writer.js";

function makeController(): SseController & { enqueued: string[] } {
  const decoder = new TextDecoder();
  const enqueued: string[] = [];
  return {
    enqueued,
    enqueue(chunk: Uint8Array) {
      enqueued.push(decoder.decode(chunk));
    },
    close: vi.fn(),
  };
}

const serialize = (event: { n: number }) => JSON.stringify(event);

describe("createSseWriter", () => {
  it("enqueues serialized events while open", () => {
    const controller = makeController();
    const writer = createSseWriter(controller, serialize);
    writer.send({ n: 1 });
    writer.send({ n: 2 });
    expect(controller.enqueued).toEqual(['{"n":1}', '{"n":2}']);
    expect(writer.closed).toBe(false);
  });

  it("send() never throws, even when the controller is already closed", () => {
    const controller: SseController = {
      enqueue: () => {
        throw new Error("Controller is already closed");
      },
      close: vi.fn(),
    };
    const writer = createSseWriter(controller, serialize);
    expect(() => writer.send({ n: 1 })).not.toThrow();
    expect(writer.closed).toBe(true);
  });

  it("send() is a no-op after cancel(), and never calls enqueue again", () => {
    const controller = makeController();
    const writer = createSseWriter(controller, serialize);
    writer.cancel();
    expect(writer.closed).toBe(true);
    writer.send({ n: 1 });
    expect(controller.enqueued).toEqual([]);
  });

  it("cancel() does not touch the controller at all", () => {
    const controller = makeController();
    const writer = createSseWriter(controller, serialize);
    writer.cancel();
    expect(controller.close).not.toHaveBeenCalled();
  });

  it("close() calls the controller's close() exactly once even if called twice", () => {
    const controller = makeController();
    const writer = createSseWriter(controller, serialize);
    writer.close();
    writer.close();
    expect(controller.close).toHaveBeenCalledTimes(1);
  });

  it("close() never throws when the controller is already closed", () => {
    const controller: SseController = {
      enqueue: vi.fn(),
      close: () => {
        throw new Error("Controller is already closed");
      },
    };
    const writer = createSseWriter(controller, serialize);
    expect(() => writer.close()).not.toThrow();
    expect(writer.closed).toBe(true);
  });

  it("close() after cancel() never calls the controller's close()", () => {
    const controller = makeController();
    const writer = createSseWriter(controller, serialize);
    writer.cancel();
    writer.close();
    expect(controller.close).not.toHaveBeenCalled();
  });

  it("downstream work after a failed send() still runs — the exact bug this fixes", async () => {
    // Simulates the shape of `runStream`'s fallback branch: `send(...)` for
    // notification, then an awaited unit of work that must complete
    // regardless of whether the notification reached anyone.
    const controller: SseController = {
      enqueue: () => {
        throw new Error("Controller is already closed");
      },
      close: vi.fn(),
    };
    const writer = createSseWriter(controller, serialize);
    const fallbackWork = vi.fn(async () => "persisted");

    async function runLikeRunStream(): Promise<string> {
      writer.send({ n: 1 }); // would have thrown before the fix
      const result = await fallbackWork(); // must still execute
      writer.send({ n: 2 });
      return result;
    }

    await expect(runLikeRunStream()).resolves.toBe("persisted");
    expect(fallbackWork).toHaveBeenCalledTimes(1);
  });
});
