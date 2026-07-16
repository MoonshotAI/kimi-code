#!/usr/bin/env bash
# Local macOS packaging + signing for kimi-code-app (arm64 only).
#
# CI 不可用时的本地替代流程。签名逻辑完全复用 CI 脚本
#（scripts/ci/macos-sign-setup.sh / macos-sign-cleanup.sh），本脚本只负责：
#   1. 前置检查（Node / pnpm / notarytool / 依赖已安装）
#   2. 把文件形式的凭证转成 CI 同款 base64 环境变量
#   3. trap 兜底执行 cleanup（本地没有 GitLab 的 after_script）
#   4. 构建 + electron-builder --arm64 打包（dmg + zip）
#   5. 验证签名 / Gatekeeper 评估 / 公证票据
#
# 凭证（仓库根 .env 或 shell export；.env 在脚本内后加载，同名变量以 .env 为准）：
#   证书：APPLE_CERTIFICATE_P12（base64）或 APPLE_CERTIFICATE_P12_FILE（.p12 路径）
#         密码 APPLE_CERTIFICATE_PASSWORD；缺省时交互式输入（不进 shell history）
#   公证：APPLE_NOTARIZATION_KEY_P8（base64）或 APPLE_NOTARIZATION_KEY_P8_FILE（.p8 路径）
#         以及 APPLE_NOTARIZATION_KEY_ID / APPLE_NOTARIZATION_ISSUER_ID
# 仓库根 .env 若存在会被自动加载（模板见 .env.example，.env 已被 gitignore）。
#
# 用法：
#   pnpm package:macos
#   或直接 bash apps/desktop/scripts/package-local-macos.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DESKTOP_DIR="$REPO_ROOT/apps/desktop"
DIST_DIR="$DESKTOP_DIR/dist-app"

# setup/cleanup 脚本用 ${CI_PROJECT_DIR:-$PWD} 定位 .ci-signing，统一在仓库根执行。
cd "$REPO_ROOT"

# 加载仓库根 .env（若存在）。set -a 让其中的赋值自动 export。
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi

# ---------------------------------------------------------------------------
# 0. 本地没有 CI 的 after_script：任何退出路径都要恢复钥匙串。
#    cleanup 脚本幂等（setup 没跑成功时直接退出 0），失败也不影响主流程退出码。
# ---------------------------------------------------------------------------
trap 'bash "$REPO_ROOT/apps/desktop/scripts/ci/macos-sign-cleanup.sh" || true' EXIT

# ---------------------------------------------------------------------------
# 1. 前置检查
# ---------------------------------------------------------------------------
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>24||(a===24&&b>=15)?0:1)' \
  || { echo "ERROR: 需要 Node >= 24.15.0（当前 $(node --version)）"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "ERROR: 未找到 pnpm"; exit 1; }
xcrun --find notarytool >/dev/null 2>&1 || { echo "ERROR: 未找到 notarytool（需要 Xcode）"; exit 1; }
[ -x "$DESKTOP_DIR/node_modules/.bin/electron-builder" ] \
  || { echo "ERROR: 依赖未安装，请先运行 pnpm install"; exit 1; }

# ---------------------------------------------------------------------------
# 2. 组装 CI 同款凭证变量（文件形式 -> base64 env）
# ---------------------------------------------------------------------------
if [ -z "${APPLE_CERTIFICATE_P12:-}${APPLE_CERTIFICATE_P12_FILE:-}" ]; then
  echo "ERROR: 需要提供 APPLE_CERTIFICATE_P12（base64）或 APPLE_CERTIFICATE_P12_FILE（.p12 路径）"
  exit 1
fi
if [ -z "${APPLE_NOTARIZATION_KEY_P8:-}${APPLE_NOTARIZATION_KEY_P8_FILE:-}" ]; then
  echo "ERROR: 需要提供 APPLE_NOTARIZATION_KEY_P8（base64）或 APPLE_NOTARIZATION_KEY_P8_FILE（.p8 路径）"
  exit 1
fi

if [ -z "${APPLE_CERTIFICATE_P12:-}" ]; then
  [ -f "$APPLE_CERTIFICATE_P12_FILE" ] \
    || { echo "ERROR: APPLE_CERTIFICATE_P12_FILE 不存在: $APPLE_CERTIFICATE_P12_FILE"; exit 1; }
  APPLE_CERTIFICATE_P12="$(base64 < "$APPLE_CERTIFICATE_P12_FILE" | tr -d '\n')"
  export APPLE_CERTIFICATE_P12
