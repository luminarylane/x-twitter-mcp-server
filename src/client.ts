/**
 * X/Twitter API client factory with caching.
 *
 * Supports two auth modes:
 *   1. OAuth 2.0 App-Only: single bearer token (read-only public data)
 *   2. OAuth 1.0a User Context: appKey + appSecret + accessToken + accessSecret (full read/write)
 *
 * Clients are cached by credential hash to avoid unnecessary instantiation.
 */

import { createHash } from "node:crypto";
import { TwitterApi } from "twitter-api-v2";

const CLIENT_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

interface CachedClient {
  client: TwitterApi;
  readonly createdAt: number;
}

const clientCache = new Map<string, CachedClient>();

export interface OAuth1Credentials {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
}

export type Credentials =
  | { type: "bearer"; bearerToken: string }
  | { type: "oauth1"; oauth1: OAuth1Credentials };

/** Cache key uses a hash of credentials so rotated credentials don't reuse stale clients. */
export function credentialHash(creds: Credentials): string {
  const raw =
    creds.type === "bearer"
      ? creds.bearerToken
      : `${creds.oauth1.appKey}:${creds.oauth1.appSecret}:${creds.oauth1.accessToken}:${creds.oauth1.accessSecret}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Get or create an X/Twitter API client. Reuses cached clients when possible.
 * No async login needed — tokens are pre-authenticated.
 */
export function createClient(creds: Credentials): TwitterApi {
  const key = credentialHash(creds);
  const cached = clientCache.get(key);
  if (cached && Date.now() - cached.createdAt < CLIENT_TTL_MS) {
    return cached.client;
  }

  const client =
    creds.type === "bearer"
      ? new TwitterApi(creds.bearerToken)
      : new TwitterApi(creds.oauth1);

  // Evict stale entries before inserting
  const now = Date.now();
  for (const [k, val] of clientCache) {
    if (now - val.createdAt >= CLIENT_TTL_MS) clientCache.delete(k);
  }

  clientCache.set(key, { client, createdAt: now });
  return client;
}
