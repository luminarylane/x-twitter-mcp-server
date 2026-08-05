/**
 * Regression tests for the #1995 first-comment partial-success contract (#1931).
 *
 * postTweetFirstComment is called from BOTH x_create_tweet paths (media tweet
 * and text/link tweet), so this single helper test guards both against the
 * silent-swallow regression: if the tweet posts but the reply fails, the
 * handler must report a partial failure, never a clean success.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { postTweetFirstComment } from "./index.js";
import type { TwitterApi } from "twitter-api-v2";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function runWithTimers<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

function clientWithReply(reply: ReturnType<typeof vi.fn>): TwitterApi {
  return { v2: { reply } } as unknown as TwitterApi;
}

describe("postTweetFirstComment — partial-success contract", () => {
  it("returns the reply id when the first comment posts", async () => {
    vi.useFakeTimers();
    const reply = vi.fn().mockResolvedValue({ data: { id: "reply-1" } });

    const result = await runWithTimers(
      postTweetFirstComment(clientWithReply(reply), "tweet-1", "More here →"),
    );

    expect(result).toEqual({ firstCommentId: "reply-1" });
    expect(reply).toHaveBeenCalledWith("More here →", "tweet-1");
  });

  it("returns { errMsg } (NOT a clean success) when the reply throws", async () => {
    vi.useFakeTimers();
    const reply = vi.fn().mockRejectedValue(new Error("x boom"));

    const result = await runWithTimers(
      postTweetFirstComment(clientWithReply(reply), "tweet-1", "hi"),
    );

    expect(result.errMsg).toContain("x boom");
    expect(result.firstCommentId).toBeUndefined();
  });

  it("is a no-op (no API call) when firstComment is blank", async () => {
    const reply = vi.fn();

    expect(
      await postTweetFirstComment(clientWithReply(reply), "tweet-1", "   "),
    ).toEqual({});
    expect(
      await postTweetFirstComment(clientWithReply(reply), "tweet-1", undefined),
    ).toEqual({});
    expect(reply).not.toHaveBeenCalled();
  });

  it("caps the reply at the 280-char tweet limit", async () => {
    vi.useFakeTimers();
    const reply = vi.fn().mockResolvedValue({ data: { id: "r" } });

    await runWithTimers(
      postTweetFirstComment(clientWithReply(reply), "t", "y".repeat(400)),
    );

    expect((reply.mock.calls[0][0] as string).length).toBe(280);
  });
});
