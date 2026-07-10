# 阶段 3：apps/web 拆库（web-ui / web-markdown / web-core）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `code-app` 仓库内把 `apps/web` 拆成三个可复用包 `@moonshot-ai/web-ui`、`@moonshot-ai/web-markdown`、`@moonshot-ai/web-core`（`exports → src/*.ts`），`apps/web` 变回薄壳用回这些包；`useKimiWebClient` 单例解成工厂。desktop 本期不动（仍 `web-dist` 套壳）。验证「复用可行」，建立包的构建 / bundler 范式，为后续桌面原生骨架铺路。

**Architecture:** 三包单向依赖、互不循环：`web-ui`（纯展示组件 + 设计 tokens，零逻辑）、`web-markdown`（`Markdown.vue` 渲染器，对外仅 `inject('resolveImage')` + `useIsDark` + tokens 契约）、`web-core`（api 层 + 会话状态 + composables，不依赖任何 UI）。`apps/web` 聚合三者。`web-core` 把所有模块级单例（`getKimiWebApi`、`useKimiWebClient`、`i18n.global.t`、`debug/trace`、`serverAuth` credential）改成工厂 / 注入；组件经 `provide/inject` 拿 client，33 处无参 `useKimiWebClient()` 调用保留签名、内部转 `inject`。消费方本期只有 `apps/web` 自己，bundler 配置（`?worker`、unplugin-icons `kimi` collection、tokens CSS）因此只有 web 一份，不扩散。

**Tech Stack:** Vue 3.5、vue-i18n 11、markstream-vue（传递 shiki / katex / mermaid）、Vite 6、unplugin-icons、TypeScript 6、vue-tsc、vitest 4、pnpm 10.33 workspace（`exports → src/*.ts`）。

## Global Constraints

- 仓规：`packages/*` 自动入 workspace（`pnpm-workspace.yaml:3`）；`exports → src/*.ts`（消费方 bundler 转译，包本身不预 build）。
- 不改 `kimi-code` 的 `packages/server/**`、`packages/agent-core/**`、`apps/kimi-code/src/**`（本阶段不动子仓）。
- 包目录 `packages/web-ui` / `packages/web-markdown` / `packages/web-core`，包名 `@moonshot-ai/web-ui` / `@moonshot-ai/web-markdown` / `@moonshot-ai/web-core`。
- Node `>=24.15.0` / pnpm `10.33.0` / `engine-strict=true`；web 侧 typecheck 用 `vue-tsc`。
- Conventional Commits；**禁止** co-author；任何文本（代码 / 注释 / commit / README）**不得出现 agent / AI 工具名称**。
- dist 形态不变：`apps/web` 仍 `vite build → dist`；desktop `copy-web-dist` 与 `scripts/sync-web-to-kimi-code.mjs`（CLI SEA 快照）链路不变，每 task 验证不碎。
- 每个 task 结束必须「三绿」：`web build` + `desktop prebuild`(copy-web-dist) + `sync:web`，并跑该包 typecheck / 测试。
- 验证命令固定（下文用 `W`=`/Users/moonshot/Desktop/moonshot/code-app`）：
  - web build：`pnpm -C "$W" --filter @moonshot-ai/kimi-web run build`
  - desktop prebuild：`pnpm -C "$W" --filter @moonshot-ai/kimi-desktop run prebuild`
  - SEA 快照：`pnpm -C "$W" run sync:web`
  - typecheck：`pnpm -C "$W" --filter @moonshot-ai/kimi-web run typecheck`

---

## File Structure（目标态）

