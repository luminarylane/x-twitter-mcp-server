/**
 * Pure post-metrics functions for the X / Twitter v2 API.
 *
 * Reused by:
 *   1. The MCP server's tool handlers (future `x_get_tweet_metrics`).
 *   2. The web app's `mcp-router-metrics.ts` orchestrator — imported via
 *      webpack alias `@x-twitter-mcp` from compiled `dist/lib/`.
 *
 * X's v2 endpoint `GET /2/tweets/:id?tweet.fields=public_metrics` returns:
 *   - like_count, retweet_count, reply_count, quote_count, bookmark_count
 *     (all public, returned for any tweet)
 *   - impression_count (private — only returned for tweets the authenticated
 *     user owns; absent from responses about other users' tweets)
 *
 * We always call this for tweets we published, so impression_count should
 * generally be present.
 */

import type { TwitterApi } from "twitter-api-v2";
import { withRetry } from "../rate-limiter.js";

export interface TweetMetrics {
  /** Total times the tweet was seen. Only populated for the authenticated user's own tweets. */
  impressionCount: number | null;
  likeCount: number | null;
  retweetCount: number | null;
  replyCount: number | null;
  quoteCount: number | null;
  bookmarkCount: number | null;
  /** Raw `public_metrics` payload for debugging / audit. */
  raw: unknown;
}

export interface FetchTweetMetricsArgs {
  tweetId: string;
}

/**
 * Fetch engagement metrics for a single tweet.
 *
 * @throws Error if tweetId is empty, on rate limit (with withRetry exhausted),
 *         or if the tweet was deleted (404 from API).
 */
export async function fetchTweetMetrics(
  client: TwitterApi,
  args: FetchTweetMetricsArgs,
): Promise<TweetMetrics> {
  if (!args.tweetId.trim()) throw new Error("tweetId cannot be empty");

  const result = await withRetry(() =>
    client.v2.singleTweet(args.tweetId, {
      "tweet.fields": ["public_metrics"],
    }),
  );

  // X v2 returns `{ errors: [...] }` with HTTP 200 on auth/access failures,
  // and `{ data: tweet }` on success. Handle both before reading metrics.
  const errors = (result as { errors?: Array<{ title?: string; detail?: string }> })
    .errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0];
    throw new Error(
      `X API returned an error: ${first.title ?? "Unknown"} — ${first.detail ?? "no detail"}`,
    );
  }

  const data = (result as { data?: { public_metrics?: Record<string, number> } })
    .data;
  const m = data?.public_metrics;

  return {
    impressionCount: m?.impression_count ?? null,
    likeCount: m?.like_count ?? null,
    retweetCount: m?.retweet_count ?? null,
    replyCount: m?.reply_count ?? null,
    quoteCount: m?.quote_count ?? null,
    bookmarkCount: m?.bookmark_count ?? null,
    raw: m ?? null,
  };
}
