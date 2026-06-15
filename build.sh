#!/bin/bash
# build.sh — kimi-code 빌드 및 배포 자동화
set -e
cd "$HOME/.kimi-code/src/kimi-code"

# Node.js 24.x 활성화
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 24

# 의존성 설치 및 빌드
echo "📦 Installing dependencies..."
pnpm install

echo "🔨 Building..."
pnpm build

# 빌드 산출물 확인
echo "🚀 Verifying build output..."
if [ ! -f apps/kimi-code/dist/main.mjs ]; then
  echo "❌ Build failed! main.mjs not found."
  exit 1
fi

# wrapper가 이미 올바른 경로指向하는지 확인
if [ ! -x "$HOME/.kimi-code/bin/kimi" ]; then
  echo "⚠️  Wrapper not found, creating..."
  cat > "$HOME/.kimi-code/bin/kimi" << 'WRAPPER'
#!/bin/bash
cd "$HOME/.kimi-code/src/kimi-code/apps/kimi-code"
exec node dist/main.mjs "$@"
WRAPPER
  chmod +x "$HOME/.kimi-code/bin/kimi"
fi

# 빌드 검증
echo "✅ Build complete. Testing..."
"$HOME/.kimi-code/bin/kimi" --version
