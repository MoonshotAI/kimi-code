---
name: write-tests
description: Use when writing or modifying the black-box example tests in kimi-code-mini-bench (`examples/*.example.ts`, run with `pnpm example`), or when asked how to write a good single test. Encodes the per-test writing rules that sit under AGENTS.md's "test contract, not implementation" principle — name and structure one behavior per `it`, drive through the public surface, stub only true external boundaries, control time/config via documented knobs, and keep tests clear, isolated, and refactor-resilient.
---

# Write Tests (kimi-code-mini-bench)

Per-test writing rules for the `examples/*.example.ts` black-box tests. They operationalize the top-level rule in `AGENTS.md` (**test contract / responsibility, not implementation**) — read that first; this skill is the how-to for a single `it`.

## File placement & run

- Tests live under `examples/` and MUST be named `*.example.ts` — `vitest.config.ts` only includes `examples/**/*.example.ts`.
- Run one file: `pnpm example -- examples/<name>.example.ts`. Run all: `pnpm test`.
- `pnpm check:blackbox` MUST pass before you submit. It fails any test that imports an **impl module** (a source file with a top-level `registerScopedService(...)`). Resolve services through `accessor.get(IX)` instead.

## Test contract, not implementation

- Drive the system through its **public control plane** and assert on **observable effects** (returned values, persisted state, injected messages), never on source details.
- Resolve services via the contract: `host.session.accessor.get(IX)` / `host.app.accessor.get(IX)`. Import only the interface + its `ServiceIdentifier`, never the module that binds the concrete impl.
- Do not reach into private fields or add backdoors "for testing". If you feel the need, the seam is wrong — fix the design, not the test.

## One behavior per `it`

Each `it` covers exactly one responsibility / scenario. If the name needs "and", split it.

```ts
it('fires a one-shot task by steering the main agent, then auto-deletes it', ...);
it('does not fire while the agent is busy, then fires once it goes idle', ...);
```

## Name and structure

- `describe('<slice> (<responsibilities>)'` — name the **responsibility**, not the class.
- `it('does <behavior> when <condition>')` — read as a sentence stating the contract.
- Arrange / Act / Assert. A short `// Given` `// When` `// Then` is fine when it aids reading; do not paste it mechanically on trivial tests.

## Build a small rig

When several tests share setup, write a `rig()` (or use `createSliceHost`) that returns the **smallest surface the test needs** — e.g. `{ cron, steered, setNow, setActiveTurn }`. Tests reach into the rig; they do not rebuild the world each time. Keep the rig dumb: wiring only, no assertions.

## Stub only the real external boundary

Default to real collaborators wired by `_harness`. Stub the **minimum seam** that is genuinely external:

- LLM — spy on the contract method, e.g. `vi.spyOn(main.accessor.get(IAgentPromptService), 'steer').mockImplementation(...)`, and capture the injected message. Do not spin up a real turn.
- Network / other process boundaries — stub at the boundary, not the internals.
- Time, timers, jitter — use the documented control knobs (`KIMI_CRON_CLOCK=file:<path>` + rewrite the file to advance time; `KIMI_CRON_MANUAL_TICK=1`; `KIMI_CRON_NO_JITTER=1`). Do **not** use `vi.useFakeTimers()` or real `setTimeout` to drive time.
- Env knobs are snapshotted at bootstrap — set them **before** `createSliceHost(...)`, and restore them in `afterEach`.

## Keep tests DAMP and keep cause next to effect

- DAMP over DRY: use **literal expected values** in assertions; do not compute the expectation with the same logic as the code under test.
- Keep the key preconditions inside the `it` (or its rig), where the reader can see cause next to effect. Reserve `beforeEach` for cross-cutting plumbing (env snapshot, cleanup), not for hiding the scenario's setup.

```ts
// Good — the expected value is a literal the reader can check.
expect(cron.getNextFireTime()).toBe(BASE + MINUTE);
// Bad — re-derives the expectation; mirrors the implementation.
expect(cron.getNextFireTime()).toBe(computeNextSlot(BASE, '* * * * *'));
```

## Assert only what is relevant

Assert the effect that proves the contract. Use matchers / `expect.objectContaining` to ignore incidental fields. Do not assert internal counters, call orders, or shapes the user cannot rely on.

## Isolate and clean up (no flakes)

Every test must be hermetic and order-independent. In `afterEach`:

- `vi.restoreAllMocks()`
- restore every env var you touched (snapshot in `beforeEach`)
- `host?.dispose()` and reset the `host` reference

No dependence on wall-clock time, run order, or leftover on-disk state — give each scenario its own `workspaceId` / home when state persists.

## Quality bar: CCCR

Before finishing, check each test against:

- **Clarity** — a stranger can tell what broke from the failure message alone.
- **Completeness** — covers the responsibility's success, error, and boundary paths.
- **Conciseness** — no duplicate or speculative cases; one scenario per `it`.
- **Resilience** — survives an internal refactor with no test change (because it asserts contract, not implementation).

## Per-file scenario header

Start each `*.example.ts` with a short header comment: the **scenario**, the **responsibilities** asserted, the **wiring** (which collaborators are real vs. the single stubbed boundary), and the **Run** line. Match the existing files (e.g. `cron.example.ts`).

## Quick checklist

- `*.example.ts` under `examples/`; `pnpm check:blackbox` passes
- Resolved through `accessor.get(IX)`; no impl-module import
- One behavior per `it`, sentence-shaped name, AAA
- Stubbed only the true external seam; time via knobs, not `useFakeTimers`
- Literal expectations; relevant assertions only
- Env/mocks/host restored in `afterEach`; hermetic, no flakes
- CCCR read-through done
