# ⚠️ LANGUAGE RULE — MANDATORY

**ALL responses MUST be in English ONLY. Never respond in Turkish, Chinese, or any other language, regardless of the user's locale or the presence of non-English content in the codebase. This is a hard rule with no exceptions.**

---

## 📚 Zread Wiki — Check First

**Before diving into source code, check if a zread wiki exists for this project:**

```bash
# Check if wiki exists:
cat .zread/wiki/current 2>/dev/null && echo "Wiki exists" || echo "No wiki"

# If wiki exists, read the pages directly:
ls .zread/wiki/versions/$(cat .zread/wiki/current)/

# To regenerate wiki (if stale):
zread generate --stdio
```

**Why?** Zread generates comprehensive documentation from code. Reading the wiki is faster than crawling source files manually.

**Rules:**
1. **ALWAYS** check `.zread/wiki/current` before reading source files
2. If wiki exists, read the markdown pages directly — they're already indexed
3. If wiki is missing or stale, run `zread generate --stdio` to create it
4. Wiki pages live in `.zread/wiki/versions/<id>/` — read `wiki.json` for the TOC

# agent-core Agent Guide

## Hard rules

- The `Agent` class in `packages/agent-core/src/agent` must be usable on its own. The constructor must not force the caller to create a `Session` instance, nor require an `agentId` or `session`. It may accept an optional `sessionId` as a request-config hint — for example mapped to the provider's `prompt_cache_key` — but the instance must not hold `sessionId`, and must not depend on the Session lifecycle, metadata, or parent/child relationship logic.

## MCP management plane

- `src/mcp/registry.ts` (`McpServerRegistry`) is the single config view for MCP servers: `global` (layered mcp.json files) / `plugin` (manifests, read-only, final effective config via `PluginManager.mcpServerEntries`) / `caller` (SDK session injection). All management lookups in `src/rpc/core-impl.ts` go through it; mutations only accept mutable (user-level) entries and push changes into live sessions.
- Live-session sync is one path: `KimiCore.reconcileMcpServerInSession` recomputes the registry runtime target (`resolveRuntimeTarget`: enabled plugin > project layer > user file; caller injection shadows everything and is never touched) per (session, name) and drives the session to it. Never add mutation-path-specific connect/remove logic — extend the reconciliation.
- Wire-facing config DTOs are redacted: session `McpServerEntry`/`McpServerInfo.config` and read-only `McpManagedServerInfo` entries carry the `src/mcp/config-view.ts` projection (`envKeys`/`headerKeys` instead of literal `env`/`headers` values, which may hold credentials). Mutable user-level management entries keep full values for edit UIs. Core-internal code compares full configs via `McpConnectionManager.getRawEntry`.
- One process-wide `McpOAuthService` lives on `KimiCore` and is shared with every `Session`; each `Session` subscribes to its credential events (save/invalidate/refresh-failed) in its constructor and unsubscribes on close, so even sessions still initializing see every event. Never construct a per-scope OAuth service in new code. Token writes go through the process-local `OAuthTokenTransaction` (`@moonshot-ai/kimi-code-oauth`), which serializes refresh grants per credential identity and stamps `obtained_at` on every durable write. Interactive authorization flows are serialized per credential too: a second `beginAuthorization` for the same identity joins the in-flight flow instead of resetting the shared provider's PKCE/state. Proactive refresh timers, their in-flight refreshes, and interactive flows live and die with `McpOAuthService.shutdown()`, which `KimiCore.shutdown()` awaits.
