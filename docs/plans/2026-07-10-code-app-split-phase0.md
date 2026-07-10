# code-app 阶段 0 · 拆仓地基 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `desktop` 与 `web` 从 `kimi-code` 迁入新仓 `code-app`，以 git submodule 引用 `kimi-code`，让 `code-app` 能 `pnpm install && pnpm dev:desktop` 起 Electron 壳（此阶段 server 仍 spawn SEA），同时让 `kimi-code` 的 SEA 改为消费 `code-app` 同步过来的 `dist-web` 快照。

**Architecture:** `code-app` 根 workspace 收编 `apps/*`（desktop、web）、`packages/*`（阶段 3 才用）、`kimi-code/packages/*`、`kimi-code/apps/kimi-code`；依赖方向 `code-app → kimi-code` 单向。web 源码一次性迁入 `code-app/apps/web`；CLI 内嵌 web 改为 `code-app` build web dist → 同步脚本写入 `kimi-code/apps/kimi-code/dist-web` 快照（vendoring）。

**Tech Stack:** pnpm 10.33.0 workspace、Node >=24.15.0、TypeScript 6.0.2、tsdown 0.22.0、Electron 33.4.11、Vue 3 + Vite 6（web）、git submodule。

## Global Constraints

- Node `>=24.15.0`，pnpm `10.33.0`，`.npmrc` `engine-strict=true`（Node 不符直接装不上）。
- 桌面端包名保持 `@moonshot-ai/kimi-desktop`；web 包名保持 `@moonshot-ai/kimi-web`（不改域，降低改动面）。
- desktop 只通过 `@moonshot-ai/*` 包名 import kimi-code 源码，**禁止相对路径**跨包（为将来演进按版本依赖留接口）。例外：`sea-path.ts`/`before-pack.cjs` 解析 SEA 的相对路径属运行时资源定位，不算 import。
- 提交规范：Conventional Commits（`chore:` / `feat:`）；**禁止**任何 co-author 署名、禁止出现 claude/claude code 字样。
- 本阶段**不**改 `packages/server`、`packages/agent-core`、CLI 启动逻辑（`apps/kimi-code/src/**`）。
- 验证方式：阶段 0 属基础设施/迁移，正确性以**命令 + 期望输出/产物**验证（运行即验证）；本阶段无复杂业务逻辑，不强制单元测试。

---

## 路线图总览

| 阶段 | 产出 | 状态 |
|---|---|---|
| **阶段 0 拆仓地基** | `code-app` 可 install/dev；CLI SEA 消费 dist 快照 | **本计划** |
| 阶段 1 server 内嵌 | desktop 主进程 `import { startServer }`，不再 spawn SEA | 阶段 0 验收后展开为独立 plan |
| 阶段 2 本地 renderer + IPC | `loadFile` 本地壳 + preload/IPC 注入 serverInfo | 阶段 1 验收后展开为独立 plan |
| 阶段 3 仓内抽共享包 | `packages/web-ui\|web-markdown\|web-core`，web/desktop 复用 | 阶段 2 验收后展开为独立 plan |

> 阶段 1-3 的精确 file path / 接口依赖阶段 0 落地后的真实布局，现在展开会含推测（违反 No Placeholders）。每阶段验收后，基于真实代码各写一张详细 plan。

## File Structure（阶段 0）

**code-app 仓（新建）：**
- `package.json`（根）：workspace 根脚本与共用 devDeps。
- `pnpm-workspace.yaml`：收编 `apps/*`、`packages/*`、`kimi-code/packages/*`、`kimi-code/apps/kimi-code`。
- `.npmrc`、`tsconfig.base.json`、`.gitignore`、`README.md`、`.gitmodules`（submodule 生成）。
- `apps/web/`：由 `kimi-code/apps/kimi-web` 迁入（包名 `@moonshot-ai/kimi-web` 不变）。
- `apps/desktop/`：由 `kimi-code/apps/kimi-desktop` 迁入（包名不变）；改 `tsconfig.json` extends、`src/main/sea-path.ts`、`scripts/before-pack.cjs`、`package.json` homepage；新增 `scripts/copy-web-dist.mjs`。
- `scripts/sync-web-to-kimi-code.mjs`：build web → 写入 `kimi-code/apps/kimi-code/dist-web`。

