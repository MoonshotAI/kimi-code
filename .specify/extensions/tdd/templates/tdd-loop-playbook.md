# TDD Loop Playbook

The discipline `/speckit.tdd.run` follows, and the standard `/speckit.tdd.verify`
grades against. It is language agnostic: every command it needs comes from the
stack profile (`.specify/memory/tdd-profile.md`), never from a guess about the
ecosystem.

Two ideas carry the whole playbook:

1. **The test list is the plan.** TDD is not "write a test, then some code."
   It starts by listing the behaviors a change must exhibit, then converts them
   into tests one at a time. The list absorbs everything discovered on the way,
   so discovery never turns into scope creep.
2. **A test only counts if it can fail.** A test written after the code, or one
   that passes the moment it is written, proves nothing about the code. The loop
   therefore records the failure before the fix, and the audit re-checks that
   record.

## The loop

```
outer loop (hours)                      inner loop (minutes)

pick the next acceptance behavior
  write the acceptance test  --> RED
                                  |
                                  +--> pick the next unit behavior
                                  |      write one unit test   --> RED
                                  |      smallest change       --> GREEN
                                  |      refactor while green  --> GREEN
                                  |      commit
                                  |    repeat until the acceptance test can pass
                                  v
  acceptance test           --> GREEN
  refactor across units     --> GREEN
  commit, mark the behavior done
```

The outer loop is the feature's acceptance criteria from `spec.md`: user-visible
behavior, one test per criterion, measured in hours. The inner loop is the
components from `plan.md`: one test per unit behavior, measured in minutes. This
is double-loop TDD, and it is what keeps unit work honest. Passing units with a
red acceptance test means the units are wrong, not the acceptance test.

Start every feature outside in: the acceptance test is written first and stays
red until the feature works end to end. That red is expected and is not a
failure of the loop. Record it as the outer-loop state in the test list.

## Step 1: the test list

Before writing any test, write the list of behaviors. For each behavior capture
one line: the input or precondition, the expected observable result, and the
acceptance criterion or requirement it serves. Cover the happy path, the
boundaries, the error paths, and the invariants that must hold across inputs.

The list lives at `tdd/test-list.md` inside the feature directory spec-kit resolves
(`FEATURE_DIR`, usually `specs/<feature>/`) and follows
`tdd-test-list-template.md`. `/speckit.tdd.plan` writes it; the loop consumes it
top to bottom and appends to it.

Rules for the list:

- One behavior per line. If a line needs the word "and", it is two behaviors.
- Every line names the observable result, not the implementation. "Rejects a
  negative amount with a validation error" is a behavior; "calls `validate()`" is
  not.
- Every line traces to an acceptance criterion, a functional requirement, or an
  explicitly recorded invariant. A line that traces to nothing is either a
  missing requirement (raise it) or scope creep (drop it).
- Listing behaviors is not designing the implementation. Deciding classes,
  layers, or algorithms while listing produces a list shaped like the design
  instead of like the requirement. The design belongs in `plan.md` and in step 5.
- When the loop discovers a new case, it is appended to the list, not
  implemented on the spot. The current cycle finishes first.

## Step 2: one concrete test

Turn exactly one list item into one runnable test. Not two, not the whole file.

- Name the test after the behavior, in the repo's existing naming style. The
  name is read in failure output, so it must say what broke.
- Use the smallest fixture that expresses the behavior. Named constants over
  magic values: a reader must see why `1_000` is the boundary.
- Assert the behavior, not the shape of the implementation. Prefer asserting the
  returned value or the observable state change over asserting that a
  collaborator was called.
- One reason to fail per test. Several unrelated assertions in one test hide
  which behavior regressed.

If the behavior cannot be expressed as a test yet because the seam does not
exist, the missing seam is the next design decision. Introduce the seam as its
own refactoring step on green code, then come back.

## Step 3: red, and red for the right reason

Run only the new test with the profile's single-test command, and capture the
real output.

A valid red fails **because the behavior is missing**, which means one of:

- an assertion failure showing the expected and actual values, or
- a deliberate "not implemented" signal from a stub the test drives, or
- an unresolved-symbol or compile error **only** when the language requires the
  symbol to exist before the test can run. In that case, add the minimal
  declaration or stub, run again, and record the resulting assertion failure as
  the red evidence.

These are **not** valid reds, and each has a required response:

| Symptom                                                      | Meaning                                                  | Response                                                                                              |
| ------------------------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Test-file syntax error, wrong import path, bad fixture setup | The test is broken, not the code                         | Fix the test, then re-run for a real red                                                              |
| Test passes on first run                                     | The behavior already exists, or the test asserts nothing | Verify with a deliberate mutant (below); if it already exists, mark the list item covered and move on |
| Suite cannot start (missing dependency, broken config)       | The stack profile is wrong or stale                      | Fix the profile first; a loop cannot run without a runner                                             |
| Error from an unrelated failing test                         | Pre-existing breakage                                    | Record the baseline, report it, and do not attribute it to this cycle                                 |

