# code-app 阶段 2 · 本地 renderer（custom protocol）+ preload/IPC 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把渲染来源从「私有 server origin」改为「**本地 custom protocol**（`app://renderer/…` 映射 `web-dist`）」，server 连接信息经 `loadURL` query 注入，引入 `preload`+`contextBridge` IPC，并替换 `console-message` 主题 hack。

**Architecture:** 主进程注册 `app` scheme（`registerSchemesAsPrivileged` + `protocol.handle` 把 `app://renderer/<path>` 映射到本地 `web-dist/<path>`，带 MIME 与目录穿越防护），`BrowserWindow` 加 `preload`（`out/preload.cjs`，`contextBridge` 暴露 `setTheme/onMenu/openExternal`，不暴露 node，`sandbox:true`）。server 起好后 `loadURL('app://renderer/index.html?kimi_desktop=1&platform=…&kimi_origin=<enc>#token=<tok>')`；`apps/web` 的 `readKimiApiConfig` 优先读 query `kimi_origin`（同步、无需 async bootstrap）。主题同步改为 web 调 `window.kimiDesktop.setTheme(scheme)` → IPC → `nativeTheme.themeSource`（删 `console-message` observer）。菜单「重试连接」= 主进程重启 server + `loadURL` 新 query；外链经 `window.kimiDesktop.openExternal` → `shell.openExternal`。

**Tech Stack:** Electron 33.4.11（`protocol`/`contextBridge`/`ipcMain`/`nativeTheme`/`shell`）、tsdown（多 entry：`main`+`preload`）、Vue 3 + Vite 6（`apps/web`，仓内小改 `config.ts`/`main.ts`/`desktopFlag.ts`）、vitest（config/preload/protocol 单元测试）。

## Global Constraints

- Node `>=24.15.0`，pnpm `10.33.0`，`engine-strict=true`；桌面端包名保持 `@moonshot-ai/kimi-desktop`。
- **渲染用 custom protocol** `app://renderer/…`（不用 `file://`，规避 null-origin CORS 坑）。`registerSchemesAsPrivileged` 的 `corsEnabled` 取值见 Task 2.1 验证（本地 loopback server；若 `app://`→`http://127.0.0.1` 触发 CORS，按 Task 2.5 排错处理）。
- **server 连接信息经 `loadURL` query 同步注入**（`kimi_origin`/`kimi_desktop`/`platform`/`#token=`），web 启动**同步**读取（无需 async bootstrap、不改 `main.ts` mount 流程）；`preload` **不**负责注入 serverInfo，只承担 theme/menu/openExternal IPC。
- **preload 不暴露 node**：只 `contextBridge.exposeInMainWorld('kimiDesktop', { setTheme, onMenu, openExternal })`；`contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`。
- **替换 `console-message` 主题 hack**：web 经 `MutationObserver('<html data-color-scheme>')` 调 `window.kimiDesktop.setTheme`，删除主进程 `index.ts` 的 `console-message` observer（阶段 1 的 `index.ts:186-218`）。
- 改动边界：code-app 仓内改 `apps/desktop` + `apps/web`（仓内）；**不改** `kimi-code` 的 `packages/server`、`packages/agent-core`、`apps/kimi-code/src/**`。
- commit 用 Conventional Commits；禁止 `Co-Authored-By`；commit message/代码/文档不得出现 agent / AI 工具名称或身份信息。
- 测试：`config.ts`（读 query `kimi_origin`）、`preload.ts`（contextBridge API）、protocol（MIME + 目录穿越防护）用 vitest 单测；custom protocol + IPC + CORS 以 Electron 端到端验证。

## File Structure（阶段 2）

