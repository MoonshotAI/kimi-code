# code-app 阶段 1 · server 内嵌（主进程 import startServer）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面端主进程 `import { startServer }` 启动**进程内私有 server**，彻底替代阶段 0 的 `execFile(SEA, ['server','run'])`，且 server 启动不阻塞 Electron 首屏。

**Architecture:** 新增 `apps/desktop/src/main/server.ts` 封装 `startDesktopServer()`：调 `@moonshot-ai/server` 的 `startServer({ host:127.0.0.1, port:0, lockPath 独立, webAssetsDir, coreProcessOptions:{identity}, serviceOverrides 中和 process.exit })`，返回 `{ origin, port, token, close }`。主进程 `index.ts` 先出窗口再异步起 server（loading 屏兜底），退出时 `close()`。server 与 CLI 守护互不影响（独立 lock、ephemeral 端口、共享 home 的 session/config/token）。删除阶段 0 的 SEA 启动链路（`ensure-server.ts` / `sea-path.ts` / `before-pack.cjs` / `extraResources bin`）。

**Tech Stack:** Electron 33.4.11、tsdown 0.22.0、`@moonshot-ai/server`（workspace 源码）、`@moonshot-ai/kimi-code-sdk`（`installGlobalProxyDispatcher`、`KimiHostIdentity`、`resolveKimiHome`）、`@electron/rebuild`（原生模块）、vitest（server.ts 单元测试）。

## Global Constraints

- Node `>=24.15.0`，pnpm `10.33.0`，`.npmrc` `engine-strict=true`。
- 桌面端包名保持 `@moonshot-ai/kimi-desktop`；只经 `@moonshot-ai/*` 包名 import，禁跨包相对路径 import。
- **私有 server 语义**：home 不覆盖（默认 `~/.kimi-code`，与 CLI 共享 session/config/token 数据）；`lockPath` 独立（`<home>/server-desktop.lock`）；`port:0` ephemeral；与 CLI 守护并行不抢锁、互不影响；桌面端退出 `close()` 只关自身实例，**不杀** CLI 守护。
- **必中和 `process.exit`**：传 `serviceOverrides: [[IServerShutdownService, { requestShutdown: async () => handle.close() }]]`，否则 `POST /api/v1/shutdown` 会杀 Electron 主进程（`start.ts:695`）。
- **必传 `coreProcessOptions.identity`**（`{ userAgentProduct: 'kimi-desktop', version: <desktopVersion> }`），否则上游 Kimi-for-Coding 40340。
- **不阻塞首屏**：先 `createWindow()` 出 loading，再异步 `startDesktopServer()`（不 `await` 在首屏关键路径上），失败 `loadURL(errorHtml)`。
- commit 用 Conventional Commits；禁止 `Co-Authored-By`；commit message/代码/文档不得出现 agent / AI 工具名称或身份信息。
- 不改 `packages/server`、`packages/agent-core`、`apps/kimi-code/src/**`（经 submodule 引用，本仓只读）。
- 测试：阶段 1 的 `server.ts` 是纯逻辑封装，用 **vitest + mock `startServer`** 做 TDD（验证 serviceOverrides / identity / 端口 / lockPath / close）；Electron 主进程集成与原生模块打包以命令 + 端到端验证。

## File Structure（阶段 1）

- Create: `apps/desktop/src/main/server.ts`（`startDesktopServer` 封装）
- Create: `apps/desktop/src/main/server.test.ts`（vitest mock `startServer`）
- Create: `apps/desktop/vitest.config.ts`
- Modify: `apps/desktop/package.json`（加 `@moonshot-ai/server`、`@moonshot-ai/kimi-code-sdk` workspace 依赖；`@electron/rebuild`、vitest devDeps；`scripts` 加 `test`、`postinstall` electron-rebuild、`prebuild` copy-web-dist）
- Modify: `apps/desktop/src/main/index.ts`（connect 改用 `startDesktopServer`、异步不阻塞首屏、退出 `close`、菜单重试重启 server；去 `ensure-server`/`resolveSeaPath` import）
- Delete: `apps/desktop/src/main/ensure-server.ts`、`apps/desktop/src/main/sea-path.ts`、`apps/desktop/scripts/before-pack.cjs`
- Modify: `apps/desktop/electron-builder.config.cjs`（去 `extraResources bin` / `beforePack`；`web-dist` 经 extraResources 进包；mac entitlements 注释更新）
- Modify: `apps/desktop/tsdown.config.ts`（原生模块 `neverBundle`；确认 `import.meta.url`/`createRequire` bundle 处理）
- Modify: `apps/desktop/AGENTS.md`（若新增）/ 根 `AGENTS.md`（阶段 0→1 状态），由收尾 task 一并

