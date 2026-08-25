# Bug Assessment: WebSearch binds to logged-in kimi account with no off-switch or MCP mapping, so quota exhaustion leaves it non-completing

- **Slug**: websearch-quota-fallback
- **Created**: 2026-08-24
- **Source**: pasted text
- **Verdict**: valid
- **Severity**: medium

## Report (verbatim or summarized)

> kimi code uses WebSearch by default the logged in users kimi.account if subscription quota is filled, WebSearch does not complete, WebSearch should be either able to be turned off and agents will be provided custom mcp, or it should be abled to mapped to another mcp tool call so when websearch is triggered it will use that mapped tool which is more preferred

(summarized) When a user is logged into their kimi account, WebSearch is automatically available and backed by that account (managed OAuth). If the kimi subscription/search quota is exhausted, WebSearch fails to complete. The reporter wants either (a) a way to turn WebSearch off so a user-provided custom MCP search tool is used instead, or (b) a way to alias/map WebSearch to another MCP tool, so calls to `WebSearch` are routed to the mapped tool.

Filing directive (user instruction): any GitHub issue for this bug must be filed **only** on the user's fork `arrrrny/kimi-code-sync`, not on upstream `MoonshotAI/kimi-code`.

## Symptom

WebSearch is auto-activated whenever a kimi account is present, and it is hard-bound to that account's managed OAuth token (`moonshotSearch` config is optional; absent that, the managed kimi OAuth provider is used). There is no configuration to disable WebSearch and no way to alias it to a user-supplied MCP tool. When the kimi account's search/subscription quota is exhausted, the search request no longer completes, and the model/agent has no fallback to a custom MCP search tool.

## Reproduction

1. Log into a kimi account (`/login`) whose search/subscription quota is exhausted (or close to it).
2. Start an agent/goal session and prompt it to perform a web search (or let the model call `WebSearch`).
3. Observe `WebSearch` being used (it is auto-available because `hasWebSearchProvider()` is true for the managed kimi account).
4. The search request fails or hangs — `WebSearch` does not complete. There is no setting to disable WebSearch so a custom MCP search tool is used instead, and no alias to redirect the call to a preferred MCP tool.
5. [NEEDS CLARIFICATION: the exact failure mode when quota is filled — HTTP status / error body / timeout vs. hard error. `classifySearchError` currently only special-cases abort/timeout/401/network; a 402/403/429 quota error would surface as a generic "Search failed". A small repro against an exhausted account would pin this down.]

## Suspected Code Paths

All paths below are the **v2 engine (default for the CLI)**; v1 has equivalent files (see Risks).

- `packages/agent-core-v2/src/app/auth/webSearch/webSearchService.ts:31` — `getWebSearchProvider()` returns `fromServicesConfig() ?? fromManagedOAuth()`. `fromManagedOAuth()` (line ~76) builds a provider from the **logged-in kimi account** OAuth token (`KIMI_CODE_PROVIDER_NAME`) with `baseUrl = <kimi provider baseUrl>/search`. This is the hard binding to the kimi account.
- `packages/agent-core-v2/src/app/auth/webSearch/webSearchService.ts:35` — `hasWebSearchProvider()` is true whenever a configured search OR a managed token provider exists, so simply being logged into kimi forces WebSearch on.
- `packages/agent-core-v2/src/agent/tools/web-search/webSearchTool.ts:114` — `registerAgentToolService(IWebSearchTool, WebSearchTool, { when: (accessor) => accessor.get(IWebSearchProviderService).hasWebSearchProvider() })`. The tool is gated only by "provider exists"; there is no `enabled`/opt-out flag.
- `packages/agent-core-v2/src/app/auth/configSection.ts:36` — `MoonshotServiceConfigSchema` only has `baseUrl`/`apiKey`/`oauth`/`customHeaders`. There is **no `enabled` flag** and no alias/redirect field, and `services.moonshotSearch` has no way to say "use an external tool instead".
- `packages/agent-core-v2/src/agent/tools/web-search/webSearchTool.ts:89` — `classifySearchError` does not distinguish quota-exhaustion (402/403/429) from generic failures, so quota errors are not surfaced distinctly.
- `packages/agent-core-v2/src/agent/toolRegistry/toolContribution.ts:50` — `overrideAgentToolService` exists but is **programmatic/registration-time only**; there is no runtime/config-driven tool alias or MCP-shadowing mechanism.
- v1 parity (unverified specifics, but present): `packages/agent-core/src/tools/builtin/web/web-search.ts`, `packages/agent-core/src/tools/providers/moonshot-web-search.ts`, `packages/agent-core/src/tools/support/services.ts` — same "bind to kimi account, no opt-out" shape.

## Root Cause Hypothesis

The WebSearch feature has no user-facing control surface. Its availability is derived implicitly from auth state (`hasWebSearchProvider()`), and its backend is the managed kimi account unless an explicit `services.moonshotSearch` is configured. Because there is (1) no flag to disable WebSearch while a kimi account is present, and (2) no mechanism to alias/redirect the `WebSearch` tool to a user-supplied MCP tool, a user whose kimi quota is exhausted is stuck: WebSearch keeps being selected, the search call fails/hangs, and there is no path to fall back to a custom MCP search. The two requested behaviors — off-switch, and MCP mapping — both require adding a config-driven control to the WebSearch activation/dispatch layer.