**kimi-code 仓（一个 PR，在 submodule 内改并提交到上游）：**
- 删除 `apps/kimi-web/`、`apps/kimi-desktop/`。
- `apps/kimi-code/package.json`：`build` 去掉 build web 步骤；`devDependencies` 去掉 `@moonshot-ai/kimi-web`。
- `apps/kimi-code/scripts/copy-web-assets.mjs`：重写为「断言 `dist-web` 快照存在」。
- 根 `package.json`：`scripts` 去掉 `dev:web`/`dev:desktop`，`typecheck` 去掉 kimi-web/kimi-desktop 两项。
- `flake.nix`：`workspacePaths`/`workspaceNames` 删 kimi-web/kimi-desktop；`buildPhase` 删 build kimi-web 行。
- `.github/workflows/`：`_native-build.yml` 删 build kimi-web 步骤；`desktop-build.yml` 删除（desktop 已迁出，code-app 后续自建桌面 CI）。

---

## Task 0.1：code-app 仓库骨架与首个 commit

**Files:**
- Create: `/Users/moonshot/Desktop/moonshot/code-app/.gitignore`
- Create: `/Users/moonshot/Desktop/moonshot/code-app/README.md`
- Create: `/Users/moonshot/Desktop/moonshot/code-app/LICENSE`

- [ ] **Step 1：初始化 git 并写 `.gitignore`**

在 `/Users/moonshot/Desktop/moonshot/code-app` 执行：

```bash
cd /Users/moonshot/Desktop/moonshot/code-app
git init -b main
```

写 `.gitignore`：

```gitignore
node_modules
dist
out
dist-app
resources-stage
web-dist
.DS_Store
*.log
coverage
.vite
```

- [ ] **Step 2：写 `README.md`**

