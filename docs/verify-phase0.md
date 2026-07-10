# 阶段 0 验证清单

前置：`node -v` ≥ 24.15.0、`pnpm -v` = 10.33.0。两仓路径：`code-app`（`/Users/moonshot/Desktop/moonshot/code-app`）、`kimi-code-2`（`/Users/moonshot/Desktop/moonshot/kimi-code-2`，分支 `chore/split-clients-to-code-app`）。

## 1. code-app 仓（约 1-3 分钟）

```bash
cd /Users/moonshot/Desktop/moonshot/code-app

# submodule 已就绪且指针在 dist-web 快照 commit
git submodule status
# 预期：ed717fa17 kimi-code (...-5-ged717fa17)，行首空格（非 -/+）

pnpm install                       # 约 20-40s，退出 0；Scope 约 15 个项目
pnpm --filter @moonshot-ai/kimi-web run build         # vite ~8s，出 apps/web/dist/index.html
pnpm --filter @moonshot-ai/kimi-desktop run typecheck  # tsc，退出 0
pnpm --filter @moonshot-ai/kimi-desktop run build      # tsdown，出 apps/desktop/out/main.cjs

# 两个脚本链路
node apps/desktop/scripts/copy-web-dist.mjs           # → Copied web assets .../apps/desktop/web-dist
pnpm run sync:web                                    # → Synced web assets to .../kimi-code-2/apps/kimi-code/dist-web
test -f /Users/moonshot/Desktop/moonshot/kimi-code-2/apps/kimi-code/dist-web/index.html && echo OK
```

## 2. kimi-code-2 分支（约 1-2 分钟）

```bash
cd /Users/moonshot/Desktop/moonshot/kimi-code-2
git branch --show-current          # 预期：chore/split-clients-to-code-app
git log --oneline -4               # ed717fa17(dist-web) / 857c2356b(CI) / a1ad1bc89(核心) / 0ad568436(起点)

pnpm install                       # 退出 0；lockfile 已无 kimi-web/desktop（Scope ~18）

# copy-web-assets 断言三态（证明 SEA 改消费快照）
node apps/kimi-code/scripts/copy-web-assets.mjs      # → Embedded web snapshot present at .../dist-web
mv apps/kimi-code/dist-web apps/kimi-code/dist-web.bak
node apps/kimi-code/scripts/copy-web-assets.mjs      # 应报错：Embedded web snapshot was not found ...
mv apps/kimi-code/dist-web.bak apps/kimi-code/dist-web

pnpm --filter @moonshot-ai/kimi-code run build       # tsdown + copy-native-assets + 断言，退出 0

# CI 残留应为 0
grep -rn -E "apps/kimi-web|apps/kimi-desktop|desktop-build\.yml" .github/ packages/server-e2e/scripts/ AGENTS.md || echo "ZERO residual"
```

## 3. 整体一致性（秒级）

```bash
# 依赖方向：desktop 不相对 import kimi-code；kimi-code 不 import code-app
grep -rn "from 'kimi-code" /Users/moonshot/Desktop/moonshot/code-app/apps/desktop/src || echo "desktop clean"
grep -rn "code-app" /Users/moonshot/Desktop/moonshot/kimi-code-2/apps/kimi-code/src || echo "kimi-code src clean"

# code-app 里 kimi-code 是 gitlink（mode 160000）
git -C /Users/moonshot/Desktop/moonshot/code-app ls-tree HEAD kimi-code
# 预期：160000 commit ed717fa17...  kimi-code
```

## 4. 端到端（约 2-5 分钟）

```bash
# 若 SEA 还没 build（或想重 build）：
cd /Users/moonshot/Desktop/moonshot/kimi-code-2
pnpm --filter @moonshot-ai/kimi-code run build:native:sea   # 几分钟，关键看 "Collected web assets ...: 528 files"

# 起窗口（用 KIMI_SEA_PATH 指向刚 build 的 SEA，因默认 sea-path 指向未 build 的 submodule 工作树）
KIMI_SEA_PATH=/Users/moonshot/Desktop/moonshot/kimi-code-2/apps/kimi-code/dist-native/bin/darwin-arm64/kimi \
pnpm -C /Users/moonshot/Desktop/moonshot/code-app dev:desktop
# 预期：窗口出现 → loading → loadURL 到 127.0.0.1:<port> → Web UI 正常加载；关窗不杀 CLI 守护
```

## 怎么算「全过」

第 1、2 段所有命令退出 0、产物路径都存在；第 3 段三处都是 `clean` / gitlink `160000`；第 4 段窗口 Web UI 正常。

## 已知非阻塞项（不影响验证）

- `kimi-code-2/flake.nix` 的 `pnpmDeps.hash` 未回填：只影响 `nix build`，本机无 nix 可忽略（merge 前由 nix 环境/CI 回填）。
- `code-app/.gitmodules` 是本地绝对路径：只影响他人 clone / 分发，本机验证无感（分发前改 github URL）。
