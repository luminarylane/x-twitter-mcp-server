import { describe, it, expect, vi } from "vitest";
import {
  buildHermesTweetHeaders,
  buildHermesTweetSearchUrl,
  parseHermesTweetSearchPayload,
  resolveSearchBackend,
  searchTweetsWithHermesTweet,
} from "./hermes-tweet.js";

describe("resolveSearchBackend", () => {
  it("defaults to the X API backend", () => {
    expect(resolveSearchBackend()).toBe("x-api");
  });

  it("accepts explicit Hermes Tweet backend names", () => {
    expect(resolveSearchBackend("hermes-tweet")).toBe("hermes-tweet");
    expect(resolveSearchBackend("xquik")).toBe("hermes-tweet");
  });
});

describe("buildHermesTweetSearchUrl", () => {
  it("builds the Xquik tweet search endpoint with encoded query params", () => {
    const url = buildHermesTweetSearchUrl(
      {
        query: "from:openai agent tools",
        maxResults: 250,
        paginationToken: "cursor-1",
      },
      "https://example.com/",
    );

    expect(url.origin).toBe("https://example.com");
    expect(url.pathname).toBe("/api/v1/x/tweets/search");
    expect(url.searchParams.get("q")).toBe("from:openai agent tools");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(url.searchParams.get("cursor")).toBe("cursor-1");
  });
});

describe("buildHermesTweetHeaders", () => {
  it("uses x-api-key for Xquik API keys", () => {
    expect(buildHermesTweetHeaders("xq_test")).toEqual({
      "x-api-key": "xq_test",
    });
  });

  it("uses bearer auth for non-Xquik tokens", () => {
    expect(buildHermesTweetHeaders("token")).toEqual({
      Authorization: "Bearer token",
    });
  });
});

describe("parseHermesTweetSearchPayload", () => {
  it("normalizes nested Xquik search results into MCP tweet DTOs", () => {
    const tweets = parseHermesTweetSearchPayload({
      data: {
        tweets: [
          {
            tweet_id: "123",
            source_full_text: "Hermes Tweet reads X search results",
            author: {
              id: "42",
              screen_name: "hermes_user",
              name: "Hermes User",
            },
            public_metrics: {
              like_count: "5",
              retweet_count: 2,
              reply_count: 1,
              quote_count: 0,
            },
            conversation_id: "100",
            created_at: "2026-05-23T18:00:00Z",
          },
        ],
      },
    });

    expect(tweets).toEqual([
      {
        id: "123",
        text: "Hermes Tweet reads X search results",
        author: {
          id: "42",
          username: "hermes_user",
          name: "Hermes User",
        },
        metrics: {
          likeCount: 5,
          retweetCount: 2,
          replyCount: 1,
          quoteCount: 0,
        },
        conversationId: "100",
        inReplyToUserId: undefined,
        createdAt: "2026-05-23T18:00:00Z",
      },
    ]);
  });
});

describe("searchTweetsWithHermesTweet", () => {
  it("fetches Hermes Tweet search results with x-api-key auth", async () => {
    const fetchMock = vi.fn(async (_url: URL, _init: RequestInit) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        tweets: [{ id: "1", text: "hello", username: "alice" }],
        next_cursor: "next",
      }),
      text: async () => "",
    }));

    const result = await searchTweetsWithHermesTweet(
      { query: "hello", maxResults: 1 },
      {
        apiKey: "xq_test",
        baseUrl: "https://xquik.test",
        fetch: fetchMock,
      },
    );

    expect(result.count).toBe(1);
    expect(result.nextToken).toBe("next");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe(
      "https://xquik.test/api/v1/x/tweets/search?q=hello&limit=1",
    );
    expect(init.headers).toMatchObject({
      Accept: "application/json",
      "x-api-key": "xq_test",
    });
  });

  it("raises a clear error when Hermes Tweet returns HTTP failure", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 402,
      statusText: "Payment Required",
      json: async () => ({}),
      text: async () => "insufficient credits",
    }));

    await expect(
      searchTweetsWithHermesTweet(
        { query: "hello" },
        {
          apiKey: "xq_test",
          baseUrl: "https://xquik.test",
          fetch: fetchMock,
        },
      ),
    ).rejects.toThrow(
      "Hermes Tweet search failed with HTTP 402: insufficient credits",
    );
  });
});
