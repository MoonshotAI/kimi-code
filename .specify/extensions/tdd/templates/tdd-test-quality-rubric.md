# Test Quality Rubric

The standard `/speckit.tdd.verify` grades against. It exists because a green suite
is not evidence. Tests generated alongside code tend to pass while proving very
little: they assert what a double was configured to return, re-implement the
calculation they are checking, or execute a line without checking its result.
Coverage counts execution; this rubric asks whether a bug would have been caught.

Grade from cold context. Read the tests as written, not as intended. If the audit
was run by the same session that wrote the tests, it must re-read every file
rather than rely on memory, because the gaps it is looking for are exactly the
ones the author's context fills in automatically.

## What the audit answers

Five questions, in this order. A failure in an earlier question makes the later
ones less meaningful, so the report says which stage failed.

1. **Did the tests come first?** Is there recorded evidence that each behavior's
   test existed and failed before the code that satisfies it?
2. **Do the tests assert behavior?** Or do they assert doubles, internals, or
   nothing at all?
3. **Would they catch a bug?** Measured by mutation testing where a tool exists,
   and by deliberate mutants where it does not.
4. **Is every requirement covered?** Does each acceptance criterion in `spec.md`
   reach at least one test that exercises the real entry point?
5. **Are the tests worth keeping?** Deterministic, fast, readable, consistent with
   the suite they join, and insensitive to refactoring, or a maintenance burden
   that will be deleted in three months.

## Evidence sources

Three independent sources. Agreement between them is what makes the verdict
trustworthy; disagreement is itself a finding.

| Source                                  | Answers                                           | Can be wrong because                       |
| --------------------------------------- | ------------------------------------------------- | ------------------------------------------ |
| `specs/<feature>/tdd/cycle-log.md`      | What the loop claims happened, with red output    | It is self-reported                        |
| Git history for the feature branch      | What order test and source files actually changed | Squashed or amended commits lose the order |
| The test and source files as they stand | What the tests actually assert today              | It cannot show what came first             |

Read all three. When the cycle log claims a red that the history contradicts, the
history wins and the discrepancy is reported. When the history is squashed and
cannot show ordering, say so rather than inferring compliance.

## Test-first evidence

Per behavior in the test list, classify the evidence:

| Class            | Criteria                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROVEN`         | Cycle log records the red command and its failure output, and the git history shows the test file changing in the same commit as, or before, the source change |
| `LIKELY`         | Cycle log records a red, but history cannot corroborate the order (squashed or amended commits)                                                                |
| `TEST_AFTER`     | No red recorded, or history shows the source change landing in an earlier commit than its test                                                                 |
| `NO_TEST`        | The behavior has no test at all                                                                                                                                |
| `NOT_APPLICABLE` | Characterization baseline, which is green by definition against untouched code                                                                                 |

Useful history checks, adapted to the repository's actual layout from the stack
profile's `test_glob`:

- Commits touching only test files, then commits touching source: the expected
  shape of a disciplined loop.
- A commit that adds a source file and its test in one commit is normal and
  consistent with a per-cycle commit. It is `PROVEN` only when the cycle log has
  the red for it.
- A commit that changes an existing test and its subject together deserves a read:
  it is either a legitimate behavior change with its own list item, or a test
  weakened to match the code.

Also check what the diff did to tests that already existed:

- Assertions removed, loosened, or replaced by a weaker predicate.
- A test renamed so it no longer matches a filter that used to select it.
- A test marked skipped, pending, or excluded through config.
- Coverage thresholds or mutation scopes reduced.

Each of these is reported with the `file:line` and the before and after, whatever
the reason given. They are the highest-signal findings in the audit.

## Test smell catalogue

For each new or changed test file, check every item. Severity is fixed: `HIGH`
means the test proves nothing or actively misleads, `MED` means it will decay,
`LOW` means readability.

Four of the items are relative to the repository rather than absolute, so read
the stack profile's `## Conventions to match` section, the exemplar for each test
kind, and every path under `helpers` before starting the pass. A test cannot be
graded against a standard the auditor has not opened. A test in a foreign style,
or one that hand-rolls what a recorded helper already provides, may prove its
behavior perfectly and still be a finding: it is the next author's licence to
invent a third way. On `Redundant test`, note that an acceptance test and a unit
test covering one criterion is double-loop TDD working as intended, not a
duplicate. Two tests at the same level that one bug would fail together are.

