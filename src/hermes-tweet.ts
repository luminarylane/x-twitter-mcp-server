const DEFAULT_BASE_URL = "https://xquik.com";
const REQUEST_TIMEOUT_MS = 30_000;

type JsonObject = Record<string, unknown>;

type FetchLike = (
  input: URL,
  init: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export type SearchBackend = "x-api" | "hermes-tweet";

export interface HermesTweetSearchArgs {
  query: string;
  maxResults?: number;
  paginationToken?: string;
}

export interface HermesTweetSearchConfig {
  apiKey?: string;
  baseUrl?: string;
  fetch?: FetchLike;
}

export interface HermesTweetSearchResult {
  tweets: HermesTweetDTO[];
  nextToken?: string;
  count: number;
}

export interface HermesTweetDTO {
  id: string;
  text: string;
  author?: {
    id: string;
    username: string;
    name: string;
  };
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

export function resolveSearchBackend(requested?: string): SearchBackend {
  const raw =
    requested ??
    process.env.X_SEARCH_BACKEND ??
    process.env.HERMES_TWEET_SEARCH_BACKEND ??
    "";
  const normalized = raw.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "hermes-tweet" || normalized === "xquik") {
    return "hermes-tweet";
  }
  return "x-api";
}

export function buildHermesTweetSearchUrl(
  args: HermesTweetSearchArgs,
  baseUrl = DEFAULT_BASE_URL,
): URL {
  const url = new URL("/api/v1/x/tweets/search", normalizeBaseUrl(baseUrl));
  url.searchParams.set("q", args.query);
  url.searchParams.set("limit", String(clampLimit(args.maxResults)));
  if (args.paginationToken) {
    url.searchParams.set("cursor", args.paginationToken);
  }
  return url;
}

export function buildHermesTweetHeaders(
  apiKey: string,
): Record<string, string> {
  const key = apiKey.trim();
  const lower = key.toLowerCase();
  if (lower.startsWith("bearer ")) {
    return { Authorization: key };
  }
  if (key.startsWith("xq_")) {
    return { "x-api-key": key };
  }
  return { Authorization: `Bearer ${key}` };
}

export async function searchTweetsWithHermesTweet(
  args: HermesTweetSearchArgs,
  config: HermesTweetSearchConfig = {},
): Promise<HermesTweetSearchResult> {
  const apiKey = resolveApiKey(config.apiKey);
  const url = buildHermesTweetSearchUrl(
    args,
    config.baseUrl ??
      process.env.HERMES_TWEET_BASE_URL ??
      process.env.HERMES_TWEET_API_BASE ??
      process.env.XQUIK_BASE_URL ??
      DEFAULT_BASE_URL,
  );
  const fetchImpl = config.fetch ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "x-twitter-mcp-server/1.0 (Hermes Tweet search backend)",
        ...buildHermesTweetHeaders(apiKey),
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const suffix = body ? `: ${body.slice(0, 240)}` : "";
      throw new Error(
        `Hermes Tweet search failed with HTTP ${response.status}${suffix}`,
      );
    }

    const payload = await response.json();
    const tweets = parseHermesTweetSearchPayload(payload);
    return {
      tweets,
      nextToken: extractNextToken(payload),
      count: tweets.length,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function parseHermesTweetSearchPayload(
  payload: unknown,
): HermesTweetDTO[] {
  return collectTweetCandidates(payload)
    .map(normalizeHermesTweet)
    .filter((tweet): tweet is HermesTweetDTO => tweet !== null);
}

function resolveApiKey(configured?: string): string {
  const key =
    configured ?? process.env.HERMES_TWEET_API_KEY ?? process.env.XQUIK_API_KEY;
  if (!key?.trim()) {
    throw new Error(
      "Hermes Tweet search requires HERMES_TWEET_API_KEY or XQUIK_API_KEY in the server environment",
    );
  }
  return key.trim();
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed || DEFAULT_BASE_URL;
}

function clampLimit(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 10;
  }
  return Math.max(1, Math.min(100, Math.trunc(value)));
}

function collectTweetCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isObject(value)) {
    return [];
  }
  if (isTweetLike(value)) {
    return [value];
  }

  for (const key of ["tweets", "data", "results", "items", "statuses"]) {
    const nested = collectTweetCandidates(value[key]);
    if (nested.length > 0) {
      return nested;
    }
  }

  for (const nestedValue of Object.values(value)) {
    const nested = collectTweetCandidates(nestedValue);
    if (nested.length > 0) {
      return nested;
    }
  }

  return [];
}