fi

if [ -z "${APPLE_NOTARIZATION_KEY_P8:-}" ]; then
  [ -f "$APPLE_NOTARIZATION_KEY_P8_FILE" ] \
    || { echo "ERROR: APPLE_NOTARIZATION_KEY_P8_FILE 不存在: $APPLE_NOTARIZATION_KEY_P8_FILE"; exit 1; }
  APPLE_NOTARIZATION_KEY_P8="$(base64 < "$APPLE_NOTARIZATION_KEY_P8_FILE" | tr -d '\n')"
  export APPLE_NOTARIZATION_KEY_P8
fi

# 提前验证可解码，避免在 setup 脚本里报晦涩的 base64 错误
printf '%s' "$APPLE_CERTIFICATE_P12" | base64 -d > /dev/null 2>&1 \
  || { echo "ERROR: APPLE_CERTIFICATE_P12 不是合法 base64（手里是 .p12 文件的话，改用 APPLE_CERTIFICATE_P12_FILE 配文件路径）"; exit 1; }
printf '%s' "$APPLE_NOTARIZATION_KEY_P8" | base64 -d > /dev/null 2>&1 \
  || { echo "ERROR: APPLE_NOTARIZATION_KEY_P8 不是合法 base64（手里是 .p8 文件的话，改用 APPLE_NOTARIZATION_KEY_P8_FILE 配文件路径）"; exit 1; }

if [ -z "${APPLE_CERTIFICATE_PASSWORD:-}" ]; then
  if [ -t 0 ]; then
    read -r -s -p "Developer ID 证书 (.p12) 密码: " APPLE_CERTIFICATE_PASSWORD
    echo
    export APPLE_CERTIFICATE_PASSWORD
  else
    echo "ERROR: APPLE_CERTIFICATE_PASSWORD 未设置，且当前非交互终端无法输入"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 3. 签名环境：临时 keychain + 身份发现 + 导出 CSC_* / APPLE_API_*
# ---------------------------------------------------------------------------
export DESKTOP_SIGN_MACOS=true
# shellcheck disable=SC1091
source "$REPO_ROOT/apps/desktop/scripts/ci/macos-sign-setup.sh"

# ---------------------------------------------------------------------------
# 4. 构建 + 打包（与 `dist` 脚本同序：build:renderer -> tsdown -> electron-builder）
# ---------------------------------------------------------------------------
pnpm --filter kimi-code-app run build:renderer
pnpm --filter kimi-code-app exec tsdown
pnpm --filter kimi-code-app exec electron-builder --config electron-builder.config.cjs --arm64

# ---------------------------------------------------------------------------
# 5. 验证：签名完整、Gatekeeper 接受、公证票据已 staple
# ---------------------------------------------------------------------------
APP="$DIST_DIR/mac-arm64/Kimi Code.app"
[ -d "$APP" ] || { echo "ERROR: 未找到产物 $APP"; exit 1; }

echo "==> codesign 验证"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "==> Gatekeeper 评估"
spctl -a -vv "$APP"

echo "==> 公证票据（app）"
xcrun stapler validate "$APP"

# dmg/zip 容器本体不签名、不附票据（与 CI 产物一致）；公证票据 staple 在
# 里面的 app 上。因此挂载 dmg，直接验证收件人实际拿到的那个 app。
shopt -s nullglob
for dmg in "$DIST_DIR"/*.dmg; do
  echo "==> dmg 验证（$(basename "$dmg")，挂载检查内部 app）"
  (
    MNT="$(mktemp -d /tmp/kimi-dmg-verify.XXXXXX)"
    trap 'hdiutil detach "$MNT" -force >/dev/null 2>&1; rmdir "$MNT" 2>/dev/null || true' EXIT
    hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$dmg" > /dev/null
    xcrun stapler validate "$MNT/Kimi Code.app"
    spctl -a -vv "$MNT/Kimi Code.app"
  )
done

echo
echo "完成。产物在 ${DIST_DIR}："
ls -lh "$DIST_DIR"/*.dmg "$DIST_DIR"/*.zip 2>/dev/null || true
