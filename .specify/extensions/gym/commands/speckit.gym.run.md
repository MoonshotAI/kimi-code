# GYM: Run

Full training run: warmup reps grow reflexes, graded exercises prove skill under
load, and the gate opens only when every rep is grown and every exercise is passed.

## Usage

```bash
bash .specify/extensions/gym/scripts/bash/gym.sh run
# or PowerShell:
powershell .specify/extensions/gym/scripts/powershell/gym.ps1 run
```

Environment overrides:

- `GYM_EXERCISES=skip` — warmup only (alias for `speckit.gym.warmup`)
- `GYM_TIMEOUT=N` — cap the exercise wait at N seconds

## What it does

1. Loads reps from the warmup location and runs each `verify` (warmup). A failed
   rep blocks the exercises and keeps the gate closed (FR-005).
2. Loads exercises from the exercises location and, for each, waits for a
   `.submitted` marker in the sandbox, then runs `evaluate`.
3. Writes `gym/.gate` (`open`/`closed`) and exits `0` if the gate opens, `1` otherwise.

A thrown `verify`/`evaluate` is treated as a failure with the error reported
(FR-015). With no curriculum defined, the runner reports empty and treats the gate
as open (FR-012).
