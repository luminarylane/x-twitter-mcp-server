#!/usr/bin/env node
/**
 * Standalone X/Twitter MCP Server
 *
 * Pure X API v2 wrapper over stdio. No database, no auth layer.
 * Credentials passed directly per tool call or via env vars.
 *
 * Auth modes (in priority order):
 *   1. OAuth 1.0a (full read/write): Set X_APP_KEY, X_APP_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
 *   2. Bearer token (app-only, read-only): Set X_BEARER_TOKEN
 *   3. Per-call: Pass credentials as tool arguments
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createClient, credentialHash } from "./client.js";
import type { Credentials } from "./client.js";
import {
  resolveSearchBackend,
  searchTweetsWithHermesTweet,
} from "./hermes-tweet.js";
import { textResult, errorResult, senseResult } from "./response.js";
import { waitForRateLimit, withRetry } from "./rate-limiter.js";
import { createRequire } from "node:module";

import type { TwitterApi } from "twitter-api-v2";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

// Env-based defaults
const DEFAULT_BEARER_TOKEN = process.env.X_BEARER_TOKEN;
const DEFAULT_APP_KEY = process.env.X_APP_KEY;
const DEFAULT_APP_SECRET = process.env.X_APP_SECRET;
const DEFAULT_ACCESS_TOKEN = process.env.X_ACCESS_TOKEN;
const DEFAULT_ACCESS_SECRET = process.env.X_ACCESS_SECRET;

const TWEET_FIELDS =
  "created_at,public_metrics,conversation_id,in_reply_to_user_id,author_id";
const USER_FIELDS =
  "created_at,description,profile_image_url,public_metrics,verified";
const EXPANSIONS = "author_id";

// --- Credential resolution ---

interface CredentialArgs {
  bearerToken?: string;
  appKey?: string;
  appSecret?: string;
  accessToken?: string;
  accessSecret?: string;
}

function resolveCredentials(args: CredentialArgs): Credentials | null {
  // OAuth 1.0a takes priority (supports read + write)
  const appKey = args.appKey || DEFAULT_APP_KEY;
  const appSecret = args.appSecret || DEFAULT_APP_SECRET;
  const accessToken = args.accessToken || DEFAULT_ACCESS_TOKEN;
  const accessSecret = args.accessSecret || DEFAULT_ACCESS_SECRET;
  if (appKey && appSecret && accessToken && accessSecret) {
    return {
      type: "oauth1",
      oauth1: { appKey, appSecret, accessToken, accessSecret },
    };
  }

  // Warn if some but not all OAuth 1.0a credentials are present
  const oauthFields = [appKey, appSecret, accessToken, accessSecret];
  const oauthCount = oauthFields.filter(Boolean).length;
  if (oauthCount > 0 && oauthCount < 4) {
    const missing = [
      !appKey && "X_APP_KEY",
      !appSecret && "X_APP_SECRET",
      !accessToken && "X_ACCESS_TOKEN",
      !accessSecret && "X_ACCESS_SECRET",
    ].filter(Boolean);
    console.error(
      `[credentials] WARNING: ${oauthCount}/4 OAuth 1.0a credentials provided. Missing: ${missing.join(", ")}. Falling back to bearer token (read-only).`,
    );
  }

  // Fall back to bearer token (app-only, read-only)
  const bearerToken = args.bearerToken || DEFAULT_BEARER_TOKEN;
  if (bearerToken) {
    return { type: "bearer", bearerToken };
  }

  return null;
}

// --- Discriminated union for client result ---

type ClientResult =
  | { ok: true; client: TwitterApi; credKey: string }
  | { ok: false; error: ReturnType<typeof errorResult> };

async function getClient(
  args: CredentialArgs,
  toolName?: string,
  overrideCost?: number,
): Promise<ClientResult> {
  const creds = resolveCredentials(args);
  if (!creds) {
    return {
      ok: false,
      error: errorResult(
        "Missing credentials",
        "Provide OAuth 1.0a credentials (appKey, appSecret, accessToken, accessSecret) or bearerToken as arguments, or set X_APP_KEY/X_APP_SECRET/X_ACCESS_TOKEN/X_ACCESS_SECRET or X_BEARER_TOKEN env vars.",
      ),
    };
  }

  // Check rate limit
  const limit = await waitForRateLimit(toolName, overrideCost);
  if (!limit.allowed) {
    const retryAfterSeconds = Math.ceil(limit.retryAfterMs / 1000);
    return {
      ok: false,
      error: errorResult(
        "Rate limited",
        `X/Twitter API rate limit reached. Wait ${retryAfterSeconds}s then retry this exact tool call with the same arguments.`,
        {
          retryAfterSeconds,
          action:
            retryAfterSeconds <= 120
              ? `RETRY_AFTER_WAIT: Sleep ${retryAfterSeconds}s then retry this tool call.`
              : `DEFER: Rate limit cooldown is ${retryAfterSeconds}s. Queue this operation for later or switch to a different task.`,
        },
      ),
    };
  }

  try {
    const client = createClient(creds);
    return { ok: true, client, credKey: credentialHash(creds) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return {
      ok: false,
      error: errorResult(
        "Client error",
        `Failed to create X/Twitter client: ${msg}`,
      ),
    };
  }
}

// --- Safe handler wrapper ---

function extractApiDetail(e: unknown): string | undefined {
  if (typeof e === "object" && e !== null && "data" in e) {
    const data = (e as { data: unknown }).data;
    if (typeof data === "object" && data !== null) {
      // X API v2 error format: { detail: "...", title: "...", status: 403 }
      if ("detail" in data) return (data as { detail: string }).detail;
      // X API v1 error format: { errors: [{ message: "..." }] }
      if ("errors" in data) {
        const errors = (data as { errors: Array<{ message: string }> }).errors;
        if (Array.isArray(errors) && errors.length > 0)
          return errors[0].message;
      }
    }
  }
  return undefined;
}

/** Suggest a workaround the agent can act on for common API errors. */
function suggestAction(
  toolName: string,
  statusCode: number | undefined,
  detail: string | undefined,
): string | undefined {
  const d = (detail || "").toLowerCase();

  // 401 — Authentication failures
  if (statusCode === 401) {
    return "AUTH_FAILED: Credentials are invalid or expired. Regenerate your Access Token and Secret in the X Developer Portal, then update X_ACCESS_TOKEN and X_ACCESS_SECRET env vars.";
  }

  // 403 — Forbidden (many subtypes)
  if (statusCode === 403) {
    if (d.includes("reply") && d.includes("not allowed")) {
      return "REPLY_RESTRICTED: This tweet's author has restricted replies. Alternatives: (1) use x_quote_tweet to quote-tweet instead, (2) post a standalone tweet with an @mention using x_create_tweet, (3) skip this tweet and try replying to a different one.";
    }
    if (d.includes("quoting") && d.includes("not allowed")) {
      return "QUOTE_RESTRICTED: This tweet's author has restricted quoting. Alternatives: (1) use x_create_tweet to post a standalone tweet referencing the author with an @mention, (2) use x_retweet to retweet without commentary, (3) skip this tweet.";
    }
    if (d.includes("duplicate")) {
      return "DUPLICATE_TWEET: X rejected this as a duplicate. Change the text to make it unique before retrying.";
    }
    if (d.includes("suspended")) {
      return "ACCOUNT_SUSPENDED: The target account is suspended. Skip this account and move on.";
    }
    if (d.includes("protected")) {
      return "PROTECTED_ACCOUNT: This user's tweets are protected. You can only see their tweets if they approve your follow request. Skip this user.";
    }
    if (d.includes("blocked")) {
      return "BLOCKED: You are blocked by this user. Skip this user and move on.";
    }
    if (d.includes("already") && d.includes("follow")) {
      return "ALREADY_FOLLOWING: You already follow this user. No action needed — skip.";
    }
    if (
      d.includes("read") ||
      d.includes("not permitted") ||
      d.includes("forbidden")
    ) {
      return "PERMISSION_DENIED: Your token may lack write permissions. Check X Developer Portal → App Settings → User authentication → Permissions must be 'Read and write'.";
    }
    return "FORBIDDEN: X rejected this action. Check the error message for details.";
  }

  // 404 — Not found
  if (statusCode === 404) {
    if (
      toolName.includes("tweet") ||
      toolName.includes("reply") ||
      toolName.includes("thread")
    ) {
      return "TWEET_NOT_FOUND: This tweet may have been deleted. Skip it and move on.";
    }
    if (
      toolName.includes("follow") ||
      toolName.includes("profile") ||
      toolName.includes("user")
    ) {
      return "USER_NOT_FOUND: This user does not exist or has been deactivated. Verify the username and skip if invalid.";
    }
    return "NOT_FOUND: The requested resource does not exist. It may have been deleted.";
  }

  // 400 — Bad request
  if (statusCode === 400) {
    if (d.includes("disallowed") || d.includes("client not enrolled")) {
      return "TIER_RESTRICTED: This endpoint is not available on your X API tier. Some endpoints (e.g., search) require Basic or Pro tier. Skip this operation.";
    }
  }

  return undefined;
}