Record the failure verbatim in the cycle log: the command run, the test id, and
the shortest decisive line of output. That record is the evidence
`/speckit.tdd.verify` re-checks; a cycle with no red evidence is treated as
test-after work.

When a test passes on the first run and the behavior is supposed to be new,
apply the **deliberate mutant** check: break the implementation in the smallest
way that should violate the behavior (invert a condition, return a constant, drop
a call), confirm the test now fails, then restore the code exactly. If the test
still passes with the mutant in place, the test is worthless. Rewrite it.

## Step 4: green by the smallest change

Make the failing test pass, and change nothing else.

Choose the smallest sufficient move:

1. **Obvious implementation** when the correct code is clear and small. Write it.
2. **Fake it** when it is not: return the constant that satisfies the test, then
   let the next test on the list force the generalization.
3. **Triangulate** when generalizing feels arbitrary: add the second example from
   the list and let the two together dictate the shape.

Prefer the transformation that adds the least behavior: a constant before a
variable, a variable before a conditional, a conditional before a loop, a loop
before recursion. Reaching for the general solution before the tests demand it is
how a loop turns into speculative design.

Then run the full suite with the profile's suite command. Green means the new
test passes **and** nothing else broke. A red elsewhere is either a real
regression to fix now or a genuine specification conflict to raise, never a test
to weaken.

"Make it run, then make it right." Ugly code that passes is a legitimate state to
be in for the length of one cycle. It is not a legitimate state to commit and
walk away from, which is what step 5 is for.

## Step 5: refactor while green

Refactoring happens only with a green suite, and only as behavior-preserving
change. If a refactor needs a test changed to stay green, it is not a refactor:
it is a behavior change and needs its own list item and its own red.

Each refactoring step is small and re-verified: rename, extract, inline, move,
replace duplication with one implementation. Run the suite after each step, not
at the end of five.

Look for the smells the cycle just created or exposed: duplication between the
new code and existing code, a function that grew a second responsibility, a name
that no longer describes what the thing does, a parameter list that has become a
missing type, primitive obsession in the new signature.

Keep structural changes separate from behavioral ones. A commit either changes
behavior (with its test) or changes structure (with the suite unchanged), never
both. Reviewers can then read a structural commit for shape and a behavioral
commit for correctness.

Refactoring the tests counts. A test file with duplicated setup, unclear names,
or a helper that hides the assertion is technical debt in the safety net itself.

## Granularity: how big is one step

The cycle should complete in minutes. If a red has been red for longer than that,
the step was too big. Revert to the last green, split the behavior into two list
items, and take the smaller one.

Signals the step is too big: more than one new production file needed to go
green; the test requires more than a few lines of setup; the implementation grows
a branch the test does not exercise. Signals it is too small: the test asserts a
getter returns what the constructor was handed, with no rule in between.

For work where reverting is cheap and the discipline is welcome, an optional
stricter mode is `test && commit || revert`: every green auto-commits and every
red discards the change. It forces tiny steps by making a long red impossible.
Use it only when the user asks; it needs a clean tree and a fast suite.

## Test doubles: when to mock and when not to

Pick per behavior, not per project. Both styles are legitimate and a real
codebase needs both.

**State based (fewer doubles).** Default for domain logic, pure functions,
calculations, and state machines. Call the real thing, assert on the returned
value or the resulting state. Tests survive refactoring because they never named
a collaborator. Use real in-memory implementations of ports where they are cheap
(a fake repository, an in-memory clock) rather than mocking method by method.

**Interaction based (doubles at the boundary).** Use where the observable
behavior _is_ the call: sending an email, publishing an event, charging a card,
writing to a queue. Assert that the boundary was invoked with the right payload,
because there is no state to read back.

Hard limits, whatever the style:

- Never double the unit under test. A test that stubs the function it claims to
  verify asserts the stub.
- Never assert on a double whose return value the test itself configured, unless
  the assertion is about the call, not the value.
- Do not double what you own and can construct cheaply. Doubles are for slow,
  non-deterministic, or side-effecting collaborators.
- Time, randomness, network, filesystem, and clock reads are injected, never
  reached for directly, so tests stay deterministic.

## Brownfield: characterization tests first

Changing untested existing code is not TDD from a blank page. Before touching
it:

1. Find the seam where behavior is observable without rewriting the code.
2. Write tests that assert what the code **currently does**, including behavior
   that looks wrong. These are characterization tests: they capture actual
   behavior as a baseline, not desired behavior.
