# Test List and Cycle Log Format

Two artifacts carry a feature's TDD state. The **test list** is the plan: every
behavior the feature must exhibit, traced to the criterion it serves. The **cycle
log** is the evidence: what actually failed, what made it pass, and what was
refactored, cycle by cycle.

They are separate on purpose. The list is rewritten as the plan evolves; the log
is append only and is what `/speckit.tdd.verify` audits. A list without a log is
a wish, and a log without a list is a diary.

## File placement and naming

Both live inside the feature directory that spec-kit already created:

```
specs/<feature>/
├── spec.md                 (spec-kit core)
├── plan.md                 (spec-kit core)
├── tasks.md                (spec-kit core, reordered by /speckit.tdd.plan)
└── tdd/
    ├── test-list.md        the plan: behaviors, traces, states
    ├── cycle-log.md        append-only evidence, one entry per cycle
    └── verification.md     the audit report, written by /speckit.tdd.verify
```

`specs/<feature>/` above is the usual layout, not a rule. Resolve the real
directory with spec-kit's own resolver rather than a heuristic: run
`.specify/scripts/bash/check-prerequisites.sh --json --paths-only` (or the
`powershell` or `python` variant the project installed) and take `FEATURE_DIR`
from its JSON. spec-kit reads the feature from `SPECIFY_FEATURE_DIRECTORY`, then
`.specify/feature.json`, and errors when neither is set. Either can point outside
`specs/`, so every path in this document is relative to `FEATURE_DIR`. If the
script is absent or errors, ask rather than guess, and never infer the feature from
the branch name or from file timestamps.

There is no index file across features. To find the other features' state, glob
`tdd/test-list.md` under the directory that holds `FEATURE_DIR` (usually `specs/`)
and read the frontmatter. A feature configured outside that tree is only reachable
through its own `FEATURE_DIR`, so a cross-feature sweep says which tree it covered.

## Frontmatter

The test list opens with this YAML block. It is the feature's TDD status record:

```yaml
---
feature: 003-user-auth # spec-kit feature directory name
loop: outside-in # outside-in | inside-out
profile: .specify/memory/tdd-profile.md # stack profile the commands must read
spec_criteria: 7 # acceptance criteria found in spec.md
planned_at: abc1234 # short SHA the list was derived from
updated_at: abc1234 # short SHA of the last change to this file
suite_baseline: green # green | red | unknown, at planning time
---
```

`loop: outside-in` is the default and means the acceptance test for a criterion is
written before the units beneath it. `inside-out` is for work with no user-visible
surface of its own (a pure library, an internal algorithm) where there is no
outer loop to open.

`suite_baseline` records whether the suite was green when the list was written. A
red baseline is not a blocker for planning, but the loop must not start on top of
one, and the audit needs to know which reds predate the feature.

## Behavior ids and states

Every behavior gets a stable id. Ids are never reused or renumbered, because the
cycle log references them:

- `A1`, `A2`, ... for outer-loop acceptance behaviors, one per acceptance
  criterion in `spec.md`.
- `U1`, `U2`, ... for inner-loop unit behaviors.
- Behaviors discovered mid-loop keep appending at the end of their series. A gap
  in the numbers is normal once something is dropped.

Each behavior carries one state:

| State      | Meaning                                                                         |
| ---------- | ------------------------------------------------------------------------------- |
| `PENDING`  | On the list, no test written yet                                                |
| `RED`      | Test written, failing for the right reason, evidence recorded in the cycle log  |
| `GREEN`    | Test passing, full suite passing, refactor step not finished                    |
| `DONE`     | Passing, suite green, refactor step completed or explicitly judged unnecessary  |
| `BASELINE` | Characterization test capturing existing behavior, green against untouched code |
| `BLOCKED`  | Cannot proceed, with a one-line reason next to the state                        |
| `DROPPED`  | Removed from scope, with a one-line reason. Kept in the table as the record     |

`RED` is a working state, not a resting state. A list left with a `RED` behavior
at the end of a session is reported as an unfinished cycle.

`kind` says what shape the test takes: `example` (the default), `property`,
`contract`, `approval`, or `characterization`. Anything other than `example`
requires the matching tool to be present in the stack profile.

## Template

