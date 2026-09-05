# GYM — Operator Forging (Spec Kit Extension)

Turn any software into something an operator must *wield*, not just *use*. GYM
forges operators through warmup reps that grow reflexes and graded exercises that
prove skill under load — then opens a gate only when they are ready.

Install it into any Spec Kit project and your software gets a training ground and a
gate, just like the games that force you through a tutorial before they let you play.

## Install

```bash
specify extension add gym
```

This registers the `speckit.gym.*` commands and copies `config-template.yml` to
`.specify/extensions/gym/gym-config.yml`.

## Scaffold a curriculum

```bash
bash .specify/extensions/gym/scripts/bash/gym.sh init
```

Creates `gym/` (warmup reps) and `exercises/` (graded exercises) with an example
each, plus the config. Edit those to match YOUR software.

### Authoring contract

- **Warmup rep** (`gym/*.mjs`) — exports `{ id, name, muscle, brief, verify(ctx) }`.
  `verify` returns `{ ok, note? }`; a truthy `ok` grows the muscle.
- **Graded exercise** (`exercises/*.mjs`) — exports `{ id, name, muscle, brief, evaluate(sandbox) }`.
  The runner waits for a `.submitted` marker in the sandbox, then `evaluate` returns
  `{ pass, notes? }`.

See `examples/gym/01-example-rep.mjs` (a rep exports `verify`) and
`examples/exercises/01-example-exercise.mjs` (an exercise exports `evaluate`) for the module shape.

## Run

```bash
bash .specify/extensions/gym/scripts/bash/gym.sh run
```

- Warmup reps run first. A failed rep blocks the exercises and keeps the gate closed.
- Each exercise waits for your `.submitted` marker, then grades your work.
- The gate (`gym/.gate`) opens only when every rep is grown and every exercise passed.
  Exit code is `0` when the gate opens, `1` otherwise.

Variants:

```bash
bash .specify/extensions/gym/scripts/bash/gym.sh warmup   # warmup only
GYM_EXERCISES=skip bash .../gym.sh run                    # warmup only
GYM_TIMEOUT=20     bash .../gym.sh run                    # cap exercise wait at 20s
```

## Query the gate (host enforcement)

```bash
bash .specify/extensions/gym/scripts/bash/gym.sh gate   # prints open/closed, exit 0/1
```

A host can block real work until the gate is open. The extension ships an optional
`before_implement` hook bound to `speckit.gym.gate` — enable it to require a cleared
gate before implementation.

## Drop a card on a mis-fire

```bash
bash .specify/extensions/gym/scripts/bash/gym.sh drop \
  --agent <you> --where "GYM ex-1" --did "..." --expected "..." --happened "..."
```

Records the mis-fire to the configured redundant stores (default `<project>/drops/`
and the extension's `.drop-ledger.md`). Missing fields are flagged, never dropped.

## Configuration

`.specify/extensions/gym/gym-config.yml`:

```yaml
warmup_location: gym/          # where reps live
exercises_location: exercises/ # where exercises live
exercise_timeout_sec: 60       # max wait for .submitted per exercise
warmup_only: false             # run warmup only
drop_stores:                   # redundant stores for drop cards
  - local                      #   <project>/drops/DROP-<agent>-<date>.md
  - ledger                    #   extension .drop-ledger.md (append-only)
  # - issue                   #   a GitHub issue via `gh` (best effort)
```

## Graceful degradation

- No curriculum defined → runner reports empty and treats the gate as `open`.
- Missing Node → the wrapper prints a clear requirement and exits non-zero.
- A thrown `verify`/`evaluate` → treated as a failure with the error reported; the
  runner never crashes.

## Layout

```text
.specify/extensions/gym/
├── extension.yml          # manifest (commands, optional hook, config defaults)
├── config-template.yml    # gym-config.yml defaults
├── README.md
├── commands/              # speckit.gym.{init,run,warmup,gate,drop}.md
├── scripts/
│   ├── gym-runner.mjs     # core: load → verify → evaluate → gate
│   ├── drop.mjs           # drop-card recorder
│   ├── bash/gym.sh        # dispatcher (locates Node)
│   └── powershell/gym.ps1 # dispatcher (locates Node)
└── examples/              # copied by `init` into the host project
    ├── gym/01-example-rep.mjs
    └── exercises/01-example-exercise.mjs
```