- Create: `apps/desktop/src/main/preload.ts`（contextBridge API）
- Create: `apps/desktop/src/main/preload.test.ts`（vitest mock electron）
- Create: `apps/desktop/src/main/protocol.ts`（`registerRendererProtocol`：`registerSchemesAsPrivileged` + `protocol.handle` 映射 web-dist + MIME + 防穿越）
- Create: `apps/desktop/src/main/protocol.test.ts`（MIME + 路径）
- Modify: `apps/desktop/src/main/index.ts`（注册 protocol、`webPreferences` 接 `preload`/`sandbox`、`loadURL(app://…)` 带 query、ipcMain theme/open-external、删 console-message hack、菜单重试重启 server）
- Modify: `apps/desktop/tsdown.config.ts`（entry 加 `preload`）
- Modify: `apps/web/src/api/config.ts`（`resolveServerOrigin` 优先读 query `kimi_origin`；`serverEndpointLabel` 同步）
- Modify: `apps/web/src/main.ts`（mount 后加 desktop theme effect 调 `window.kimiDesktop.setTheme`，替换主进程 observer）
- Create: `apps/web/src/api/config.test.ts`（若仓库已有 vitest for web，沿用；否则轻量单测）
- Modify: 根 `AGENTS.md`（阶段 1→2 状态，由收尾 task 一并）

---

## Task 2.1：custom protocol + preload 骨架 + loadURL

**Files:**
- Create: `apps/desktop/src/main/protocol.ts`、`apps/desktop/src/main/protocol.test.ts`
- Create: `apps/desktop/src/main/preload.ts`、`apps/desktop/src/main/preload.test.ts`
- Modify: `apps/desktop/tsdown.config.ts`
- Modify: `apps/desktop/src/main/index.ts`

**Interfaces:**
- Produces: `registerRendererProtocol(getWebDistRoot: () => string): void`（在 `app.whenReady()` 前调 `registerSchemesAsPrivileged`，在 ready 后调 `protocol.handle('app', handler)`）。
- Produces: `rendererUrl(origin: string, token: string | undefined): string`（拼 `app://renderer/index.html?kimi_desktop=1&platform=<os>&kimi_origin=<enc>#token=<tok>`），Task 2.2 也复用。

- [ ] **Step 1：写 `protocol.ts` + `protocol.test.ts`（TDD：MIME + 防穿越）**

`apps/desktop/src/main/protocol.ts`：

```ts
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { protocol, type ProtocolRequest, type ProtocolResponse } from 'electron';

export const RENDERER_SCHEME = 'app';
export const RENDERER_HOST = 'renderer';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

export function mimeFor(filePath: string): string {
  return MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

const priv = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  // See Global Constraints: verify CORS behaviour in Task 2.5; flip to false
  // only if `app://`→`http://127.0.0.1` is blocked and the loopback server is
  // confirmed to ignore Origin (local trusted context).
  corsEnabled: true,
};

export function registerRendererScheme(): void {
  // MUST run before `app.whenReady()`.
  protocol.registerSchemesAsPrivileged([
    { scheme: RENDERER_SCHEME, privileges: priv },
  ]);
}

export function rendererUrl(origin: string, token: string | undefined): string {
  const base = `${RENDERER_SCHEME}://${RENDERER_HOST}/index.html`;
  const params = new URLSearchParams({
    kimi_desktop: '1',
    platform: process.platform,
    kimi_origin: origin,
  });
  const hash = token === undefined ? '' : `#token=${encodeURIComponent(token)}`;
  return `${base}?${params.toString()}${hash}`;
}

/**
 * Map `app://renderer/<path>` to `<webDistRoot>/<path>` with MIME + traversal
 * protection. Returns a Response for `protocol.handle`.
 */
