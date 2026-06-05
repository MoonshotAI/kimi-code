---
"@moonshot-ai/agent-core": minor
"@moonshot-ai/kimi-code-sdk": minor
"@moonshot-ai/kimi-code": minor
---

Honor the standard `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` environment variables for all outbound HTTP(S) traffic — model API calls, MCP servers, web tools, telemetry, sign-in, and update checks.

A global proxy dispatcher is installed at startup only when a proxy variable is set, so the zero-config default is unchanged. Loopback hosts (`localhost`, `127.0.0.1`, `::1`) always bypass the proxy so local servers (e.g. a localhost MCP server) keep working, and stdio MCP servers running as Node processes honor the proxy automatically.
