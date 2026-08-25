#!/usr/bin/env bash
#
# 把 Kimi Code Desktop（本仓 apps/desktop）的 GitHub Release 产物上传到 TOS CDN。
# 本地不留：tmp 下载 → rclone copy → rm。
#
# 用法：
#   ./publish-desktop-cdn.sh                  # 拉最新正式版 GH release（不含 prerelease）
#   ./publish-desktop-cdn.sh 0.0.3            # 指定版本（rebuild / 补传 / 回滚切指针）
#   ./publish-desktop-cdn.sh 0.0.3 --artifacts-only   # 只传版本目录，不动更新指针与下载入口
#   ./publish-desktop-cdn.sh 0.0.4-alpha.0    # alpha 版本：只切 alpha*.yml 指针，
#                                             # latest*.yml 与 download/ 保持不变
#
# 前置依赖（只在本机手动跑，TOS 凭证限内网、不进 CI）：
#   gh（已登录）、curl、rclone（配 `oss:` remote）+ mg-sts 凭证——配置方法见
#   kimi-cli-cdn-sync 仓 README 的"前置依赖"一节。
#
# CDN 布局（双 bucket，内容一致：
#   tos://kimi-code/desktop/         对外 https://code.kimi.com/kimi-code/desktop/
#   tos://kimi-code-oversea/desktop/ 对外 https://code.kimi.ai/kimi-code/desktop/）：
#   binaries/<version>/ 该版本全部产物（安装包 + blockmap + 原始 <channel>*.yml），immutable
#   binaries/<version>/changelog.{zh,en}.md
#                       更新弹窗的双语更新说明（release-notes skill 生成，仓内
#                       release-notes/<version>/ 存档），immutable；旧版本没有
#                       此文件，客户端静默降级（弹窗不显示更新说明）；alpha 版本
#                       不发 changelog
#   <version>/changelog.{zh,en}.md
#                       【过渡期，两个版本后删除】旧布局 changelog 副本：未升级
#                       的客户端仍按旧路径拉更新说明，只传 changelog 不传产物
#   latest-mac.yml      自动更新指针（mac，正式版通道），no-cache
#   latest.yml          自动更新指针（win，正式版通道），no-cache
#   latest-linux.yml    自动更新指针（linux AppImage，正式版通道），no-cache
#   alpha-mac.yml       自动更新指针（mac，alpha 通道），no-cache
#   alpha.yml           自动更新指针（win，alpha 通道），no-cache
#   alpha-linux.yml     自动更新指针（linux AppImage，alpha 通道），no-cache
#   download/           固定下载入口（官网链接，仅正式版），TOS 服务端复制当版本
#                       安装包为恒定文件名（KimiCode-mac-arm64.dmg 等），no-cache，
#                       每次正式版切流量时刷新、永远指向最新正式版
#
# electron-updater 固定轮询根目录的 <channel>*.yml（channel 烘焙在安装包内，与
# electron-builder detectUpdateChannel 同源：正式版为 latest，预发版取版本号
# prerelease 段如 alpha），并按 yml 所在 URL 相对解析安装包地址，所以指针 yml
# 里的 path/url 会被改写为带 binaries/<version>/ 前缀（yml 内的 sha512 是文件
# 内容哈希，与路径无关，改写安全）。两条通道的指针各自只被本通道的发布刷新，
# 互不触碰；alpha 版本发布只切 alpha*.yml，不刷新 download/。
#
# 上传顺序即安全：先传版本目录，后传根目录指针——传指针 = 切自动更新流量。
# 回滚 = 用旧版本号重跑本脚本（rclone copy 跳过已存在文件，等效只切回指针）。
#
# 本脚本从 kimi-cli-cdn-sync 仓迁入（2026-07）：产物格式（资产命名、latest*.yml、
# 双 arch 合并约定）由本仓 CI 定义，脚本与格式同仓演进，避免跨仓漂移。

set -euo pipefail

cd "$(dirname "$0")"


REPO="MoonshotAI/kimi-code-app"
# 两个 bucket 分属不同 region，各走各的 remote（配置见 kimi-cli-cdn-sync 仓 README "前置依赖"）
TOS_TARGETS="oss:kimi-code oss-oversea:kimi-code-oversea"
DESKTOP_PREFIX="desktop"
ARTIFACTS_PREFIX="${DESKTOP_PREFIX}/binaries"
CACHE_CONTROL_VERSIONED="public, max-age=31536000, immutable"
CACHE_CONTROL_POINTER="no-cache, max-age=0, must-revalidate"

# ---------- 解析参数 ----------