```markdown
# code-app

Kimi Code 客户端仓库：桌面端（`apps/desktop`）+ Web（`apps/web`）+ 共享包（`packages/*`，阶段 3 引入）。
核心仓 [`kimi-code`](./kimi-code) 以 git submodule 引用。

## 快速开始

```bash
pnpm run sync      # 初始化/更新 submodule
pnpm install
pnpm dev:desktop   # 启动桌面端（阶段 0：主进程仍 spawn SEA）
```

## 目录

- `apps/desktop`：Electron 桌面端（`@moonshot-ai/kimi-desktop`）
- `apps/web`：浏览器 Web UI（`@moonshot-ai/kimi-web`）
- `kimi-code/`：核心仓 submodule（CLI / server / agent-core / packages）
- `docs/specs`、`docs/plans`：设计与实施计划
```

- [ ] **Step 3：写 `LICENSE`**

从 `kimi-code` 仓复制 `LICENSE`（MIT），保持版权一致：

```bash
cp /Users/moonshot/Desktop/moonshot/kimi-code-2/LICENSE /Users/moonshot/Desktop/moonshot/code-app/LICENSE
```

- [ ] **Step 4：首个 commit**

```bash
git add .gitignore README.md LICENSE
git commit -m "chore: initialize code-app repository"
```

期望：`git log --oneline` 看到一条 `chore: initialize code-app repository`。

---

## Task 0.2：添加 kimi-code submodule 并 pin

**Files:**
- Create: `/Users/moonshot/Desktop/moonshot/code-app/.gitmodules`（由 `git submodule add` 生成）
- Create: `/Users/moonshot/Desktop/moonshot/code-app/kimi-code/`（submodule 工作树）

- [ ] **Step 1：添加 submodule 并 pin 到当前 kimi-code commit**

先取 kimi-code 当前 commit：

```bash
cd /Users/moonshot/Desktop/moonshot/kimi-code-2
KIMI_REV=$(git rev-parse HEAD)
echo "$KIMI_REV"
```

回 code-app 添加 submodule（URL 用 kimi-code 的真实远端；若仅本地验证可暂用本地路径，后续改 URL）：

```bash
cd /Users/moonshot/Desktop/moonshot/code-app
git submodule add https://github.com/MoonshotAI/kimi-code.git kimi-code
cd kimi-code && git checkout "$KIMI_REV" && cd ..
```

- [ ] **Step 2：验证 submodule**

```bash
git submodule status
```

期望：输出一行 `<commit> kimi-code (heads/main 或 <tag>)`，commit 与 `$KIMI_REV` 一致；`kimi-code/packages/server/src/start.ts` 存在。

- [ ] **Step 3：加 sync 脚本到根 `package.json`**

> 根 `package.json` 在 Task 0.3 创建；此处先记下要加入的 script：`"sync": "git submodule update --init --recursive"`，Task 0.3 一并写入。

- [ ] **Step 4：commit**

```bash
cd /Users/moonshot/Desktop/moonshot/code-app
git add .gitmodules kimi-code
git commit -m "chore: add kimi-code submodule pinned at ${KIMI_REV:0:12}"
```

---

## Task 0.3：根工程化四件套 + 嵌套 workspace 实测

**Files:**
- Create: `code-app/package.json`
- Create: `code-app/pnpm-workspace.yaml`
- Create: `code-app/.npmrc`
- Create: `code-app/tsconfig.base.json`

- [ ] **Step 1：写根 `package.json`**

```json
{
  "name": "@moonshot-ai/code-app",
  "version": "0.0.0",
  "private": true,
  "license": "MIT",
  "type": "module",
  "scripts": {
    "sync": "git submodule update --init --recursive",
    "build": "pnpm -r run build",
    "dev:desktop": "pnpm --filter @moonshot-ai/kimi-desktop run dev",
    "dev:web": "pnpm --filter @moonshot-ai/kimi-web run dev",
    "sync:web": "node scripts/sync-web-to-kimi-code.mjs",
    "typecheck": "pnpm --filter @moonshot-ai/kimi-desktop run typecheck && pnpm --filter @moonshot-ai/kimi-web run typecheck",
    "lint": "oxlint --type-aware",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^22.15.3",
    "oxlint": "1.59.0",
    "oxlint-tsgolint": "0.20.0",
    "tsdown": "0.22.0",
    "tsx": "^4.21.0",
    "typescript": "6.0.2",
    "vitest": "4.1.4"
  },
  "engines": {
    "node": ">=24.15.0"
  },
  "packageManager": "pnpm@10.33.0"
}
```

- [ ] **Step 2：写 `pnpm-workspace.yaml`**

```yaml
packages:
  - apps/*
  - packages/*
  - kimi-code/packages/*
  - kimi-code/apps/kimi-code

catalog:
  zod: 4.3.6

overrides:
  "ssh2@1.17.0>cpu-features": "-"
  "ssh2@1.17.0>nan": "-"

# Allow Electron's postinstall to extract its prebuilt binary (apps/desktop).
onlyBuiltDependencies:
  - electron
```

> 注意：不收编 `kimi-code/apps/kimi-web`（web 已迁到 `apps/web`）。`kimi-code/apps/kimi-code` 收编进来，是为了阶段 1 desktop 能 import `@moonshot-ai/server` 源码（其依赖 `agent-core` 等在 `kimi-code/packages/*`）。

- [ ] **Step 3：写 `.npmrc`**

```ini
auto-install-peers=true
engine-strict=true
strict-peer-dependencies=false
```

- [ ] **Step 4：写 `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "preserve",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "lib": ["ES2023"],
    "strict": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "experimentalDecorators": true,
    "declaration": true,
    "sourceMap": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "exclude": ["node_modules", "dist", "out", "**/*.disabled/**", "**/*.disabled"]
}
```

- [ ] **Step 5：嵌套 workspace 实测（关键风险验证）**

```bash
cd /Users/moonshot/Desktop/moonshot/code-app
pnpm install
```

期望：退出码 0；根生成 `pnpm-lock.yaml`；**无** `ERR_PNPM_NESTED_WORKSPACE` 之类错误；`node_modules/@moonshot-ai/server` 为指向 `kimi-code/packages/server` 的软链（`ls -l node_modules/@moonshot-ai/server` 应指向 `../../kimi-code/packages/server`）。

若失败：记录报错，常见原因——① submodule 未 checkout（跑 `pnpm run sync`）；② Node 版本不符（`node -v` 需 ≥24.15.0）；③ `kimi-code` 自带 `pnpm-lock.yaml` 干扰（应被根忽略，若冲突可临时重命名验证）。

- [ ] **Step 6：commit**

```bash
git add package.json pnpm-workspace.yaml .npmrc tsconfig.base.json pnpm-lock.yaml
git commit -m "chore: scaffold root workspace tooling"
```

---

## Task 0.4：迁入 apps/web

**Files:**
- Create: `code-app/apps/web/**`（从 kimi-code 复制）
- Source（只读）：`kimi-code-2/apps/kimi-web/**`

> 历史处理：默认**直接复制源码**（code-app 从首个 commit 起算新历史，web 的 git 历史价值低、不值得跨仓 filter-repo）。若需保留历史，改用 `git filter-repo --subdirectory-filter apps/kimi-web` 导出再 merge 进 code-app（可选，不在本任务步骤内）。

- [ ] **Step 1：复制 web 源码到 code-app**

```bash
cd /Users/moonshot/Desktop/moonshot/code-app
mkdir -p apps
cp -R /Users/moonshot/Desktop/moonshot/kimi-code-2/apps/kimi-web apps/web
rm -rf apps/web/node_modules apps/web/dist apps/web/.vite
```

- [ ] **Step 2：验证包名与 build**

```bash
node -e "console.log(require('./apps/web/package.json').name)"
```

期望：`@moonshot-ai/kimi-web`（包名保持不变）。

```bash
pnpm --filter @moonshot-ai/kimi-web run build
```

期望：退出码 0；生成 `apps/web/dist/index.html`。

- [ ] **Step 3：commit**

```bash
git add apps/web
git commit -m "chore: import kimi-web as apps/web"
```

---

## Task 0.5：迁入 apps/desktop 并修正路径

**Files:**
- Create: `code-app/apps/desktop/**`（从 kimi-code 复制）
- Modify: `code-app/apps/desktop/tsconfig.json`
- Modify: `code-app/apps/desktop/src/main/sea-path.ts`
- Modify: `code-app/apps/desktop/scripts/before-pack.cjs`
- Modify: `code-app/apps/desktop/package.json`

**Interfaces（consumes/produces）:**
- Consumes: 根 `tsconfig.base.json`（Task 0.3）。
- Produces: `resolveSeaPath()`（阶段 0 仍被 `ensure-server.ts` 调用；阶段 1 删除）。

- [ ] **Step 1：复制 desktop 源码**

```bash
cd /Users/moonshot/Desktop/moonshot/code-app
cp -R /Users/moonshot/Desktop/moonshot/kimi-code-2/apps/kimi-desktop apps/desktop
rm -rf apps/desktop/node_modules apps/desktop/out apps/desktop/dist-app apps/desktop/resources-stage
```

- [ ] **Step 2：改 `apps/desktop/tsconfig.json`（extends 指向 base）**

完整内容：

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

- [ ] **Step 3：改 `apps/desktop/src/main/sea-path.ts`（dev 路径 + env 覆盖）**

完整内容：

```ts
import { join } from 'node:path';

import { app } from 'electron';

// The bundled backend targets the same 6 platform/arch pairs the kimi-code
// native SEA build supports (apps/kimi-code/scripts/native/native-deps.mjs).
const SUPPORTED_TARGETS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
]);

/** `<platform>-<arch>` triple for the current process, validated against the SEA targets. */
export function currentTarget(): string {
  const target = `${process.platform}-${process.arch}`;
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new Error(`No bundled Kimi server for this platform: ${target}`);
  }
  return target;
}

