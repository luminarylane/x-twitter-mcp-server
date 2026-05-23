# 🐦 X/Twitter MCP Server

[![CI](https://github.com/luminarylane/x-twitter-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/luminarylane/x-twitter-mcp-server/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/x-twitter-mcp-server)](https://www.npmjs.com/package/x-twitter-mcp-server)
[![MCP](https://img.shields.io/badge/MCP-1.0-blue)](https://modelcontextprotocol.io)
[![GitHub Release](https://img.shields.io/github/v/release/luminarylane/x-twitter-mcp-server)](https://github.com/luminarylane/x-twitter-mcp-server/releases)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

A Model Context Protocol (MCP) server that enables Claude Desktop (and other MCP clients) to interact with X/Twitter — post tweets, read timelines, search content, manage follows, and monitor your account.

## ✨ Features

### 🔐 Flexible Authentication

- **OAuth 1.0a** — Full read + write access (post, reply, like, retweet, follow)
- **Bearer Token** — App-only read access (search, timelines, profiles)
- **Per-call credentials** — Pass credentials as tool arguments for multi-account setups
- **Env var defaults** — Set once in environment, reuse across all tool calls

### 🛡️ Security

- **SSRF protection** — Blocks private/internal IPs when uploading media from URLs
- **Prompt injection protection** — External content wrapped in randomised `EXTCONTENT` markers
- **No secrets in code** — All credentials resolved from env vars or per-call arguments

### ⚡ Performance

- **In-memory client cache** — Reuses authenticated clients (4h TTL) to avoid redundant handshakes
- **Username → ID cache** — Resolves `@username` to user IDs once, caches for 4h
- **Token-bucket rate limiter** — Respects X free-tier limits before hitting the API
- **Auto-retry on 429** — Exponential backoff up to 3 retries on rate-limit responses

### 🧰 18 Tools (9 SENSE + 9 ACT)

**SENSE — Read from X/Twitter:**
| Tool | Description |
|------|-------------|
| `x_get_timeline` | Home timeline — recent posts from followed accounts |
| `x_get_notifications` | Mentions of the authenticated user |
| `x_search_tweets` | Search by keyword, hashtag, or `from:username` via X API or optional Hermes Tweet/Xquik backend |
| `x_get_tweet_thread` | Fetch a tweet and its full conversation thread |
| `x_get_profile` | User profile by username |
| `x_get_followers` | Followers list for any account |
| `x_get_user_tweets` | Recent tweets from a specific user |
| `x_search_users` | Search for users by name or keyword |
| `x_get_media_specs` | X/Twitter media format specs (dimensions, size limits, formats) |

**ACT — Write to X/Twitter:**
| Tool | Description |
|------|-------------|
| `x_create_tweet` | Post a tweet (text, link card, image, or video) |
| `x_reply` | Reply to a tweet |
| `x_create_thread` | Post a series of connected tweets |
| `x_quote_tweet` | Quote-tweet with commentary |
| `x_like` | Like a tweet |
| `x_retweet` | Retweet |
| `x_follow` | Follow a user by username |
| `x_unfollow` | Unfollow a user by username |
| `x_delete_tweet` | Delete a tweet |

## 🚀 Quick Start

### Prerequisites

- Node.js 18 or higher
- An [X Developer account](https://developer.x.com) with an app created
- Claude Desktop (or any MCP-compatible client)

### Get Your X API Credentials

1. Go to the [X Developer Portal](https://developer.x.com/en/portal/dashboard)
2. Create a project and app
3. Under **User authentication settings**, set permissions to **Read and write**
4. Generate your keys:
   - **Consumer Key** → `X_APP_KEY`
   - **Consumer Secret** → `X_APP_SECRET`
   - **Access Token** → `X_ACCESS_TOKEN`
   - **Access Token Secret** → `X_ACCESS_SECRET`

For read-only access, a **Bearer Token** alone is sufficient.

## 📦 Installation

### Option 0: Claude Code Plugin (Simplest for Claude Code Users) 🔌

If you're using [Claude Code](https://claude.ai/code), install directly via the plugin system:

```bash
# Add the Luminary Lane Tools marketplace
/plugin marketplace add luminarylane/x-twitter-mcp-server

# Install the plugin
/plugin install x-twitter@luminary-lane-tools
```

Or install directly without adding the marketplace:

```bash
/plugin install x-twitter@luminarylane/x-twitter-mcp-server
```

> **Note:** Set your X API credentials as environment variables before using the plugin.

### Option 1: npx (Recommended — Zero Install) ⚡

Run directly without installation:

```bash
# Test it works
X_BEARER_TOKEN=your-token npx -y x-twitter-mcp-server
```

**Claude Desktop configuration:**

```json
{
  "mcpServers": {
    "x-twitter": {
      "command": "npx",
      "args": ["-y", "x-twitter-mcp-server"],
      "env": {
        "X_APP_KEY": "your-consumer-key",
        "X_APP_SECRET": "your-consumer-secret",
        "X_ACCESS_TOKEN": "your-access-token",
        "X_ACCESS_SECRET": "your-access-token-secret"
      }
    }
  }
}
```

> **Read-only setup** (bearer token only):
>
> ```json
> { "env": { "X_BEARER_TOKEN": "your-bearer-token" } }
> ```

### Option 2: Install from npm

```bash
npm install -g x-twitter-mcp-server
```

Then configure Claude Desktop:

```json
{
  "mcpServers": {
    "x-twitter": {
      "command": "x-twitter-mcp-server",
      "env": {
        "X_APP_KEY": "your-consumer-key",
        "X_APP_SECRET": "your-consumer-secret",
        "X_ACCESS_TOKEN": "your-access-token",
        "X_ACCESS_SECRET": "your-access-token-secret"
      }
    }
  }
}
```

### Option 3: Install from Source

```bash
git clone https://github.com/luminarylane/x-twitter-mcp-server.git
cd x-twitter-mcp-server
npm install
npm run build
```

Then configure Claude Desktop:

```json
{
  "mcpServers": {
    "x-twitter": {
      "command": "node",
      "args": ["/path/to/x-twitter-mcp-server/dist/index.js"],
      "env": {
        "X_APP_KEY": "your-consumer-key",
        "X_APP_SECRET": "your-consumer-secret",
        "X_ACCESS_TOKEN": "your-access-token",
        "X_ACCESS_SECRET": "your-access-token-secret"
      }
    }
  }
}
```

## 🔑 Authentication

The server resolves credentials in this priority order:

| Priority | Mode         | Env Vars                                                            | Access            |
| -------- | ------------ | ------------------------------------------------------------------- | ----------------- |
| 1        | OAuth 1.0a   | `X_APP_KEY` + `X_APP_SECRET` + `X_ACCESS_TOKEN` + `X_ACCESS_SECRET` | Full read + write |
| 2        | Bearer Token | `X_BEARER_TOKEN`                                                    | Read-only         |
| 3        | Per-call     | Pass as tool arguments                                              | Either mode       |

**Per-call credentials** let you manage multiple X accounts from one server instance — pass `appKey`, `appSecret`, `accessToken`, `accessSecret` (or `bearerToken`) directly as tool arguments.

### Optional Hermes Tweet/Xquik search backend

`x_search_tweets` defaults to the X API path above. For read-only search through
[Hermes Tweet](https://github.com/Xquik-dev/hermes-tweet), set a Hermes
Tweet/Xquik key and select the backend per call or by environment:

```bash
export HERMES_TWEET_API_KEY="xq_..."
export X_SEARCH_BACKEND="hermes-tweet"
# Optional self-hosted or alternate endpoint:
export XQUIK_BASE_URL="https://xquik.com"
```

Per-call usage:

```json
{
  "query": "Model Context Protocol",
  "maxResults": 20,
  "searchBackend": "hermes-tweet"
}
```

This only affects tweet search. Timeline, profile, write, and engagement tools
continue to use the configured X credentials.

## 💬 Usage Examples

Once configured, ask Claude to:

- "What's on my X timeline?"
- "Search for tweets about Model Context Protocol"
- "Search X through Hermes Tweet for posts about AI agent launch"
- "Post a tweet: Just shipped a new feature!"
- "Create a thread about the benefits of async programming"
- "Reply to tweet 1234567890 with 'Great point!'"
- "Like tweet 1234567890"
- "Follow @anthropic"
- "Get the profile for @sama"
- "Show me the full thread for tweet 1234567890"
- "What media formats does X support for video uploads?"

## 📊 Rate Limits

The server enforces X free-tier rate limits client-side before hitting the API:

| Category                    | Limit        | Window   |
| --------------------------- | ------------ | -------- |
| General reads               | 450 requests | 15 min   |
| Timeline reads              | 900 requests | 15 min   |
| Tweet creation              | 50 tweets    | 24 hours |
| Likes                       | 1,000 likes  | 24 hours |
| Retweet / Follow / Unfollow | 5 actions    | 15 min   |

When a limit is reached the server returns a structured error with a `retryAfterSeconds` field and an `action` hint for the agent.

## 🔧 Troubleshooting

### Credentials not working

```
Error: Missing credentials
```

Ensure all four OAuth 1.0a variables are set, or at minimum `X_BEARER_TOKEN` for read-only access.

### 401 Authentication failed

```
AUTH_FAILED: Credentials are invalid or expired.
```

Regenerate your Access Token and Secret in the [X Developer Portal](https://developer.x.com) and update `X_ACCESS_TOKEN` / `X_ACCESS_SECRET`.

### 403 Permission denied

```
PERMISSION_DENIED: Your token may lack write permissions.
```

Go to **X Developer Portal → App Settings → User authentication → Permissions** and set it to **Read and write**, then regenerate your tokens.

### 403 Duplicate tweet

```
DUPLICATE_TWEET: X rejected this as a duplicate.
```

Change the tweet text to make it unique.

### 400 Tier restricted

```
TIER_RESTRICTED: This endpoint is not available on your X API tier.
```

Some endpoints (e.g., full-archive search) require a Basic or Pro tier. The `x_search_tweets` tool uses recent search which is available on the free tier.

### Rate limit exceeded

```
Rate limited: Wait Xs then retry.
```

The server handles this automatically for short waits (≤ 60s). For longer windows it returns the `retryAfterSeconds` so the agent can defer the task.

### Reporting Issues

1. Check [existing issues](https://github.com/luminarylane/x-twitter-mcp-server/issues)
2. Open a new issue with:
   - Full error message
   - Steps to reproduce
   - Tool name used
   - Environment (OS, Node.js version)

[📝 Open an Issue](https://github.com/luminarylane/x-twitter-mcp-server/issues/new)

## 🤝 Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

```bash
# Install dependencies
npm install

# Run in dev mode
npm run dev

# Type check
npx tsc --noEmit

# Run tests
npm test

# Format
npx prettier --write .
```

## 📝 License

MIT License — see [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- [Anthropic](https://anthropic.com) for the MCP specification
- [twitter-api-v2](https://github.com/plhery/node-twitter-api-v2) for the excellent X API client
