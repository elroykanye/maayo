const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export async function fetchWithTimeout<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  consume: (response: Response) => Promise<T>,
  requestedTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? requestedTimeoutMs
    : DEFAULT_REQUEST_TIMEOUT_MS;
  const forwardAbort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) forwardAbort();
  else init.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new DOMException(`Request timed out after ${timeoutMs}ms`, 'TimeoutError'));
  }, timeoutMs);

  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAbort = () => reject(
      controller.signal.reason
        ?? new DOMException('Request aborted', 'AbortError'),
    );
    if (controller.signal.aborted) rejectAbort();
    else controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });

  try {
    const request = (async () => {
      const response = await fetch(input, { ...init, signal: controller.signal });
      return consume(response);
    })();
    return await Promise.race([request, aborted]);
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', forwardAbort);
  }
}
