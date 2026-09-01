# TDD Extension for Spec Kit

A Spec Kit extension that makes the implementation phase test-driven, in any
language. It turns a feature's acceptance criteria into a test list, drives
red-green-refactor one behavior at a time while recording the failure that
preceded each fix, then audits the result from cold context: was the test really
first, does it assert behavior, and would it actually catch a bug.

Spec-driven development produces a good specification and then hands it to an
agent that writes code and tests together. That is where the guarantee leaks:
tests written alongside the code they check tend to pass while proving very
little, and a green suite reads as done. This extension closes that gap with
evidence rather than trust.

```
once      ->  /speckit.tdd.setup                   (the stack, proved by running it)
spec-kit  ->  /speckit.specify ... /speckit.tasks  (the specification)
plan      ->  /speckit.tdd.plan                    (criteria become a test list)
loop      ->  /speckit.tdd.run                     (red, green, refactor, logged)
rest      ->  /speckit.implement                   (whatever was not a behavior change)
audit     ->  /speckit.tdd.verify                  (evidence, smells, mutants)
```

## Documentation

The full guide lives in the **[project wiki](https://github.com/d0whc3r/spec-kit-tdd/wiki)**. This README is the front door only.

| Wiki page                                                                         | When to read                                                               |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [Home](https://github.com/d0whc3r/spec-kit-tdd/wiki/Home)                         | Overview and reading order.                                                |
| [Getting Started](https://github.com/d0whc3r/spec-kit-tdd/wiki/Getting-Started)   | First install, zero to first red-green cycle in five minutes.              |
| [Commands](https://github.com/d0whc3r/spec-kit-tdd/wiki/Commands)                 | Deep reference for the four `/speckit.tdd.*` commands and their modifiers. |
| [Workflow](https://github.com/d0whc3r/spec-kit-tdd/wiki/Workflow)                 | Where the loop sits in the spec-kit lifecycle, and the artifacts it keeps. |
| [The Loop](https://github.com/d0whc3r/spec-kit-tdd/wiki/The-Loop)                 | The discipline itself: double loop, valid reds, step size, doubles.        |
| [Test List Format](https://github.com/d0whc3r/spec-kit-tdd/wiki/Test-List-Format) | The test list and cycle log, field by field.                               |
| [Test Quality](https://github.com/d0whc3r/spec-kit-tdd/wiki/Test-Quality)         | The rubric the audit grades against, and how mutation testing is used.     |
| [Stack Profiles](https://github.com/d0whc3r/spec-kit-tdd/wiki/Stack-Profiles)     | How the extension stays language agnostic, per ecosystem.                  |
| [Examples](https://github.com/d0whc3r/spec-kit-tdd/wiki/Examples)                 | A real test list, cycle log, and verification report.                      |
| [Troubleshooting](https://github.com/d0whc3r/spec-kit-tdd/wiki/Troubleshooting)   | Common breakages, refusals, and their fixes.                               |
| [FAQ](https://github.com/d0whc3r/spec-kit-tdd/wiki/FAQ)                           | Conceptual questions, design rationale, and how it composes.               |
| [Architecture](https://github.com/d0whc3r/spec-kit-tdd/wiki/Architecture)         | What happens when you run a command.                                       |

The wiki is generated from [`docs/`](docs/) on every push to `main`. To browse the same content as plain markdown, open the [docs folder](docs/).

## At a glance

| Command               | What it does                                                                                                                               | Writes                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `/speckit.tdd.setup`  | Detects the test stack and proves each command by running it. Once per repository.                                                         | `.specify/memory/tdd-profile.md`, constitution (with approval)  |
| `/speckit.tdd.plan`   | Turns acceptance criteria and plan components into a test list, then makes the test tasks in `tasks.md` mandatory and correctly ordered.   | `tdd/test-list.md`, `tdd/cycle-log.md`, `tasks.md`              |
| `/speckit.tdd.run`    | Drives the loop: one failing test, red proven and recorded, smallest green, refactor on green, one commit.                                 | tests, source, `tdd/cycle-log.md`, ticks the tasks it completed |
| `/speckit.tdd.verify` | Audits from cold context: test-first evidence in git, test smells, mutation testing on the changed files, criteria coverage. Fails closed. | `tdd/verification.md`, remediation in `tasks.md`                |

Three hooks put the right command at the right moment. `plan` after `/speckit.tasks` and
`verify` after `/speckit.implement` both prompt and can be declined. `run` runs before
`/speckit.implement` writes anything and it waits, because a prompt at that point would
arrive after the code was already written. The loop ticks the tasks it drove, so
`/speckit.implement` covers only what is left. Disable any hook in
`.specify/extensions.yml`.

## What it enforces

- **A test exists and was seen failing before the code that satisfies it.** The
  failure output is recorded per cycle, and the audit re-checks it against git
  history rather than taking the log's word for it.
- **A red must be red for the right reason.** A test that fails on a typo, or
  passes the moment it is written, is not evidence. Both have a defined response,
  including a deliberate-mutant check.
- **Tests are never weakened to reach green.** No loosened assertion, no widened
  tolerance, no skip, no narrowed filter, no lowered threshold. When code and test
  disagree, `spec.md` decides which is wrong.
- **Test strength is measured, not assumed.** Mutation testing on the changed
  files where the ecosystem has a tool, deliberate mutants on the highest-risk
  behaviors where it does not.
- **Every acceptance criterion reaches a test through the real entry point**, not
  only units with doubles at every boundary.

## Language agnostic, on purpose

Nothing in the loop knows what ecosystem you are in. `/speckit.tdd.setup` detects
the stack from the manifests, the scripts, the CI config, and the existing test
layout, **runs each command to prove it works**, and writes them to one profile
the other commands read. That includes the check that catches the worst failure
mode: a single-test command that exits successfully while running nothing turns
every red into a false green.

Starting points are documented for JS and TS, Python, JVM, .NET, Go, Rust, Ruby,
PHP, Swift, Elixir, C and C++, and Dart, with their coverage, mutation, and
property-based tooling. Detection always wins over the table.

That is a claim worth checking rather than believing, so [the same cycle is driven
in five ecosystems](https://github.com/d0whc3r/spec-kit-tdd/wiki/Stack-Profiles#the-same-cycle-in-five-ecosystems)
side by side. The behavior text on the test list is identical in all five. Three
lines per cycle differ, and all three are quoted from the runner rather than
composed: the test reference, the red command, and the failure output.

## Install

Install directly from the latest release. This needs no catalog setup and is the recommended path:

```bash
specify extension add tdd --from https://github.com/d0whc3r/spec-kit-tdd/releases/download/v1.1.2/tdd-1.1.2.zip
```

Change the version in the URL to pin a different release.

Want to install by name with `specify extension add tdd`? That resolves the extension from Spec Kit's community catalog, which ships as discovery only (`install_allowed: false`). Approve it once:

```bash
specify extension catalog add https://raw.githubusercontent.com/github/spec-kit/main/extensions/catalog.community.json --name community --install-allowed
specify extension add tdd
```

If `specify extension add tdd` fails with `installation is not allowed from that catalog`, that is why. See [Troubleshooting](https://github.com/d0whc3r/spec-kit-tdd/wiki/Troubleshooting#installation-errors).

For prerequisites and the first-run walkthrough see [Getting Started](https://github.com/d0whc3r/spec-kit-tdd/wiki/Getting-Started).

## Composes with

This extension owns the loop and the evidence. It deliberately does not
reimplement what other Spec Kit extensions already do well, and it reads their
output where it exists: Gherkin scenarios as outer-loop behaviors, generated test
scaffolds as list items, and existing traceability or coverage-drift reports as
corroboration in the audit. See the [FAQ](https://github.com/d0whc3r/spec-kit-tdd/wiki/FAQ) for the specifics.

## Credits

The loop discipline follows established practice: the test-list-first framing of
Canon TDD (Kent Beck), double-loop or outside-in TDD for the acceptance and unit
cycles, the state-based and interaction-based schools treated as a per-behavior
choice rather than a doctrine, and mutation testing as the mechanical answer to
"do these tests actually bite". The test-smell catalogue draws on the empirical
work on smells in generated unit tests.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) at the repo root.

## License

MIT. See [LICENSE](LICENSE).
