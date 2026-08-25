---
name: speckit-gym-drop
description: 'Spec-kit workflow command: speckit-gym-drop'
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: github-spec-kit
  source: gym:commands/speckit.gym.drop.md
---

# GYM: Drop

Record a drop card from a mis-fire. A mis-fire is not a mistake to punish — it is a
discovery to keep. Drop cards capture what was done, what was expected, and what
happened, persisted to the configured redundant stores (default `<project>/drops/`
plus the extension's append-only `.drop-ledger.md`).

## Usage

```bash
bash .specify/extensions/gym/scripts/bash/gym.sh drop \
  --agent <you> --where "GYM ex-1" \
  --did "..." --expected "..." --happened "..."
# or PowerShell:
powershell .specify/extensions/gym/scripts/powershell/gym.ps1 drop `
  --agent <you> --where "GYM ex-1" `
  --did "..." --expected "..." --happened "..."
```

## Arguments

- `--agent` — who dropped (person or agent)
- `--where` — where in the GYM (e.g. `GYM ex-1 warmup-1`)
- `--did` — what was done
- `--expected` — what was expected
- `--happened` — what actually happened

## Result

Writes the card to each configured store and prints the recorded paths. Missing
fields are flagged but the card is still recorded (FR-010).