export async function handleRendererRequest(
  request: ProtocolRequest,
  getWebDistRoot: () => string,
): Promise<Response> {
  const url = new URL(request.url);
  // Normalise and forbid traversal. URL pathname is already percent-decoded
  // and collapsed, but guard against sneaky `..` after decoding anyway.
  const decodedPathname = decodeURIComponent(url.pathname);
  if (decodedPathname.split('/').some((seg) => seg === '..')) {
    return new Response('forbidden', { status: 403 });
  }
  const rel = decodedPathname === '/' ? '/index.html' : decodedPathname;
  const root = getWebDistRoot();
  const filePath = resolve(join(root, rel));
  if (!filePath.startsWith(root)) {
    return new Response('forbidden', { status: 403 });
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return new Response('not found', { status: 404 });
    }
  } catch {
    return new Response('not found', { status: 404 });
  }
  const stream = createReadStream(filePath);
  return new Response(stream as unknown as BodyInit, {
    headers: { 'content-type': mimeFor(filePath) },
  });
}

export function registerRendererProtocol(getWebDistRoot: () => string): void {
  protocol.handle(RENDERER_SCHEME, (request) => handleRendererRequest(request, getWebDistRoot));
}
```

`apps/desktop/src/main/protocol.test.ts`（vitest；只测纯函数 `mimeFor` / `rendererUrl` / `handleRendererRequest` 的防穿越与映射，不拉起 electron protocol）：

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mimeFor, rendererUrl, handleRendererRequest } from './protocol';

describe('mimeFor', () => {
  it('maps common web extensions and falls back to octet-stream', () => {
    expect(mimeFor('index.html')).toBe('text/html; charset=utf-8');
    expect(mimeFor('assets/index-X.js')).toBe('text/javascript; charset=utf-8');
    expect(mimeFor('style.css')).toBe('text/css; charset=utf-8');
    expect(mimeFor('font.woff2')).toBe('font/woff2');
    expect(mimeFor('blob.unknown')).toBe('application/octet-stream');
  });
});

describe('rendererUrl', () => {
  it('builds app:// URL with query + token fragment', () => {
    const u = rendererUrl('http://127.0.0.1:54321', 'abc def');
    expect(u).toMatch(/^app:\/\/renderer\/index\.html\?/);
    expect(u).toContain('kimi_desktop=1');
    expect(u).toContain('kimi_origin=http%3A%2F%2F127.0.0.1%3A54321');
    expect(u).toMatch(/#token=abc%20def$/);
  });
  it('omits token fragment when undefined', () => {
    expect(rendererUrl('http://127.0.0.1:1', undefined)).not.toContain('#token=');
  });
});

describe('handleRendererRequest', () => {
  async function makeRoot() {
    const root = await mkdtemp(join(tmpdir(), 'kimi-renderer-'));
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'index.html'), '<h1>ok</h1>');
    await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)');
    return root;
  }

  it('serves index.html for / with correct mime', async () => {
    const root = await makeRoot();
    const res = await handleRendererRequest(
      { url: 'app://renderer/' } as any,
      () => root,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe('<h1>ok</h1>');
  });

  it('serves /assets/app.js', async () => {
    const root = await makeRoot();
    const res = await handleRendererRequest(
      { url: 'app://renderer/assets/app.js' } as any,
      () => root,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });

  it('returns 404 for missing file', async () => {
    const root = await makeRoot();
    const res = await handleRendererRequest(
      { url: 'app://renderer/nope.js' } as any,
      () => root,
    );
    expect(res.status).toBe(404);
  });

  it('rejects directory traversal (..)', async () => {
    const root = await makeRoot();
    const res = await handleRendererRequest(
      { url: 'app://renderer/../secret' } as any,
      () => root,
    );
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2：写 `preload.ts` + `preload.test.ts`（TDD：contextBridge API）**

`apps/desktop/src/main/preload.ts`：

```ts
import { contextBridge, ipcRenderer } from 'electron';

export type KimiDesktopApi = {
  setTheme: (scheme: 'light' | 'dark' | 'system') => void;
  onMenu: (cb: (action: string) => void) => () => void;
  openExternal: (url: string) => Promise<void>;
};