```markdown
# Test List: <feature title>

## Outer loop: acceptance behaviors

One per acceptance criterion in `spec.md`. Each stays red until the feature works
end to end through its real entry point.

| id  | behavior                                                    | traces | kind    | state   | test                                        |
| --- | ----------------------------------------------------------- | ------ | ------- | ------- | ------------------------------------------- |
| A1  | A signed-in user sees only their own orders                 | AC-1   | example | DONE    | `tests/acceptance/orders.spec.ts::own only` |
| A2  | An expired session is rejected with a 401 and no order data | AC-3   | example | RED     | `tests/acceptance/auth.spec.ts::expired`    |
| A3  | An empty order history renders the empty state              | AC-4   | example | PENDING |                                             |

## Inner loop: unit behaviors

Grouped by the component from `plan.md` that owns them. Each line names one
observable result.

### `src/auth/session.ts`

| id  | behavior                                                  | traces     | kind     | state   | test                                   |
| --- | --------------------------------------------------------- | ---------- | -------- | ------- | -------------------------------------- |
| U1  | Rejects a token whose expiry is in the past               | AC-3, FR-2 | example  | DONE    | `src/auth/session.test.ts::expired`    |
| U2  | Accepts a token expiring exactly at the current instant   | AC-3       | example  | DONE    | `src/auth/session.test.ts::boundary`   |
| U3  | Round-trips any valid claim set through encode and decode | FR-2       | property | GREEN   | `src/auth/session.prop.ts::round trip` |
| U4  | Reads the clock through the injected time source          | FR-2       | example  | PENDING |                                        |

### `src/orders/repository.ts`

| id  | behavior                                              | traces | kind             | state    | test                                    |
| --- | ----------------------------------------------------- | ------ | ---------------- | -------- | --------------------------------------- |
| U5  | Current listing behavior for a legacy customer record | AC-1   | characterization | BASELINE | `src/orders/repository.test.ts::legacy` |
| U6  | Filters orders to the requesting user's id            | AC-1   | example          | DONE     | `src/orders/repository.test.ts::scoped` |

## Invariants and edge cases still to place

Behaviors that belong to the feature but do not yet have a home component. Each
must become a numbered line above before the feature is done, or be dropped with
a reason.

- Concurrent refresh of the same session must not issue two tokens.
- A clock skew of up to 30 seconds must not reject a valid token.

## Out of scope

Things a reader may expect on this list and the one-line reason they are absent.

- Password reset flow: separate feature, `specs/004-password-reset/`.
- Load behavior above 1000 concurrent sessions: no requirement, no test.

## Verification commands

Copied verbatim from `.specify/memory/tdd-profile.md` at planning time, so this
file is readable on its own:

- Single test: `pnpm vitest run <file> -t "<name>"`
- Full suite: `pnpm test`
- Coverage: `pnpm test --coverage`
- Mutation (changed files): `pnpm stryker run --mutate <files>`
```

## The cycle log

`cycle-log.md` is append only. One entry per completed cycle, in the order the
cycles ran. Never edit a past entry; a correction is a new entry that says what it
corrects.

Each entry records the four facts the audit cannot reconstruct afterwards: the
command that produced the red, the failure output, what made it green, and what
the refactor step changed.

```markdown
# Cycle Log: <feature title>

Append only. Newest last. Every entry's `red` block is the evidence that the test
existed and failed before the implementation.

## Baseline

- suite: `pnpm test` -> 124 passed, 0 failed
- commit: `abc1234`
- recorded: cycle 0, before any change

## Cycle 1: U1 rejects a token whose expiry is in the past

- test: `src/auth/session.test.ts::rejects an expired token` (new)
- red: `pnpm vitest run src/auth/session.test.ts -t "rejects an expired token"`
  -> `AssertionError: expected undefined to be 'expired'` (1 failed)
- green: `src/auth/session.ts:31` added the expiry comparison. Suite `pnpm test`
  -> 125 passed, 0 failed
- refactor: none needed, three lines inside an existing guard
- commit: `d41f8a2`

## Cycle 2: U2 accepts a token expiring exactly at the current instant

- test: `src/auth/session.test.ts::accepts a token expiring now` (new)
- red: `pnpm vitest run src/auth/session.test.ts -t "accepts a token expiring now"`
  -> `AssertionError: expected 'expired' to be undefined` (1 failed)
- green: `src/auth/session.ts:31` changed `<` to `<=`. Suite -> 126 passed
- refactor: extracted `isExpired(claims, now)` from the inline comparison; suite
  re-run green after the extraction
- commit: `9c2b117` (behavior), `5ee0a30` (structure)

## Cycle 3: U3 round-trips any valid claim set

- test: `src/auth/session.prop.ts::round trip` (new, property)
- red: `pnpm vitest run src/auth/session.prop.ts`
  -> `Property failed after 1 test. Seed: 1738. Counterexample: {sub:""}`
- green: `src/auth/session.ts:48` now rejects an empty subject before encoding.
  Suite -> 127 passed
- follow-up: added `U7 rejects an empty subject` to the test list as the pinned
  example for the shrunk counterexample
- refactor: none
- commit: `71ad4e9`

## Notes and deviations

Anything the audit must know that does not fit a cycle:

- Cycle 4 was reverted: the step needed two new files, so U5 was split into U5 and
  U8, and the cycle re-run from the last green (`71ad4e9`).
- `src/orders/legacy.ts` has a pre-existing failing test
  (`legacy.test.ts::currency rounding`) that was already red at baseline. Not
  touched by this feature.
```

## Quality bar: check before finishing the list

- Does every acceptance criterion in `spec.md` have at least one `A` behavior? A
  criterion with no acceptance behavior is an untested requirement.
- Does every `traces` value resolve to a real criterion, requirement, or recorded
  invariant id in `spec.md`? Trace values are checked mechanically by the audit.
- Is every behavior line one behavior, phrased as an observable result rather than
  a call to make?
- Does any pair of lines describe the same observable result in different words?
  Two lines a single bug would fail together are one behavior: merge them, keep
  the clearer wording, and drop the other id with a reason. An `A` behavior and
  the `U` behaviors beneath it are not a duplicate, because the outer loop is what
  fails when the units are individually right and collectively wrong.
- Are the boundaries listed, not just the happy path? For every rule with a
  threshold there should be a line on each side of it.
- Are the error paths listed, with the specific expected failure, not "handles
  errors"?
- Is every `kind` other than `example` backed by a tool recorded in the stack
  profile?
- Are the verification commands copied verbatim from the profile, so the list is
  usable without opening another file?
- Is anything a reader would expect and not find named in "Out of scope" with a
  reason?