function executableName(): string {
  return process.platform === 'win32' ? 'kimi.exe' : 'kimi';
}

/**
 * Absolute path to the bundled SEA backend executable.
 *
 * Resolution order:
 * 1. `KIMI_SEA_PATH` env override (escape hatch for dev / custom layouts).
 * 2. packaged: `<resources>/bin/<target>/kimi[.exe]` (electron-builder extraResources).
 * 3. dev: `<code-app>/kimi-code/apps/kimi-code/dist-native/bin/<target>/kimi[.exe]`.
 *    kimi-code is a submodule at the repo root; in dev `app.getAppPath()` is
 *    `code-app/apps/desktop`, so we walk up two levels to the repo root.
 */
export function resolveSeaPath(): string {
  const override = process.env.KIMI_SEA_PATH;
  if (override) {
    return override;
  }
  const target = currentTarget();
  const exe = executableName();
  if (app.isPackaged) {
    return join(process.resourcesPath, 'bin', target, exe);
  }
  return join(app.getAppPath(), '..', '..', 'kimi-code', 'apps', 'kimi-code', 'dist-native', 'bin', target, exe);
}
```

- [ ] **Step 4：改 `apps/desktop/scripts/before-pack.cjs`（stage 路径）**

完整内容：

```js
'use strict';

// electron-builder `beforePack` hook.
//
// Each electron-builder run targets one (platform, arch). We stage the matching
// prebuilt Kimi SEA backend into `resources-stage/bin/<target>/` so that the
// `extraResources` rule copies exactly that one binary into the packaged app's
// resources. sea-path.ts resolves `<resources>/bin/<target>/kimi[.exe]` at
// runtime, where <target> is `${process.platform}-${process.arch}`.
//
// kimi-code is a git submodule at `<repoRoot>/kimi-code`; desktopRoot is
// `<repoRoot>/apps/desktop`, so the SEA lives two levels up then down into the
// submodule.

const { existsSync, rmSync, mkdirSync, cpSync } = require('node:fs');
const { join, resolve } = require('node:path');

// electron-builder Arch enum -> Node `process.arch` name.
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

