# GYM: Warmup

Warmup only — grow the operator's reflexes without the graded exercises. Skips
Phase 2 entirely.

## Usage

```bash
bash .specify/extensions/gym/scripts/bash/gym.sh warmup
# or PowerShell:
powershell .specify/extensions/gym/scripts/powershell/gym.ps1 warmup
```

## What it does

1. Loads reps from the warmup location and runs each `verify`.
2. Reports the board (grown / total). If every rep is grown, prints `READY (warmup)`
   and exits `0`. Otherwise exits `1`.
3. Writes `gym/.gate` as `closed` (warmup only) — the full gate is not cleared
   until a full `run` passes the exercises too.

Use this to verify reflexes quickly, or as the gating step before granting access
to a sandbox without requiring a full graded run.