---

## Task 1.1：desktop 加依赖并验证 import 解析

**Files:**
- Modify: `apps/desktop/package.json`

- [ ] **Step 1：改 `apps/desktop/package.json` 加依赖与脚本**

在 `apps/desktop/package.json` 中：新增 `dependencies` 字段（`@moonshot-ai/server` 与 `@moonshot-ai/kimi-code-sdk` 用 `workspace:^`），`devDependencies` 追加 `@electron/rebuild` 与 `vitest`，`scripts` 追加 `test`/`postinstall`/`prebuild`。完整目标内容（合并到现有文件，保留 `name`/`version`/`private`/`license`/`description`/`author`/`homepage`/`type`/`main`）：

```json
{
  "scripts": {
    "build": "tsdown",
    "prebuild": "node scripts/copy-web-dist.mjs",
    "start": "electron .",
    "dev": "tsdown && electron .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "postinstall": "electron-rebuild",
    "dist": "tsdown && electron-builder --config electron-builder.config.cjs"
  },
  "dependencies": {
    "@moonshot-ai/kimi-code-sdk": "workspace:^",
    "@moonshot-ai/server": "workspace:^"
  },
  "devDependencies": {
    "@electron/rebuild": "3.7.1",
    "electron": "33.4.11",
    "electron-builder": "25.1.8",
    "tsdown": "0.22.0",
    "typescript": "6.0.2",
    "vitest": "4.1.4"
  }
}
```

> `electron-rebuild` 在 `postinstall` 为 Electron 重新编译原生模块（`node-pty`/`chokidar` 经 agent-core 传递）。首次 postinstall 可能较慢/需本机编译工具链；若失败，后续 Task 1.5 处理，本 task 允许先 `--ignore-scripts` 完成 install 验证 import 解析。

- [ ] **Step 2：install 并验证解析**

```bash
cd /Users/moonshot/Desktop/moonshot/code-app
pnpm install
```

期望：退出 0；`apps/desktop/node_modules/@moonshot-ai/server` 与 `.../@moonshot-ai/kimi-code-sdk` 存在（软链到 `kimi-code/packages/server`、`kimi-code/packages/node-sdk`，可用 `ls -l apps/desktop/node_modules/@moonshot-ai/server` 确认）。若 `electron-rebuild` postinstall 失败导致 install 非 0，临时 `pnpm install --ignore-scripts` 完成本 task 的 import 解析验证，并在报告记录 electron-rebuild 留 Task 1.5。

- [ ] **Step 3：验证 import 解析（typecheck）**

```bash
pnpm --filter @moonshot-ai/kimi-desktop run typecheck
```

期望：退出 0（`@moonshot-ai/server`、`@moonshot-ai/kimi-code-sdk` 的 `exports→src` 被 tsdown/bundler 解析；本 task 尚无新 import，仅确认依赖就位不破坏 typecheck）。

- [ ] **Step 4：commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml
git commit -m "feat(desktop): add @moonshot-ai/server and kimi-code-sdk deps for in-process server"
```

---

## Task 1.2：`server.ts` 封装（TDD）

**Files:**
- Create: `apps/desktop/src/main/server.ts`
- Create: `apps/desktop/src/main/server.test.ts`
- Create: `apps/desktop/vitest.config.ts`

**Interfaces:**
- Consumes: `@moonshot-ai/server` 的 `startServer` / `IServerShutdownService` / `createServerLogger`；`@moonshot-ai/kimi-code-sdk` 的 `installGlobalProxyDispatcher` / `resolveKimiHome` / `KimiHostIdentity`。
- Produces: `startDesktopServer(opts): Promise<DesktopServerHandle>`，其中 `DesktopServerHandle = { origin: string; port: number; token: string | undefined; close(): Promise<void> }`。Task 1.3 的 `index.ts` 用它。

- [ ] **Step 1：写失败测试 `server.test.ts`**

`vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