3. Run them, confirm green against the untouched code. A characterization test
   that fails immediately means the assertion, not the code, is wrong.
4. Where output is large or structured, an approval test (record the current
   output, diff future runs against the approved snapshot) captures the baseline
   faster than hand-written assertions. Review the approved file once, carefully:
   an approved snapshot of wrong output silently freezes a bug.
5. Only then start the red-green-refactor loop for the new behavior. When a
   characterization test now contradicts an intended change, updating it is a
   behavior change: it gets its own list item, its own red, and a line in the
   cycle log saying which baseline changed and why.

Record every characterization test in the test list with its own state, so the
audit can tell a captured baseline apart from a specified behavior.

## Beyond example tests: properties, contracts, approvals

Example-based tests are the default. Three step-ups are worth their cost when the
list item calls for them, and each needs the corresponding tool recorded in the
stack profile:

- **Property-based tests** for invariants that must hold across all inputs:
  round-trip (`decode(encode(x)) == x`), idempotence, commutativity, ordering,
  never-throws, conservation of totals. Write the example test first to pin one
  known case, then generalize it to the property. Always record the failing seed
  and add the shrunk counterexample to the list as its own example test, so the
  regression stays pinned even if the generator changes.
- **Contract tests** at a service or module boundary shared with another team or
  repository. The consumer's expectations become an artifact the provider
  verifies, which catches integration drift that mocks on both sides hide.
- **Approval tests** for large structured output (rendered documents, generated
  code, complex payloads) where hand-written assertions would be unreadable. One
  reviewed, committed approved file per behavior, never a directory of
  auto-accepted snapshots.

None of these replace the loop. They are the shape a particular red takes.

## Forbidden shortcuts

These are the ways a test-driven loop degrades into theater. Every one of them is
a hard stop, and `/speckit.tdd.verify` looks for each.

1. **Writing the implementation first and the test after.** The cycle is void.
   Revert the implementation, or if that is impractical, say so explicitly in the
   cycle log and mark the behavior as test-after, which the audit reports.
2. **Weakening a test to make it pass.** Loosening an assertion, widening a
   tolerance, replacing a value check with a truthiness check, or asserting the
   actual output the code happens to produce. If a test is wrong, fix it as its
   own step with a stated reason, before the implementation change.
3. **Deleting, skipping, or commenting out a failing test.** Including marking it
   pending, adding it to an exclusion list, or narrowing a test filter so it stops
   running. If a test must be retired, that is a decision to report, with the
   reason, never a step in a cycle.
4. **Assertion-free tests.** A test that calls the code and asserts nothing
   (or only that no exception was raised, where the behavior is a value) proves
   only that the code runs.
5. **Tautological tests.** Asserting a mock returns what it was configured to
   return, re-implementing the production calculation inside the test, or
   comparing the code's output to itself.
6. **Testing the implementation instead of the behavior.** Asserting private
   internals, call counts that no requirement mentions, or exact log strings.
   These break on every refactor and pass on every bug.
7. **Changing the test to match the code.** When code and test disagree, the
   specification decides which is wrong. Read `spec.md` before editing either.
8. **Broadening the run.** Coverage thresholds lowered, mutation runs scoped away
   from the changed files, a suite invoked with a filter that hides reds.

Any of these encountered in existing work is reported, not silently corrected.

## Commit cadence

One commit per completed cycle, at green. The commit contains the test and the
implementation that makes it pass, and nothing else. A structural refactor is its
own commit, with the suite unchanged.

Commit messages follow the repository's existing convention, verified from
`git log`, and name the behavior rather than the mechanics. Never commit on red.
Never commit with the suite unrun.

Whether the loop commits at all is the user's call: check the repository for an
existing convention (a `checkpoint`-style extension, a documented flow) and ask
once if it is unclear. Never commit to a shared branch, never push, never merge.

## Escape hatches

Stop the loop and report instead of improvising when:

- The stack profile's commands do not work, or the suite cannot run at all.
- The suite is red before the first cycle. Report the baseline; a loop on top of
  an already-red suite cannot prove anything.
- An acceptance criterion is ambiguous enough that two reasonable tests would
  contradict each other. Ask, with the two candidate tests as the options.
- A behavior on the list turns out to be impossible or already implemented
  elsewhere.
- Going green would require changing a test you did not write in this cycle.
- The suite is so slow that a per-cycle run is impractical. Report it, propose a
  fast subset for the inner loop plus a full run before each commit, and get
  agreement before proceeding.
- The change needs a credential, network access, or a service that is not
  available in the test environment.

Reporting a blocked loop with the evidence is a successful outcome. Guessing past
one of these is how a green suite ends up meaning nothing.