function safeHandler<T>(
  toolName: string,
  handler: (
    args: T,
  ) => Promise<ReturnType<typeof textResult | typeof senseResult>>,
): (
  args: T,
) => Promise<
  ReturnType<typeof textResult | typeof senseResult | typeof errorResult>
> {
  return async (args: T) => {
    try {
      return await handler(args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const detail = extractApiDetail(e);
      const statusCode =
        typeof e === "object" && e !== null && "code" in e
          ? (e as { code: number }).code
          : undefined;
      const action = suggestAction(toolName, statusCode, detail);
      console.error(
        `[${toolName}] Error: ${msg}${detail ? ` — ${detail}` : ""}`,
      );
      return errorResult("API error", `${toolName} failed: ${detail || msg}`, {
        ...(statusCode && { statusCode }),
        ...(detail && detail !== msg && { rawError: msg }),
        ...(action && { action }),
      });
    }
  };
}

/** Append linkUrl to text if not already present. Returns the updated text. */
function appendLinkUrl(text: string, linkUrl?: string): string {
  if (!linkUrl || text.includes(linkUrl)) return text;
  return `${text} ${linkUrl}`;
}

// --- SSRF protection for image URLs ---

const TWITTER_MAX_IMAGE_BYTES = 5_242_880; // 5MB
const TWITTER_MAX_VIDEO_BYTES = 512 * 1024 * 1024; // 512MB
const ALLOWED_TWITTER_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const ALLOWED_TWITTER_VIDEO_MIME_TYPES = new Set(["video/mp4"]);

const PRIVATE_IP_RE = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;

function isAllowedMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;

    const hostname = parsed.hostname.toLowerCase();
    // Block private/internal addresses
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "[::1]" ||
      hostname === "169.254.169.254" ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal")
    ) {
      return false;
    }
    // Block IPv6 private ranges (fc00::/7, fe80::/10, IPv4-mapped ::ffff:)
    const bare = hostname.replace(/^\[|\]$/g, "");
    if (
      bare.startsWith("fc") ||
      bare.startsWith("fd") ||
      bare.startsWith("fe80") ||
      bare.startsWith("::ffff:")
    ) {
      return false;
    }
    // Block RFC1918 and link-local IPv4 ranges
    const ipMatch = hostname.match(PRIVATE_IP_RE);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      if (a === 10) return false; // 10.0.0.0/8
      if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
      if (a === 192 && b === 168) return false; // 192.168.0.0/16
      if (a === 169 && b === 254) return false; // 169.254.0.0/16 link-local
    }
    return true;
  } catch (e) {
    console.error(
      `[isAllowedMediaUrl] Failed to parse URL: ${url} — ${e instanceof Error ? e.message : String(e)}`,
    );
    return false;
  }
}

