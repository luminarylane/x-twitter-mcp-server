import pino from "pino";

// stdout is the MCP stdio protocol channel — pino defaults to fd 1 (stdout)
// when no destination is given, which corrupts every JSONRPC message this
// server writes with an interleaved log line. Route to fd 2 (stderr) instead.
const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    base: {
      service: "x-twitter-mcp-server",
      environment: process.env.NODE_ENV || "development",
    },
    redact: {
      paths: ["*.password", "*.token", "*.apiKey", "*.secret"],
      censor: "[REDACTED]",
    },
  },
  pino.destination(2),
);

export default logger;