```
packages/
  web-ui/
    package.json            # exports: { ".": "./src/index.ts", "./style.css": "./src/style.css" }
    tsconfig.json
    src/
      index.ts              # export * from 35 presentational components
      style.css             # 设计 tokens（从 apps/web/src/style.css 抽 :root / [data-color-scheme] 段）
      components/ui/*.vue   # 35 个（git mv 自 apps/web/src/components/ui）
    README.md               # 消费方 vite 配置清单（unplugin-icons kimi collection、tokens css import）
  web-markdown/
    package.json            # exports: { ".": "./src/index.ts" }
    tsconfig.json
    src/
      index.ts              # export { default as Markdown } from './Markdown.vue'
      Markdown.vue          # git mv 自 apps/web/src/components/chat/Markdown.vue
      lib/{markdownPerformance,filePathLinks,clipboard}.ts
    README.md               # 消费方 vite: worker.format:'es'、?worker 导入、shiki/katex/mermaid 依赖、
                            # 宿主 provide('resolveImage')、useIsDark + tokens 契约
  web-core/
    package.json            # exports: { ".": "./src/index.ts", "./api": "./src/api/index.ts", "./contracts": "./src/contracts.ts" }
    tsconfig.json
    src/
      index.ts              # export createKimiWebClient, KimiWebClientKey, types
      contracts.ts          # Tracer / CredentialStore / ResolveImage / ThemeBridge 接口 + noop 默认
      api/                  # daemon/http, ws, config, errors, eventReducer, agentEventProjector, mappers, index(DaemonKimiWebApi)
      client/               # createKimiWebClient 工厂 + 原 client/* 子模块（rawState/eventConn 收闭包）
      composables/          # useAppearance, useIsDark, useWorkspaceState 等（按依赖评估迁入）
      lib/                  # 纯 helper：storage, sessionRoute, ...
    test/                   # api inject 单测、工厂非单例单测
apps/web/                   # 薄壳
  src/
    main.ts                 # createApp + i18n + createKimiWebClient + provide(KimiWebClientKey) + mount
    App.vue                 # create client → provide；组装 web-ui / web-markdown
    i18n/                   # 留 web（locale 文案与 UI 紧，本期不抽）
    style.css               # @import '@moonshot-ai/web-ui/style.css' + web 自身 skin
    components/{chat,tool-calls,dialogs,settings,mobile}   # 业务组件留 web，依赖三包
  vite.config.ts            # 复刻 unplugin-icons kimi collection + worker.format:'es'（原样保留）
```

依赖方向（强制，review 关卡）：
- `apps/web → { web-ui, web-markdown, web-core }`
- `web-markdown → web-core`（仅 `useIsDark` + `ResolveImage` / tokens 契约，不 import 具体单例）
- `web-ui → （无）`；`web-core → （无 @moonshot-ai）`
- 禁止 `web-ui ↔ web-core`、`web-ui → web-markdown` 反向依赖。

---

## Task 3.0：packages 骨架 + workspace 接线

**Files:**
- Create: `packages/web-ui/package.json`、`packages/web-ui/tsconfig.json`、`packages/web-ui/src/index.ts`
- Create: `packages/web-markdown/package.json`、`packages/web-markdown/tsconfig.json`、`packages/web-markdown/src/index.ts`
- Create: `packages/web-core/package.json`、`packages/web-core/tsconfig.json`、`packages/web-core/src/index.ts`、`packages/web-core/src/contracts.ts`
- Verify: `pnpm-workspace.yaml` 含 `packages/*`（已含，仅确认）

**`packages/web-ui/package.json`（其余两个同构，替换 name / exports）：**
```json
{
  "name": "@moonshot-ai/web-ui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./style.css": "./src/style.css"
  },
  "peerDependencies": { "vue": "^3.5.35" },
  "devDependencies": { "vue": "^3.5.35", "vue-tsc": "^2.2.0", "typescript": "6.0.2" }
}
```
`web-core` 额外 `peerDependencies: { "vue-i18n": "^11.4.5" }`；`web-markdown` `dependencies: { "markstream-vue": "^1.0.4", "stream-markdown": "<沿用 apps/web 当前版本>" }` 并 `peerDependencies: { "vue": "^3.5.35" }`（版本号执行时从 `apps/web/package.json` 抄齐，不得改升降）。

**`packages/web-core/src/contracts.ts`（先给空接口骨架，3.3 / 3.4 填充方法）：**
```ts
export interface Tracer {
  restRequest?(info: unknown): void;
  restFailure?(info: unknown): void;
  wsEvent?(info: unknown): void;
}
export const noopTracer: Tracer = {};

export interface CredentialStore {
  getToken(): string | undefined;
  markAuthRequired?(): void;
}

export interface ResolveImage {
  (src: string): string;
}
```

- [ ] **Step 1: 写骨架文件（package.json / tsconfig / src/index.ts / contracts.ts）**
- [ ] **Step 2: `pnpm -C "$W" install`** —— Expected: 三包装入 workspace，`node_modules/@moonshot-ai/{web-ui,web-markdown,web-core}` 出现 symlink
- [ ] **Step 3: 空包 typecheck** —— `pnpm -C "$W" --filter @moonshot-ai/web-core exec vue-tsc --noEmit`；Expected: PASS（空 index）
- [ ] **Step 4: Commit**