Confidence: high (the absence of any disable/alias config is directly visible in `webSearchService.ts`, `webSearchTool.ts`, and `configSection.ts`). The only uncertainty is the precise quota-failure mode (see Open Questions).

## Proposed Remediation

**Preferred**: Add two config-driven controls to the `[services]` (and/or a new `[tools]`) layer:

1. **Disable switch** — add `enabled` (default `true`) to `MoonshotServiceConfigSchema` (and/or a general tool-disable list). When WebSearch is disabled, `hasWebSearchProvider()` returns `false` / the `WebSearchTool` `when` gate evaluates false, so the built-in is not registered/activated and a user-provided MCP search tool (e.g. an MCP server exposing a `WebSearch`-equivalent or any search tool) is used instead.
2. **Alias / redirect** — add a mapping (e.g. `services.moonshotSearch.alias = "MyMcpSearch"` or `[tools] map = { WebSearch = "MyMcpSearch" }`). When the model invokes `WebSearch`, route the call to the mapped MCP tool. Implement via the tool registry/dispatch: resolve the requested tool name through the alias before execution, or register a thin `WebSearch` shim that forwards to the target tool. The mapped tool's own permission/approval rules should apply.

This satisfies both stated wishes (turn off → use custom MCP; or map → preferred MCP tool used transparently).

**Alternatives**:
- **MCP shadowing by name (lower effort)**: let a user-supplied MCP tool named `WebSearch` override the built-in (registry precedence: user/MCP tools shadow built-ins). Satisfies "use that mapped tool" without an explicit alias config, but gives less control (the MCP tool must literally be named `WebSearch`) and doesn't add an off-switch.
- **Off-switch only**: unblocks custom MCP usage but doesn't provide named mapping.
- **Quota-aware error + auto-fallback**: detect quota exhaustion in `classifySearchError`/provider and surface a clear message; helpful but does not by itself let the user route to their MCP tool.

**Files likely to change**:
- `packages/agent-core-v2/src/app/auth/webSearch/webSearchService.ts` — honor `enabled`; expose alias resolution in `getWebSearchProvider()` / `hasWebSearchProvider()`.
- `packages/agent-core-v2/src/app/auth/configSection.ts` — extend `MoonshotServiceConfigSchema` with `enabled` and an alias/redirect field; or add a `[tools]` map schema.
- `packages/agent-core-v2/src/agent/tools/web-search/webSearchTool.ts` — respect disable; optionally become an alias shim.
- `packages/agent-core-v2/src/agent/toolRegistry/toolRegistryService.ts` and `toolContribution.ts` — alias dispatch / MCP shadowing precedence.
- `packages/agent-core-v2/src/agent/toolActivation/toolActivationService.ts` — skip disabled tools.
- Docs: `docs/en/configuration/config-files.md`, `docs/en/reference/tools.md`, and zh equivalents.
- v1 parity: `packages/agent-core/src/tools/builtin/web/web-search.ts`, `moonshot-web-search.ts`, `tools/support/services.ts`, and the v1 config schema.

**Tests to add or update**:
- v2: with a kimi account present and `services.moonshotSearch.enabled = false`, assert `hasWebSearchProvider()` is false / WebSearch is not activated, and a custom MCP search tool is selectable instead.
- v2: with `services.moonshotSearch.alias = "MySearch"`, assert that a `WebSearch` invocation is routed to `MySearch` (and the mapped tool's approval rules apply).
- v2: `classifySearchError` distinguishes quota/402-403-429 errors clearly.
- v1 parity tests mirroring the above.

## Risks & Considerations

- **Default behavior regression**: changing `hasWebSearchProvider()` must keep WebSearch enabled by default for users who rely on kimi search; only an explicit opt-out disables it.
- **Approval/permission semantics**: aliasing changes which tool actually runs. The mapped MCP tool's permission/approval policy must apply (not WebSearch's), so the alias must resolve before the approval gate, not after.
- **Both engines**: the CLI defaults to v2, but v1 (`agent-core`) has the same architecture and needs parity fixes for the legacy flag.
- **Config/contract**: adding schema fields requires a changeset and docs updates (and zh docs).
- **Quota error surfacing**: without knowing the exact quota failure mode, the error-classification piece is best-effort until reproduced (see Open Questions).

## Open Questions

- [NEEDS CLARIFICATION: what exactly happens when the kimi search/subscription quota is filled — HTTP status (402/403/429?), error body, or a hang/timeout? This determines the error-handling part of the fix.]
- [NEEDS CLARIFICATION: preferred UX — explicit alias config (`map = { WebSearch = "X" }`) vs. MCP shadowing by name vs. both? The reporter says mapping "is more preferred".]
- Filing directive (user instruction): any GitHub issue must be created **only** on the fork `arrrrny/kimi-code-sync`, never upstream `MoonshotAI/kimi-code`.
