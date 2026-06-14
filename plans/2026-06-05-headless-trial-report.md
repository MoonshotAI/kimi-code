# Headless Mode Trial Report

## Summary

Three side projects were created under `/tmp/kimi-headless-examples/` with headless CLI runs.

Each project used at least 10 completed headless invocations.

| Project | Completed turns | Verification |
| --- | ---: | --- |
| `headless-js-checklist` | 11 | `node --test test/*.test.js` |
| `headless-python-textstats` | 10 | `python3 -m unittest discover -s tests` |
| `headless-web-timer` | 11 | `node test.js` |

Project-level DOs and DONTs are in each project's `trial-report.md`.

## DOs

- Use `--status-file` on every long or scripted run.
- Use `headless status --file <path>` while a turn is running.
- Keep each prompt narrow.
- Use `--output-dir` so each turn leaves Markdown and metadata files.
- Keep response Markdown out of JSON for readability.
- Use one output directory per invocation.
- Run the project test command after the final turn.
- Treat stale or misleading status as a product bug, not trial noise.
- Document runtime assumptions in the generated project.

## DONTs

- Do not batch too many feature, fixture, doc, and test changes into one turn.
- Do not rely on system `node` outside the repo. It may be older than the repo-required Node version.
- Do not assume a resumed session reports a new numeric `turnId`; count completed CLI invocations for trial accounting.
- Do not ignore slow turns when the status file shows no output files yet.
- Do not treat `pause` as an immediate stop. Immediate active-turn stop belongs to `interrupt`.
- Do not leave reports to the final project check only; reports should include failures and interruptions.

## Product Notes

- Live status writes are useful. They showed active tool counts during long turns.
- The Python project exposed a signal-cleanup gap. A pre-fix interrupted process left its status file at `state: "running"`.
- After the signal cleanup fix, a SIGINT smoke exited with code `130` and wrote `state: "cancelled"` with `lastEvent: "signal.sigint"`.
- Long turns tend to happen when a prompt combines feature work, docs, and tests. Smaller follow-up prompts completed more predictably.