```bash
git -C "$W" add packages/web-ui packages/web-markdown packages/web-core
git -C "$W" commit -m "chore: scaffold web-ui, web-markdown and web-core packages"
```

---

## Task 3.1：`web-ui` —— 35 通用 UI 组件 + 设计 tokens + icons 契约

**Files:**
- Move (git mv): `apps/web/src/components/ui/*.vue` (35) → `packages/web-ui/src/components/ui/*.vue`
- Modify: `apps/web/src/style.css` —— 把 `:root{}` / `html[data-color-scheme="light"]{}` / `[data-color-scheme="dark"]{}` 三个 tokens 块抽出 → `packages/web-ui/src/style.css`；`apps/web/src/style.css` 改首行 `@import '@moonshot-ai/web-ui/style.css';` 保留其余 skin
- Create: `packages/web-ui/src/index.ts`（`export { default as Button } from './components/ui/Button.vue'` … 35 个 named export）
- Create: `packages/web-ui/README.md`（消费方 vite 配置清单，见下）
- Modify: `apps/web/src/**` 中所有 `import X from '../components/ui/X.vue'` / `import { X } from '@/components/ui/X'` → `import { X } from '@moonshot-ai/web-ui'`（执行时用 codemod / 逐个改；改动文件预计 30-60 个）

**Interfaces:**
- Produces: `@moonshot-ai/web-ui`（35 个 Vue 组件 named export）+ `@moonshot-ai/web-ui/style.css`（tokens）
- Consumes: 无（纯展示）。组件内部用到的 `~icons/kimi/*` 属**消费方 bundler 契约**，不进包。