VERSION_ARG=""
ARTIFACTS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --artifacts-only) ARTIFACTS_ONLY=1 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *)
      if [ -n "$VERSION_ARG" ]; then
        echo "error: 多余参数: $arg"; exit 1
      fi
      VERSION_ARG="$arg"
      ;;
  esac
done

if [ -n "$VERSION_ARG" ]; then
  VERSION="${VERSION_ARG#v}"
  TAG="v${VERSION}"
else
  echo "==> 没传版本号，从 GitHub 拉最新正式版 release tag（不含 prerelease）"
  TAG="$(gh release list -R "$REPO" -L 1 --exclude-pre-releases --json tagName -q '.[0].tagName')"
  VERSION="${TAG#v}"
fi

# 通道与 electron-builder detectUpdateChannel 同源：版本号含 prerelease 段时
# 取该段（0.0.x-alpha.N → alpha），否则为 latest（正式版）。POINTER_FILES 是
# 本通道的自动更新指针，只有它们会被切换；另一通道的指针与 download/ 不受影响。
if [[ "$VERSION" == *-* ]]; then
  CHANNEL="${VERSION#*-}"
  CHANNEL="${CHANNEL%%.*}"
else
  CHANNEL="latest"
fi
# 限定纯小写字母：后面要插值进 jq 表达式（gh 的 --jq 不支持 --arg 传参），
# 同时防止奇葩版本号产出意外的指针文件名。
[[ "$CHANNEL" =~ ^[a-z]+$ ]] \
  || { echo "error: 无法从版本号解析更新通道: $VERSION"; exit 1; }
POINTER_FILES=("${CHANNEL}-mac.yml" "${CHANNEL}.yml" "${CHANNEL}-linux.yml")

echo "==> Tag:     $TAG"
echo "==> Version: $VERSION"
echo "==> Channel: $CHANNEL"
echo "==> Targets: $(for t in $TOS_TARGETS; do printf '%s ' "${t}/${ARTIFACTS_PREFIX}/${VERSION}/"; done)"
[ "$ARTIFACTS_ONLY" -eq 1 ] && echo "==> Mode:    artifacts-only（不动 ${CHANNEL}*.yml 指针与下载入口）"

# 更新弹窗双语 changelog 成套检测（release-notes skill 生成，仓内
# release-notes/<version>/ 存档）：不成套立即警告，让发布人尽早发现——可以
# 中断去补，也可以继续（不阻断；旧版本本来就没有 changelog，客户端静默降级/
# 单语言 fallback）。事后补传：生成后重跑本脚本 --artifacts-only。
# alpha 版本不做双语更新说明（静默降级），跳过检测。
NOTES_DIR="release-notes/${VERSION}"
if [ "$CHANNEL" = "latest" ]; then
  NOTES_MISSING=()
  for lang in zh en; do
    [ -f "${NOTES_DIR}/changelog.${lang}.md" ] || NOTES_MISSING+=("changelog.${lang}.md")
  done
  if [ "${#NOTES_MISSING[@]}" -gt 0 ]; then
    echo "==> WARNING: ${NOTES_DIR}/ 缺少 ${NOTES_MISSING[*]} —— 更新弹窗需要成套双语 changelog（release-notes skill 可生成；继续 = 本次跳过或只发半套）"
  fi
fi

# ---------- 依赖检查 ----------

command -v gh >/dev/null || { echo "error: gh CLI 未安装"; exit 1; }
command -v curl >/dev/null || { echo "error: curl 未安装"; exit 1; }
command -v rclone >/dev/null \
  || { echo "error: rclone 未安装（brew install rclone）"; exit 1; }
for remote in oss: oss-oversea:; do
  rclone listremotes | grep -q "^${remote}" \
    || { echo "error: rclone 没配 '${remote%:}' remote，参 kimi-cli-cdn-sync 仓 README '前置依赖'"; exit 1; }
done

_curl_auth_args=()
if gh_token="$(gh auth token 2>/dev/null)" && [ -n "$gh_token" ]; then
  _curl_auth_args=(-H "Authorization: Bearer ${gh_token}")
fi

