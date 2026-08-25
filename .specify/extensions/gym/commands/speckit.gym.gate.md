# GYM: Gate

Query the current gate state. This is the host-enforcement surface: a host (CLI,
CI, service, or the optional `before_implement` hook) queries it before letting an
operator perform the real task.

## Usage

```bash
bash .specify/extensions/gym/scripts/bash/gym.sh gate
# or PowerShell:
powershell .specify/extensions/gym/scripts/powershell/gym.ps1 gate
```

## Output

Prints `open` or `closed` to stdout and exits `0` when open, `1` when closed.

- If `gym/.gate` exists, its stored state is returned (the gate is the source of truth).
- If it does not exist yet (no run has happened), the gate is reported `closed`.

Hosts should treat `closed` as "do not proceed." Pair this with the optional
`before_implement` hook bound to `speckit.gym.gate` to block implementation until
the operator has cleared GYM.