function normalizeHermesTweet(value: unknown): HermesTweetDTO | null {
  if (!isObject(value)) {
    return null;
  }

  const id = firstString(value, [
    ["tweet_id"],
    ["id"],
    ["id_str"],
    ["rest_id"],
  ]);
  if (!id) {
    return null;
  }

  const text =
    firstString(value, [
      ["source_full_text"],
      ["full_text"],
      ["text"],
      ["content"],
      ["body"],
    ]) ?? "";
  const username =
    firstString(value, [
      ["handle"],
      ["username"],
      ["screen_name"],
      ["author", "username"],
      ["author", "screen_name"],
      ["user", "username"],
      ["user", "screen_name"],
    ])?.replace(/^@/, "") ?? "unknown";
  const authorName =
    firstString(value, [["name"], ["author", "name"], ["user", "name"]]) ??
    username;

  return {
    id,
    text,
    author: {
      id:
        firstString(value, [["author_id"], ["author", "id"], ["user", "id"]]) ??
        "",
      username,
      name: authorName,
    },
    metrics: {
      likeCount: metricValue(value, ["likes", "like_count"]),
      retweetCount: metricValue(value, [
        "retweets",
        "retweet_count",
        "reposts",
      ]),
      replyCount: metricValue(value, ["replies", "reply_count"]),
      quoteCount: metricValue(value, ["quotes", "quote_count"]),
    },
    conversationId:
      firstString(value, [["conversation_id"], ["conversationId"]]) ??
      undefined,
    inReplyToUserId:
      firstString(value, [["in_reply_to_user_id"], ["inReplyToUserId"]]) ??
      undefined,
    createdAt:
      firstString(value, [["created_at"], ["createdAt"], ["timestamp"]]) ??
      undefined,
  };
}

function extractNextToken(payload: unknown): string | undefined {
  return (
    firstNestedString(payload, [
      "nextToken",
      "next_token",
      "cursor",
      "next_cursor",
      "paginationToken",
    ]) ?? undefined
  );
}

function firstNestedString(
  value: unknown,
  keys: readonly string[],
): string | null {
  if (!isObject(value)) {
    return null;
  }
  for (const key of keys) {
    const direct = valueToString(value[key]);
    if (direct) {
      return direct;
    }
  }
  for (const nested of Object.values(value)) {
    const match = firstNestedString(nested, keys);
    if (match) {
      return match;
    }
  }
  return null;
}

function isTweetLike(value: JsonObject): boolean {
  return Boolean(
    firstString(value, [["tweet_id"], ["id"], ["id_str"], ["rest_id"]]) &&
    firstString(value, [
      ["source_full_text"],
      ["full_text"],
      ["text"],
      ["content"],
      ["body"],
    ]),
  );
}

function firstString(
  value: JsonObject,
  paths: readonly string[][],
): string | null {
  for (const path of paths) {
    const nested = getPath(value, path);
    const text = valueToString(nested);
    if (text) {
      return text;
    }
  }
  return null;
}

function getPath(value: JsonObject, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function valueToString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function metricValue(value: JsonObject, keys: readonly string[]): number {
  for (const key of keys) {
    const direct = valueToNumber(value[key]);
    if (direct !== null) {
      return direct;
    }
    for (const metricsKey of ["metrics", "public_metrics"]) {
      const metrics = value[metricsKey];
      if (isObject(metrics)) {
        const nested = valueToNumber(metrics[key]);
        if (nested !== null) {
          return nested;
        }
      }
    }
  }
  return 0;
}

function valueToNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (
    typeof value === "string" &&
    value.trim() &&
    Number.isFinite(Number(value))
  ) {
    return Number(value);
  }
  return null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