_download_release_assets() {
  local asset_list="$1" dir="$2" name url dest
  while IFS=$'\t' read -r name url; do
    [ -n "$name" ] || continue
    [ -n "$url" ] || { echo "error: release asset $name is missing a download URL"; exit 1; }
    case "$name" in
      */*) echo "error: invalid release asset name: $name"; exit 1 ;;
    esac

    dest="${dir}/${name}"
    echo "==> Downloading ${name}"
    curl --fail --location --progress-bar \
      "${_curl_auth_args[@]}" \
      -H 'Accept: application/octet-stream' \
      -o "$dest" \
      "$url"
  done < "$asset_list"
}

# 指针 yml 里引用的安装包必须都在下载集合里，否则客户端更新必炸。
_check_yml_references() {
  local dir="$1" yml ref missing=0
  for yml in "${POINTER_FILES[@]}"; do
    [ -f "$dir/$yml" ] || { echo "error: $yml 没下到，release 完整吗？"; exit 1; }
    while IFS= read -r ref; do
      [ -f "$dir/$ref" ] || { echo "error: $yml 引用了不存在的 asset: $ref"; missing=1; }
    done < <(sed -nE 's/^[[:space:]]*- url: ([^ ]+)$/\1/p; s/^path: ([^ ]+)$/\1/p' "$dir/$yml" | sort -u)
  done
  [ "$missing" -eq 0 ] || exit 1
}

# 把 yml 内 path/url 的文件名改写为 binaries/<version>/ 前缀，生成根目录指针。
_rewrite_pointer_yml() {
  local src="$1" dest="$2"
  sed -E \
    -e "s|^([[:space:]]*- url: )([^ ]+)$|\1binaries\/${VERSION}/\2|" \
    -e "s|^(path: )([^ ]+)$|\1binaries\/${VERSION}/\2|" \
    "$src" > "$dest"
  grep -q "path: binaries/${VERSION}/" "$dest" \
    || { echo "error: 指针改写失败，$(basename "$src") 里没有 path: 行？"; exit 1; }
}

# ---------- 临时下载 ----------

TMP="$(mktemp -d -t kimi-desktop-release-XXXX)"
_cleanup() {
  rm -rf "$TMP"
}
trap _cleanup EXIT
echo "==> Tmp: $TMP"

ASSET_LIST="$TMP/.download-assets.tsv"

echo "==> Resolving release assets"
# gh 的 --jq 不支持 --arg，表达式里直接插值（CHANNEL 已校验为纯小写字母）。
ASSET_JQ=".assets[] | select(.name | startswith(\"KimiCode-\") or . == \"${POINTER_FILES[0]}\" or . == \"${POINTER_FILES[1]}\" or . == \"${POINTER_FILES[2]}\") | [.name, (.apiUrl // .url // .browserDownloadUrl // .browser_download_url)] | @tsv"
gh release view "$TAG" \
  -R "$REPO" \
  --json assets \
  --jq "$ASSET_JQ" \
  > "$ASSET_LIST"
[ -s "$ASSET_LIST" ] \
  || { echo "error: release 里没看到 KimiCode-* 或 ${CHANNEL}*.yml asset"; exit 1; }

echo "==> Downloading from GitHub Release $TAG"
_download_release_assets "$ASSET_LIST" "$TMP"
rm -f "$ASSET_LIST"

echo "==> Downloaded:"
ls -lh "$TMP"

ls "$TMP"/KimiCode-* >/dev/null 2>&1 \
  || { echo "error: 没看到 KimiCode-* 安装包，release 完整吗？"; exit 1; }
echo "==> Checking ${CHANNEL}*.yml asset references"
_check_yml_references "$TMP"

# ---------- 上传 ----------

echo "==> [1/2] Uploading versioned artifacts"
echo "==> Cache-Control: ${CACHE_CONTROL_VERSIONED}"
for target in $TOS_TARGETS; do
  echo ""
  echo "==> Uploading → ${target}/${ARTIFACTS_PREFIX}/${VERSION}/"
  rclone copy "$TMP/" "${target}/${ARTIFACTS_PREFIX}/${VERSION}/" \
    --exclude ".download-assets.tsv" \
    -M --metadata-set "cache-control=${CACHE_CONTROL_VERSIONED}" \
    -v --progress --stats-one-line

  # 更新弹窗双语 changelog：上传存在的语言文件（成套检测与警告已在开头做过，
  # alpha 版本没有 changelog，循环自然空转）。
  # 同时往旧布局 <version>/ 传一份副本（过渡期：未升级的客户端仍按旧路径
  # 拉 changelog；两个版本后删除 legacy 分支）。
  for lang in zh en; do
    if [ -f "${NOTES_DIR}/changelog.${lang}.md" ]; then
      for dest in "${ARTIFACTS_PREFIX}/${VERSION}" "${DESKTOP_PREFIX}/${VERSION}"; do
        echo "==> Uploading changelog.${lang}.md → ${target}/${dest}/"
        rclone copyto \
          "${NOTES_DIR}/changelog.${lang}.md" \
          "${target}/${dest}/changelog.${lang}.md" \
          -M --metadata-set "cache-control=${CACHE_CONTROL_VERSIONED}" \
          -v
      done
    fi
  done
done

if [ "$ARTIFACTS_ONLY" -eq 0 ]; then
  echo "==> [2/2] Rewriting ${CHANNEL}*.yml pointers (-> ${VERSION}/…) and uploading to prefix root"
  echo "==> Cache-Control: ${CACHE_CONTROL_POINTER}"
  POINTER_DIR="$TMP/.pointers"
  mkdir -p "$POINTER_DIR"
  for yml in "${POINTER_FILES[@]}"; do
    _rewrite_pointer_yml "$TMP/$yml" "$POINTER_DIR/$yml"
  done
  for target in $TOS_TARGETS; do
    echo ""
    echo "==> Uploading pointers → ${target}/${DESKTOP_PREFIX}/"
    rclone copy "$POINTER_DIR/" "${target}/${DESKTOP_PREFIX}/" \
      -M --metadata-set "cache-control=${CACHE_CONTROL_POINTER}" \
      -v --progress --stats-one-line
  done

  if [ "$CHANNEL" = "latest" ]; then
    # 固定下载入口（官网链接）：把当版本的安装包经 TOS 服务端复制覆盖到
    # download/，URL 恒定、永远指向最新正式版。与 latest*.yml 同属"切流量"，
    # --artifacts-only 时不刷新。两个 bucket 各自做桶内服务端复制（源是
    # [1/2] 已传的版本目录，不跨 region 走流量）。仅正式版刷新——alpha
    # 安装包走 GH Release 分发，不占用固定入口。
    echo "==> [2/2] Refreshing stable download entries at ${DESKTOP_PREFIX}/download/"
    DOWNLOAD_SUFFIXES=(
      "mac-arm64.dmg"
      "mac-x64.dmg"
      "win-x64.exe"
      "linux-x86_64.AppImage"
      "linux-amd64.deb"
    )
    for target in $TOS_TARGETS; do
      echo ""
      echo "==> Refreshing download/ → ${target}/${DESKTOP_PREFIX}/download/"
      for suffix in "${DOWNLOAD_SUFFIXES[@]}"; do
        src="KimiCode-${VERSION}-${suffix}"
        [ -f "$TMP/$src" ] || { echo "error: release 里缺 $src，固定入口中止刷新"; exit 1; }
        rclone copyto \
          "${target}/${ARTIFACTS_PREFIX}/${VERSION}/${src}" \
          "${target}/${DESKTOP_PREFIX}/download/KimiCode-${suffix}" \
          -M --metadata-set "cache-control=${CACHE_CONTROL_POINTER}" \
          -v
      done
    done
  else
    echo "==> alpha 发布：跳过 download/ 固定入口刷新（入口永远指最新正式版）"
  fi
else
  echo "==> [2/2] skipped（--artifacts-only）"
fi

echo "==> Verifying upload"
for target in $TOS_TARGETS; do
  echo "-- ${target}/${ARTIFACTS_PREFIX}/${VERSION}/"
  rclone lsf "${target}/${ARTIFACTS_PREFIX}/${VERSION}/"
done

echo ""
if [ "$ARTIFACTS_ONLY" -eq 0 ]; then
  if [ "$CHANNEL" = "latest" ]; then
    echo "✅ Published desktop ${VERSION} 并切换 latest*.yml 指针 + 固定下载入口（国内 + 海外双 bucket）"
  else
    echo "✅ Published desktop ${VERSION} 并切换 ${CHANNEL}*.yml 指针（国内 + 海外双 bucket；latest*.yml 与 download/ 未动）"
  fi
  echo ""
  echo "自查（code.kimi.com / code.kimi.ai 分别 302 到 cdn.kimi.com / cdn.kimi.ai，curl 需 -L 跟随）:"
  echo "  curl -sIL https://code.kimi.com/kimi-code/${DESKTOP_PREFIX}/${CHANNEL}-mac.yml"
  echo "  curl -sL https://code.kimi.com/kimi-code/${DESKTOP_PREFIX}/${CHANNEL}-mac.yml | grep -E '^(path|- url):'"
  echo "  curl -sIL https://code.kimi.ai/kimi-code/${DESKTOP_PREFIX}/${CHANNEL}-mac.yml"
  if [ "$CHANNEL" = "latest" ]; then
    echo "  curl -sIL https://code.kimi.com/kimi-code/${DESKTOP_PREFIX}/download/KimiCode-mac-arm64.dmg"
    echo "  curl -sIL https://code.kimi.ai/kimi-code/${DESKTOP_PREFIX}/download/KimiCode-mac-arm64.dmg"
  fi
else
  echo "✅ Published desktop ${VERSION} artifacts（指针与下载入口未动）"
  echo ""
  echo "验证 CDN 下载无误后切流量:"
  echo "  ./publish-desktop-cdn.sh ${VERSION}"
fi

# trap 自动 rm -rf $TMP
