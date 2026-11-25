#!/usr/bin/env bash
set -euo pipefail

check_commands() {
  if command -v git >/dev/null 2>&1; then
    printf 'Unexpected git on the isolated Windows Bash PATH: %s\n' "$(command -v git)" >&2
    return 1
  fi
  local cmd
  for cmd in "$@"; do
    if ! command -v "$cmd" >/dev/null; then
      printf 'Missing required Windows Bash command: %s\n' "$cmd" >&2
      return 1
    fi
  done
}

check_different_files() {
  local status=0
  diff "$1" "$2" >/dev/null || status=$?
  if (( status != 1 )); then
    printf 'diff: expected 1 for different files, got %d\n' "$status" >&2
    return 1
  fi
}

verify_runtime() {
  local marker=$1 tmp cmd
  test -x /bin/bash
  test -x /bin/sh
  check_commands cat grep sed awk gawk find sort xargs diff patch tar gzip bzip2 xz unzip which cygpath mktemp rm
  for cmd in find sort; do
    if [[ $(command -v "$cmd") != "/usr/bin/$cmd" ]]; then
      printf 'Expected bundled %s, found %s\n' "$cmd" "$(command -v "$cmd")" >&2
      return 1
    fi
  done
  test "$(cat "/tmp/$marker")" = from-windows
  tmp=$(mktemp)
  test "$tmp" -ef "/tmp/${tmp##*/}"
  printf 'alpha\nbeta\n' > "/tmp/${tmp##*/}"
  test "$(grep alpha "$tmp" | sed 's/alpha/gamma/' | awk '{print $1}')" = gamma
  printf 'alpha\n' > "$tmp.diff"
  check_different_files "$tmp" "$tmp.diff"
  rm -f "$tmp" "$tmp.diff"
  cygpath -w / >/dev/null
  for cmd in cat grep sed gawk find xargs diff patch tar gzip bzip2 xz which; do "$cmd" --version >/dev/null; done
  unzip -v >/dev/null
}

if [[ ${BASH_SOURCE[0]:-$0} == "$0" ]]; then
  verify_runtime "$@"
fi
