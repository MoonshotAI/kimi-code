#!/usr/bin/env bash
# GYM runner dispatcher. Locates Node and routes to the right script.
#   gym.sh init | run | warmup | gate | drop [args]
set -euo pipefail

SCRIPT_DIR="$(CDPATH="" cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "GYM requires Node.js on PATH. Install Node >= 18 and retry." >&2
  exit 1
fi

case "${1:-run}" in
  drop)
    shift
    exec node "$SCRIPT_DIR/../drop.mjs" "$@"
    ;;
  init|run|warmup|gate)
    exec node "$SCRIPT_DIR/../gym-runner.mjs" "$@"
    ;;
  *)
    echo "Usage: gym.sh [init|run|warmup|gate|drop]" >&2
    exit 1
    ;;
esac
