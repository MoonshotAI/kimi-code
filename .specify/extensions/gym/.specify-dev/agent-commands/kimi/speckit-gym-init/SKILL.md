---
name: speckit-gym-init
description: 'Spec-kit workflow command: speckit-gym-init'
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: github-spec-kit
  source: gym:commands/speckit.gym.init.md
---

# GYM: Init

Scaffold a starter GYM curriculum in the current Spec Kit project so its operators
can be trained and gated.

## Usage

```bash
bash .specify/extensions/gym/scripts/bash/gym.sh init
# or PowerShell:
powershell .specify/extensions/gym/scripts/powershell/gym.ps1 init
```

## What it does

1. Creates the configured warmup and exercises directories (default `gym/` and `exercises/`).
2. Copies the example rep and example exercise from the extension's `.specify/extensions/gym/examples/` into those directories.
3. Writes `.specify/extensions/gym/gym-config.yml` from `config-template.yml` if it does not already exist.

## Result

The project now has a runnable curriculum. Edit the copied reps/exercises (or add
your own) to match YOUR software, then run `speckit.gym.warmup` or `speckit.gym.run`.

See `.specify/extensions/gym/examples/gym/01-example-rep.mjs` and `.specify/extensions/gym/examples/exercises/01-example-exercise.mjs` for the rep/exercise module shape.