export const api: KimiDesktopApi = {
  setTheme: (scheme) => {
    if (scheme === 'light' || scheme === 'dark' || scheme === 'system') {
      ipcRenderer.send('kimi:theme', scheme);
    }
  },
  onMenu: (cb) => {
    const listener = (_event: unknown, action: string) => cb(action);
    ipcRenderer.on('kimi:menu', listener);
    return () => ipcRenderer.removeListener('kimi:menu', listener);
  },
  openExternal: (url) => ipcRenderer.invoke('kimi:open-external', url),
};

contextBridge.exposeInMainWorld('kimiDesktop', api);
```

`apps/desktop/src/main/preload.test.ts`（mock electron）：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const expose = vi.fn();
const send = vi.fn();
const on = vi.fn();
const removeListener = vi.fn();
const invoke = vi.fn().mockResolvedValue(undefined);

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { send, on, removeListener, invoke },
}));

beforeEach(() => {
  expose.mockClear(); send.mockClear(); on.mockClear(); removeListener.mockClear(); invoke.mockClear();
});

it('exposes kimiDesktop via contextBridge with the expected surface', async () => {
  await import('./preload');
  expect(expose).toHaveBeenCalledOnce();
  const [name, exposed] = expose.mock.calls[0];
  expect(name).toBe('kimiDesktop');
  expect(Object.keys(exposed).sort()).toEqual(['onMenu', 'openExternal', 'setTheme']);
  exposed.setTheme('dark');
  expect(send).toHaveBeenCalledWith('kimi:theme', 'dark');
  exposed.setTheme('bogus');
  expect(send).toHaveBeenCalledTimes(1); // ignored invalid scheme
  const off = exposed.onMenu(() => {});
  expect(on).toHaveBeenCalledWith('kimi:menu', expect.any(Function));
  off();
  expect(removeListener).toHaveBeenCalledWith('kimi:menu', expect.any(Function));
  await exposed.openExternal('https://example.com');
  expect(invoke).toHaveBeenCalledWith('kimi:open-external', 'https://example.com');
});
```

- [ ] **Step 3：`tsdown.config.ts` entry 加 `preload`**

把 `entry: { main: 'src/main/index.ts' }` 改为：

```ts
entry: { main: 'src/main/index.ts', preload: 'src/main/preload.ts' },
```

> 产物：`out/main.cjs` + `out/preload.cjs`。preload 仅依赖 `electron`（已 `neverBundle`），无 `@moonshot-ai/*`，故 `noExternal`/`rawTextPlugin` 不影响它。

- [ ] **Step 4：跑测试（RED→GREEN）+ build + typecheck**

```bash
cd /Users/moonshot/Desktop/moonshot/code-app
pnpm --filter @moonshot-ai/kimi-desktop run test        # protocol + preload 单测 PASS
pnpm --filter @moonshot-ai/kimi-desktop run build       # 出 out/main.cjs + out/preload.cjs
pnpm --filter @moonshot-ai/kimi-desktop run typecheck   # 退出 0
test -f apps/desktop/out/preload.cjs && echo OK
```

- [ ] **Step 5：commit**

```bash
git add apps/desktop/src/main/protocol.ts apps/desktop/src/main/protocol.test.ts \
        apps/desktop/src/main/preload.ts apps/desktop/src/main/preload.test.ts \
        apps/desktop/tsdown.config.ts
git commit -m "feat(desktop): add app:// renderer protocol and contextBridge preload"
```

---