**`packages/web-ui/README.md`（消费方配置清单，必须如实）：**
```markdown
# @moonshot-ai/web-ui

消费方 Vite 必须：
1. `import '@moonshot-ai/web-ui/style.css'` 一次（设计 tokens）。
2. unplugin-icons 注册 `kimi` collection（组件内 `~icons/kimi/*`）：
   ```ts
   import Icons from 'unplugin-icons/vite';
   import { FileSystemIconLoader } from 'unplugin-icons/loaders';
   Icons({ compiler: 'vue3', customCollections: {
     kimi: FileSystemIconLoader('<path-to-icons>', svg => svg.replace(/^<svg /, '<svg fill="currentColor" ')),
   }});
   ```
3. 组件用 `<html data-color-scheme>` 切换主题；消费方负责设置该属性。
```

- [ ] **Step 1: git mv 35 组件 + 抽 tokens CSS**
- [ ] **Step 2: 写 `packages/web-ui/src/index.ts`（35 named export）**
- [ ] **Step 3: 改 `apps/web` 引用为 `@moonshot-ai/web-ui` + `@import` tokens**
- [ ] **Step 4: 三绿** —— web build + desktop prebuild + sync:web + web typecheck；Expected: 全 PASS；`grep -r "from '@/components/ui" "$W/apps/web/src"` 无残留
- [ ] **Step 5: Commit**

```bash
git -C "$W" add -A
git -C "$W" commit -m "feat(web-ui): extract presentational UI components and design tokens"
```

---

## Task 3.2：`web-markdown` —— Markdown 渲染器 + worker 契约

**Files:**
- Move (git mv): `apps/web/src/components/chat/Markdown.vue` → `packages/web-markdown/src/Markdown.vue`
- Move (git mv): `apps/web/src/lib/{markdownPerformance,filePathLinks,clipboard}.ts` → `packages/web-markdown/src/lib/`
- Create: `packages/web-markdown/src/index.ts`（`export { default as Markdown } from './Markdown.vue'`）
- Create: `packages/web-markdown/README.md`
- Modify: `apps/web` 引用 `components/chat/Markdown.vue` → `import { Markdown } from '@moonshot-ai/web-markdown'`；`Markdown.vue` 内 `inject('resolveImage')` 保留（由 `apps/web/App.vue` 继续 `provide('resolveImage', …)`）

**Interfaces:**
- Produces: `@moonshot-ai/web-markdown`（`Markdown` 组件）
- Consumes: 宿主 `provide('resolveImage', ResolveImage)`；`useIsDark`（3.4 后 from `@moonshot-ai/web-core`，本期可暂留 `apps/web` 转发）；tokens css（`web-ui`）

**`packages/web-markdown/README.md` 关键片段：**
```markdown
# @moonshot-ai/web-markdown

消费方必须：
1. 安装 `markstream-vue`（传递 shiki/katex/mermaid），版本与 apps/web 锁定一致。
2. Vite `worker: { format: 'es' }`；渲染器内部 `import KWorker from '...?worker&type=module'`。
3. `app.provide('resolveImage', (src) => …)` 解析附件 / 聊天图片。
4. import `@moonshot-ai/web-ui/style.css`（tokens），设置 `<html data-color-scheme>`。
```

- [ ] **Step 1: git mv Markdown.vue + 3 个 lib**
- [ ] **Step 2: 写 index.ts + 改 apps/web 引用**
- [ ] **Step 3: 三绿**；Expected: PASS；`Markdown.vue` 内 `enableKatex()/enableMermaid()` 在 web 消费方仍生效（`worker.format:'es'` 已在 `apps/web/vite.config.ts`）
- [ ] **Step 4: Commit**

```bash
git -C "$W" add -A
git -C "$W" commit -m "feat(web-markdown): extract Markdown renderer with katex, mermaid and shiki workers"
```

---

## Task 3.3：`web-core` —— api 层解注入（tracer + credential）

**Files:**
- Move (git mv): `apps/web/src/api/daemon/{http,ws,config,errors,eventReducer,agentEventProjector,mappers}.ts`、`apps/web/src/api/index.ts` → `packages/web-core/src/api/`
- Modify: `packages/web-core/src/contracts.ts`（补全 `Tracer` / `CredentialStore` 方法签名，对齐 `debug/trace.ts` 现有 `traceRestRequest/traceRestFailure/traceWs*` 与 `serverAuth.getCredential/markAuthRequired`）
- Modify: `packages/web-core/src/api/daemon/http.ts` —— 删 `import … from 'debug/trace'`(:6) 与对 `getCredential()`(:68 经 serverAuth) 的模块级依赖；改 `DaemonHttpClient` 构造：
  ```ts
  export interface DaemonHttpClientOptions {
    identity: ClientIdentity;
    tracer?: Tracer;                 // default noopTracer
    credentialStore?: CredentialStore;
  }
  export class DaemonHttpClient {
    constructor(private readonly opts: DaemonHttpClientOptions) {}
    // addClientHeaders 内：const tok = this.opts.credentialStore?.getToken(); if (tok) headers['Authorization'] = `Bearer ${tok}`;
    // 401/40101 → this.opts.credentialStore?.markAuthRequired?.();
    // traceRestRequest/traceRestFailure → this.opts.tracer?.restRequest?.(info)
  }
  ```
  `ws.ts` 同理注入 `tracer`。
- Modify: `packages/web-core/src/api/index.ts`（`DaemonKimiWebApi`）构造接 `{ identity, tracer?, credentialStore? }` 并下传给 `DaemonHttpClient` / `DaemonEventSocket`。
- Create: `packages/web-core/test/api.test.ts`

**Interfaces:**
- Produces: `DaemonHttpClient(DaemonHttpClientOptions)`、`DaemonKimiWebApi({ identity, tracer?, credentialStore? })`、`Tracer` / `CredentialStore` / `noopTracer`
- Consumes: 无 `@moonshot-ai`（仅 `vue` 类型 / 浏览器 fetch / WebSocket）

**`packages/web-core/test/api.test.ts`（关键用例，先写失败）：**
```ts
import { describe, expect, it, vi } from 'vitest';
import { DaemonHttpClient } from '#/api/daemon/http';

describe('DaemonHttpClient injection', () => {
  it('uses injected credentialStore for Authorization and tracer for failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const credentialStore = { getToken: () => 'tok_abc', markAuthRequired: vi.fn() };
    const tracer = { restRequest: vi.fn(), restFailure: vi.fn() };
    const client = new DaemonHttpClient({
      identity: { clientId: 'web_t', clientName: 't', clientVersion: '0', clientUiMode: 'web' },
      tracer, credentialStore,
    });
    await client.request('GET', '/api/v1/meta');
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok_abc');
    expect(tracer.restRequest).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 1: git mv api/* → packages/web-core/src/api**
- [ ] **Step 2: 写 contracts.ts（Tracer/CredentialStore）+ 改 http.ts / ws.ts / index.ts 注入**
- [ ] **Step 3: 写 `test/api.test.ts`（上面用例），先跑确认 FAIL（构造未接 opts）→ 实现 → PASS**
- [ ] **Step 4: apps/web 提供桥接**：`apps/web/src/api/bootstrap.ts` 创建 `DaemonKimiWebApi({ identity, tracer: webTracer(桥到 apps/web/src/debug/trace), credentialStore: webCredentialStore(桥到 serverAuth) })`，行为等价原 `getKimiWebApi()`
- [ ] **Step 5: 三绿 + web-core 单测**；Expected: PASS；`grep -rn "debug/trace" "$W/packages/web-core/src"` 无结果
- [ ] **Step 6: Commit**

```bash
git -C "$W" add -A
git -C "$W" commit -m "refactor(web-core): inject tracer and credential store into api layer"
```

---

## Task 3.4：`web-core` —— `useKimiWebClient` 单例 → 工厂

**Files:**
- Move (git mv): `apps/web/src/composables/useKimiWebClient.ts` + `apps/web/src/composables/client/*` → `packages/web-core/src/client/`
- Move: `apps/web/src/composables/{useAppearance,useIsDark,useWorkspaceState,useModelProviderState,useSideChat,useTaskPoller}.ts` → `packages/web-core/src/composables/`（按对 `rawState/api` 的实际依赖逐项确认；只依赖 `inject` 契约的才迁）
- Create: `packages/web-core/src/client/createKimiWebClient.ts`（工厂）+ `packages/web-core/src/client/KimiWebClientKey.ts`（InjectionKey）
- Modify: `packages/web-core/src/contracts.ts`（如需要 `ThemeBridge`）
- Modify: `packages/web-core/src/index.ts`（export `createKimiWebClient`、`KimiWebClientKey`、`useKimiWebClient` 兼容 composable、类型）
- Create: `packages/web-core/test/createKimiWebClient.test.ts`

**核心实现骨架（真实接口，执行时把 2675 行按此收拢）：**
```ts
// packages/web-core/src/client/KimiWebClientKey.ts
import type { InjectionKey } from 'vue';
import type { KimiWebClient } from './createKimiWebClient';
export const KimiWebClientKey: InjectionKey<KimiWebClient> = Symbol('KimiWebClient');

// packages/web-core/src/client/createKimiWebClient.ts
import { reactive } from 'vue';
import type { DaemonKimiWebApi } from '../api';
import type { Tracer } from '../contracts';

export interface CreateKimiWebClientDeps {
  api: DaemonKimiWebApi;
  t?: (key: string, params?: Record<string, unknown>) => string;  // default (k)=>k
  tracer?: Tracer;
}
export interface KimiWebClient {
  state: ReturnType<typeof createRawState>;
  install(): void;   // 注册 window.storage / document.visibilitychange 监听（原 :462-501）
  dispose(): void;   // 解注册（原 safeRemove :119/123）
  // …其余 public methods（sendMessage / setActiveSession / …，原 useKimiWebClient 返回值）
}

export function createKimiWebClient(deps: CreateKimiWebClientDeps): KimiWebClient {
  const t = deps.t ?? ((k: string) => k);
  const rawState = reactive(createInitialState());     // 原模块级 rawState(:358) 收进闭包
  const eventConn = createEventConnection(deps.api);   // 原 :707
  // appearance / notification / sound / draftModes / Set / Record 全部成闭包局部
  // i18n.global.t(:927/:977) → t(key, params)
  // client/* 子模块改为 (rawState, deps.api) => …（去掉 type-only 回环 import 单例 + 去掉 getKimiWebApi()）
  return { state: rawState, install() {/* … */}, dispose() {/* … */}, /* methods */ };
}

