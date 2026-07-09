---
name: kc-review
description: Use ONLY for code review and test write/review guidance in `packages/agent-core-v2` (the DI × Scope agent engine). Does NOT apply to the legacy `packages/agent-core` or to any other package — for those, do not load this skill. Groups the review and testing lenses used for agent-core-v2 — `slop` (single-level-of-abstraction / layered error-handling review, invoked only on explicit request) and `test` (contract-driven per-test rules for both authoring and reviewing tests). Apply the sub-skill that matches the task; do not apply `slop` unprompted.
has-sub-skill: true
---

# kc-review

> **Scope: `packages/agent-core-v2` only.** These lenses are calibrated for the v2 engine (DI × Scope). Do not apply them to the legacy `packages/agent-core` or to other packages.

A bundle of the lenses used when reviewing or testing `packages/agent-core-v2`. Each sub-skill is self-contained; invoke the one that matches the task.

## Sub-skills

- **`slop/`** — Single Level of Abstraction & layered error handling. A *review dimension*: a function should read as a straight-line description of its own layer, with errors handled above or below. The agent reports detections and measurements, not severity grades. **Invoke only when the user explicitly asks for this lens** — do not apply it unprompted to general reviews or refactors.
- **`test/`** — Per-test rules behind "test the contract / responsibility, not the implementation," serving two modes. **Write mode:** author a test — one behavior per `it`, drive through the public surface, stub only the true external boundary, control time/config via documented knobs, keep tests clear, isolated, and refactor-resilient (CCCR). **Review mode:** audit existing tests against the same rules and report findings with `file:line`. Use when writing, modifying, or reviewing tests, or when asked how to write a good single test.

## Routing

- Reviewing code structure / abstraction layers / where error handling belongs → `slop` (only on explicit request).
- Writing or modifying tests, reviewing test quality, or advising on a single test → `test`.
