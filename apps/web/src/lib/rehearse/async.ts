/** Abortable sleep — rejects with an `AbortError` when `signal` fires. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

export function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

/** Resolve on the next animation frame (or a short macrotask outside a browser). */
export function nextFrame(signal: AbortSignal): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return sleep(16, signal);
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    requestAnimationFrame(() => resolve());
  });
}