| Smell                         | What it looks like                                                                             | Severity |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | -------- |
| Assertion free                | Calls the code, asserts nothing. Or asserts only "did not throw" where the behavior is a value | HIGH     |
| Tautological assertion        | Asserts a double returns what the test configured it to return                                 | HIGH     |
| Re-implemented expectation    | Computes the expected value with the same logic the code uses, so both are wrong together      | HIGH     |
| Doubled subject               | Stubs or spies the very unit the test claims to verify                                         | HIGH     |
| Over-mocked collaborators     | Every dependency is a double, so the test passes with a completely wrong implementation        | HIGH     |
| Vacuous assertion             | Asserts truthiness, non-null, or `length >= 0` where a specific value is required              | HIGH     |
| Self-approving snapshot       | A snapshot or approval file generated and accepted in the same step, never reviewed            | HIGH     |
| Conditional logic in the test | `if` or loops deciding what to assert, so some runs assert nothing                             | HIGH     |
| Empty or always-skipped test  | A test body that is empty, or skipped, pending, or excluded in the committed state             | HIGH     |
| Implementation coupled        | Asserts private state, call counts no requirement mentions, or exact log strings               | MED      |
| Assertion roulette            | Many unlabelled assertions in one test, so a failure does not say which behavior broke         | MED      |
| Eager test                    | One test exercising several behaviors, so it has several reasons to fail                       | MED      |
| Magic values                  | Unexplained literals where the value carries the rule (a boundary, a tolerance, an id)         | MED      |
| Mystery guest                 | Depends on an external file, fixture database, or shared state not visible in the test         | MED      |
| Non-deterministic             | Real clock, real random, real network, real sleep, or dependence on test execution order       | MED      |
| Sleepy test                   | A fixed sleep instead of waiting on a condition                                                | MED      |
| Redundant test                | A second test pinning what another test at the same level already pins                         | MED      |
| Foreign style                 | Naming, assertions, or fixtures that do not match the exemplar for that test kind              | MED      |
| Bypassed test utility         | A hand-rolled fixture, double, or matcher the profile's `helpers` already provides             | MED      |
| Framework under test          | Asserts behavior owned by the framework or a library rather than by the feature                | MED      |
| Duplicated setup              | The same fixture construction copied across tests instead of one factory                       | LOW      |
| Unclear name                  | A name that does not state the behavior, so failure output says nothing                        | LOW      |

Report every `HIGH` with `file:line`, what it asserts today, and what it should
assert instead. Do not rewrite the tests during the audit; the report is the
product, and fixing is a separate, explicit step.

Alongside the smells, check the properties a test suite is supposed to have. A
suite can be smell free and still be a bad safety net if it is slow, coupled to
structure, or unable to tell you where a failure came from. Note any behavior
whose tests are not isolated, deterministic, fast, specific about what broke, or
insensitive to refactoring.

## Test strength: mutation and deliberate mutants

Coverage says a line ran. Mutation testing says a change to that line would have
been caught. It is the only mechanical answer to "are these tests real", and it is
what catches tautologies and vacuous assertions that read fine.

**With a mutation tool** (from the stack profile):

1. Scope the run to the files the feature changed. A whole-repo run is a CI job,
   not an audit step.
2. Record the mutation score and, more importantly, the **surviving mutants**. The
   score is a number; a survivor is a specific bug the suite would ship.
3. Map each survivor to the behavior that should have caught it. A survivor inside
   a behavior marked `DONE` is a `HIGH` finding: that test does not test what it
   claims.
4. Distinguish survivors that matter from equivalent mutants (a change with no
   observable effect, for example altering a log message or a redundant
   initialization). Judge, do not report the raw list.
5. Report the score with its scope and the tool's version, so it is comparable
   next time. An unscoped score is not comparable to anything.

**Without a mutation tool**, use deliberate mutants on a sample. For each of the
highest-risk behaviors (the ones an acceptance criterion depends on, the ones with
money, auth, or data loss in the path):

1. Make one small change to the implementation that should violate the behavior:
   invert a comparison, return a constant, drop a call, skip a guard, change a
   boundary by one.
2. Run the behavior's test. It must fail.
3. Restore the code exactly and re-run the suite to confirm green.
4. Record the mutant, the file, and whether it was caught.

A mutant that survives is the same finding as a surviving mutant from a tool.
Record how many behaviors were sampled and which, so the report does not read as
exhaustive when it was not.

Never leave a mutant in the tree. Verify the restore with the suite before moving
on.

## Traceability: criteria to tests

Build the mapping from `spec.md` to tests, mechanically:

1. Enumerate the acceptance criteria and functional requirements with their ids.
2. For each, find the tests that claim it through the test list's `traces` column.
3. Confirm each claimed test exists, runs, and asserts something related to the
   criterion. A `traces` value pointing at a test that does not exist is a
   `HIGH` finding: the list is lying about coverage.
4. Confirm each acceptance criterion has at least one test that exercises the real
   entry point, not a unit beneath it. A criterion covered only by unit tests with
   doubles at every boundary is not verified end to end.
