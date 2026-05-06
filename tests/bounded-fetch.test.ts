import { describe, expect, it } from "vitest";
import { fetchWithDeadline, readBoundedText } from "../src/util/bounded-fetch.js";

// On overflow, the helper must do more than throw — it must actually cancel
// the underlying body so the upstream socket closes. Releasing the reader
// lock alone leaves a hostile sender free to keep streaming after we've
// already given up, defeating the DoS protection this helper exists for.
interface CancelTracker {
  cancelled: boolean;
  reason: unknown;
  pulls: number;
}

function makeUnboundedResponse(
  chunkSize: number,
  tracker: CancelTracker
): Response {
  const chunk = new Uint8Array(chunkSize).fill(0x41);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      tracker.pulls += 1;
      controller.enqueue(chunk);
    },
    cancel(reason) {
      tracker.cancelled = true;
      tracker.reason = reason;
    }
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/plain" } });
}

function makeBoundedResponse(text: string, tracker: CancelTracker): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
    cancel(reason) {
      tracker.cancelled = true;
      tracker.reason = reason;
    }
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/plain" } });
}

describe("readBoundedText", () => {
  it("cancels the underlying stream when the cap is exceeded", async () => {
    const tracker: CancelTracker = { cancelled: false, reason: undefined, pulls: 0 };
    // Pull-based stream that keeps sending chunks until cancel is called.
    // Without cancel propagation the producer would keep getting pulled and
    // the socket would stay open after we've already bailed.
    const response = makeUnboundedResponse(8, tracker);
    await expect(readBoundedText(response, 15, "test://bounded")).rejects.toThrow(
      /body exceeds 15 bytes/
    );
    expect(tracker.cancelled).toBe(true);
  });

  it("does not cancel when the body fits under the cap", async () => {
    const tracker: CancelTracker = { cancelled: false, reason: undefined, pulls: 0 };
    const response = makeBoundedResponse("ok", tracker);
    const text = await readBoundedText(response, 64, "test://fits");
    expect(text).toBe("ok");
    expect(tracker.cancelled).toBe(false);
  });

  // Round-36 fix: a stalled stream that never reaches the size cap was hanging
  // forever. The GitHub adapter fetches resources serially, so a single
  // half-open socket would pin install_skill / check_updates indefinitely with
  // no signal. The deadline must abort and the reader must cancel.
  it("aborts and cancels when the body never completes (deadline)", async () => {
    const tracker: CancelTracker = { cancelled: false, reason: undefined, pulls: 0 };
    // Stream that sends one tiny chunk then hangs forever — well under the
    // size cap, so only the time deadline can break out.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a"));
        // No close, no further enqueues — pull() never resolves.
      },
      pull() {
        tracker.pulls += 1;
        return new Promise<void>(() => {
          // Never resolves; the deadline must cancel the reader.
        });
      },
      cancel(reason) {
        tracker.cancelled = true;
        tracker.reason = reason;
      }
    });
    const response = new Response(stream, { status: 200 });
    const start = Date.now();
    await expect(
      readBoundedText(response, 1024, "test://stalled", { deadlineMs: 50 })
    ).rejects.toThrow(/did not complete within 50ms/);
    const elapsed = Date.now() - start;
    // 50ms deadline — a 1s ceiling proves the deadline fired (no test should
    // be flaky on a 20× margin) and the loop didn't hang.
    expect(elapsed).toBeLessThan(1000);
    expect(tracker.cancelled).toBe(true);
  });

  // Round-38 fix: readBoundedText only fires after a Response is in hand.
  // A server that accepts the connection but never sends headers leaves
  // `await fetcher(...)` pending forever. fetchWithDeadline must abort the
  // fetch promise itself, not just the body.
  it("fetchWithDeadline aborts a never-resolving fetch promise", async () => {
    const stalledFetcher: typeof fetch = (() =>
      new Promise<Response>(() => {
        // Never resolves — simulates a TCP-accepted connection that never sends headers.
      })) as unknown as typeof fetch;
    const start = Date.now();
    await expect(
      fetchWithDeadline(stalledFetcher, "https://example.test/stalled", {}, "test://request-stall", {
        deadlineMs: 50
      })
    ).rejects.toThrow(/request did not complete within 50ms/);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("fetchWithDeadline propagates the abort signal to fetch", async () => {
    let receivedSignal: AbortSignal | undefined;
    const fetcher: typeof fetch = ((url: string | URL, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_, reject) => {
        // Fail when aborted — confirms the signal was wired in, not just that the
        // outer Promise.race fired.
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("abort propagated"));
        });
      });
    }) as unknown as typeof fetch;
    await expect(
      fetchWithDeadline(fetcher, "https://example.test/x", {}, "test://abort-prop", {
        deadlineMs: 30
      })
    ).rejects.toThrow(/request did not complete within 30ms/);
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("fetchWithDeadline returns the response when the fetch resolves in time", async () => {
    const ok = new Response("hello", { status: 200 });
    const fetcher: typeof fetch = (async () => ok) as unknown as typeof fetch;
    const result = await fetchWithDeadline(
      fetcher,
      "https://example.test/ok",
      {},
      "test://ok",
      { deadlineMs: 1000 }
    );
    expect(result).toBe(ok);
  });

  // Round-40 fix: a hostile upstream's ReadableStream can return a never-
  // settling promise from cancel(). Awaiting it in finally would pin the
  // helper forever, defeating the DoS guard. Cancel must be raced against
  // a short deadline so the original "body exceeds N bytes" error always
  // propagates.
  it("does not hang when the underlying cancel() promise never resolves (round-40)", async () => {
    const chunk = new Uint8Array(8).fill(0x41);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        // Returning a forever-pending promise — simulates a hostile upstream
        // whose stream cancel never settles.
        return new Promise<void>(() => {});
      }
    });
    const response = new Response(stream, { status: 200 });
    const start = Date.now();
    await expect(readBoundedText(response, 15, "test://cancel-hang")).rejects.toThrow(
      /body exceeds 15 bytes/
    );
    // 500ms cancel deadline; assert settle well before that to prove the
    // race engaged. A 2s ceiling is generous against CI jitter while still
    // proving we did not hang on the never-settling cancel promise.
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("aborts the buffered (no body) path when text() never resolves", async () => {
    // Some test mocks return a Response with no `body` and only stub `text()`.
    // The deadline must apply to that path too — otherwise a mock that
    // forgets to resolve text() would hang the whole suite.
    const response = {
      body: null,
      text: () => new Promise<string>(() => {})
    } as unknown as Response;
    const start = Date.now();
    await expect(
      readBoundedText(response, 1024, "test://buffered-stall", { deadlineMs: 50 })
    ).rejects.toThrow(/did not complete within 50ms/);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
