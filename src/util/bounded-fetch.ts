// Default total deadline for streaming a single response body. The bundle
// limit is 1 MiB; even a 56 kbps modem finishes that in ~3 minutes, so 30s
// is generous for any reasonable upstream while still bounding the worst
// case where the body never completes (slowloris, half-open socket, kernel
// drop). Callers that need a different ceiling pass `deadlineMs` explicitly.
const DEFAULT_FETCH_DEADLINE_MS = 30_000;

// Round-38 fix: readBoundedText only fires once we already hold a Response.
// A server that accepts the connection but never sends headers, or a socket
// that hangs after TCP open, leaves `await fetcher(...)` pending forever —
// the body deadline never engages because there is no body yet. Wrap every
// remote fetch in this helper so the AbortController fires before the body
// stage takes over. Defaults match the body deadline (30s); worst case is
// request-deadline + body-deadline ≈ 60s, which still bounds DoS while
// surviving real-world TLS handshakes on slow links.
export async function fetchWithDeadline(
  fetcher: typeof fetch,
  url: string | URL,
  init: RequestInit,
  label: string,
  options?: { deadlineMs?: number }
): Promise<Response> {
  const deadlineMs = options?.deadlineMs ?? DEFAULT_FETCH_DEADLINE_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  // Race the fetch against an abort-driven rejection. Real fetch() honors the
  // signal and rejects on its own, but we cannot rely on that — a custom
  // fetcher (test mock, or some non-stdlib transport) might ignore the signal
  // and stay pending forever. The race guarantees we reject either way.
  const abortRejection = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        reject(
          new Error(`Fetch refused: ${label} request did not complete within ${deadlineMs}ms`)
        );
      },
      { once: true }
    );
  });
  try {
    return await Promise.race([
      fetcher(url, { ...init, signal: controller.signal }),
      abortRejection
    ]);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(
        `Fetch refused: ${label} request did not complete within ${deadlineMs}ms`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Stream a fetch response body and abort once we've buffered MAX bytes OR the
// per-fetch deadline elapses. Without the size cap, a hostile or buggy
// upstream that returns 100 MiB (no Content-Length, or a lying Content-Length)
// would force the MCP server to buffer the whole thing before the bundle-size
// validator runs. Without the time cap, an upstream that delivers <max bytes
// but never closes the body would pin install_skill or check_updates forever
// — the GitHub adapter fetches resources serially, so one stalled connection
// blocks the whole install. Used by every remote source adapter so both caps
// are enforced uniformly. The label is interpolated into the error message
// so callers don't have to do their own framing.
export async function readBoundedText(
  response: Response,
  max: number,
  label: string,
  options?: { deadlineMs?: number }
): Promise<string> {
  const deadlineMs = options?.deadlineMs ?? DEFAULT_FETCH_DEADLINE_MS;
  const body = response.body;
  if (!body) {
    // Some test mocks omit `body` and only stub `text()`; enforce both caps on
    // the buffered path so behavior matches the streaming path. Race text()
    // against a deadline so a stalled `await response.text()` cannot hang.
    const text = await raceWithDeadline(
      response.text(),
      deadlineMs,
      `Fetch refused: ${label} body did not complete within ${deadlineMs}ms`
    );
    if (Buffer.byteLength(text, "utf-8") > max) {
      throw new Error(`Fetch refused: ${label} body exceeds ${max} bytes`);
    }
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let succeeded = false;
  let timedOut = false;
  // Single one-shot timer for the whole read loop. On expiry we cancel the
  // reader, which causes the in-flight reader.read() to resolve/reject — the
  // loop then sees `timedOut` and throws. Cleared in finally so a fast read
  // doesn't leak a pending timer.
  const timer = setTimeout(() => {
    timedOut = true;
    reader.cancel(`bounded-fetch deadline exceeded: ${label}`).catch(() => {});
  }, deadlineMs);
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (timedOut) {
          throw new Error(`Fetch refused: ${label} body did not complete within ${deadlineMs}ms`);
        }
        throw err;
      }
      if (timedOut) {
        throw new Error(`Fetch refused: ${label} body did not complete within ${deadlineMs}ms`);
      }
      const { value, done } = chunk;
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        throw new Error(`Fetch refused: ${label} body exceeds ${max} bytes`);
      }
      chunks.push(value);
    }
    succeeded = true;
  } finally {
    clearTimeout(timer);
    // releaseLock leaves the underlying body open — sockets can stay alive
    // and a hostile upstream keeps streaming after we've already bailed.
    // cancel() signals the source to abort and releases the lock as part of
    // its contract, so we use it on every non-success exit.
    if (succeeded) {
      try {
        reader.releaseLock();
      } catch {
        // Reader already released — fine.
      }
    } else {
      // Round-40 fix: a hostile upstream's stream can return a never-settling
      // promise from cancel(), which would hang the in-flight throw forever
      // and defeat the very DoS guard this helper exists for. Race cancel
      // against a short deadline so the helper always settles. The original
      // error is already thrown inside the try block — finally just needs
      // to not block its propagation.
      await cancelWithDeadline(reader, `bounded-fetch aborted: ${label}`);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
}

// Cancel is cleanup, not the core path — the original error is already in
// flight. 500ms is enough for any well-behaved stream to release its
// underlying socket; a longer wait would only let a hostile upstream pin
// the helper longer before the deadline fires. Sockets stuck open for a
// fraction of a second on a refused fetch are the lesser evil vs. hanging.
const CANCEL_DEADLINE_MS = 500;

async function cancelWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: string
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const cancelPromise = (async () => {
    try {
      await reader.cancel(reason);
    } catch {
      // Reader already cancelled or in a terminal state — fine.
    }
  })();
  const deadlinePromise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CANCEL_DEADLINE_MS);
  });
  try {
    await Promise.race([cancelPromise, deadlinePromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function raceWithDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
  message: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), deadlineMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function assertContentLength(
  label: string,
  contentLength: string | null,
  max: number
): void {
  if (contentLength === null) return;
  const declared = Number(contentLength);
  if (!Number.isFinite(declared) || declared < 0) return;
  if (declared > max) {
    throw new Error(`Fetch refused: ${label} declares ${declared} bytes (> ${max})`);
  }
}