async function downloadAndUploadMedia(
  mediaUrl: string,
  client: TwitterApi,
): Promise<string> {
  if (!isAllowedMediaUrl(mediaUrl)) {
    throw new Error(
      `URL rejected (not https:// or blocked address): ${mediaUrl}`,
    );
  }

  // Single GET with generous timeout (handles both image and video)
  const res = await fetch(mediaUrl, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching media: ${mediaUrl}`);
  }

  const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || "";
  if (!mimeType) {
    throw new Error(
      `Server returned no Content-Type header for media: ${mediaUrl}`,
    );
  }

  const isVideo = ALLOWED_TWITTER_VIDEO_MIME_TYPES.has(mimeType);
  const isImage = ALLOWED_TWITTER_IMAGE_MIME_TYPES.has(mimeType);
  if (!isVideo && !isImage) {
    throw new Error(
      `Unsupported media type "${mimeType}". Twitter accepts images: ${[...ALLOWED_TWITTER_IMAGE_MIME_TYPES].join(", ")} and video: ${[...ALLOWED_TWITTER_VIDEO_MIME_TYPES].join(", ")}`,
    );
  }

  const maxSize = isVideo ? TWITTER_MAX_VIDEO_BYTES : TWITTER_MAX_IMAGE_BYTES;
  const mediaLabel = isVideo ? "video" : "image";

  const contentLength = res.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > maxSize) {
    throw new Error(
      `${mediaLabel} too large (${contentLength} bytes, max ${maxSize}): ${mediaUrl}`,
    );
  }

  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > maxSize) {
    throw new Error(
      `${mediaLabel} too large after download (${buffer.byteLength} bytes, max ${maxSize}): ${mediaUrl}`,
    );
  }

  const mediaId = await client.v1.uploadMedia(
    Buffer.from(buffer, 0, buffer.byteLength),
    isVideo
      ? { mimeType: "video/mp4", longVideo: true, chunkLength: 5 * 1024 * 1024 }
      : { mimeType },
  );
  return mediaId;
}

// --- Caches for username→ID and authenticated user resolution ---

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MAX_CACHE_SIZE = 500;

interface CachedValue {
  value: string;
  createdAt: number;
}

const userIdCache = new Map<string, CachedValue>();
const meCache = new Map<string, CachedValue>();

function getCached(
  cache: Map<string, CachedValue>,
  key: string,
): string | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt >= CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function setCache(
  cache: Map<string, CachedValue>,
  key: string,
  value: string,
): void {
  // Evict oldest entries if cache is full
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value!;
    cache.delete(firstKey);
  }
  cache.set(key, { value, createdAt: Date.now() });
}

async function resolveUserId(
  client: TwitterApi,
  username: string,
): Promise<string> {
  const normalized = username.replace(/^@/, "").toLowerCase();
  const cached = getCached(userIdCache, normalized);
  if (cached) return cached;

  const user = await withRetry(() =>
    client.v2.userByUsername(normalized, { "user.fields": "id" }),
  );
  if (!user.data) throw new Error(`User not found: @${normalized}`);
  setCache(userIdCache, normalized, user.data.id);
  return user.data.id;
}

async function resolveMe(client: TwitterApi, credKey: string): Promise<string> {
  const cached = getCached(meCache, credKey);
  if (cached) return cached;

  const me = await withRetry(() => client.v2.me({ "user.fields": "id" }));
  if (!me.data) throw new Error("Could not resolve authenticated user");
  setCache(meCache, credKey, me.data.id);
  return me.data.id;
}

// --- DTO mappers ---

interface TweetDTO {
  id: string;
  text: string;
  author?: { id: string; username: string; name: string };
  metrics?: {
    likeCount: number;
    retweetCount: number;
    replyCount: number;
    quoteCount: number;
  };
  conversationId?: string;
  inReplyToUserId?: string;
  createdAt?: string;
}

interface UserDTO {
  id: string;
  username: string;
  name: string;
  description?: string;
  profileImageUrl?: string;
  metrics?: {
    followersCount: number;
    followingCount: number;
    tweetCount: number;
  };
  verified?: boolean;
  createdAt?: string;
}

function mapTweet(
  tweet: {
    id: string;
    text: string;
    author_id?: string;
    public_metrics?: {
      like_count: number;
      retweet_count: number;
      reply_count: number;
      quote_count: number;
    };
    conversation_id?: string;
    in_reply_to_user_id?: string;
    created_at?: string;
  },
  users?: Map<string, { id: string; username: string; name: string }>,
): TweetDTO {
  const author =
    tweet.author_id && users ? users.get(tweet.author_id) : undefined;
  return {
    id: tweet.id,
    text: tweet.text,
    author,
    metrics: tweet.public_metrics
      ? {
          likeCount: tweet.public_metrics.like_count,
          retweetCount: tweet.public_metrics.retweet_count,
          replyCount: tweet.public_metrics.reply_count,
          quoteCount: tweet.public_metrics.quote_count,
        }
      : undefined,
    conversationId: tweet.conversation_id,
    inReplyToUserId: tweet.in_reply_to_user_id,
    createdAt: tweet.created_at,
  };
}

function mapUser(user: {
  id: string;
  username: string;
  name: string;
  description?: string;
  profile_image_url?: string;
  public_metrics?: {
    followers_count?: number;
    following_count?: number;
    tweet_count?: number;
  };
  verified?: boolean;
  created_at?: string;
}): UserDTO {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    description: user.description,
    profileImageUrl: user.profile_image_url,
    metrics: user.public_metrics
      ? {
          followersCount: user.public_metrics.followers_count ?? 0,
          followingCount: user.public_metrics.following_count ?? 0,
          tweetCount: user.public_metrics.tweet_count ?? 0,
        }
      : undefined,
    verified: user.verified,
    createdAt: user.created_at,
  };
}

/** Build a users map from Twitter v2 includes for author resolution. */
function buildUsersMap(includes?: {
  users?: Array<{ id: string; username: string; name: string }>;
}): Map<string, { id: string; username: string; name: string }> {
  const map = new Map<string, { id: string; username: string; name: string }>();
  if (includes?.users) {
    for (const u of includes.users) {
      map.set(u.id, { id: u.id, username: u.username, name: u.name });
    }
  }
  return map;
}

// --- Tool Definitions ---

const credentialFields = {
  bearerToken: z
    .string()
    .optional()
    .describe(
      "X/Twitter OAuth 2.0 bearer token (app-only, read-only). Falls back to X_BEARER_TOKEN env var.",
    ),
  appKey: z
    .string()
    .optional()
    .describe("OAuth 1.0a Consumer Key. Falls back to X_APP_KEY env var."),
  appSecret: z
    .string()
    .optional()
    .describe(
      "OAuth 1.0a Consumer Secret. Falls back to X_APP_SECRET env var.",
    ),
  accessToken: z
    .string()
    .optional()
    .describe("OAuth 1.0a Access Token. Falls back to X_ACCESS_TOKEN env var."),
  accessSecret: z
    .string()
    .optional()
    .describe(
      "OAuth 1.0a Access Token Secret. Falls back to X_ACCESS_SECRET env var.",
    ),
};

// --- Server Setup ---

const server = new McpServer({
  name: "x-twitter-mcp-server",
  version,
});

// =====================
// SENSE Tools (read)
// =====================

server.registerTool(
  "x_get_timeline",
  {
    description:
      "Get the X/Twitter home timeline. Returns recent posts from followed accounts.",
    inputSchema: {
      ...credentialFields,
      maxResults: z
        .number()
        .optional()
        .describe("Number of tweets (default: 20, max: 100)"),
      paginationToken: z.string().optional().describe("Pagination token"),
    },
  },
  safeHandler("x_get_timeline", async (args) => {
    const result = await getClient(args, "x_get_timeline");
    if (!result.ok) return result.error;
    const { client } = result;

    const response = await withRetry(() =>
      client.v2.homeTimeline({
        max_results: Math.min(args.maxResults || 20, 100),
        ...(args.paginationToken && {
          pagination_token: args.paginationToken,
        }),
        "tweet.fields": TWEET_FIELDS,
        "user.fields": USER_FIELDS,
        expansions: EXPANSIONS,
      }),
    );

    const users = buildUsersMap(response.includes);
    const tweets = (response.data?.data ?? []).map((t) => mapTweet(t, users));

    return senseResult(
      {
        tweets,
        nextToken: response.data?.meta?.next_token,
        count: tweets.length,
      },
      "X/Twitter",
    );
  }),
);

server.registerTool(
  "x_get_notifications",
  {
    description:
      "Get X/Twitter notifications (mentions of the authenticated user).",
    inputSchema: {
      ...credentialFields,
      maxResults: z
        .number()
        .optional()
        .describe("Number of mentions (default: 20, max: 100)"),
      paginationToken: z.string().optional().describe("Pagination token"),
    },
  },
  safeHandler("x_get_notifications", async (args) => {
    const result = await getClient(args, "x_get_notifications");
    if (!result.ok) return result.error;
    const { client, credKey } = result;

    const meId = await resolveMe(client, credKey);
    const response = await withRetry(() =>
      client.v2.userMentionTimeline(meId, {
        max_results: Math.min(args.maxResults || 20, 100),
        ...(args.paginationToken && {
          pagination_token: args.paginationToken,
        }),
        "tweet.fields": TWEET_FIELDS,
        "user.fields": USER_FIELDS,
        expansions: EXPANSIONS,
      }),
    );

    const users = buildUsersMap(response.includes);
    const tweets = (response.data?.data ?? []).map((t) => mapTweet(t, users));

    return senseResult(
      {
        mentions: tweets,
        nextToken: response.data?.meta?.next_token,
        count: tweets.length,
      },
      "X/Twitter",
    );
  }),
);

server.registerTool(
  "x_search_tweets",
  {
    description:
      "Search X/Twitter tweets by keyword or phrase. Useful for brand monitoring and trend discovery.",
    inputSchema: {
      ...credentialFields,
      query: z
        .string()
        .describe(
          "Search query (keywords, phrases, hashtags, or from:username)",
        ),
      maxResults: z
        .number()
        .optional()
        .describe("Number of results (default: 10, max: 100)"),
      paginationToken: z.string().optional().describe("Pagination token"),
      searchBackend: z
        .enum(["x-api", "hermes-tweet"])
        .optional()
        .describe(
          "Search backend. Defaults to x-api. Use hermes-tweet with HERMES_TWEET_API_KEY or XQUIK_API_KEY for optional read-only Hermes Tweet/Xquik search.",
        ),
    },
  },
  safeHandler("x_search_tweets", async (args) => {
    if (!args.query.trim())
      return errorResult("Invalid input", "Query cannot be empty");

    if (resolveSearchBackend(args.searchBackend) === "hermes-tweet") {
      const response = await searchTweetsWithHermesTweet({
        query: args.query,
        maxResults: args.maxResults,
        paginationToken: args.paginationToken,
      });
      return senseResult(
        {
          ...response,
          query: args.query,
          backend: "hermes-tweet",
        },
        "Hermes Tweet/Xquik",
      );
    }

    const result = await getClient(args, "x_search_tweets");
    if (!result.ok) return result.error;
    const { client } = result;

    const response = await withRetry(() =>
      client.v2.search(args.query, {
        max_results: Math.max(10, Math.min(args.maxResults || 10, 100)),
        ...(args.paginationToken && { next_token: args.paginationToken }),
        "tweet.fields": TWEET_FIELDS,
        "user.fields": USER_FIELDS,
        expansions: EXPANSIONS,
      }),
    );

    const users = buildUsersMap(response.includes);
    const tweets = (response.data?.data ?? []).map((t) => mapTweet(t, users));

    return senseResult(
      {
        tweets,
        nextToken: response.data?.meta?.next_token,
        count: tweets.length,
        query: args.query,
      },
      "X/Twitter",
    );
  }),
);

server.registerTool(
  "x_get_tweet_thread",
  {
    description:
      "Get an X/Twitter tweet thread by fetching the tweet and its conversation.",
    inputSchema: {
      ...credentialFields,
      tweetId: z.string().describe("ID of the tweet to get the thread for"),
    },
  },
  safeHandler("x_get_tweet_thread", async (args) => {
    if (!args.tweetId.trim())
      return errorResult("Invalid input", "tweetId cannot be empty");
    // 2 API calls: singleTweet + search by conversation_id
    const result = await getClient(args, "x_get_tweet_thread", 2);
    if (!result.ok) return result.error;
    const { client } = result;

    // Step 1: Fetch the original tweet to get conversation_id
    const tweet = await withRetry(() =>
      client.v2.singleTweet(args.tweetId, {
        "tweet.fields": TWEET_FIELDS,
        "user.fields": USER_FIELDS,
        expansions: EXPANSIONS,
      }),
    );

    if (!tweet.data)
      return errorResult("Not found", `Tweet ${args.tweetId} not found`);

    const conversationId = tweet.data.conversation_id || args.tweetId;

    // Step 2: Search for all tweets in the conversation
    const threadResponse = await withRetry(() =>
      client.v2.search(`conversation_id:${conversationId}`, {
        max_results: 100,
        "tweet.fields": TWEET_FIELDS,
        "user.fields": USER_FIELDS,
        expansions: EXPANSIONS,
      }),
    );

    const tweetUsers = buildUsersMap(tweet.includes);
    const threadUsers = buildUsersMap(threadResponse.includes);
    // Merge user maps
    for (const [k, v] of tweetUsers) threadUsers.set(k, v);

    const rootTweet = mapTweet(tweet.data, threadUsers);
    const threadTweets = (threadResponse.data?.data ?? [])
      .map((t) => mapTweet(t, threadUsers))
      .sort(
        (a, b) =>
          new Date(a.createdAt || 0).getTime() -
          new Date(b.createdAt || 0).getTime(),
      );

    return senseResult(
      {
        rootTweet,
        thread: threadTweets,
        conversationId,
        count: threadTweets.length + 1,
      },
      "X/Twitter",
    );
  }),
);

server.registerTool(
  "x_get_profile",
  {
    description: "Get an X/Twitter user profile by username.",
    inputSchema: {
      ...credentialFields,
      username: z
        .string()
        .describe('X/Twitter username (without @, e.g., "elonmusk")'),
    },
  },
  safeHandler("x_get_profile", async (args) => {
    if (!args.username.trim())
      return errorResult("Invalid input", "Username cannot be empty");
    const result = await getClient(args, "x_get_profile");
    if (!result.ok) return result.error;
    const { client } = result;

    const normalized = args.username.replace(/^@/, "");
    const response = await withRetry(() =>
      client.v2.userByUsername(normalized, {
        "user.fields": USER_FIELDS,
      }),
    );

    if (!response.data)
      return errorResult("Not found", `User @${normalized} not found`);

    return senseResult(mapUser(response.data), "X/Twitter");
  }),
);

server.registerTool(
  "x_get_followers",
  {
    description: "Get followers of an X/Twitter account.",
    inputSchema: {
      ...credentialFields,
      username: z.string().describe("X/Twitter username (without @)"),
      maxResults: z
        .number()
        .optional()
        .describe("Number of followers (default: 100, max: 1000)"),
      paginationToken: z.string().optional().describe("Pagination token"),
    },
  },
  safeHandler("x_get_followers", async (args) => {
    if (!args.username.trim())
      return errorResult("Invalid input", "Username cannot be empty");
    const result = await getClient(args, "x_get_followers");
    if (!result.ok) return result.error;
    const { client } = result;

    const userId = await resolveUserId(client, args.username);
    const response = await withRetry(() =>
      client.v2.followers(userId, {
        max_results: Math.min(args.maxResults || 100, 1000),
        ...(args.paginationToken && {
          pagination_token: args.paginationToken,
        }),
        "user.fields": USER_FIELDS,
      }),
    );

    const followers = (response.data ?? []).map(mapUser);

    return senseResult(
      {
        username: args.username,
        followers,
        nextToken: response.meta?.next_token,
        count: followers.length,
      },
      "X/Twitter",
    );
  }),
);

server.registerTool(
  "x_search_users",
  {
    description:
      "Search for X/Twitter users by name or keyword. Uses v1.1 API (v2 lacks user search). Requires a v1.1-compatible bearer token — may fail with v2-only OAuth 2.0 tokens.",
    inputSchema: {
      ...credentialFields,
      query: z.string().describe("Search query"),
      count: z
        .number()
        .optional()
        .describe("Number of results (default: 20, max: 20)"),
    },
  },
  safeHandler("x_search_users", async (args) => {
    if (!args.query.trim())
      return errorResult("Invalid input", "Query cannot be empty");
    const result = await getClient(args, "x_search_users");
    if (!result.ok) return result.error;
    const { client } = result;

    const paginator = await withRetry(() =>
      client.v1.searchUsers(args.query, {
        count: Math.min(args.count || 20, 20),
      }),
    );

    const users = paginator.users.map((u) => ({
      id: String(u.id),
      username: u.screen_name,
      name: u.name,
      description: u.description,
      profileImageUrl: u.profile_image_url_https,
      metrics: {
        followersCount: u.followers_count,
        followingCount: u.friends_count,
        tweetCount: u.statuses_count,
      },
      verified: u.verified,
    }));

    return senseResult(
      {
        users,
        count: users.length,
        query: args.query,
      },
      "X/Twitter",
    );
  }),
);

server.registerTool(
  "x_get_user_tweets",
  {
    description: "Get recent tweets from a specific X/Twitter user.",
    inputSchema: {
      ...credentialFields,
      username: z.string().describe("X/Twitter username (without @)"),
      maxResults: z
        .number()
        .optional()
        .describe("Number of tweets (default: 10, max: 100)"),
      paginationToken: z.string().optional().describe("Pagination token"),
    },
  },
  safeHandler("x_get_user_tweets", async (args) => {
    if (!args.username.trim())
      return errorResult("Invalid input", "Username cannot be empty");
    const result = await getClient(args, "x_get_user_tweets");
    if (!result.ok) return result.error;
    const { client } = result;

    const userId = await resolveUserId(client, args.username);
    const response = await withRetry(() =>
      client.v2.userTimeline(userId, {
        max_results: Math.max(10, Math.min(args.maxResults || 10, 100)),
        ...(args.paginationToken && {
          pagination_token: args.paginationToken,
        }),
        "tweet.fields": TWEET_FIELDS,
        "user.fields": USER_FIELDS,
        expansions: EXPANSIONS,
      }),
    );

    const users = buildUsersMap(response.includes);
    const tweets = (response.data?.data ?? []).map((t) => mapTweet(t, users));

    return senseResult(
      {
        username: args.username,
        tweets,
        nextToken: response.data?.meta?.next_token,
        count: tweets.length,
      },
      "X/Twitter",
    );
  }),
);

// =====================
// Media Specs
// =====================

server.registerTool(
  "x_get_media_specs",
  {
    description:
      "Get X/Twitter platform media specifications — supported formats, dimensions, " +
      "file size limits, and duration caps. Call this BEFORE generating media assets " +
      "to ensure they conform to X/Twitter API v2 requirements.",
    inputSchema: {},
  },
  safeHandler("x_get_media_specs", async () => {
    return textResult({
      platform: "X/Twitter (API v2)",
      mediaFormats: [
        {
          type: "image",
          formats: ["JPG", "PNG", "GIF", "WEBP"],
          maxFileSize: "5MB (static images), 15MB (animated GIF)",
          maxDimensions: "4096x4096",
          recommendedDimensions: "1200x675 (landscape), 1080x1080 (square)",
          notes:
            "Up to 4 images per tweet (carousel). Animated GIFs count as single media.",
        },
        {
          type: "video",
          formats: ["MP4"],
          maxFileSize: "512MB",
          maxDuration: "140 seconds",
          maxDimensions: "1920x1200",
          recommendedDimensions: "1280x720 (16:9)",
          notes:
            "H.264 video, AAC audio. Vertical video supported. Min duration 0.5s.",
        },
      ],
      unsupportedFormats: [
        {
          type: "document",
          reason: "X/Twitter does not support document attachments",
        },
        {
          type: "audio",
          reason: "Audio is only available via Spaces, not as post attachments",
        },
      ],
      tip: "Animated GIFs have a 15MB limit vs 5MB for static images. For longer video content, consider posting a link instead.",
    });
  }),
);

// =====================
// ACT Tools (write)
// =====================

server.registerTool(
  "x_create_tweet",
  {
    description:
      "Create an X/Twitter tweet. Max 280 characters. Supports link preview cards via linkUrl, image embeds via imageUrl, or video embeds via videoUrl (mutually exclusive). Twitter may auto-generate cards from URLs if the page has valid Twitter Card / OG meta tags.",
    inputSchema: {
      ...credentialFields,
      text: z.string().describe("Tweet text (max 280 characters)"),
      linkUrl: z
        .string()
        .min(1)
        .optional()
        .describe(
          "URL to include for a link preview card. If the URL is not already in the text, it will be appended. Twitter may auto-generate cards if the page has valid Twitter Card / OG meta tags. The URL counts toward the 280-char limit.",
        ),
      imageUrl: z
        .string()
        .min(1)
        .optional()
        .refine((u) => !u || u.startsWith("https://"), {
          message: "imageUrl must use https://",
        })
        .describe(
          "URL of an image to embed in the tweet (max 5MB). Must be https://. Mutually exclusive with linkUrl and videoUrl.",
        ),
      videoUrl: z
        .string()
        .min(1)
        .optional()
        .refine((u) => !u || u.startsWith("https://"), {
          message: "videoUrl must use https://",
        })
        .describe(
          "URL of a video to embed in the tweet (MP4 only, max 512MB). Must be https://. Mutually exclusive with linkUrl and imageUrl.",
        ),
    },
  },
  safeHandler("x_create_tweet", async (args) => {
    if (!args.text.trim())
      return errorResult("Invalid input", "Text cannot be empty");

    const embedCount = [args.imageUrl, args.videoUrl, args.linkUrl].filter(
      Boolean,
    ).length;
    if (embedCount > 1) {
      return errorResult(
        "Invalid input",
        "Only one of imageUrl, videoUrl, or linkUrl can be provided.",
      );
    }

    // If videoUrl or imageUrl: upload media and tweet with it
    const mediaEmbedUrl = args.videoUrl || args.imageUrl;
    if (mediaEmbedUrl) {
      if (args.text.length > 280)
        return errorResult(
          "Invalid input",
          `${args.text.length} chars exceeds 280 limit`,
        );
      const result = await getClient(args, "x_create_tweet");
      if (!result.ok) return result.error;
      const { client } = result;

      const mediaId = await downloadAndUploadMedia(mediaEmbedUrl, client);
      const response = await withRetry(() =>
        client.v2.tweet({
          text: args.text,
          media: { media_ids: [mediaId] },
        }),
      );

      const mediaType = args.videoUrl ? "video" : "image";
      return textResult({
        id: response.data.id,
        text: response.data.text,
        message: `Tweet created successfully with ${mediaType}`,
        ...(args.videoUrl ? { videoEmbed: true } : { imageEmbed: true }),
      });
    }

    // Existing linkUrl / text-only flow
    const finalText = appendLinkUrl(args.text, args.linkUrl);

    if (finalText.length > 280)
      return errorResult(
        "Invalid input",
        `${finalText.length} chars exceeds 280 limit${args.linkUrl ? " (includes appended linkUrl)" : ""}`,
      );
    const result = await getClient(args, "x_create_tweet");
    if (!result.ok) return result.error;
    const { client } = result;

    const response = await withRetry(() => client.v2.tweet(finalText));

    return textResult({
      id: response.data.id,
      text: response.data.text,
      message: "Tweet created successfully",
      ...(args.linkUrl && { linkPreview: true }),
    });
  }),
);

server.registerTool(
  "x_reply",
  {
    description:
      "Reply to an X/Twitter tweet. Max 280 characters. Supports link preview cards via linkUrl.",
    inputSchema: {
      ...credentialFields,
      text: z.string().describe("Reply text (max 280 characters)"),
      tweetId: z.string().describe("ID of the tweet to reply to"),
      linkUrl: z
        .string()
        .min(1)
        .optional()
        .describe(
          "URL to include for a link preview card. If the URL is not already in the text, it will be appended. Twitter may auto-generate cards if the page has valid Twitter Card / OG meta tags. The URL counts toward the 280-char limit.",
        ),
    },
  },
  safeHandler("x_reply", async (args) => {
    if (!args.text.trim())
      return errorResult("Invalid input", "Text cannot be empty");

    const finalText = appendLinkUrl(args.text, args.linkUrl);

    if (finalText.length > 280)
      return errorResult(
        "Invalid input",
        `${finalText.length} chars exceeds 280 limit${args.linkUrl ? " (includes appended linkUrl)" : ""}`,
      );
    if (!args.tweetId.trim())
      return errorResult("Invalid input", "tweetId cannot be empty");
    const result = await getClient(args, "x_reply");
    if (!result.ok) return result.error;
    const { client } = result;

    const response = await withRetry(() =>
      client.v2.reply(finalText, args.tweetId),
    );

    return textResult({
      id: response.data.id,
      text: response.data.text,
      inReplyTo: args.tweetId,
      message: "Reply posted successfully",
      ...(args.linkUrl && { linkPreview: true }),
    });
  }),
);

server.registerTool(
  "x_like",
  {
    description: "Like an X/Twitter tweet.",
    inputSchema: {
      ...credentialFields,
      tweetId: z.string().describe("ID of the tweet to like"),
    },
  },
  safeHandler("x_like", async (args) => {
    if (!args.tweetId.trim())
      return errorResult("Invalid input", "tweetId cannot be empty");
    const result = await getClient(args, "x_like");
    if (!result.ok) return result.error;
    const { client, credKey } = result;

    const meId = await resolveMe(client, credKey);
    await withRetry(() => client.v2.like(meId, args.tweetId));

    return textResult({
      tweetId: args.tweetId,
      message: "Tweet liked successfully",
    });
  }),
);

server.registerTool(
  "x_retweet",
  {
    description: "Retweet an X/Twitter tweet.",
    inputSchema: {
      ...credentialFields,
      tweetId: z.string().describe("ID of the tweet to retweet"),
    },
  },
  safeHandler("x_retweet", async (args) => {
    if (!args.tweetId.trim())
      return errorResult("Invalid input", "tweetId cannot be empty");
    const result = await getClient(args, "x_retweet");
    if (!result.ok) return result.error;
    const { client, credKey } = result;

    const meId = await resolveMe(client, credKey);
    await withRetry(() => client.v2.retweet(meId, args.tweetId));

    return textResult({
      tweetId: args.tweetId,
      message: "Tweet retweeted successfully",
    });
  }),
);

server.registerTool(
  "x_follow",
  {
    description: "Follow an X/Twitter user by username.",
    inputSchema: {
      ...credentialFields,
      username: z.string().describe("Username of the user to follow"),
    },
  },
  safeHandler("x_follow", async (args) => {
    if (!args.username.trim())
      return errorResult("Invalid input", "Username cannot be empty");
    const result = await getClient(args, "x_follow");
    if (!result.ok) return result.error;
    const { client, credKey } = result;

    const [meId, targetId] = await Promise.all([
      resolveMe(client, credKey),
      resolveUserId(client, args.username),
    ]);
    await withRetry(() => client.v2.follow(meId, targetId));

    return textResult({
      username: args.username,
      message: "User followed successfully",
    });
  }),
);

server.registerTool(
  "x_unfollow",
  {
    description: "Unfollow an X/Twitter user by username.",
    inputSchema: {
      ...credentialFields,
      username: z.string().describe("Username of the user to unfollow"),
    },
  },
  safeHandler("x_unfollow", async (args) => {
    if (!args.username.trim())
      return errorResult("Invalid input", "Username cannot be empty");
    const result = await getClient(args, "x_unfollow");
    if (!result.ok) return result.error;
    const { client, credKey } = result;

    const [meId, targetId] = await Promise.all([
      resolveMe(client, credKey),
      resolveUserId(client, args.username),
    ]);
    await withRetry(() => client.v2.unfollow(meId, targetId));

    return textResult({
      username: args.username,
      message: "User unfollowed successfully",
    });
  }),
);

server.registerTool(
  "x_delete_tweet",
  {
    description: "Delete an X/Twitter tweet.",
    inputSchema: {
      ...credentialFields,
      tweetId: z.string().describe("ID of the tweet to delete"),
    },
  },
  safeHandler("x_delete_tweet", async (args) => {
    if (!args.tweetId.trim())
      return errorResult("Invalid input", "tweetId cannot be empty");
    const result = await getClient(args, "x_delete_tweet");
    if (!result.ok) return result.error;
    const { client } = result;

    await withRetry(() => client.v2.deleteTweet(args.tweetId));

    return textResult({
      tweetId: args.tweetId,
      message: "Tweet deleted successfully",
    });
  }),
);

server.registerTool(
  "x_quote_tweet",
  {
    description:
      "Quote tweet — create a tweet with a quoted tweet attached. Max 280 characters.",
    inputSchema: {
      ...credentialFields,
      text: z.string().describe("Tweet text (max 280 characters)"),
      quoteTweetId: z.string().describe("ID of the tweet to quote"),
    },
  },
  safeHandler("x_quote_tweet", async (args) => {
    if (!args.text.trim())
      return errorResult("Invalid input", "Text cannot be empty");
    if (args.text.length > 280)
      return errorResult(
        "Invalid input",
        `${args.text.length} chars exceeds 280 limit`,
      );
    if (!args.quoteTweetId.trim())
      return errorResult("Invalid input", "quoteTweetId cannot be empty");
    const result = await getClient(args, "x_quote_tweet");
    if (!result.ok) return result.error;
    const { client } = result;

    const response = await withRetry(() =>
      client.v2.tweet({
        text: args.text,
        quote_tweet_id: args.quoteTweetId,
      }),
    );

    return textResult({
      id: response.data.id,
      text: response.data.text,
      quotedTweetId: args.quoteTweetId,
      message: "Quote tweet created successfully",
    });
  }),
);

server.registerTool(
  "x_create_thread",
  {
    description:
      "Create an X/Twitter thread (series of connected tweets). Each tweet max 280 characters. Consumes N tweets from the daily tweet budget. Supports link preview via linkUrl — appended to the LAST tweet only.",
    inputSchema: {
      ...credentialFields,
      texts: z
        .array(z.string())
        .describe(
          "Array of tweet texts for the thread, each max 280 characters",
        ),
      linkUrl: z
        .string()
        .min(1)
        .optional()
        .describe(
          "URL to include for a link preview card on the LAST tweet in the thread. If the URL is not already in the last tweet's text, it will be appended. Twitter may auto-generate cards if the page has valid Twitter Card / OG meta tags.",
        ),
    },
  },
  safeHandler("x_create_thread", async (args) => {
    if (!args.texts.length)
      return errorResult("Invalid input", "Thread must have at least 1 tweet");

    // Shallow copy texts so we can modify the last one for linkUrl
    const texts = [...args.texts];
    if (args.linkUrl) {
      const lastIdx = texts.length - 1;
      texts[lastIdx] = appendLinkUrl(texts[lastIdx], args.linkUrl);
    }

    // Validate all tweets before sending any
    for (let i = 0; i < texts.length; i++) {
      if (!texts[i].trim())
        return errorResult(
          "Invalid input",
          `Tweet ${i + 1} in thread cannot be empty`,
        );
      if (texts[i].length > 280)
        return errorResult(
          "Invalid input",
          `Tweet ${i + 1} is ${texts[i].length} chars (max 280)${i === texts.length - 1 && args.linkUrl ? " (includes appended linkUrl)" : ""}`,
        );
    }

    // Thread costs N tweets from the daily budget
    const result = await getClient(args, "x_create_thread", texts.length);
    if (!result.ok) return result.error;
    const { client } = result;

    const posted: Array<{ id: string; text: string }> = [];

    try {
      // First tweet
      const first = await withRetry(() => client.v2.tweet(texts[0]));
      posted.push({ id: first.data.id, text: first.data.text });

      // Subsequent tweets as replies
      for (let i = 1; i < texts.length; i++) {
        const prev = posted[posted.length - 1];
        const reply = await withRetry(() => client.v2.reply(texts[i], prev.id));
        posted.push({ id: reply.data.id, text: reply.data.text });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (posted.length > 0) {
        return errorResult(
          "Partial thread failure",
          `Posted ${posted.length}/${texts.length} tweets before failure: ${msg}. Review partialThread for cleanup.`,
          {
            action:
              "PARTIAL_THREAD: Some tweets were posted. Review the partialThread array.",
            partialThread: posted,
          },
        );
      }
      throw e;
    }

    return textResult({
      thread: posted,
      count: posted.length,
      message: "Thread created successfully",
      ...(args.linkUrl && { linkPreview: true }),
    });
  }),
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("X/Twitter MCP Server running on stdio");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
