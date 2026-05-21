# CHANGELOG

<!-- version list -->

## v1.0.0 (2025-05-21)

### Features

- Initial open-source release
- 18 MCP tools: 9 SENSE (read) + 9 ACT (write)
- OAuth 1.0a and Bearer Token authentication
- Per-call credential support for multi-account setups
- Token-bucket rate limiter (respects X free-tier limits)
- Auto-retry with exponential backoff on HTTP 429
- SSRF protection for media URL uploads
- Prompt injection protection via randomised `EXTCONTENT` markers
- In-memory client cache with 4-hour TTL
- Username → user ID resolution cache
- Structured error responses with agent-actionable hints
