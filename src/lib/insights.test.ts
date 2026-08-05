/**
 * fetchTweetMetrics tests.
 *
 * Mocks the `twitter-api-v2` client's `v2.singleTweet` method.
 */

import { describe, it, expect, vi } from "vitest";
import type { TwitterApi } from "twitter-api-v2";
import { fetchTweetMetrics } from "./insights.js";

function makeClient(response: unknown, throws?: Error): TwitterApi {
  const singleTweet = vi.fn(async () => {
    if (throws) throw throws;
    return response;
  });
  return {
    v2: { singleTweet },
  } as unknown as TwitterApi;
}

describe("fetchTweetMetrics", () => {
  it("parses public_metrics into typed fields", async () => {
    const client = makeClient({
      data: {
        id: "12345",
        public_metrics: {
          impression_count: 1500,
          like_count: 42,
          retweet_count: 7,
          reply_count: 3,
          quote_count: 1,
          bookmark_count: 5,
        },
      },
    });

    const result = await fetchTweetMetrics(client, { tweetId: "12345" });

    expect(result.impressionCount).toBe(1500);
    expect(result.likeCount).toBe(42);
    expect(result.retweetCount).toBe(7);
    expect(result.replyCount).toBe(3);
    expect(result.quoteCount).toBe(1);
    expect(result.bookmarkCount).toBe(5);
  });

  it("returns null fields when public_metrics is missing", async () => {
    const client = makeClient({ data: { id: "12345" } });
    const result = await fetchTweetMetrics(client, { tweetId: "12345" });

    expect(result.impressionCount).toBeNull();
    expect(result.likeCount).toBeNull();
  });

  it("throws when X returns an errors array (auth/access failures)", async () => {
    const client = makeClient({
      errors: [
        { title: "Forbidden", detail: "Access denied to this tweet." },
      ],
    });
    await expect(
      fetchTweetMetrics(client, { tweetId: "12345" }),
    ).rejects.toThrow(/Forbidden/);
  });

  it("rejects empty tweetId without hitting the network", async () => {
    const fn = vi.fn();
    const client = { v2: { singleTweet: fn } } as unknown as TwitterApi;

    await expect(fetchTweetMetrics(client, { tweetId: "" })).rejects.toThrow(
      /tweetId/,
    );
    expect(fn).not.toHaveBeenCalled();
  });
});