`apps/desktop/src/main/server.test.ts`（完整）：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const SHUTDOWN_ID = { _serviceBrand: undefined, id: 'IServerShutdownService' };
const startServerMock = vi.fn();
const installProxyMock = vi.fn();

vi.mock('@moonshot-ai/server', () => ({
  startServer: startServerMock,
  createServerLogger: vi.fn(),
  IServerShutdownService: SHUTDOWN_ID,
  serverTokenPath: () => '/tmp/kimi-test/server.token',
}));
vi.mock('@moonshot-ai/kimi-code-sdk', () => ({
  installGlobalProxyDispatcher: installProxyMock,
  resolveKimiHome: () => '/tmp/kimi-test',
}));

import { startDesktopServer } from './server';

describe('startDesktopServer', () => {
  beforeEach(() => {
    startServerMock.mockReset();
    installProxyMock.mockReset();
  });

  it('wires startServer with loopback, ephemeral port, independent lock, identity, shutdown override (no process.exit), webAssetsDir; calls installGlobalProxyDispatcher; returns origin/port/close', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    startServerMock.mockResolvedValue({
      address: '127.0.0.1:54321',
      logger: {},
      services: {},
      close,
    });

    const handle = await startDesktopServer({
      webAssetsDir: '/app/web-dist',
      identity: { userAgentProduct: 'kimi-desktop', version: '1.2.3' },
    });

    expect(installProxyMock).toHaveBeenCalledOnce();
    expect(startServerMock).toHaveBeenCalledOnce();
    const args = startServerMock.mock.calls[0][0];
    expect(args.host).toBe('127.0.0.1');
    expect(args.port).toBe(0);
    expect(args.lockPath).toMatch(/server-desktop\.lock$/);
    expect(args.webAssetsDir).toBe('/app/web-dist');
    expect(args.coreProcessOptions.identity).toEqual({
      userAgentProduct: 'kimi-desktop',
      version: '1.2.3',
    });

    // shutdown override neutralises process.exit and calls close
    expect(Array.isArray(args.serviceOverrides)).toBe(true);
    expect(args.serviceOverrides).toHaveLength(1);
    expect(args.serviceOverrides[0][0]).toBe(SHUTDOWN_ID);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit must not be called');
    });
    await args.serviceOverrides[0][1].requestShutdown('test');
    expect(close).toHaveBeenCalledOnce();
    exitSpy.mockRestore();

    expect(handle.origin).toBe('http://127.0.0.1:54321');
    expect(handle.port).toBe(54321);
    await handle.close();
    expect(close).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2：跑测试确认失败**

```bash
cd /Users/moonshot/Desktop/moonshot/code-app
pnpm --filter @moonshot-ai/kimi-desktop run test
```

期望：FAIL，`Cannot find module './server'` 或 `startDesktopServer is not a function`。

- [ ] **Step 3：写最小实现 `server.ts`**

`apps/desktop/src/main/server.ts`（完整）：

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  startServer,
  createServerLogger,
  IServerShutdownService,
  serverTokenPath,
  type RunningServer,
} from '@moonshot-ai/server';
import {
  installGlobalProxyDispatcher,
  resolveKimiHome,
  type KimiHostIdentity,
} from '@moonshot-ai/kimi-code-sdk';

export interface DesktopServerHandle {
  readonly origin: string;
  readonly port: number;
  readonly token: string | undefined;
  readonly close: () => Promise<void>;
}

export interface StartDesktopServerOptions {
  /** Directory that holds the built web UI (`apps/desktop/web-dist` in dev, `<resources>/web-dist` packaged). */
  readonly webAssetsDir: string;
  /** Host identity required upstream (Kimi-for-Coding rejects without it, 40340). */
  readonly identity: KimiHostIdentity;
  readonly logger?: ReturnType<typeof createServerLogger>;
}

const DESKTOP_LOCK_FILE = 'server-desktop.lock';

function desktopLockPath(): string {
  return join(resolveKimiHome(), DESKTOP_LOCK_FILE);
}

function toOrigin(address: string): string {
  return address.startsWith('http://') || address.startsWith('https://')
    ? address
    : `http://${address}`;
}

