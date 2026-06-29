const TRANSIENT_RE =
  /ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EPIPE|EAI_AGAIN|socket hang up|connection reset|timed?\s*out|fetch failed|(?<![#/\-])(?:^|\b)50[0-4]\b|Bad Gateway|Service Unavailable|Gateway Timeout|Internal Server Error/i;

export function isTransientError(err: unknown): boolean {
  // Prefer err.cause (raw stderr/API error) over err.message which may
  // contain branch names, PR numbers, or slugified titles that false-positive.
  if (err instanceof Error) {
    if (typeof err.cause === "string") return TRANSIENT_RE.test(err.cause);
    if (err.cause instanceof Error) return isTransientError(err.cause);
    return TRANSIENT_RE.test(err.message);
  }
  return TRANSIENT_RE.test(String(err));
}

export interface RetryTransientOpts {
  onRetry?: (attempt: number, err: unknown) => void;
}

/**
 * Retry `fn` up to `retries` times on transient errors only.
 * Deterministic errors are thrown immediately without retry.
 * Total attempts = retries + 1.
 */
export async function retryTransient<T>(
  retries: number,
  fn: () => Promise<T>,
  opts?: RetryTransientOpts,
): Promise<T> {
  if (!Number.isFinite(retries) || retries < 0 || !Number.isInteger(retries)) {
    throw new Error(`retryTransient: invalid retries value: ${retries}`);
  }
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i < retries && isTransientError(err)) {
        try { opts?.onRetry?.(i + 1, err); } catch { /* logging must not break retry */ }
        continue;
      }
      throw err;
    }
  }
  throw new Error("retryTransient: unreachable");
}