// 兼容 composable：保留 33 处 useKimiWebClient() 调用签名，内部转 inject
import { inject } from 'vue';
import { KimiWebClientKey } from './KimiWebClientKey';
export function useKimiWebClient(): KimiWebClient {
  const client = inject(KimiWebClientKey);
  if (!client) throw new Error('KimiWebClient not provided — did you app.provide(KimiWebClientKey, …)?');
  return client;
}
```

**`packages/web-core/test/createKimiWebClient.test.ts`（非单例断言）：**
```ts
import { describe, expect, it } from 'vitest';
import { createKimiWebClient } from '#/client/createKimiWebClient';
import { noopTracer } from '#/contracts';

describe('createKimiWebClient', () => {
  it('creates two isolated clients (no shared singleton state)', () => {
    const api = {} as any;
    const a = createKimiWebClient({ api, tracer: noopTracer });
    const b = createKimiWebClient({ api, tracer: noopTracer });
    a.state.activeSessionId = 'x';
    expect(b.state.activeSessionId).not.toBe('x');
    expect(a.state).not.toBe(b.state);
  });
});
```

- [ ] **Step 1: git mv useKimiWebClient.ts + client/* → packages/web-core/src/client**
- [ ] **Step 2: 写 `createKimiWebClient.ts` + `KimiWebClientKey.ts`（按骨架把模块级状态/副作用收进闭包；client/* 子模块改接 `(state, api)`）**
- [ ] **Step 3: 写兼容 `useKimiWebClient()` composable（inject 转发），保持 33 处调用签名不变**
- [ ] **Step 4: `test/createKimiWebClient.test.ts` 先 FAIL（无工厂）→ 实现 → PASS**
- [ ] **Step 5: 三绿 + web-core 单测**；Expected: PASS；非单例断言绿
- [ ] **Step 6: Commit**

```bash
git -C "$W" add -A
git -C "$W" commit -m "refactor(web-core): replace useKimiWebClient singleton with injected factory"
```

---

## Task 3.5：`apps/web` 收口 + 遗留测试修复 + 三绿 + 端到端冒烟

> 范围调整（human 决议，2026-07-10）：`useKimiWebClient` 全量工厂化解单例**推迟**到「桌面原生骨架」后续阶段。本 task **不再**做 `main.ts` 工厂装配 / `provide`（旧 plan 已撤）；改为收口 + 修遗留红测试 + 清理死配置 + 三绿 + 冒烟。`createKimiWebClientCore` 地基待用，本期不消费。

**Files:**
- Modify: `apps/web/test/lib-logic.test.ts`、`apps/web/test/ws-lifecycle.test.ts`、`apps/web/test/agent-event-projector.test.ts` —— 把指向已迁入 `@moonshot-ai/web-core` / `@moonshot-ai/web-markdown` 模块的 import 改为新路径（BASE 即红，3.1–3.3 搬迁遗留，**必修**）。
- Modify: `apps/web/scripts/check-style.mjs` —— 删 `ICON_EXEMPT` 中已迁出的 `components/ui/{Spinner,MoonSpinner,ContextRing,AuthStateIcon}.vue` 死条目（Task 3.1 M1），并把扫描扩展到 `packages/web-ui/src`（让迁入 web-ui 的组件回到 §06 守护）。
- Delete: `apps/web/src` 中已抽走的空目录 / 转发残留（若有）。
- Verify: `apps/web/dist` 产物结构 / 体积与阶段 2 基线一致（±5%）。

- [ ] **Step 1: 修 3 个遗留红测试的 import 路径（→ @moonshot-ai/web-core / web-markdown），跑 `pnpm --filter @moonshot-ai/kimi-web exec vitest run` 确认全绿**
- [ ] **Step 2: 清理 check-style.mjs 死 ICON_EXEMPT + 扩展扫描到 packages/web-ui/src；`pnpm --filter @moonshot-ai/kimi-web run check:style`（如存在）无新增告警**
- [ ] **Step 3: 确认无残留旧路径引用（`grep -rn "@/components/ui\|@/api/\|composables/useKimiWebClient.ts\|components/chat/Markdown" apps/web/src` = 0）**
- [ ] **Step 4: 三绿**；Expected: web build + desktop prebuild + sync:web 全 PASS
- [ ] **Step 5: 端到端冒烟**（人工 + 复用阶段 2 流程）：`pnpm -C "$W" dev:desktop` → app:// 加载、免 CORS 红、会话列表、发消息、markdown（code/math/mermaid，验证 Task 3.2 worker runtime round-trip）渲染、theme IPC；`pnpm -C "$W" run sync:web` 后确认 `kimi-code-2/apps/kimi-code/dist-web` 已更新
- [ ] **Step 6: Commit**

```bash
git -C "$W" add -A
git -C "$W" commit -m "fix(web): repair test imports and retire dead check-style config after package split"
```

---

## Task 3.6：文档 + changeset + 收尾

**Files:**
- Create/Modify: `packages/web-{ui,markdown,core}/README.md`（汇总消费方 vite 配置清单）
- Modify: `apps/web/README.md`（不再是 monolith；说明聚合三包）
- Modify: `code-app/AGENTS.md`（阶段状态：阶段 3 done）
- Run: `gen-changesets` skill（minor：内部重构、无 breaking；说明抽包 + 单例工厂化）

- [ ] **Step 1: 写三包 README（消费方配置：web-ui=icons+tokens、web-markdown=worker+provide、web-core=工厂+注入）**
- [ ] **Step 2: 更新 apps/web/README.md + 根 AGENTS.md 阶段状态**
- [ ] **Step 3: 跑 `gen-changesets` 生成 `.changeset/*.md`（minor，英文 changelog）**
- [ ] **Step 4: whole-branch review（reviewer subagent，范围 Task 3.0-3.6 全部 commit）**
- [ ] **Step 5: Commit**

```bash
git -C "$W" add -A
git -C "$W" commit -m "docs: document web package split and consumer vite configuration"
```

---

## 风险与回退

1. **bundler 配置扩散（最大名义风险，本期实际为 0）**：A1 下消费方只有 `apps/web` 自己，desktop / SEA 都消费 `apps/web/dist`（不直接 build 包），所以 `?worker` / unplugin-icons `kimi` collection / tokens CSS 仍只在 `apps/web/vite.config.ts` 一份，**不扩散**。这是「desktop 仍套壳」换来的关键收益，必须在 review 时确认没有被哪一步打破（即 web-ui / web-markdown 没有要求 desktop 也 vite build 它们）。
2. **web-core 解单例半成品**：用兼容 `useKimiWebClient()` composable（内部 `inject`）保住 33 处调用签名，Task 3.4 不必逐点改组件；分 3.3（api 注入）/ 3.4（状态工厂）两步，每步三绿。
3. **i18n / debug 归属摇摆**：本期 `i18n` 留 `apps/web`（`t` 经工厂 deps 注入），`debug/trace` 留 `apps/web`（`tracer` 桥接注入）。三包不反向依赖 `apps/web`。
4. **回退**：每 task 独立 commit；任一 task 三绿失败，先 `git revert` 该 task commit 回到上一绿点再排查，不带着红状态推进。

## 阶段 3 完成定义（DoD）

- `packages/web-{ui,markdown,core}` 存在，`exports → src/*.ts`，各自 typecheck + 单测绿。
- `apps/web` 改为 `import` 这三包；原 monolith 文件（`components/ui/*`、`components/chat/Markdown.vue`、`composables/useKimiWebClient.ts` 单例、`api/*`）已移除或转薄壳转发。
- 三绿：web build + desktop prebuild + sync:web。
- desktop `dev:desktop` 端到端冒烟通过（同阶段 2 验证项 + markdown 渲染 + 会话收发）。
- `useKimiWebClient` 单例已解（`createKimiWebClient` 工厂 + `provide/inject`；单测可创建两个互相隔离的 client）。
- 三包 README + 根 AGENTS.md 阶段状态 + changeset。

## 开放点（不在本阶段）

- 桌面原生骨架（desktop renderer 直接 `import` 包组件组装）—— 后续阶段。
- `i18n` 是否抽 `packages/web-i18n` —— 本期留 web。
- `debug/trace` 是否独立成包 —— 本期仅接口注入（noop 默认），不进包。
- `web-ui` 的 unplugin-icons `kimi` collection 是否提供 `webUiVitePlugin()` 工厂 —— 本期文档化（消费方仅 web），待 desktop 直接渲染时再提供。

---

## Self-Review

1. **Spec coverage**：用户选定 A1（拆库 + web 用回 + desktop 不动）→ Task 3.0–3.5 覆盖；三包 → 3.1/3.2/3.3-3.4；解 `useKimiWebClient` 单例 → 3.4；三绿 + 端到端 → 3.5；文档/changeset → 3.6。无遗漏。
2. **Placeholder scan**：关键新文件（`package.json` exports、`contracts.ts` 接口、`createKimiWebClient` 工厂签名、`KimiWebClientKey`、消费方 vite 配置片段、单测用例）均给真实代码；组件 / api 文件移动用 `git mv` 命令清单（35 个 UI / api/* / composables 来自 explore 清单），不逐行贴组件源码（执行时搬运 + 改 import）。无 TBD/TODO。
3. **Type consistency**：`createKimiWebClient` / `KimiWebClient` / `KimiWebClientKey` / `Tracer` / `CredentialStore` / `ResolveImage` / `DaemonKimiWebApi` 命名在 Task 3.0 / 3.3 / 3.4 / 3.5 一致；`noopTracer` 在 3.0 定义、3.3/3.4 引用一致。