exports.default = async function beforePack(context) {
  const platform = context.electronPlatformName; // 'darwin' | 'win32' | 'linux'
  const archName = ARCH_NAMES[context.arch];
  if (archName === undefined) {
    throw new Error(`Unsupported arch for packaging: ${String(context.arch)}`);
  }
  const target = `${platform}-${archName}`;
  const exe = platform === 'win32' ? 'kimi.exe' : 'kimi';

  const desktopRoot = resolve(__dirname, '..');
  const seaDir = resolve(desktopRoot, '..', '..', 'kimi-code', 'apps', 'kimi-code', 'dist-native', 'bin', target);
  const seaExe = join(seaDir, exe);
  if (!existsSync(seaExe)) {
    throw new Error(
      `Bundled Kimi server not found for ${target} at ${seaExe}. ` +
        `Build it for this platform first (inside the kimi-code submodule): ` +
        `\`pnpm -C kimi-code/apps/kimi-code build:native:sea\`.`,
    );
  }

  const stageDir = resolve(desktopRoot, 'resources-stage', 'bin', target);
  rmSync(resolve(desktopRoot, 'resources-stage'), { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  cpSync(seaDir, stageDir, { recursive: true });
  console.log(`[before-pack] staged Kimi server (${target}) -> ${stageDir}`);
};
```

- [ ] **Step 5：改 `apps/desktop/package.json`（homepage）**

把第 8 行：

```json
"homepage": "https://github.com/MoonshotAI/kimi-code",
```

改为：

```json
"homepage": "https://github.com/MoonshotAI/code-app",
```

其余字段不变（`name` 保持 `@moonshot-ai/kimi-desktop`，`devDependencies` 不变）。

- [ ] **Step 6：验证 desktop typecheck 与 build**

```bash
cd /Users/moonshot/Desktop/moonshot/code-app
pnpm --filter @moonshot-ai/kimi-desktop run typecheck
pnpm --filter @moonshot-ai/kimi-desktop run build
```

期望：typecheck 退出码 0；build 生成 `apps/desktop/out/main.cjs`。

- [ ] **Step 7：commit**

```bash
git add apps/desktop
git commit -m "chore: import kimi-desktop as apps/desktop and repoint SEA paths to submodule"
```

---

## Task 0.6：`copy-web-dist.mjs`（desktop 本地 web 产物）

**Files:**
- Create: `code-app/apps/desktop/scripts/copy-web-dist.mjs`

**Produces:** `apps/desktop/web-dist/`（阶段 1 由私有 server 的 `webAssetsDir` 托管；阶段 0 仅验证产物落地，渲染仍走 SEA origin）。

- [ ] **Step 1：写脚本（完整内容）**

```js
import { cp, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktopRoot, '../..');
const source = resolve(repoRoot, 'apps/web/dist');
const target = resolve(desktopRoot, 'web-dist');

async function assertBuiltWeb() {
  try {
    const info = await stat(resolve(source, 'index.html'));
    if (!info.isFile()) {
      throw new Error('index.html is not a file');
    }
  } catch {
    throw new Error(
      `Web build output was not found at ${source}. Run \`pnpm --filter @moonshot-ai/kimi-web run build\` first.`,
    );
  }
}

await assertBuiltWeb();
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });

console.log(`Copied web assets to ${target}`);
```

- [ ] **Step 2：验证**

```bash
cd /Users/moonshot/Desktop/moonshot/code-app
pnpm --filter @moonshot-ai/kimi-web run build
node apps/desktop/scripts/copy-web-dist.mjs
test -f apps/desktop/web-dist/index.html && echo OK
```

期望：打印 `Copied web assets to .../apps/desktop/web-dist`；`OK`。

- [ ] **Step 3：commit**

```bash
git add apps/desktop/scripts/copy-web-dist.mjs
git commit -m "feat(desktop): add copy-web-dist script to stage web assets locally"
```

---

## Task 0.7：`sync-web-to-kimi-code.mjs`（同步 web dist 到 SEA）

**Files:**
- Create: `code-app/scripts/sync-web-to-kimi-code.mjs`

**Produces:** 写入 `kimi-code/apps/kimi-code/dist-web/`（在 submodule 工作树内，需在 kimi-code 仓提交快照）。

- [ ] **Step 1：写脚本（完整内容）**

```js
import { cp, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(repoRoot, 'apps/web/dist');
const target = resolve(repoRoot, 'kimi-code/apps/kimi-code/dist-web');

async function assertBuiltWeb() {
  try {
    const info = await stat(resolve(source, 'index.html'));
    if (!info.isFile()) {
      throw new Error('index.html is not a file');
    }
  } catch {
    throw new Error(
      `Web build output was not found at ${source}. Run \`pnpm --filter @moonshot-ai/kimi-web run build\` first.`,
    );
  }
}

await assertBuiltWeb();
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });

console.log(`Synced web assets to kimi-code SEA bundle: ${target}`);
console.log('Next: commit the dist-web snapshot inside the kimi-code submodule and open a PR.');
```

- [ ] **Step 2：验证（dry-run 写 submodule，先不 commit）**

```bash
cd /Users/moonshot/Desktop/moonshot/code-app
pnpm --filter @moonshot-ai/kimi-web run build
pnpm run sync:web
test -f kimi-code/apps/kimi-code/dist-web/index.html && echo OK
```

期望：打印 `Synced web assets to ...` 与 `Next: commit...`；`OK`。

> 注意：这会修改 submodule 工作树。本任务只验证写入；**先不要在 submodule 内 commit**，dist-web 首个快照在 Task 0.10 与 kimi-code 仓改动一并提交。

- [ ] **Step 3：commit（code-app 仓）**

```bash
git add scripts/sync-web-to-kimi-code.mjs package.json
git commit -m "feat: add sync-web script to vendoring web dist into kimi-code SEA"
```

---

## Task 0.8：kimi-code 仓改动（一个 PR）

> 在 `code-app/kimi-code`（submodule）工作树内改动，并提交到 kimi-code 上游。建议先在 submodule 内切出分支：`cd kimi-code && git checkout -b chore/split-clients-to-code-app`。

**Files（均在 kimi-code 仓内）：**
- Delete: `apps/kimi-web/`、`apps/kimi-desktop/`
- Modify: `apps/kimi-code/package.json`
- Modify: `apps/kimi-code/scripts/copy-web-assets.mjs`
- Modify: 根 `package.json`
- Modify: `flake.nix`
- Modify: `.github/workflows/_native-build.yml`
- Delete: `.github/workflows/desktop-build.yml`

- [ ] **Step 1：删除迁出的两个 app**

```bash
cd /Users/moonshot/Desktop/moonshot/code-app/kimi-code
git rm -r apps/kimi-web apps/kimi-desktop
```

- [ ] **Step 2：改 `apps/kimi-code/package.json` 的 `build` 与 devDeps**

`scripts.build` 从：

```json
"build": "pnpm -C ../kimi-web run build && tsdown && node scripts/copy-native-assets.mjs && node scripts/copy-web-assets.mjs",
```

改为：

```json
"build": "tsdown && node scripts/copy-native-assets.mjs && node scripts/copy-web-assets.mjs",
```

`devDependencies` 删除一行：

```json
"@moonshot-ai/kimi-web": "workspace:^",
```

- [ ] **Step 3：重写 `apps/kimi-code/scripts/copy-web-assets.mjs` 为消费快照**

完整内容：

```js
import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(appRoot, 'dist-web');

async function assertWebSnapshot() {
  try {
    const info = await stat(resolve(target, 'index.html'));
    if (!info.isFile()) {
      throw new Error('index.html is not a file');
    }
  } catch {
    throw new Error(
      `Embedded web snapshot was not found at ${target}. ` +
        `The web app now lives in the code-app repo. Run code-app's \`pnpm run sync:web\` ` +
        `and commit the dist-web snapshot here first.`,
    );
  }
}

