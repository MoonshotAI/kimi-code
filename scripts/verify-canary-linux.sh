#!/usr/bin/env bash
set -euo pipefail

artifact_dir="$(cd "${1:?Usage: verify-canary-linux.sh <artifact-directory>}" && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
shopt -s nullglob
for extension in AppImage deb rpm; do
  files=("$artifact_dir"/KimiCodeCanary-*-linux-*.$extension)
  [ "${#files[@]}" -eq 1 ] || { echo "Expected one Canary $extension"; exit 1; }
  case "$extension" in
    deb)
      [ "$(dpkg-deb -f "${files[0]}" Package)" = kimi-code-canary ]
      [ "$(dpkg-deb -f "${files[0]}" Architecture)" = amd64 ]
      dpkg-deb -c "${files[0]}" > "$tmp_dir/deb-files"
      dpkg-deb -e "${files[0]}" "$tmp_dir/control"
      dpkg-deb -x "${files[0]}" "$tmp_dir/deb"
      node scripts/verify-linux-resources.mjs "$tmp_dir/deb/opt/Kimi Code Canary/resources" deb
      grep -q 'kimi-code-canary' "$tmp_dir/control/postinst"
      if grep -q "'/usr/bin/kimi-code'" "$tmp_dir/control/postinst"; then
        echo "Canary installer modifies the stable executable"; exit 1
      fi
      ;;
    rpm)
      [ "$(rpm -qp --queryformat '%{NAME}' "${files[0]}")" = kimi-code-canary ]
      [ "$(rpm -qp --queryformat '%{ARCH}' "${files[0]}")" = x86_64 ]
      rpm -qpl "${files[0]}" > "$tmp_dir/rpm-files"
      mkdir "$tmp_dir/rpm"
      (cd "$tmp_dir/rpm" && rpm2cpio "${files[0]}" | cpio -idm --quiet)
      node scripts/verify-linux-resources.mjs "$tmp_dir/rpm/opt/Kimi Code Canary/resources" rpm
      ;;
    AppImage)
      chmod +x "${files[0]}"
      (cd "$tmp_dir" && "${files[0]}" --appimage-extract >/dev/null)
      node scripts/verify-linux-resources.mjs "$tmp_dir/squashfs-root/resources" AppImage
      test -f "$tmp_dir/squashfs-root/kimi-code-canary.desktop"
      grep -q 'StartupWMClass=kimi-code-canary' "$tmp_dir/squashfs-root/kimi-code-canary.desktop"
      grep -q 'Name=Kimi Code Canary' "$tmp_dir/squashfs-root/kimi-code-canary.desktop"
      ;;
  esac
done
for format in deb rpm; do
  grep -q '/usr/share/applications/kimi-code-canary.desktop' "$tmp_dir/$format-files"
  grep -q '/usr/share/metainfo/com.kimi.code.desktop.canary.metainfo.xml' "$tmp_dir/$format-files"
  if grep -Eq '/usr/share/(applications/kimi-code\.desktop|metainfo/com\.kimi\.code\.desktop\.metainfo\.xml)$' "$tmp_dir/$format-files"; then
    echo "Canary package contains stable application metadata"; exit 1
  fi
done
test -f "$artifact_dir/canary-linux.yml"
echo 'Canary Linux package identity verified'