5. Report both directions: criteria with no test (untested requirements) and tests
   that trace to nothing (either an undocumented requirement worth recording, or a
   test that is testing the framework rather than the feature).

Coverage output, where available, backs this up: a criterion whose implementation
files have uncovered branches is suspect even when a test claims it.

## Scoring and verdict

One verdict per feature, and it fails closed. When the evidence is missing, the
verdict is not "pass by default".

| Verdict          | Conditions                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASS`           | Every behavior `PROVEN` or `LIKELY`; no `HIGH` smells; every acceptance criterion has an end-to-end test; mutation survivors triaged with none inside a `DONE` behavior                           |
| `PASS_WITH_GAPS` | No `HIGH` smells and no untested criteria, but some evidence is weak: `LIKELY` instead of `PROVEN`, mutation unmeasured, or coverage unavailable. Gaps listed individually                        |
| `FAIL`           | Any `HIGH` smell, any `TEST_AFTER` or `NO_TEST` behavior, any weakened or skipped existing test, any acceptance criterion without a test, or any surviving mutant inside a behavior marked `DONE` |
| `BLOCKED`        | The audit could not run: no test runner, suite red at baseline for reasons unrelated to the feature, or the feature has no test list                                                              |

Report the verdict with the single most decisive reason on the same line. A `FAIL`
that requires reading three sections to understand will be ignored.

## Report format

`FEATURE_DIR/tdd/verification.md`, overwritten on each run. Previous runs are kept
in git history, so the file always shows current state. `standard:` names the rubric
file the audit actually resolved and graded against, so a verdict can be read
against the standard that produced it.

```markdown
---
feature: 003-user-auth
verdict: PASS_WITH_GAPS
standard: .specify/extensions/tdd/templates/tdd-test-quality-rubric.md # rubric graded against
verified_at: 9f3a1c2 # short SHA audited
behaviors: 18
proven: 15
likely: 3
test_after: 0
no_test: 0
high_smells: 0
criteria_total: 7
criteria_covered: 7
mutation_score: 84 # scope: changed files only, StrykerJS 9.2.0
mutants_survived: 3 # all triaged as equivalent
suite: 127 passed, 0 failed, 41s
---

# TDD Verification: User authentication

**Verdict: PASS_WITH_GAPS.** Discipline holds and every criterion is covered.
Three behaviors could not be corroborated in git history because the branch was
rebased, and two survivors need a second look.

## Test-first evidence

| Behavior | Class  | Evidence                                                      |
| -------- | ------ | ------------------------------------------------------------- |
| U1       | PROVEN | cycle 1 red recorded; `d41f8a2` adds test and source together |
| U9       | LIKELY | cycle 9 red recorded; history squashed, order not verifiable  |

## Findings

Ordered by severity, each with evidence and the fix.

| #   | Severity | Finding                                                                      | Evidence                               |
| --- | -------- | ---------------------------------------------------------------------------- | -------------------------------------- |
| 1   | MED      | `session.test.ts::refresh` asserts the spy was called but not the new expiry | `src/auth/session.test.ts:88`          |
| 2   | LOW      | Boundary literal `900` repeated in four tests with no named constant         | `src/auth/session.test.ts:12,34,51,77` |

## Mutation results

Scope, tool, score, and every survivor with a judgment:

| Mutant                            | Behavior | Survived | Judgment                              |
| --------------------------------- | -------- | -------- | ------------------------------------- |
| `session.ts:31` `<=` to `<`       | U2       | No       | Caught by U2, boundary is pinned      |
| `session.ts:44` removed debug log | none     | Yes      | Equivalent mutant, no behavior change |

## Traceability

| Criterion | Tests            | End to end |
| --------- | ---------------- | ---------- |
| AC-1      | `A1`, `U6`       | Yes        |
| AC-3      | `A2`, `U1`, `U2` | Yes        |

Untested criteria: none. Tests tracing to nothing: none.

## What was not audited

Say it plainly, every run.

- `packages/legacy` was out of scope: no runner configured.
- Mutation was scoped to the 6 changed files, not the whole repository.
- Performance and load behavior: no criterion, no test, not assessed.
```

## Remediation tasks

Findings become work only when they are written where the lifecycle will pick them
up. For each finding worth acting on, append a task to the feature's `tasks.md` in
a `## Phase N: TDD remediation` section, following the file's existing task format
and id sequence:

- One task per finding, referencing the finding number and the `file:line`.
- Phrased as a verifiable change, with the command that proves it done.
- Ordered so a `HIGH` finding precedes anything that builds on the code it covers.
- A `FAIL` verdict's blocking findings come first, and the section says the feature
  is not done until they are cleared.

Never fix findings inside the audit. An auditor that edits the code it is grading
loses the only thing that made the grade worth reading.
