---
name: test
description: Use when writing or reviewing tests, or when asked how to write a good single test. Encodes the per-test rules behind the "test the contract / responsibility, not the implementation" principle — name and structure one behavior per `it`, drive through the public surface, stub only true external boundaries, control time and config via documented knobs, and keep tests clear, isolated, and refactor-resilient. The same rules drive both authoring (write mode) and auditing existing tests (review mode).
---

# Tests — write & review

Per-test rules that operationalize one principle: **test the contract / responsibility, not the implementation**. This is the how-to for a single `it`, and the lens for reviewing one.

## Two modes, one rule set

- **Write mode** — authoring a test. Apply the rules below to produce it.
- **Review mode** — auditing an existing test or test diff. Apply the same rules as a checklist; report each violation with `file:line`, the rule it breaks, and the fix. See "Review mode" near the end.

The rules are identical in both modes — only the posture changes (produce vs. audit).

## Test contract, not implementation

- Drive the system through its **public control plane** and assert on **observable effects** (returned values, persisted state, emitted events, injected messages), never on source details.
- Resolve collaborators through their contract — the interface plus its identifier — not the module that binds a concrete implementation.
- Do not reach into private fields or add backdoors "for testing". If you feel the need, the seam is wrong — fix the design, not the test.

## One behavior per `it`

Each `it` covers exactly one responsibility / scenario. If the name needs "and", split it.

```ts
it('returns 401 when the caller is unauthorized', ...);
it('does not double-fire when the same tick repeats', ...);
```

## Name and structure

- `describe('<slice> (<responsibilities>)'` — name the **responsibility**, not the class.
- An `it(...)` reads as a sentence, but it must still encode three things — the **behavior / method**, the **state or condition**, and the **expected outcome**: `it('<behavior> when <condition>, <outcome>')`. A name like `does X when Y` with no result is too vague to fail usefully.
  - Use spaces, not the Java-style `method_state_outcome` underscores — that convention exists only because Java test methods cannot contain spaces. A string-named test reads fine as a sentence.
  - Good: `it('returns 401 when the caller is unauthorized')` · `it('advances the cursor and does not double-fire on a repeat tick')`
  - Bad: `it('works')` · `it('handles auth correctly')` — no condition, no outcome
- Arrange / Act / Assert. A short `// Given` `// When` `// Then` is fine when it aids reading; do not paste it mechanically on trivial tests.

## Build a small rig

When several tests share setup, write a factory (`rig()`, `createHost()`, whatever fits the codebase) that returns the **smallest surface the test needs**. Tests reach into the rig; they do not rebuild the world each time. Keep the rig dumb: wiring only, no assertions.

## Stub only the real external boundary

Default to real collaborators wired the way production wires them. Stub the **minimum seam** that is genuinely external:

- A remote / model / service boundary — spy on the contract method (the interface), and capture what the system sends across it. Do not stand up the real external thing.
- Network / other-process boundaries — stub at the boundary, not the internals.
- Time, timers, jitter — use the documented control knobs the system exposes (env, an injected clock, a manual tick). Do **not** use fake timers or real `setTimeout` to drive time.
- Env / config knobs are usually snapshotted at bootstrap — set them **before** building the system under test, and restore them in `afterEach`.

## Keep tests DAMP and keep cause next to effect

- DAMP over DRY: use **literal expected values** in assertions; do not compute the expectation with the same logic as the code under test.
- Keep the key preconditions inside the `it` (or its rig), where the reader can see cause next to effect. Reserve `beforeEach` for cross-cutting plumbing (env snapshot, cleanup), not for hiding the scenario's setup.

```ts
// Good — the expected value is a literal the reader can check.
expect(discount).toBe(15);
// Bad — re-derives the expectation; mirrors the implementation.
expect(discount).toBe(price * rate);
```

## Assert only what is relevant

Assert the effect that proves the contract. Use matchers / partial-object matching to ignore incidental fields. Do not assert internal counters, call orders, or shapes the user cannot rely on.

## Isolate and clean up (no flakes)

Every test must be hermetic and order-independent. In `afterEach`:

- restore every mock / spy
- restore every env var you touched (snapshot in `beforeEach`)
- dispose the host / container and reset its reference

No dependence on wall-clock time, run order, or leftover on-disk state — give each scenario its own isolated identity / workspace when state persists.

## Quality bar: CCCR

Before finishing, check each test against:

- **Clarity** — a stranger can tell what broke from the failure message alone.
- **Completeness** — covers the responsibility's success, error, and boundary paths.
- **Conciseness** — no duplicate or speculative cases; one scenario per `it`.
- **Resilience** — survives an internal refactor with no test change (because it asserts contract, not implementation).

## Per-file scenario header

Start each test file with a short header comment: the **scenario**, the **responsibilities** asserted, the **wiring** (which collaborators are real vs. the single stubbed boundary), and how to run it.

## Review mode — auditing existing tests

Apply the rules above as a checklist against each test in scope (a file, a diff, or a named `it`). For every hit, report `file:line` + the rule it breaks + the fix; do not rewrite unless asked. Lead with the contract question: *what observable behavior does this test prove, and would it survive a refactor?*

Check, in order:

1. **Contract, not implementation** — asserts observable effects, not private fields, call order, or internal shapes the user cannot rely on.
2. **One behavior per `it`** — the name carries behavior + condition + outcome; "and" in the name means a split is owed.
3. **Boundary discipline** — only the true external seam is stubbed; time is driven by documented knobs, not fake timers / real `setTimeout`.
4. **DAMP expectations** — expected values are literals, not re-derived by the code under test's logic.
5. **Isolation** — mocks / spies / env / host restored in `afterEach`; no wall-clock, run-order, or leftover on-disk dependence.
6. **CCCR read-through** — Clarity, Completeness (success / error / boundary), Conciseness, Resilience.

Report findings as evidence + fix, e.g. "`foo.test.ts:42` asserts on `service.internalMap` (contract) — assert the returned value instead." If a test passes the lens, say so briefly; silence on a rule means it held.

## Quick checklist (write & review)

- Resolved through the contract; no concrete-impl import
- One behavior per `it`; name carries behavior + condition + outcome; AAA
- Stubbed only the true external seam; time via knobs, not fake timers
- Literal expectations; relevant assertions only
- Mocks / env / host restored in `afterEach`; hermetic, no flakes
- CCCR read-through done
