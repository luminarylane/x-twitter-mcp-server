import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkRateLimit, withRetry, WRITE_TOOL_NAMES } from "./rate-limiter.js";

describe("checkRateLimit", () => {
  it("allows read requests under the global limit", () => {
    const result = checkRateLimit("x_get_profile");
    expect(result.allowed).toBe(true);
  });

  it("allows timeline read requests", () => {
    const result = checkRateLimit("x_get_timeline");
    expect(result.allowed).toBe(true);
  });

  it("allows write requests and consumes write bucket tokens", () => {
    const result = checkRateLimit("x_create_tweet");
    expect(result.allowed).toBe(true);
  });

  it("allows like requests", () => {
    const result = checkRateLimit("x_like");
    expect(result.allowed).toBe(true);
  });

  it("allows retweet requests", () => {
    const result = checkRateLimit("x_retweet");
    expect(result.allowed).toBe(true);
  });

  it("treats unknown tool names as global reads", () => {
    const result = checkRateLimit("x_unknown_tool");
    expect(result.allowed).toBe(true);
  });
});

describe("WRITE_TOOL_NAMES", () => {
  it("contains exactly 9 write tools", () => {
    expect(WRITE_TOOL_NAMES.size).toBe(9);
  });

  it("contains all expected write tools", () => {
    expect(WRITE_TOOL_NAMES.has("x_create_tweet")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("x_reply")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("x_quote_tweet")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("x_create_thread")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("x_like")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("x_retweet")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("x_follow")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("x_unfollow")).toBe(true);
    expect(WRITE_TOOL_NAMES.has("x_delete_tweet")).toBe(true);
  });

  it("does not contain read tools", () => {
    expect(WRITE_TOOL_NAMES.has("x_get_timeline")).toBe(false);
    expect(WRITE_TOOL_NAMES.has("x_search_tweets")).toBe(false);
    expect(WRITE_TOOL_NAMES.has("x_get_profile")).toBe(false);
    expect(WRITE_TOOL_NAMES.has("x_get_followers")).toBe(false);
    expect(WRITE_TOOL_NAMES.has("x_get_user_tweets")).toBe(false);
    expect(WRITE_TOOL_NAMES.has("x_search_users")).toBe(false);
    expect(WRITE_TOOL_NAMES.has("x_get_notifications")).toBe(false);
    expect(WRITE_TOOL_NAMES.has("x_get_tweet_thread")).toBe(false);
  });
});

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the result on first success", async () => {
    const result = await withRetry(() => Promise.resolve("ok"));
    expect(result).toBe("ok");
  });

  it("throws non-429 errors immediately", async () => {
    await expect(
      withRetry(() => Promise.reject(new Error("Bad Request"))),
    ).rejects.toThrow("Bad Request");
  });

  it("retries on 429 status errors", async () => {
    let attempt = 0;
    const fn = () => {
      attempt++;
      if (attempt === 1) {
        const err = new Error("rate limited") as Error & { status: number };
        err.status = 429;
        return Promise.reject(err);
      }
      return Promise.resolve("success");
    };

    const promise = withRetry(fn);
    await vi.advanceTimersByTimeAsync(2500);
    const result = await promise;
    expect(result).toBe("success");
    expect(attempt).toBe(2);
  });

  it("retries on ApiResponseError with code 429", async () => {
    let attempt = 0;
    const fn = () => {
      attempt++;
      if (attempt === 1) {
        const err = new Error("Too Many Requests") as Error & { code: number };
        err.code = 429;
        return Promise.reject(err);
      }
      return Promise.resolve("success");
    };

    const promise = withRetry(fn);
    await vi.advanceTimersByTimeAsync(2500);
    const result = await promise;
    expect(result).toBe("success");
    expect(attempt).toBe(2);
  });

  it("retries on rateLimitError flag", async () => {
    let attempt = 0;
    const fn = () => {
      attempt++;
      if (attempt === 1) {
        const err = new Error("rate limit") as Error & {
          rateLimitError: boolean;
        };
        err.rateLimitError = true;
        return Promise.reject(err);
      }
      return Promise.resolve("success");
    };

    const promise = withRetry(fn);
    await vi.advanceTimersByTimeAsync(2500);
    const result = await promise;
    expect(result).toBe("success");
    expect(attempt).toBe(2);
  });
});
