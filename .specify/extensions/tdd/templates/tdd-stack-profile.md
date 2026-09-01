# Stack Profile

The loop is language agnostic because it never assumes an ecosystem. It reads
exact commands from one file, `.specify/memory/tdd-profile.md`, written once per
repository by `/speckit.tdd.setup` and verified by running each command.

A wrong profile is worse than a missing one: a single-test command that silently
runs nothing turns every red into a false green. Every command in the profile is
proven before it is written down.

## What the loop needs

Six capabilities, in priority order. The first three are required; a loop cannot
run without them. The last three raise the ceiling on what the loop can prove.

| Capability               | Used for                                                       | Required |
| ------------------------ | -------------------------------------------------------------- | -------- |
| Run one test by name     | Step 3, proving the new behavior fails in isolation            | Yes      |
| Run the whole suite      | Step 4, proving nothing else broke                             | Yes      |
| Report failures usefully | Distinguishing an assertion failure from a broken test file    | Yes      |
| Coverage                 | Finding behavior with no test at all                           | No       |
| Mutation testing         | Proving the tests would catch a bug, not just execute the code | No       |
| Property-based testing   | Expressing invariants that must hold across all inputs         | No       |

Also record, when they exist: the acceptance or end-to-end runner (the outer
loop's home), the contract-test tool, the approval or snapshot tool, and how to
run the suite in watch mode for a human following along.

Record the repository's test utilities too. They are not a capability, but a test
that hand-rolls a fixture the project already ships reads as an import from
another codebase, and the loop cannot reuse what the profile never named.

## Detection order

Detect, do not ask first. Ask only what the repository cannot answer.

1. **Read the manifests.** `package.json`, `pyproject.toml` or `setup.cfg`,
   `pom.xml` or `build.gradle(.kts)`, `*.csproj` or `*.sln`, `go.mod`,
   `Cargo.toml`, `Gemfile`, `composer.json`, `Package.swift`, `mix.exs`,
   `pubspec.yaml`, `CMakeLists.txt`. A monorepo has several: record each
   ecosystem separately with its own working directory.
2. **Read the scripts, not the docs.** A `test` script in `package.json` or a
   `Makefile` target is what CI actually runs. Prefer it over a guessed
   invocation, because it carries the flags the repo needs.
3. **Read the CI config.** `.github/workflows/*`, `.gitlab-ci.yml`, `Jenkinsfile`.
   Whatever gates merges is the authoritative suite command, including the
   environment variables it sets.
4. **Read the test layout and the utilities it already has.** Where existing
   tests live, how they are named, which assertion style and which double library
   they use. Then open the runner's own configuration and the shared fixture
   entry points, because that is where a project keeps the helpers a new test is
   expected to reuse: `conftest.py`, vitest `setupFiles`, jest
   `setupFilesAfterEnv`, a `TestBase` or `*TestCase` class, custom matchers,
   factory or object-mother modules, testcontainers and fixture-server helpers.
   Record their paths, and record one exemplar test file **per test kind** the
   stack can run. A unit exemplar says nothing about how an acceptance test is
   written when the two use different runners, and the outer loop is exactly the
   layer that must integrate correctly.
5. **Check the lock file for the tools.** A mutation or property library present in
   the lock file is available; one merely mentioned in a README is not.
6. **Run each candidate command.** A profile entry is a command that has been
   executed successfully in this repository, with its real output observed.

Record the exact working directory for each command. In a monorepo, running the
suite from the wrong directory is the most common cause of a false green.

## Ecosystem reference

Starting points, not substitutes for detection. Confirm each against the actual
repository before writing it into the profile.

| Ecosystem       | Common runners                 | Run one test by name                                                                                   | Coverage                            | Mutation               | Property based        |
| --------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------- | ---------------------- | --------------------- |
| JS and TS       | vitest, jest, node:test, mocha | `vitest run <file> -t "<name>"`, `jest <file> -t "<name>"`, `node --test --test-name-pattern "<name>"` | `--coverage`, c8, nyc               | StrykerJS              | fast-check            |
| Python          | pytest, unittest               | `pytest "<file>::<test>"`, `python -m unittest <mod>.<Class>.<test>`                                   | `pytest --cov`, coverage.py         | mutmut, cosmic-ray     | Hypothesis            |
| JVM             | JUnit 5, TestNG, Spock         | `mvn test -Dtest='<Class>#<method>'`, `gradle test --tests '<Class>.<method>'`                         | JaCoCo                              | PIT (pitest)           | jqwik                 |
| .NET            | xUnit, NUnit, MSTest           | `dotnet test --filter "FullyQualifiedName~<name>"`                                                     | coverlet                            | Stryker.NET            | FsCheck, CsCheck      |
| Go              | testing, testify               | `go test ./<pkg> -run '^<TestName>$'`                                                                  | `go test -cover`                    | gremlins, go-mutesting | rapid, gopter         |
| Rust            | cargo test, nextest            | `cargo test <name> -- --exact`, `cargo nextest run -E 'test(<name>)'`                                  | cargo-llvm-cov, tarpaulin           | cargo-mutants          | proptest, quickcheck  |
| Ruby            | RSpec, Minitest                | `rspec <file> -e "<name>"`, `ruby -Itest <file> -n "/<name>/"`                                         | SimpleCov                           | mutant                 | rantly, propcheck     |
| PHP             | PHPUnit, Pest                  | `vendor/bin/phpunit --filter '<name>'`, `vendor/bin/pest --filter '<name>'`                            | phpunit with pcov or xdebug         | Infection              | Eris                  |
| Swift           | XCTest, swift-testing          | `swift test --filter <Name>`, `xcodebuild test -only-testing:<id>`                                     | `swift test --enable-code-coverage` | muter                  | SwiftCheck            |
| Elixir          | ExUnit                         | `mix test <file>:<line>`                                                                               | `mix test --cover`, excoveralls     | muzak                  | StreamData, PropCheck |
| C and C++       | GoogleTest, Catch2, ctest      | `ctest -R '<name>'`, `<binary> --gtest_filter=<Name>`                                                  | gcov with lcov, llvm-cov            | mull, dextool          | rapidcheck            |
| Dart or Flutter | package:test, flutter_test     | `dart test -n "<name>"`, `flutter test --plain-name "<name>"`                                          | `--coverage`                        | mutation_test          | glados                |

Acceptance and end-to-end layer, where the outer loop usually lives: Playwright,
Cypress, or WebdriverIO for browsers; the framework's own HTTP test client for
APIs (supertest, TestClient, MockMvc, `httptest`, `WebApplicationFactory`,
Rack::Test); Testcontainers or Docker Compose where a real dependency is
required. Contract testing is Pact in most ecosystems, or Spring Cloud Contract on
the JVM. Approval and snapshot: Verify, ApprovalTests, insta, syrupy, jest or
vitest snapshots, goldie.

## Profile format

`.specify/memory/tdd-profile.md`. Frontmatter carries the machine-readable
commands the loop substitutes into; the body carries the conventions a test
author needs. `{file}`, `{name}`, and `{files}` are the only placeholders.

```yaml
---
detected_at: abc1234 # short SHA the profile was detected against
ecosystems: [typescript] # one entry per detected stack
default: typescript # which one the loop uses when a path is ambiguous
stacks:
  typescript:
    cwd: . # working directory every command below runs in
    runner: vitest
    single: 'pnpm vitest run {file} -t "{name}"'
    file: pnpm vitest run {file}
    suite: pnpm test
    watch: pnpm vitest
    coverage: pnpm test --coverage
    mutation: 'pnpm stryker run --mutate "{files}"'
    acceptance: pnpm playwright test {file}
    property: fast-check # library, not a command
    approval: vitest snapshots
    contract: null # absent capabilities are explicit, never omitted
    test_glob: "src/**/*.test.ts"
    exemplar: # one per test kind the stack can run, never one file for all of them
      unit: src/orders/total.test.ts
      acceptance: tests/acceptance/orders.spec.ts
    helpers: # test utilities a new test reuses instead of hand-rolling
      - src/testing/factories.ts
      - vitest.setup.ts
verified: [single, file, suite, coverage, mutation] # each was run successfully
suite_baseline: green # green | red, at detection time
suite_seconds: 34 # observed wall time of the full suite
---
```

A profile written before `exemplar` became a map records it as a single path. Read
it as the unit exemplar, say in the report that the acceptance layer has none, and
suggest `/speckit.tdd.setup refresh` rather than guessing one.

The body records what the frontmatter cannot:

```markdown
# TDD Stack Profile

## Conventions to match

- Test files sit next to the source as `<name>.test.ts`. Acceptance tests live in
  `tests/acceptance/`.
- Assertions use `expect` from vitest. Doubles use `vi.fn()`; there is no separate
  mocking library.
- Fixtures are plain factory functions in `src/testing/factories.ts`. Follow
  `makeOrder()` rather than building objects inline.
- `vitest.setup.ts` registers the custom `toBeMoney` matcher. Use it rather than
  comparing cents by hand.
- The clock is injected as a `Clock` port (`src/lib/clock.ts`). Never call
  `Date.now()` in production code or in a test.
- Exemplars to imitate: `src/orders/total.test.ts` for a unit test,
  `tests/acceptance/orders.spec.ts` for an acceptance test.

## Notes and constraints

- The suite takes 34 seconds, so per-cycle full runs are fine.
- `pnpm test` sets `TZ=UTC`; a test that relies on the local zone will pass
  locally and fail in CI.
- Mutation runs are scoped to changed files. A whole-repo run takes 20 minutes and
  is a CI job, not a loop step.
- `packages/legacy` has no tests and no runner configured. Work there needs
  characterization tests first, and the profile has no single-test command for it.
```

For a polyglot repository, add one entry per stack under `stacks:` and one
`## Conventions to match` subsection per stack. Never average two ecosystems into
one command.

## Constitution principle

TDD holds only when it survives the sessions where nobody asks for it. In
spec-kit that means the project constitution, because `/speckit.plan`,
`/speckit.tasks`, and `/speckit.implement` all read it. `/speckit.tdd.setup`
proposes this principle and applies it only with the user's approval, since the
constitution is the user's document.

```markdown
### Test-Driven Development (NON-NEGOTIABLE)

Every behavior change is driven by a test that failed first.

- A test exists and has been observed failing, for the right reason, before the
  code that makes it pass. The failure output is recorded in
  `specs/<feature>/tdd/cycle-log.md`.
- Test tasks are not optional. `tasks.md` places each behavior's test task before
  its implementation task, and the implementation task is not started until the
  test is red.
- Tests are never weakened, skipped, deleted, or filtered out to reach green. When
  a test and the code disagree, `spec.md` decides which is wrong.
- Every acceptance criterion in `spec.md` has at least one acceptance test that
  exercises the real entry point.
- Refactoring happens only on a green suite, and never changes a test in the same
  commit as a behavior change.
- Test strength is verified, not assumed: mutation testing on the changed files
  where a mutation tool exists, and a deliberate-mutant spot check where it does
  not.
```

Adapt the wording to the constitution's existing voice and numbering. Do not add a
principle that contradicts one already there; report the conflict instead.

## Verifying the profile

A command is not recorded until it has been run in this repository:

1. Run the suite command. Record the pass and fail counts and the wall time. A red
   suite is recorded as `suite_baseline: red` with the failing test names, and
   reported: the loop cannot start on top of it.
2. Run the single-test command against a **known existing test name** and confirm
   it runs exactly that test. Then run it with a name that matches nothing and
   confirm the runner says zero tests ran rather than exiting 0 silently. A
   single-test command that reports success while running nothing is the failure
   mode that voids every red in the log.
3. Run the coverage command and confirm a report is produced.
4. Run the mutation command scoped to one small file and confirm it completes.
   Record how long it took, because that determines whether the audit can use it.
5. Open every path recorded under `exemplar` and `helpers` and confirm it exists
   and is what the profile claims it is. A helper path that moved, or an exemplar
   that is itself a poor test, is copied into every test the loop writes.
6. Record only the commands that passed, in `verified:`. Anything unverified is
   recorded as `null` with a note, never as a plausible guess.

Re-verify when the profile's `detected_at` is far behind `HEAD` and the manifests
or CI config have changed since. `/speckit.tdd.setup` re-run refreshes it.

## When a capability is missing

Missing capabilities are reported, and the loop degrades in a stated way rather
than pretending.

- **No test runner at all.** This is the first thing to fix, and it is a feature's
  worth of work. Report it, propose the runner the ecosystem defaults to plus the
  one command CI would run, and stop. Do not scaffold a test framework as a side
  effect of a TDD command.
- **No single-test command.** The loop runs the whole file instead and records that
  in the cycle log. Reds stay valid but are slower to read.
- **No coverage tool.** The audit falls back to trace checking: every acceptance
  criterion must map to a named test in the test list. Report coverage as
  unmeasured rather than assumed.
- **No mutation tool.** The audit uses deliberate mutants instead: for each of the
  highest-risk behaviors, break the implementation in one small way, confirm a test
  fails, and restore the code exactly. Fewer samples, same question answered.
  Record which behaviors were sampled.
- **No property-based library.** Invariants become several example tests at the
  boundaries. Note in the test list that the invariant is sampled, not proven.
- **Suite too slow for a per-cycle run.** Record the observed time, propose a fast
  subset for the inner loop with a full run before every commit, and get agreement
  before the loop starts.
