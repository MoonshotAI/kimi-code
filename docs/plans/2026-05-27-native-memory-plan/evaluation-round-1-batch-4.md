# Evaluation — Round 1, Batch 4

**Plan**: `docs/plans/2026-05-27-native-memory-plan/`
**Batch**: 4 (Resilience verification + Telemetry)
**Checklist**: `docs/retros/checklists/code-v1.md` (v1, code mode)
**Evaluator**: inline self-evaluation (Batch 4 coordinator)
**Date**: 2026-05-28

## Files under evaluation

### Source (modified)
- `packages/agent-core/src/memory/loader.ts` — extended `loadMemory` with optional `telemetry?: TelemetryClient`; emits `memory_index_truncated` when entries are dropped; added private `safeTrack` helper.
- `packages/agent-core/src/tools/builtin/state/memory.ts` — `MemoryTool` constructor accepts optional `telemetry`; `write`/`update`/`delete` emit `memory_write`/`memory_update`/`memory_delete` with `{ scope, slug }` after the store call succeeds; `view()` forwards telemetry into `loadMemory`. Private `emit()` wraps `telemetry.track` in try/catch.
- `packages/agent-core/src/agent/tool/index.ts` — passes `this.agent.telemetry` to the `MemoryTool` constructor.
- `packages/agent-core/src/profile/context.ts` — `prepareSystemPromptContext` accepts an optional `telemetry` and forwards it to `loadMemory`.
- `packages/agent-core/src/session/index.ts` — passes `this.telemetry` into `prepareSystemPromptContext` from `bootstrapAgentProfile`.
- `packages/agent-core/src/session/subagent-host.ts` — passes `child.telemetry` into `prepareSystemPromptContext` for spawned subagents.

### Tests (extended)
- `packages/agent-core/test/profile/context.test.ts` — added 4 resilience scenarios + 3 truncation-telemetry scenarios.
- `packages/agent-core/test/tools/memory.test.ts` — added 6 telemetry scenarios (write/update/delete events, body redaction, failure-no-event, no-event-on-read, sink-failure swallowing).

### Notes
- **Pair A (Tasks 12 + 13) is verification-only**: all 4 resilience tests passed on first run with NO source changes required, matching the design's prediction. The existing `prepareSystemPromptContext` flow + `loadMemory`'s disk-every-time semantics handle resume / `/compact` / subagent visibility correctly.
- Plumbing the telemetry through `prepareSystemPromptContext` is out-of-scope-of-the-strict-task-list but required so the system-prompt assembly path actually emits `memory_index_truncated` (the task spec describes the renderer as the firing site). The threading touches `session/index.ts` and `session/subagent-host.ts`; both edits are mechanical forwarding of `this.telemetry` / `child.telemetry`.

---

## CODE-VER-01 — All verification commands exit code 0

| Command | exit | output tail |
|---|---|---|
| `pnpm typecheck` | 0 | `packages/agent-core typecheck: Done` ... `packages/node-sdk typecheck: Done` |
| `pnpm exec vitest run packages/agent-core/test/tools/memory.test.ts` | 0 | `Test Files  1 passed (1)`; `Tests  27 passed (27)` |
| `pnpm exec vitest run packages/agent-core/test/profile/context.test.ts` | 0 | `Test Files  1 passed (1)`; `Tests  23 passed (23)` |
| `pnpm exec vitest run packages/agent-core/test/profile` | 0 | `Test Files  3 passed (3)`; `Tests  31 passed (31)` |
| `pnpm exec vitest run packages/agent-core/test/skill` | 0 | `Test Files  4 passed (4)`; `Tests  77 passed (77)` |
| `pnpm exec vitest run packages/agent-core/test/agent` | 0 | `Test Files  23 passed (23)`; `Tests  316 passed (316)` |
| `pnpm lint packages/agent-core/src/memory packages/agent-core/src/profile packages/agent-core/src/tools/builtin/state/memory.ts` | 0 | `Found 0 warnings and 0 errors.` |

Full agent-core suite: 117 files / 1753 passing (was 1740 in Batch 3, +13 new tests).

**Result:** PASS

---

## CODE-QUAL-01 — No TODO/FIXME/HACK/XXX/STUB markers in produced files

```bash
grep -rn -E '(TODO|FIXME|HACK|XXX|STUB|stub\b)' \
  packages/agent-core/src/memory/loader.ts \
  packages/agent-core/src/tools/builtin/state/memory.ts \
  packages/agent-core/src/profile/context.ts \
  packages/agent-core/src/agent/tool/index.ts \
  packages/agent-core/src/session/index.ts \
  packages/agent-core/src/session/subagent-host.ts \
  packages/agent-core/test/profile/context.test.ts \
  packages/agent-core/test/tools/memory.test.ts
# (no output; exit 1 — no lines selected)
```

**Result:** PASS

---

## CODE-QUAL-02 — No stub implementations

```bash
grep -rn 'NotImplementedError' <produced files>  # no matches (exit 1)
grep -rn -E '^[[:space:]]+pass[[:space:]]*$' <produced files>  # no matches (exit 1)
grep -rn -E '^[[:space:]]+\.\.\.[[:space:]]*$' <produced files>  # no matches (exit 1)
```

**Result:** PASS

---

## Verdict

**PASS** — all three checklist items PASS, all verification commands exit 0.

## Recurring patterns

None detected this batch.

## Notes for the main agent

- **Pair A (Resilience) was correctly designed as verification-only.** The 4 new resilience scenarios passed without any source edit. The design's invariant — "memory lives in the system prompt; loader reads disk on every call; subagents call `prepareSystemPromptContext` independently" — is preserved.
- **Architectural observation (not a defect this batch)**: `Agent.useProfile` snapshots `systemPrompt` as a frozen string into `config.systemPrompt`. The Memory section is therefore captured at profile-load time. In the current flow this is only re-rendered on session bootstrap (`bootstrapAgentProfile`) and subagent spawn. If a future batch needs a written fact to appear mid-session in the same parent agent without re-bootstrapping the profile, this is the site to revisit. Tests for this batch operate at the `prepareSystemPromptContext` layer (matching the task spec), not at the in-process Agent layer, so no defect surfaces here.
- **Telemetry surface (Task 19 resolution)**: `Agent.telemetry: TelemetryClient` from `agent-core/src/telemetry.ts`. Pattern: pass through constructors, wrap each `.track(...)` call in try/catch for fire-and-forget. `loadMemory` now takes an optional 3rd `telemetry` param; `MemoryTool` takes an optional 3rd `telemetry` param. Both default to no-op behaviour to keep existing call sites and unit-tests compatible.
- **No body content leaks in telemetry**: enforced via tests that JSON-stringify each payload and assert the exclusive body token does not appear; the `emit()` helper only ever receives `{ scope, slug }` objects by construction.