await assertWebSnapshot();
console.log(`Embedded web snapshot present at ${target}`);
```

- [ ] **Step 4：改根 `package.json` scripts**

删除 `dev:web`、`dev:desktop` 两行：

```json
"dev:web": "pnpm -C apps/kimi-web run dev",
"dev:desktop": "pnpm -C apps/kimi-desktop run dev",
```

`typecheck` 从：

```json
"typecheck": "pnpm run build:packages && pnpm -r --filter './packages/*' run typecheck && pnpm --filter @moonshot-ai/kimi-code run typecheck && pnpm --filter @moonshot-ai/kimi-web run typecheck && pnpm --filter @moonshot-ai/vis-server run typecheck && pnpm --filter @moonshot-ai/vis-web run typecheck && pnpm --filter @moonshot-ai/kimi-desktop run typecheck",
```

改为（去掉末尾 kimi-web 与 kimi-desktop 两项）：

```json
"typecheck": "pnpm run build:packages && pnpm -r --filter './packages/*' run typecheck && pnpm --filter @moonshot-ai/kimi-code run typecheck && pnpm --filter @moonshot-ai/vis-server run typecheck && pnpm --filter @moonshot-ai/vis-web run typecheck",
```

- [ ] **Step 5：改 `flake.nix`**

`workspacePaths` 删除两行：

```nix
./apps/kimi-desktop
./apps/kimi-web
```

`workspaceNames` 删除两行：

```nix
"@moonshot-ai/kimi-desktop"
"@moonshot-ai/kimi-web"
```

`buildPhase` 删除这一行（保留 `copy-web-assets.mjs` 断言行与 `build:native:sea`）：

```nix
pnpm --filter=@moonshot-ai/kimi-web run build
```

> `pnpmDeps.hash` 因依赖闭包改变需重算：执行 `nix build` 会报 expected/got hash 不匹配，把 got 值回填 `pnpmDeps.hash`。若本机无 nix，标注在 PR 描述里由维护者更新。

- [ ] **Step 6：改 `.github/workflows/_native-build.yml`**

定位其中「build kimi-web」步骤（约第 89-93 行，形如 `pnpm --filter @moonshot-ai/kimi-web run build` 或 `pnpm -C apps/kimi-web run build`），删除该 step；保留下载/同步 `dist-web` 之前的 SEA build 步骤。若该 workflow 显式调用 `copy-web-assets.mjs`，无需改（脚本已重写为断言）。

- [ ] **Step 7：删除 `.github/workflows/desktop-build.yml`**

```bash
git rm .github/workflows/desktop-build.yml
```

> desktop 已迁出，桌面端 CI 由 code-app 后续（阶段 1 之后）自建。

- [ ] **Step 8：在 kimi-code 仓内验证**

```bash
cd /Users/moonshot/Desktop/moonshot/code-app/kimi-code
pnpm install
pnpm --filter @moonshot-ai/kimi-code run build
```

期望：`pnpm install` 退出码 0（`apps/*` glob 自动收缩，不再匹配已删目录）；`build` 在 `copy-web-assets.mjs` 处**应失败**（因为 `dist-web` 快照尚未提交到本仓）——这是预期，证明断言生效。

然后同步快照后重试：

```bash
cd /Users/moonshot/Desktop/moonshot/code-app
pnpm run sync:web
cd kimi-code
pnpm --filter @moonshot-ai/kimi-code run build
```

期望：`copy-web-assets.mjs` 打印 `Embedded web snapshot present at .../dist-web`，build 继续通过 `tsdown`/`copy-native-assets`。

- [ ] **Step 9：commit（kimi-code 仓 / submodule）**

```bash
cd /Users/moonshot/Desktop/moonshot/code-app/kimi-code
git add -A
git commit -m "chore: move kimi-web and kimi-desktop to code-app; consume vendored web snapshot"
```

> 此 commit 落在 submodule 的检出分支上，需 push 到 kimi-code 上游并开 PR。回到 code-app 根后，`git submodule status` 会显示 submodule 指针已移动，先**不**在 code-app 提交指针——待 Task 0.10 与首个 dist-web 快照一并定指针。

---

## Task 0.9：端到端验证（阶段 0 跑通）

- [ ] **Step 1：在 kimi-code 内产出本机 SEA（供 desktop spawn）**

```bash
cd /Users/moonshot/Desktop/moonshot/code-app/kimi-code
pnpm --filter @moonshot-ai/kimi-code run build:native:sea
```

期望：生成 `kimi-code/apps/kimi-code/dist-native/bin/<target>/kimi`（`<target>` 为本机 `darwin-arm64` 等）。

- [ ] **Step 2：启动桌面端（spawn SEA，loadURL SEA origin）**

```bash
cd /Users/moonshot/Desktop/moonshot/code-app
pnpm dev:desktop
```

期望：Electron 窗口出现；先显示 loading 屏；主进程 `execFile` 起 SEA `server run`、读 `~/.kimi-code/server/lock`；随后 `loadURL(http://127.0.0.1:<port>/?kimi_desktop=1&platform=...#token=...)`；Web UI 正常加载、可创建/选择会话。

- [ ] **Step 3：验证无回归**

- 关闭桌面端，确认 CLI 守护未被杀（另一个终端 `kimi server ps` 仍能看到进程，或 `~/.kimi-code/server/lock` 对应 pid 仍活）。
- `kimi-code` 仓根 `pnpm run typecheck` 退出码 0（删 web/desktop 后）。

- [ ] **Step 4：记录**

在终端贴出：① `pnpm dev:desktop` 启动到窗口出现的日志关键行（ensureServer → origin）；② `ls kimi-code/apps/kimi-code/dist-native/bin/` 看到的 target 目录。

---

## Task 0.10：提交首个 dist-web 快照 + 阶段 0 验收

- [ ] **Step 1：在 kimi-code 仓提交 dist-web 快照**

```bash
cd /Users/moonshot/Desktop/moonshot/code-app/kimi-code
# 若 apps/kimi-code/dist-web 被 .gitignore 忽略，先确认是否需 force add：
git status --ignored apps/kimi-code/dist-web | head
git add apps/kimi-code/dist-web   # 若被忽略：git add -f apps/kimi-code/dist-web
git commit -m "chore: vendor initial web dist snapshot from code-app"
```

> 若 `dist-web` 在 kimi-code 的 `.gitignore` 内，需决定治理策略（开放点 2）：① force-add 并纳入版本（简单，体积涨）；② 改 `.gitignore` 例外 `!apps/kimi-code/dist-web/`；③ 后续改 artifact 下载。本任务默认 force-add，治理策略留 PR 讨论。

- [ ] **Step 2：回 code-app 根，更新 submodule 指针并提交**

```bash
cd /Users/moonshot/Desktop/moonshot/code-app
git add kimi-code
git commit -m "chore: bump kimi-code submodule for client split and vendored web snapshot"
```

- [ ] **Step 3：阶段 0 验收清单（全部打勾才算完成）**

- [ ] `code-app` 根 `pnpm install` 成功，根 `pnpm-lock.yaml` 生成，`node_modules/@moonshot-ai/server` 软链到 `kimi-code/packages/server`。
- [ ] `pnpm --filter @moonshot-ai/kimi-web run build` 成功出 `apps/web/dist`。
- [ ] `node apps/desktop/scripts/copy-web-dist.mjs` 成功出 `apps/desktop/web-dist`。
- [ ] `pnpm --filter @moonshot-ai/kimi-desktop run typecheck && pnpm --filter @moonshot-ai/kimi-desktop run build` 成功出 `apps/desktop/out/main.cjs`。
- [ ] `pnpm dev:desktop` 起 Electron 壳，spawn SEA、`loadURL(SEA origin)` 正常。
- [ ] `kimi-code` 仓：`apps/kimi-web`、`apps/kimi-desktop` 已删；`build:native:sea` 消费 `dist-web` 快照成功出 SEA。
- [ ] kimi-code 仓改动已开 PR；code-app 根的 submodule 指针已提交指向该 PR commit。

- [ ] **Step 4：commit 收尾（如有 README/文档更新）**

```bash
cd /Users/moonshot/Desktop/moonshot/code-app
git add docs/
git commit -m "docs: add split design and phase-0 plan"
```

---

## Self-Review（对照 spec）

**1. Spec coverage：**
- spec §3 决策「仓库归属 / 引用方式 / web 一次性搬迁 / CLI 内嵌 web 改 dist 快照」→ Tasks 0.2-0.8 覆盖。✓
- spec §6 阶段 0 全部要点（submodule、根 workspace/tsconfig、迁 desktop/web、kimi-code 删 web + 改 build/copy-web-assets/flake/workflow、sync 脚本、验证）→ Tasks 0.1-0.10 覆盖。✓
- spec §8 阶段 0 风险（嵌套 workspace、TS 解析、onlyBuiltDependencies/catalog/engine-strict 迁移、flake 手工同步）→ Task 0.3 Step 5 实测 + Task 0.8 Step 5 flake 改动覆盖；TS 解析由 Task 0.5 Step 6 typecheck 验证。✓
- spec §10 Non-goals（不改 server/core/CLI 启动、不抽共享包、不 import web 源码）→ Global Constraints 明确，本计划无相关任务。✓

**2. Placeholder scan：** 无 TBD/TODO。所有创建文件给了完整内容；kimi-code 仓修改给了修改前/后片段；workflow 改动给了路径+行号+模式（`_native-build.yml:89-93`、`desktop-build.yml` 整文件删除）。flake `pnpmDeps.hash` 重算给了明确获取方式（nix build 报错回填）。

**3. Type/path 一致性：** `resolveSeaPath()` 名与现状一致；dev 路径 `.., .., kimi-code, apps, kimi-code, dist-native, bin, target` 在 sea-path.ts 与 before-pack.cjs 两处一致；web 包名 `@moonshot-ai/kimi-web` 与 `--filter` 一致；`dist-web` 路径在 sync 脚本与 copy-web-assets 断言中一致。

**遗留开放点（移交 PR / 后续 plan）：**
- 桌面端包名是否改域（默认保持）。
- `dist-web` 进 git 的体积治理（force-add / gitignore 例外 / artifact）。
- desktop CI（原 `desktop-build.yml`）在 code-app 重建（阶段 1 之后）。

---

## Execution Handoff

Plan 已存到 `code-app/docs/plans/2026-07-10-code-app-split-phase0.md`。两种执行方式：

1. **Subagent-Driven（推荐）** — 每个 task 派一个全新的 implementer subagent 执行，task 间两阶段 review，迭代快、上下文干净。
2. **Inline Execution** — 在当前会话用 executing-plans 批量执行，checkpoint 处 review。

选哪种？
