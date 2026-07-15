#!/usr/bin/env bash
# macOS signing cleanup for GitLab CI — pairs with macos-sign-setup.sh.
#
# Runs in after_script (a separate shell), so it reads the state file written
# by the setup script instead of relying on exported variables. Restores the
# runner's original default keychain + user search list, then deletes the
# temporary keychain and the whole .ci-signing directory.
#
# Never fails the job: every step is best-effort.

set +e

SIGN_DIR="${CI_PROJECT_DIR:-$PWD}/.ci-signing"

if [ ! -f "$SIGN_DIR/env" ]; then
  # Signing was disabled or setup didn't get far enough — nothing to undo.
  rm -rf "$SIGN_DIR"
  exit 0
fi

# shellcheck disable=SC1090
. "$SIGN_DIR/env"

# 1. Delete the temporary keychain.
if [ -n "${KEYCHAIN_PATH:-}" ] && [ -f "$KEYCHAIN_PATH" ]; then
  security delete-keychain "$KEYCHAIN_PATH" || true
fi

# 2. Restore the original default keychain.
if [ -s "$SIGN_DIR/default-keychain.txt" ]; then
  orig_default=$(tr -d '[:space:]"' < "$SIGN_DIR/default-keychain.txt")
  if [ -n "$orig_default" ]; then
    security default-keychain -s "$orig_default" || true
  fi
fi

# 3. Restore the original user keychain search list.
if [ -s "$SIGN_DIR/keychain-list.txt" ]; then
  orig_list=""
  while IFS= read -r line; do
    kc=$(printf '%s' "$line" | tr -d '[:space:]"')
    [ -n "$kc" ] && orig_list="$orig_list $kc"
  done < "$SIGN_DIR/keychain-list.txt"
  if [ -n "$orig_list" ]; then
    # shellcheck disable=SC2086
    security list-keychains -d user -s $orig_list || true
  fi
fi

rm -rf "$SIGN_DIR"
exit 0
