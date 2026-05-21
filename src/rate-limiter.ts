/**
 * Token-bucket rate limiter for X/Twitter API.
 *
 * X free-tier limits:
 *   - Search: ~450 requests per 15 min
 *   - Timeline reads: ~900 per 15 min
 *   - Tweet creation: 50 per 24 hours (free tier!)
 *   - Likes: 1000 per 24 hours
 *   - Retweet/Follow writes: ~5 per 15 min (free tier)
 *
 * This is a simple in-memory implementation — no external dependencies.
 */

interface BucketConfig {
  maxTokens: number;
  refillRate: number; // tokens per millisecond
}

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;

  constructor(config: BucketConfig) {
    this.maxTokens = config.maxTokens;
    this.refillRate = config.refillRate;
    this.tokens = config.maxTokens;
    this.lastRefill = Date.now();
  }

  tryConsume(cost = 1): boolean {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  msUntilAvailable(cost = 1): number {
    this.refill();
    if (this.tokens >= cost) return 0;
    const deficit = cost - this.tokens;
    return Math.ceil(deficit / this.refillRate);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = elapsed * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// X-specific bucket configuration
const globalBucket = new TokenBucket({
  maxTokens: 450,
  refillRate: 450 / FIFTEEN_MINUTES_MS,
});
const timelineBucket = new TokenBucket({
  maxTokens: 900,
  refillRate: 900 / FIFTEEN_MINUTES_MS,
});
const tweetDailyBucket = new TokenBucket({
  maxTokens: 50,
  refillRate: 50 / ONE_DAY_MS,
});
const likeDailyBucket = new TokenBucket({
  maxTokens: 1000,
  refillRate: 1000 / ONE_DAY_MS,
});
const writeShortBucket = new TokenBucket({
  maxTokens: 5,
  refillRate: 5 / FIFTEEN_MINUTES_MS,
});

type WriteBucket = "tweetDaily" | "likeDaily" | "writeShort" | "global";

const WRITE_COSTS: Record<string, { bucket: WriteBucket; cost: number }> = {
  x_create_tweet: { bucket: "tweetDaily", cost: 1 },
  x_reply: { bucket: "tweetDaily", cost: 1 },
  x_quote_tweet: { bucket: "tweetDaily", cost: 1 },
  x_create_thread: { bucket: "tweetDaily", cost: 1 }, // cost multiplied by tweet count at runtime
  x_like: { bucket: "likeDaily", cost: 1 },
  x_retweet: { bucket: "writeShort", cost: 1 },
  x_follow: { bucket: "writeShort", cost: 1 },
  x_unfollow: { bucket: "writeShort", cost: 1 },
  x_delete_tweet: { bucket: "global", cost: 1 },
};

/** Set of tool names classified as write operations. Derived from WRITE_COSTS. */
export const WRITE_TOOL_NAMES = new Set(Object.keys(WRITE_COSTS));

// Tools that use the timeline bucket instead of global
const TIMELINE_TOOLS = new Set([
  "x_get_timeline",
  "x_get_user_tweets",
  "x_get_notifications",
]);

const writeBuckets: Record<WriteBucket, TokenBucket> = {
  tweetDaily: tweetDailyBucket,
  likeDaily: likeDailyBucket,
  writeShort: writeShortBucket,
  global: globalBucket,
};

const MAX_WAIT_MS = 60_000;
const MAX_429_RETRIES = 3;

/**
 * Check if a request is allowed under rate limits.
 * Uses peek-then-consume: checks all required buckets first, only consumes
 * tokens when all buckets have capacity. Prevents token waste on partial failures.
 */
export function checkRateLimit(
  toolName?: string,
  overrideCost?: number,
): { allowed: true } | { allowed: false; retryAfterMs: number } {
  const isWrite = toolName ? WRITE_TOOL_NAMES.has(toolName) : false;

  // Peek global bucket first — all requests count against it
  const globalWait = globalBucket.msUntilAvailable();
  if (globalWait > 0) return { allowed: false, retryAfterMs: globalWait };

  if (isWrite && toolName) {
    const entry = WRITE_COSTS[toolName];
    const bucket = writeBuckets[entry.bucket];
    const cost = overrideCost ?? entry.cost;

    // Peek write-specific bucket
    const writeWait = bucket.msUntilAvailable(cost);
    if (writeWait > 0) return { allowed: false, retryAfterMs: writeWait };

    // Consume both global (full cost) and write-specific (guard against same-object double-consume)
    globalBucket.tryConsume(cost);
    if (bucket !== globalBucket) bucket.tryConsume(cost);
    return { allowed: true };
  }

  // Read path: use timeline or global bucket
  const readBucket =
    toolName && TIMELINE_TOOLS.has(toolName) ? timelineBucket : globalBucket;

  if (readBucket !== globalBucket) {
    const readWait = readBucket.msUntilAvailable();
    if (readWait > 0) return { allowed: false, retryAfterMs: readWait };
    readBucket.tryConsume();
  }

  globalBucket.tryConsume();
  return { allowed: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for rate limit to clear (up to 60s), then consume the token.
 * Returns { allowed: false, retryAfterMs } if the wait would exceed MAX_WAIT_MS.
 */
export async function waitForRateLimit(
  toolName?: string,
  overrideCost?: number,
): Promise<{ allowed: true } | { allowed: false; retryAfterMs: number }> {
  const result = checkRateLimit(toolName, overrideCost);
  if (result.allowed) return result;

  if (result.retryAfterMs > MAX_WAIT_MS) {
    return result;
  }

  console.error(
    `[rate-limit] Waiting ${Math.ceil(result.retryAfterMs / 1000)}s for ${toolName ?? "read"} bucket...`,
  );
  await sleep(result.retryAfterMs);
  return checkRateLimit(toolName, overrideCost);
}

/**
 * Execute an API call with automatic retry on HTTP 429 from X/Twitter.
 * Detects ApiResponseError from twitter-api-v2 and generic 429 patterns.
 */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e: unknown) {
      const is429 =
        (typeof e === "object" &&
          e !== null &&
          "code" in e &&
          (e as { code: number }).code === 429) ||
        (typeof e === "object" &&
          e !== null &&
          "rateLimitError" in e &&
          (e as { rateLimitError: boolean }).rateLimitError === true) ||
        (typeof e === "object" &&
          e !== null &&
          "status" in e &&
          (e as { status: number }).status === 429) ||
        (e instanceof Error &&
          (e.message.includes("429") ||
            e.message.toLowerCase().includes("rate limit")));

      if (!is429 || attempt === MAX_429_RETRIES) throw e;

      const backoffMs = 2000 * Math.pow(2, attempt);
      console.error(
        `[rate-limit] X/Twitter 429 — backing off ${backoffMs / 1000}s (attempt ${attempt + 1}/${MAX_429_RETRIES})...`,
      );
      await sleep(backoffMs);
    }
  }
  throw new Error("Unreachable");
}
