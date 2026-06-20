---
name: service-skill
description: Use when discussing, designing, or reviewing application Service boundaries purely from business and data-model first principles — concept-only, not code-driven — and when archiving a finalized Service design as long-lived reference material. Inputs are business semantics (entities, interactions, invariants), not source code. Not for bug fixes, refactors, current-code mapping, or module exposure review.
---

# Service Design Skill

Use this skill to reason about application Service boundaries **from concepts only** — entities, aggregates, user interactions, data-model invariants — and to archive finalized designs as reusable reference material.

## Inputs and outputs

**Inputs**

- Business / product description: entities, user interactions, constraints (persistence, visibility, archival, concurrency).
- Optionally a candidate design or an existing archived design under reconsideration.

**Not used as input**

- Current source code, existing Service names, DI container wiring, route layer, repository implementations.
- File paths, package layout, prior tooling decisions in any repository.

**Outputs**

- A conceptual Service split (Command / Query / Runtime / Repository / Index).
- Interfaces as TypeScript-like pseudocode.
- Decision records for non-obvious choices.
- Optionally: archived files under this skill's `explanation/` / `reference/` / `how-to/` / `tutorial/` trees.

## When to use

- Designing a new application Service boundary from scratch.
- Deciding which Service owns a piece of business logic.
- Reviewing an existing **design** (not code) for boundary violations.
- Archiving a finalized design as reusable reference.

## When NOT to use

- Bug fixes, code refactors, renaming, single-file edits.
- Mapping current code structure to documentation (use `knowledge-lifecycle__docs-sync`).
- Reviewing module public API / exposure (use `module-review`).
- Implementing or migrating a designed Service (use `plan-lifecycle__*`).

## Skill Map

Read by Diátaxis type.

### Explanation — principles and domain narratives

- [`explanation/service-design-principles.md`](explanation/service-design-principles.md) — thinking style, the Command / Query / Runtime split, red flags.
- [`explanation/domains/session-workspace.md`](explanation/domains/session-workspace.md) — finalized domain narrative for Session / Workspace.

### Reference — reusable patterns and per-service contracts

Patterns (generic Service templates):

- [`reference/patterns/command-service.md`](reference/patterns/command-service.md)
- [`reference/patterns/query-service.md`](reference/patterns/query-service.md)
- [`reference/patterns/runtime-service.md`](reference/patterns/runtime-service.md)
- [`reference/patterns/repository-and-index.md`](reference/patterns/repository-and-index.md)

Domains (finalized Service contracts):

- Session / Workspace:
  - [`reference/domains/session-workspace/workspace-service.md`](reference/domains/session-workspace/workspace-service.md)
  - [`reference/domains/session-workspace/session-service.md`](reference/domains/session-workspace/session-service.md)
  - [`reference/domains/session-workspace/session-query-service.md`](reference/domains/session-workspace/session-query-service.md)
  - [`reference/domains/session-workspace/session-runtime-service.md`](reference/domains/session-workspace/session-runtime-service.md)
  - [`reference/domains/session-workspace/types.md`](reference/domains/session-workspace/types.md)

### How-to

- [`how-to/design-a-service.md`](how-to/design-a-service.md) — design a Service from business facts.
- [`how-to/review-a-service-design.md`](how-to/review-a-service-design.md) — review a candidate or archived design.
- [`how-to/archive-service-design.md`](how-to/archive-service-design.md) — archive a finalized design into this skill.

### Tutorial

- [`tutorial/design-session-workspace-services.md`](tutorial/design-session-workspace-services.md)

## How to read this skill

- For a quick refresher on the split and rules: `explanation/service-design-principles.md`.
- For a working example: the tutorial, then the Session / Workspace domain narrative and reference files.
- For executing a task: the matching `how-to/` file.
- For writing a new Service from scratch: pick the relevant patterns in `reference/patterns/` and instantiate them in your domain.