function parsePort(address: string): number {
  const idx = address.lastIndexOf(':');
  if (idx === -1) return 0;
  const n = Number(address.slice(idx + 1));
  return Number.isFinite(n) ? n : 0;
}

function readServerToken(): string | undefined {
  try {
    const token = readFileSync(serverTokenPath(), 'utf-8').trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Start an in-process Kimi server for the desktop host.
 *
 * - Loopback only, ephemeral port (`port: 0`), independent lock file so it never
 *   races the CLI daemon's `<home>/server/lock`.
 * - Neutralises the shutdown route's `process.exit` via `serviceOverrides` so a
 *   `/api/v1/shutdown` request cannot terminate the Electron main process.
 * - Returns once the HTTP server is listening (does not block the caller).
 */
export async function startDesktopServer(
  opts: StartDesktopServerOptions,
): Promise<DesktopServerHandle> {
  installGlobalProxyDispatcher();

  let handle: RunningServer | undefined;
  const shutdownOverride = {
    _serviceBrand: undefined,
    requestShutdown: async (_reason: string) => {
      if (handle !== undefined) {
        await handle.close();
      }
    },
  };

  handle = await startServer({
    host: '127.0.0.1',
    port: 0,
    logger: opts.logger,
    lockPath: desktopLockPath(),
    webAssetsDir: opts.webAssetsDir,
    coreProcessOptions: { identity: opts.identity },
    serviceOverrides: [[IServerShutdownService, shutdownOverride]],
  });

  return {
    origin: toOrigin(handle.address),
    port: parsePort(handle.address),
    token: readServerToken(),
    close: () => handle!.close(),
  };
}
```

- [ ] **Step 4：跑测试确认通过**

```bash
pnpm --filter @moonshot-ai/kimi-desktop run test
```

期望：PASS，1 个 test 全过。

- [ ] **Step 5：commit**

```bash
git add apps/desktop/src/main/server.ts apps/desktop/src/main/server.test.ts apps/desktop/vitest.config.ts
git commit -m "feat(desktop): add startDesktopServer with shutdown-exit neutralisation"
```

---

## Task 1.3：主进程 `index.ts` 接入进程内 server

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Delete: `apps/desktop/src/main/ensure-server.ts`

**Interfaces:**
- Consumes: `startDesktopServer` / `DesktopServerHandle`（Task 1.2）；`app.getVersion()`（Electron，identity version）。
- Produces: 无（主进程接线）。

- [ ] **Step 1：改 import（替换 ensure-server/sea-path）**

把 `index.ts:7-8`：

```ts
import { ensureServer, kimiHome, serverLogPath } from './ensure-server';
import { resolveSeaPath } from './sea-path';
```

改为：

```ts
import { join } from 'node:path';
import { startDesktopServer, type DesktopServerHandle } from './server';
```

> `kimiHome`/`serverLogPath` 仍由错误屏/菜单使用，改从 `server.ts` 同源取不重复——见 Step 2 用 `resolveKimiHome`（`@moonshot-ai/kimi-code-sdk`）替代 `kimiHome`，`serverLogPath` 用 `join(resolveKimiHome(), 'server', 'server.log')`。在 `index.ts` 顶部追加 import：`import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';`，并加局部 helper：
> ```ts
> function serverLogPath(): string {
>   return join(resolveKimiHome(), 'server', 'server.log');
> }
> ```
> `node:path` 的 `join` 已在原 import（`index.ts:2`），复用即可（Step 1 的 `import { join }` 若与原有重复，合并到原 `node:path` import，不要重复 import 语句）。

- [ ] **Step 2：加 server 句柄 + webAssetsDir 解析**

在 `index.ts` 顶部 `let mainWindow` 之后加：

```ts
let serverHandle: DesktopServerHandle | null = null;

function webAssetsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'web-dist')
    : join(app.getAppPath(), 'web-dist');
}
```

- [ ] **Step 3：重写 `connect(win)`（异步、不阻塞首屏、私有 origin）**

替换 `index.ts:119-144` 整个 `connect`：

```ts
async function connect(win: BrowserWindow): Promise<void> {
  await win.loadURL(dataUrl(loadingHtml()));
  try {
    serverHandle?.close().catch(() => {});
    serverHandle = await startDesktopServer({
      webAssetsDir: webAssetsDir(),
      identity: { userAgentProduct: 'kimi-desktop', version: app.getVersion() },
    });
    const { origin, token } = serverHandle;
    process.stdout.write(`[kimi-desktop] connected to ${origin}\n`);
    if (!win.isDestroyed()) {
      const fragment = token === undefined ? '' : `#token=${encodeURIComponent(token)}`;
      await win.loadURL(
        `${origin}/?kimi_desktop=1&platform=${process.platform}${fragment}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[kimi-desktop] startDesktopServer failed: ${message}\n`);
    if (!win.isDestroyed()) {
      await win.loadURL(dataUrl(errorHtml(message)));
    }
  }
}
```

> 删除原 `readServerToken` 函数（`index.ts:108-115`）与 `SERVER_TOKEN_FILE` 常量（`index.ts:101`）——token 改由 `server.ts` 的 `readServerToken` 经 `serverTokenPath` 提供。

- [ ] **Step 4：退出时 `close()`（不杀 CLI 守护）**

替换 `index.ts:295-314` 的 `main` 内 `window-all-closed` 段，并在 `whenReady` 前注册退出钩子：

```ts
function main(): void {
  app.on('before-quit', () => {
    void serverHandle?.close();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  void app.whenReady().then(() => {
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}
```

> 删除原 `index.ts:296-298` 那段「shared daemon left running on quit」注释（私有 server 随桌面端退出而 close，不再共享 CLI 守护；CLI 守护不受影响）。

- [ ] **Step 5：删 `ensure-server.ts` + typecheck + test**

```bash
cd /Users/moonshot/Desktop/moonshot/code-app
git rm apps/desktop/src/main/ensure-server.ts
pnpm --filter @moonshot-ai/kimi-desktop run typecheck
pnpm --filter @moonshot-ai/kimi-desktop run test
```

期望：typecheck 退出 0；test PASS（Task 1.2 的测试不受影响）。

- [ ] **Step 6：commit**

```bash
git add apps/desktop/src/main/index.ts
git commit -m "feat(desktop): start in-process server from main, drop SEA spawn"
```

---

## Task 1.4：去 SEA 分发 + web-dist 进包

**Files:**
- Modify: `apps/desktop/electron-builder.config.cjs`
- Delete: `apps/desktop/src/main/sea-path.ts`、`apps/desktop/scripts/before-pack.cjs`

- [ ] **Step 1：删 SEA 相关文件**

```bash
cd /Users/moonshot/Desktop/moonshot/code-app
git rm apps/desktop/src/main/sea-path.ts apps/desktop/scripts/before-pack.cjs
```

- [ ] **Step 2：改 `electron-builder.config.cjs`**

修改三处：
- 删 `beforePack: './scripts/before-pack.cjs',`（`electron-builder.config.cjs:49`）。
- `extraResources: [{ from: 'resources-stage/bin', to: 'bin' }]`（`:50`）改为 `extraResources: [{ from: 'web-dist', to: 'web-dist' }]`（web-dist 由 `prebuild` 的 `copy-web-dist.mjs` 在 `apps/desktop/web-dist` 生成，packaged 时 `startServer.webAssetsDir = <resources>/web-dist`）。
- 顶部注释里「including the bundled Kimi SEA backend」「Mirrors the TUI's native entitlements」改为「including native `.node` modules loaded by the in-process server」。

`files` 保持 `['out/**', 'package.json']`（主进程 bundle 在 `out/main.cjs`，含 tsdown bundle 的 server/core；原生 `.node` 经 Task 1.5 asarUnpack）。

- [ ] **Step 3：验证 typecheck + build**

```bash
pnpm --filter @moonshot-ai/kimi-desktop run typecheck
pnpm --filter @moonshot-ai/kimi-desktop run build
```

期望：typecheck 0；build 出 `apps/desktop/out/main.cjs`（`prebuild` 先跑 copy-web-dist 出 `apps/desktop/web-dist/index.html`）。

- [ ] **Step 4：commit**

```bash
git add apps/desktop/electron-builder.config.cjs
git commit -m "chore(desktop): stop bundling SEA; ship web-dist via extraResources"
```

---

## Task 1.5：原生模块与 tsdown 打包

**Files:**
- Modify: `apps/desktop/tsdown.config.ts`
- Modify: `apps/desktop/electron-builder.config.cjs`（asarUnpack）

- [ ] **Step 1：改 `tsdown.config.ts`（原生模块不 bundle）**

替换为：

```ts
import { defineConfig } from 'tsdown';

// Electron main process is CommonJS (`out/main.cjs`). Native modules loaded via
// agent-core (`node-pty`, optional clipboard/koffi) must stay external so
// Electron loads the rebuilt `.node` binaries at runtime (see asarUnpack).
export default defineConfig({
  entry: { main: 'src/main/index.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  outDir: 'out',
  clean: true,
  dts: false,
  fixedExtension: true,
  deps: {
    neverBundle: [
      'electron',
      'node-pty',
      '@mariozechner/clipboard',
      '@mariozechner/clipboard-darwin-arm64',
      '@mariozechner/clipboard-darwin-x64',
      '@mariozechner/clipboard-win32-x64',
      '@mariozechner/clipboard-linux-x64',
      '@mariozechner/clipboard-linux-arm64',
      'koffi',
    ],
  },
});
```

- [ ] **Step 2：electron-builder `asarUnpack` 原生模块**

在 `electron-builder.config.cjs` 顶层配置（`module.exports` 对象）追加：

```js
  asarUnpack: [
    'node_modules/node-pty/**',
    'node_modules/@mariozechner/clipboard*/**',
    'node_modules/koffi/**',
  ],
```

- [ ] **Step 3：验证 build（处理 import.meta.url / createRequire）**

```bash
pnpm --filter @moonshot-ai/kimi-desktop run build
```

期望：tsdown 成功出 `out/main.cjs`。若报 `import.meta` / `createRequire` 相关错误（来自 `@moonshot-ai/server` 的 `svc/program.ts`、`version.ts`）：(a) 确认 tsdown/rolldown 对 CJS 的 `import.meta.url` shim 生效；(b) 若仍失败，在 `tsdown.config.ts` 加 `alias` 把 `@moonshot-ai/server` 的 `svc` 入口指空 stub（`resolveServiceManager` 嵌入场景用不到），或 `deps.neverBundle` 追加 `@moonshot-ai/server` 并依赖 node_modules 解析（不推荐，会让 server 不进 bundle）。记录采用哪种，写进报告。

- [ ] **Step 4：typecheck + test**

```bash
pnpm --filter @moonshot-ai/kimi-desktop run typecheck
pnpm --filter @moonshot-ai/kimi-desktop run test
```

期望：typecheck 0；test PASS。

- [ ] **Step 5：commit**

```bash
git add apps/desktop/tsdown.config.ts apps/desktop/electron-builder.config.cjs
git commit -m "build(desktop): externalise native modules and asarUnpack for in-process server"
```

---

## Task 1.6：端到端验证（私有 server）

- [ ] **Step 1：启动桌面端**

```bash
cd /Users/moonshot/Desktop/moonshot/code-app
pnpm dev:desktop
```

期望：Electron 窗口立即出现（loading 屏，**不**等 server）；主进程异步 `startDesktopServer`；数毫-数秒后 `loadURL(http://127.0.0.1:<ephemeral>/?kimi_desktop=1&platform=...#token=...)`；Web UI 正常加载（由私有 server 的 `webAssetsDir` 托管）、可选/建会话。终端打印 `[kimi-desktop] connected to http://127.0.0.1:<port>`。

- [ ] **Step 2：验证与 CLI 守护并存不抢锁**

另起终端：
```bash
cd /Users/moonshot/Desktop/moonshot/kimi-code-2
node apps/kimi-code/dist-native/bin/darwin-arm64/kimi server run   # 或已运行的 CLI 守护
```

期望：CLI 守护（`<home>/server/lock`，端口 58627±）与桌面端私有 server（`<home>/server-desktop.lock`，ephemeral 端口）并存，互不 `ServerLockedError`；两个 lock 文件同在 `~/.kimi-code/`。`ls ~/.kimi-code/` 应见 `server.lock`（CLI）与 `server-desktop.lock`（桌面端）并存（lock 文件名以实际为准：CLI 用 `server/lock`，桌面端用 `server-desktop.lock`）。

- [ ] **Step 3：验证退出不杀 CLI 守护**

关闭桌面端窗口/退出应用。期望：`before-quit` 调 `serverHandle.close()`，桌面端私有 server 关闭；CLI 守护仍运行（`node .../kimi server ps` 或 `~/.kimi-code/server/lock` 对应 pid 仍活）。

- [ ] **Step 4：（可选）dist 出包 sanity**

```bash
pnpm --filter @moonshot-ai/kimi-desktop run dist
```

期望：electron-builder 出安装包到 `apps/desktop/dist-app/`（mac dmg/zip）；asar 内 `out/main.cjs`，`web-dist` 与原生 `.node` 经 asarUnpack 落地。本步耗时且 macOS 可能触发签名/公证（未配置则本地未签名），失败不阻塞阶段 1（属打包发布，阶段 1 重点是主进程内嵌 server 运行）。记录结果。

- [ ] **Step 5：记录**

贴出：① `pnpm dev:desktop` 启动到 Web UI 加载的日志关键行（`connected to http://127.0.0.1:<port>`）；② `~/.kimi-code/` 下两个 lock 并存；③ 关闭桌面端后 CLI 守护仍活的证据。

---

## Self-Review（对照 spec §6 阶段 1 + §8 阶段 1 风险）

**1. Spec coverage：**
- spec §6 阶段 1「desktop 加依赖 / `startDesktopServer` 封装（serviceOverrides 中和 process.exit、identity、独立 lock、`port:0`、`installGlobalProxyDispatcher`、异步不阻塞首屏）/ `index.ts` 主流程 / 原生模块 rebuild+asarUnpack / tsdown bundle / 去 SEA 分发」→ Tasks 1.1-1.5 覆盖。✓
- spec §6 阶段 1 验证（私有 server 起、CLI 守护并行不抢锁、关桌面端不杀 CLI）→ Task 1.6 覆盖。✓
- spec §8 阶段 1 风险（node-pty/chokidar rebuild、tsdown import.meta.url/createRequire、svc 连带、setUnexpectedErrorHandler 全局单槽、冷启动 loading 兜底、token 并发写）→ Task 1.5（rebuild/asarUnpack/tsdown，含 import.meta 失败处理分支）+ Task 1.2/1.3（异步不阻塞首屏、close）。`setUnexpectedErrorHandler` 全局单槽：startServer 内部覆盖 agent-core handler，electron 侧未另装，无冲突（无需任务）。token 并发写：私有 server 与 CLI 共享 home/server.token，首启并发写低风险（spec 已记），无任务。✓
- spec §10 Non-goals（不重写 server/core、不抽共享包、不引自动更新）→ 无相关任务。✓

**2. Placeholder scan：** 无 TBD/TODO。`server.ts`/`server.test.ts`/`index.ts` 改动给了完整或精确片段；tsdown 的 `import.meta.url` 处理给了明确失败处理分支（非「implement later」，是可执行的排错路径）。

**3. Type/consistency：** `startDesktopServer` 返回 `{ origin, port, token, close }` 在 Task 1.2 定义、Task 1.3 消费一致；`webAssetsDir()` dev/packaged 两态与 Task 1.4 extraResources 一致；`IServerShutdownService` 在 test 与实现用同一 mock 对象；`serverTokenPath`/`readServerToken` 只在 `server.ts`，`index.ts` 不再重复（原 `readServerToken`/`SERVER_TOKEN_FILE` 删除在 Task 1.3 Step 3 明确）。

**遗留开放点（移交后续 task / 阶段 2）：**
- tsdown 对 `@moonshot-ai/server` 的 `import.meta.url`/`createRequire` bundle 行为（Task 1.5 Step 3 实测确定是否需要 alias/stub）。
- mac entitlements 对主进程 dlopen 原生 `.node` 的充分性（沿用阶段 0 entitlements，dist 出包后实测）。
- `token` 为 `undefined`（首启无 server.token）时 web UI fallback token dialog 的体验（阶段 1 接受，阶段 2 IPC 注入 serverInfo 时统一）。

---

## Execution Handoff

Plan 已存到 `code-app/docs/plans/2026-07-10-code-app-split-phase1.md`。两种执行方式：

1. **Subagent-Driven（推荐）** — 每个 task 派一个全新的 implementer subagent 执行，task 间两阶段 review。
2. **Inline Execution** — 在当前会话用 executing-plans 批量执行，checkpoint 处 review。

选哪种？
