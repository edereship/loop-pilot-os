import type { FetchFn } from "./task-source.js";

export const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

export function fetchWithTimeout(
  fetchFn: FetchFn,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): FetchFn {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const merged = { ...init, signal: controller.signal };
      return await fetchFn(url, merged);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(`fetch timed out after ${timeoutMs}ms: ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}