## Task 2.2：主进程接 protocol/preload + web 读 serverInfo

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/web/src/api/config.ts`
- Create: `apps/web/src/api/config.test.ts`（若 web 有 vitest 配置；否则并入 `apps/web/src/lib/__tests__` 或跳过单测、改靠端到端验证）

**Interfaces:**
- Consumes: `registerRendererScheme`/`registerRendererProtocol`/`rendererUrl`（Task 2.1）；`startDesktopServer`（阶段 1）。
- Consumes: web 现有 `readKimiApiConfig` / `buildRestUrl` / `buildWsUrl`（`config.ts`）。

- [ ] **Step 1：主进程注册 protocol + webPreferences + loadURL**

在 `apps/desktop/src/main/index.ts`：
- 顶部追加 import：
  ```ts
  import { app, BrowserWindow, Menu, nativeTheme, shell, ipcMain } from 'electron';
  import { registerRendererScheme, registerRendererProtocol, rendererUrl } from './protocol';
  ```
  （`app` 已在原 import，合并；新增 `ipcMain`。）
- 在 `main()` 最前（`app.whenReady()` 之前）调 `registerRendererScheme();`。
- `webAssetsDir()` 已存在（阶段 1）。新增 `webDistRoot()`：
  ```ts
  function webDistRoot(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'web-dist')
      : join(app.getAppPath(), 'web-dist');
  }
  ```
- `whenReady().then(() => { registerRendererProtocol(webDistRoot); buildMenu(); createWindow(); … })`。
- `createWindow` 的 `webPreferences` 改为：
  ```ts
  webPreferences: {
    preload: join(__dirname, 'preload.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
  ```
- 重写 `connect(win)`（替换阶段 1 的 loadURL 私有 origin）：
  ```ts
  async function connect(win: BrowserWindow): Promise<void> {
    await win.loadURL(dataUrl(loadingHtml()));
    try {
      serverHandle?.close().catch(() => {});
      serverHandle = await startDesktopServer({
        webAssetsDir: webDistRoot(),
        identity: { userAgentProduct: 'kimi-desktop', version: app.getVersion() },
      });
      const { origin, token } = serverHandle;
      process.stdout.write(`[kimi-desktop] connected to ${origin}\n`);
      if (!win.isDestroyed()) {
        await win.loadURL(rendererUrl(origin, token));
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
- 注册 ipcMain（在 `main()` 内 `whenReady` 之后，或文件级 `main()` 顶部一次）：
  ```ts
  ipcMain.on('kimi:theme', (_event, scheme) => {
    if (scheme === 'light' || scheme === 'dark' || scheme === 'system') {
      nativeTheme.themeSource = scheme;
    }
  });
  ipcMain.handle('kimi:open-external', (_event, url: string) => shell.openExternal(url));
  ```

- [ ] **Step 2：删 console-message 主题 hack**

删除 `index.ts` 阶段 1 的主题同步块（`const THEME_TAG = '__kimi_desktop_theme__:';` 起的 `win.webContents.on('console-message', …)` 与 `win.webContents.on('did-finish-load', … executeJavaScript …)`，阶段 1 行号约 `:186-218`）。保留 mac 红绿灯的 `enter-full-screen`/`leave-full-screen`/`focus` 处理（`:186-194` 那段 `showTrafficLights` 保留）。

- [ ] **Step 3：`apps/web/src/api/config.ts` 读 query `kimi_origin`**

把 `readKimiApiConfig` 中的 `serverHttpUrl: normalizeServerOrigin(import.meta.env.VITE_KIMI_SERVER_HTTP_URL),` 改为 `serverHttpUrl: resolveServerOrigin(),`，并在文件内（`defaultServerOrigin` 附近）新增：

```ts
/**
 * Resolve the server origin, with the desktop app taking precedence: when the
 * desktop loads the renderer via `app://renderer/index.html?kimi_origin=<enc>`,
 * that injected origin is the in-process server the renderer must talk to
 * (cross-origin from `app://`, so CORS/WS behaviour is verified in Task 2.5).
 * Falls back to the explicit env, then same-origin, then the loopback default.
 */
function resolveServerOrigin(): string {
  if (typeof window !== 'undefined') {
    const injected = new URLSearchParams(window.location.search).get('kimi_origin');
    if (injected) {
      return normalizeServerOrigin(decodeURIComponent(injected));
    }
  }
  return normalizeServerOrigin(import.meta.env.VITE_KIMI_SERVER_HTTP_URL);
}
```

`serverEndpointLabel` 末尾的 `const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : ''; return shortOrigin(origin);` 改为优先用注入 origin：

```ts
  if (typeof window !== 'undefined') {
    const injected = new URLSearchParams(window.location.search).get('kimi_origin');
    if (injected) return shortOrigin(normalizeServerOrigin(decodeURIComponent(injected)));
  }
  const origin =
    typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
  return shortOrigin(origin);
```

- [ ] **Step 4：（可选）config 单测 + build web + copy-web-dist + typecheck**

若 `apps/web` 已有 vitest（`apps/web/package.json` 有 `test: vitest run`），新增 `apps/web/src/api/config.test.ts` 覆盖 `resolveServerOrigin`/`serverEndpointLabel` 读 `kimi_origin`（用 `vi.stubGlobal('window', { location: { search: '?kimi_origin=http%3A%2F%2F127.0.0.1%3A4242', origin: 'app://renderer' } })` 与 `vi.stubEnv`）。若无 vitest 配置，跳过单测、改靠 Task 2.5 端到端验证。

```bash
cd /Users/moonshot/Desktop/moonshot/code-app
pnpm --filter @moonshot-ai/kimi-web run build
node apps/desktop/scripts/copy-web-dist.mjs
pnpm --filter @moonshot-ai/kimi-web run typecheck
pnpm --filter @moonshot-ai/kimi-desktop run typecheck
```

期望：web build 出 `apps/web/dist`；copy 到 `apps/desktop/web-dist`；两边 typecheck 0。

- [ ] **Step 5：commit**

```bash
git add apps/desktop/src/main/index.ts apps/web/src/api/config.ts
# 若有 config.test.ts：git add apps/web/src/api/config.test.ts
git commit -m "feat: load renderer via app:// and inject server origin through query"
```

---

## Task 2.3：主题 IPC + 菜单重试 + openExternal

**Files:**
- Modify: `apps/web/src/main.ts`
- Modify: `apps/desktop/src/main/index.ts`（菜单「重试连接」）

- [ ] **Step 1：`apps/web/src/main.ts` 加 desktop theme effect（替换主进程 observer）**

把 `main.ts` 的 `createApp(App).use(i18n).mount('#app');` 改为：

```ts
import { isDesktop } from './lib/desktopFlag';

const app = createApp(App).use(i18n);
app.mount('#app');

// In the desktop app, mirror <html data-color-scheme> to the host's nativeTheme
// via the preload-exposed IPC (replaces the main process's console-message hack).
if (isDesktop) {
  const bridge = (window as unknown as { kimiDesktop?: { setTheme: (s: 'light' | 'dark' | 'system') => void } }).kimiDesktop;
  if (bridge) {
    const report = () => {
      const v = document.documentElement.dataset.colorScheme;
      bridge.setTheme(v === 'light' || v === 'dark' ? v : 'system');
    };
    new MutationObserver(report).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-color-scheme'],
    });
    report();
  }
}
```

> `isDesktop`（`desktopFlag.ts`）经 query `kimi_desktop=1` / sessionStorage 识别，custom protocol 下 `loadURL` 已带 `kimi_desktop=1`，检测成立。

- [ ] **Step 2：菜单「重试连接」= 重启 server + `loadURL` 新 query**

在 `index.ts` 菜单项「重试连接」的 `click`（阶段 1 为 `void connect(mainWindow)`）改为：

```ts
click: () => {
  if (mainWindow !== null) {
    void connect(mainWindow);   // connect 内部会先 close 旧 serverHandle 再起新实例
  } else {
    createWindow();
  }
},
```

> `connect`（Task 2.2）已先 `serverHandle?.close()` 再 `startDesktopServer` 并 `loadURL(rendererUrl(origin, token))`，重启后 renderer 加载带**新** `kimi_origin`（`port:0` 可能变），web 重新读 query 连新 server。无需 `webContents.reload()`（reload 会复用旧 query 的过期 origin）。

- [ ] **Step 3：外链 openExternal（web 端接线，若存在现成外链点击）**

`apps/web` 当前若用 `<a target="_blank">` 在 Electron 里会新开 Electron 窗口。本 task 不强制改造所有外链（YAGNI）；仅在确认有「应用内链接被 Electron 内打开」的具体问题时，把对应点击改 `window.kimiDesktop?.openExternal(href)` 或 `shell.openExternal`。默认行为保持（绝大多数 web 内跳转走自身路由）。若评审/端到端发现具体问题，加一个 `click` 委托：

```ts
// apps/web/src/main.ts（仅在确认需要时加，否则跳过本 step）
document.addEventListener('click', (e) => {
  const a = (e.target as Element).closest('a[target="_blank"][href^="http"]') as HTMLAnchorElement | null;
  const bridge = (window as any).kimiDesktop;
  if (a && bridge?.openExternal) {
    e.preventDefault();
    bridge.openExternal(a.href);
  }
});
```

- [ ] **Step 4：build web + copy-web-dist + typecheck + test**

```bash
pnpm --filter @moonshot-ai/kimi-web run build
node apps/desktop/scripts/copy-web-dist.mjs
pnpm --filter @moonshot-ai/kimi-web run typecheck
pnpm --filter @moonshot-ai/kimi-desktop run typecheck
pnpm --filter @moonshot-ai/kimi-desktop run test
```

- [ ] **Step 5：commit**

```bash
git add apps/web/src/main.ts apps/desktop/src/main/index.ts
git commit -m "feat: drive native theme via IPC and retry connection by reloading renderer"
```

---

## Task 2.4：mac 拖拽区 + 端到端验证

**Files:**
- Modify: `apps/desktop/src/main/index.ts`（如标题栏/红绿灯坐标需微调）
- （可选）Modify: `apps/web` 顶部拖拽条样式（`-webkit-app-region`），仅当端到端发现拖拽区与红绿灯重叠时

- [ ] **Step 1：mac 拖拽区 / 红绿灯坐标复核**

阶段 1 已用 `titleBarStyle:'hidden'` + `trafficLightPosition:{x:16,y:18}`（为 web 顶部 48px 拖拽条 + 红绿灯中点 y=24 对齐）。custom protocol 下 web 顶部拖拽条（`-webkit-app-region:drag`）应仍在（apps/web 现有顶部条）。端到端目视确认：红绿灯不遮挡 web 顶部交互、拖拽区可拖动窗口。若重叠/错位，微调 `trafficLightPosition.y` 或 web 顶部条高度/留白。本 step 仅在端到端发现问题时改动，默认保留阶段 1 坐标。

- [ ] **Step 2：端到端验证（custom protocol + IPC + CORS）**

```bash
cd /Users/moonshot/Desktop/moonshot/code-app
pnpm dev:desktop
```

期望：
- 窗口出现 → loading → `loadURL('app://renderer/index.html?kimi_desktop=1&platform=darwin&kimi_origin=http%3A%2F%2F127.0.0.1%3A<port>#token=…')` → Web UI 正常加载（DevTools 地址栏显示 `app://renderer/...`）。
- `[kimi-desktop] connected to http://127.0.0.1:<port>` 日志在。
- Web UI 经 REST（`/api/v1`）+ WebSocket（`/api/v1/ws`）正常通信（会话列表/消息能加载与发送）。
- **CORS 验证**：DevTools Network 面板无 CORS 错误（`app://renderer` → `http://127.0.0.1`）。若出现 CORS 失败：把 `protocol.ts` 的 `corsEnabled` 改为 `false`（本地 loopback 可信，请求不带 Origin），或让 server 允许 `app://renderer` origin（设置 `KIMI_CODE_CORS_ORIGINS=app://renderer` 后重启）。记录采用哪种。
- 主题：切换 web 主题，`nativeTheme` 跟随（mac 红绿灯/窗口外观随主题变）。
- 菜单「重试连接」：点击后 renderer 重新加载（新 `kimi_origin`）、Web UI 重连正常。
- 关闭桌面端不杀 CLI 守护（同阶段 1）。

- [ ] **Step 3：记录**

贴出：① `pnpm dev:desktop` 启动到 Web UI 加载的日志（`connected to …`）；② DevTools 地址栏 `app://renderer/index.html?…`；③ Network 面板无 CORS 错误的截图/描述（若改了 `corsEnabled` 或 `KIMI_CODE_CORS_ORIGINS`，注明）。

- [ ] **Step 4：（无代码改动则跳过 commit；若有标题栏/样式微调）**

```bash
git add apps/desktop/src/main/index.ts apps/web
git commit -m "fix(desktop): align macOS drag region and traffic lights for app renderer"
```

---

## Self-Review（对照 spec §6 阶段 2 + §8 阶段 2 风险）

**1. Spec coverage：**
- spec §6 阶段 2「本地 renderer 薄壳 + preload/IPC 注入 serverInfo、替换 console-message 主题 hack、菜单/标题栏」→ Tasks 2.1（custom protocol + preload + loadURL）、2.2（主进程接线 + web 读 query origin）、2.3（主题 IPC + 菜单重试 + openExternal）、2.4（拖拽区 + 端到端）覆盖。serverInfo 注入方式由「IPC invoke」改为「loadURL query 同步注入」（更稳、无需 async bootstrap；spec 未限定注入手段，符合「渲染脱离守护 origin + IPC」意图）。✓
- spec §8 阶段 2 风险（file:// 资源/Worker/WS origin 行为需实测；contextBridge 暴露面最小化）→ 用 custom protocol 替代 file://（规避 null-origin CORS），Task 2.5 含 CORS 排错分支；preload 仅暴露 `setTheme/onMenu/openExternal`（不暴露 node，sandbox:true）。✓
- spec §10 Non-goals（不重写 server/core、不抽共享包、不引自动更新）→ 无相关任务。✓

**2. Placeholder scan：** 无 TBD/TODO。protocol/preload/config.ts/main.ts 给了完整代码；测试给完整用例；openExternal 的 web 端委托标了「仅在确认需要时加」（不是 implement later，是有条件的可选 step，默认跳过）。CORS 给了明确排错分支（可执行）。

**3. Type/consistency：** `rendererUrl` 在 Task 2.1 定义、Task 2.2 主进程与 Task 2.3 菜单重试复用一致；`webDistRoot()` 与阶段 1 `webAssetsDir()` 同源（统一为 `webDistRoot`，Task 2.2 用同一根托管 web 与映射 protocol）；`kimi_origin` query key 在 `rendererUrl`（主进程写）与 `config.ts`（web 读）一致；`window.kimiDesktop` API（`setTheme/onMenu/openExternal`）在 preload（暴露）与 web（调用）一致。

**遗留开放点（移交后续）：**
- `corsEnabled` 最终取值（`true` 标准 / `false` 本地绕过）由 Task 2.5 端到端实测定。
- 外链 `openExternal` 全量改造（YAGNI，按需）。
- 自定义协议在 Windows/Linux 的 MIME/路径行为（端到端覆盖 macOS 后，其它平台按需补测）。

---

## Execution Handoff

Plan 已存到 `code-app/docs/plans/2026-07-10-code-app-split-phase2.md`。两种执行方式：

1. **Subagent-Driven（推荐）** — 每个 task 派一个全新的 implementer subagent 执行，task 间两阶段 review。
2. **Inline Execution** — 在当前会话用 executing-plans 批量执行，checkpoint 处 review。

选哪种？
