import { describe, it, expect } from "vitest";
import { fetchWithTimeout, DEFAULT_FETCH_TIMEOUT_MS } from "../src/fetch-timeout.js";
import type { FetchFn } from "../src/task-source.js";

describe("fetchWithTimeout", () => {
  const okResponse = { ok: true as const, status: 200, json: async () => ({}) };

  it("passes through a successful response", async () => {
    const inner: FetchFn = async () => okResponse;
    const wrapped = fetchWithTimeout(inner);
    const res = await wrapped("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("throws a descriptive error when fetch exceeds timeout", async () => {
    const hanging: FetchFn = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    const wrapped = fetchWithTimeout(hanging, 50);
    await expect(
      wrapped("https://api.linear.app/graphql", {
        method: "POST",
        headers: {},
        body: "{}",
      }),
    ).rejects.toThrow(/fetch timed out after 50ms.*api\.linear\.app/);
  });

  it("propagates non-timeout errors unchanged", async () => {
    const failing: FetchFn = async () => {
      throw new TypeError("network down");
    };
    const wrapped = fetchWithTimeout(failing);
    await expect(
      wrapped("https://api.linear.app/graphql", {
        method: "POST",
        headers: {},
        body: "{}",
      }),
    ).rejects.toThrow("network down");
  });

  it("passes abort signal to the underlying fetch", async () => {
    let receivedSignal: AbortSignal | undefined;
    const spy: FetchFn = async (_url, init) => {
      receivedSignal = init.signal;
      return okResponse;
    };
    const wrapped = fetchWithTimeout(spy);
    await wrapped("https://example.com", {
      method: "POST",
      headers: {},
      body: "{}",
    });
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal!.aborted).toBe(false);
  });

  it("exports DEFAULT_FETCH_TIMEOUT_MS as 60 seconds", () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBe(60_000);
  });
});
