#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

dist_dir="${1:?Installer directory is required}"
dmgs=("$dist_dir"/*.dmg)
zips=("$dist_dir"/*.zip)
if [ "${#dmgs[@]}" -ne 1 ] || [ "${#zips[@]}" -ne 1 ]; then
  echo 'Expected exactly one DMG and one ZIP installer' >&2
  exit 1
fi

verify_dir="$(mktemp -d "${TMPDIR:-/tmp}/kimi-installer-check.XXXXXX")"
mount_dir="$verify_dir/dmg"
mounted=false
cleanup() {
  if [ "$mounted" = true ]; then
    hdiutil detach "$mount_dir" >&2
  fi
}
trap cleanup EXIT

verify_app() {
  local apps=("$1"/*.app)
  if [ "${#apps[@]}" -ne 1 ] || [ ! -d "${apps[0]}" ] || [ -L "${apps[0]}" ]; then
    echo 'Expected exactly one application bundle in the installer' >&2
    return 1
  fi
  codesign --verify --deep --strict \
    -R '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists' \
    "${apps[0]}"
  xcrun stapler validate "${apps[0]}"
  spctl --assess --type execute --verbose=2 "${apps[0]}"
}

hdiutil verify "${dmgs[0]}"
mkdir "$mount_dir"
hdiutil attach -readonly -nobrowse -mountpoint "$mount_dir" "${dmgs[0]}"
mounted=true
verify_app "$mount_dir"
hdiutil detach "$mount_dir"
mounted=false

ditto -x -k "${zips[0]}" "$verify_dir/zip"
verify_app "$verify_dir/zip"
echo 'DMG and ZIP contain valid Developer ID-signed, notarized applications'
