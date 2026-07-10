# 阶段 4：桌面原生骨架（全量）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 desktop 从 `app://` 套壳 `web-dist` 改成**原生骨架**：desktop renderer 直接组装 `@moonshot-ai/{web-ui,web-markdown,web-core,web-shell,web-i18n}` 自写完整桌面 UI（会话侧栏 + 主区聊天 + 设置 + 文件树 + 终端 + 主题 + 菜单/快捷键），主要骨架在桌面端；`useKimiWebClient` 全量工厂化解单例（每实例 client、可多窗口隔离）；web 反过来复用下沉到 `packages/web-shell` 的同一套壳组件，消除双份。

**Architecture:** 先打四个地基（共享 vite preset + §F `useKimiWebClient` 全量工厂化 + `web-i18n` 下沉 + `web-shell` 下沉），**都先在 web 端验证**（web 用回、三绿不破）；再建 desktop renderer 工程（独立 vite 用 preset → `desktop-dist`，主进程 `protocol.ts` 改指 `desktop-dist`，preload/IPC 经 `contextBridge` 白名单扩展）和 desktop 原生 `App.vue`（用 `web-ui` + `web-shell` + `web-core` 组装完整桌面 UI）；最后 `apps/web` 改 `import` `web-shell`（消双份）。依赖方向单向 `apps/{web,desktop} → packages/*`，packages 间不循环，`web-core` 无反向依赖。

**Tech Stack:** Electron 33、Vue 3.5、vue-i18n 11、Vite 6、unplugin-icons、markstream-vue（shiki/katex/mermaid workers）、TypeScript 6、vue-tsc、vitest 4、tsdown（主进程 CJS）、node-pty（主进程 server terminal，本期 server-mediated）、pnpm 10.33 workspace（`exports → src/*.ts`）。

## Global Constraints

- 仓规：`packages/*` 自动入 workspace；`exports → src/*.ts`（消费方 bundler 转译，包不预 build）。
- 不改 `kimi-code` 的 `packages/server/**`、`packages/agent-core/**`、`apps/kimi-code/src/**`（已获用户认可的拆仓改动除外，如阶段 2 server CORS `origin.ts`）。
- 依赖方向 `apps/{web,desktop} → packages/*` 单向；packages 间不循环；`web-core` 不 `import` `apps/*` / `i18n` / `debug/trace` / `toolMeta` / `vue-i18n`（全经注入）。
- **bundler 配置只许一份共享 vite preset**（`packages/vite-preset`），web + desktop renderer 都用；**禁止**两份漂移；`apps/web` 禁 `#/@/` alias（`apps/web/AGENTS.md:33`），preset 不得强注 alias。
- **preload/IPC**：`contextIsolation:true` / `sandbox:true` / `nodeIntegration:false` 不变；所有原生能力经 `contextBridge.exposeInMainWorld` 白名单，**禁**暴露 `ipcRenderer` / `node`；新增 IPC 通道必须 `preload.test.ts` / `protocol.test.ts` 覆盖。
- **dist**：CLI SEA 仍消费 `apps/web/dist → sync:web`（不变）；desktop 用独立 `desktop-dist`（`electron-builder` `extraResources` 收），与 `web-dist` 解耦；`server.ts webAssetsDir`（静态兜底）需分清「renderer 协议根」与「server 静态根」。
- Node `>=24.15.0` / pnpm `10.33.0` / `engine-strict=true`；web/desktop renderer 侧 typecheck 用 `vue-tsc`。
- Conventional Commits；**禁止** co-author；任何文本（代码/注释/commit/README）**不得出现** agent / AI 工具名称。
- 每 task 三绿：`web build` + `web typecheck` + `web vitest` + `desktop prebuild` + `sync:web`（+ 该包测试）；desktop renderer 任务再加 `desktop renderer build` + desktop GUI 冒烟。
- 命令固定（`W`=`/Users/moonshot/Desktop/moonshot/code-app`）：
  - web build：`pnpm -C "$W" --filter @moonshot-ai/kimi-web run build`
  - web typecheck：`pnpm -C "$W" --filter @moonshot-ai/kimi-web run typecheck`
  - web vitest：`pnpm -C "$W" --filter @moonshot-ai/kimi-web exec vitest run`
  - desktop prebuild：`pnpm -C "$W" --filter @moonshot-ai/kimi-desktop run prebuild`
  - sync:web：`pnpm -C "$W" run sync:web`

## 执行分组与暂停检查点

- **地基组（Task 4.0–4.3）**：都在 web 端先验证，**不破 web**。
- **⛔ 检查点 A**：地基完（web 全绿 + web GUI 不破），用户确认后进 desktop 组。
- **desktop 组（Task 4.4–4.5）**：起 desktop renderer + 原生 UI。
- **⛔ 检查点 B**：desktop 原生 UI 端到端通，用户确认后进复用组。
- **复用组 + 收尾（Task 4.6–4.7）**：web 复用 web-shell + 文档 + final review。

---

## File Structure（目标态）

```
packages/
  vite-preset/            # 4.0  kimiRendererViteConfig({ root, iconsDir, defines }) + *.d.ts（icons/?worker）
  web-i18n/               # 4.2  locales/{en,zh} + createKimiI18n({ locale }) 工厂（web-markdown 经此收口 I-1）
  web-shell/              # 4.3  Sidebar / TopBar / SessionRow / WorkspaceGroup / settings/SettingsDialog /
                          #      dialogs/* / ConversationPane / MessageItem / ChatInput（依赖 web-core+web-ui+web-i18n）
  web-ui/  web-markdown/  web-core/   # 已存在（阶段 3）
apps/
  web/                    # 薄壳聚合（4.1 工厂化 main.ts provide；4.6 复用 web-shell）
  desktop/
    src/
      main/               # 主进程（index/protocol/preload/server 已存在；4.4 protocol webDistRoot 改指 desktop-dist、preload/IPC 扩展）
      renderer/           # 4.4 新增：main.ts + App.vue + bootstrap.ts + router?(可选) + components?(少量 desktop-only)
    desktop-dist/         # 4.4 renderer vite build 产物（gitignored，electron-builder extraResources 收）
    out/                  # 主进程 tsdown CJS（已存在）
```

依赖方向（review 关卡）：
- `apps/web → { web-ui, web-markdown, web-core, web-i18n, web-shell, vite-preset(dev) }`
- `apps/desktop → { web-ui, web-markdown, web-core, web-i18n, web-shell, vite-preset(dev), @moonshot-ai/server, @moonshot-ai/kimi-code-sdk }`
- `web-shell → { web-core, web-ui, web-i18n }`；`web-markdown → { web-core, web-ui }`；`web-i18n → (vue-i18n)`；`vite-preset → (vite, unplugin-icons, 类型)`
- 禁止 `web-core → apps/*`、禁止 `web-ui ↔ web-core`、禁止 `web-shell → apps/*`。

---

## Task 4.0：共享 vite preset（`packages/vite-preset`）+ `apps/web` 改用 preset

**Files:**
- Create: `packages/vite-preset/package.json`（exports: `{ ".": "./src/index.ts", "./icons": "./src/icons.d.ts", "./worker": "./src/worker.d.ts" }`）、`tsconfig.json`
- Create: `packages/vite-preset/src/index.ts`（`kimiRendererViteConfig` 工厂）+ `src/icons.d.ts`（`~icons/*` 类型）+ `src/worker.d.ts`（`*?worker&type=module` 类型）
- Create: `packages/vite-preset/test/preset.test.ts`
- Modify: `apps/web/vite.config.ts` 改为调用 `kimiRendererViteConfig({ root, iconsDir, defines })`（删内联重复配置）
- Modify: `apps/web/src/env.d.ts` → `import '@moonshot-ai/vite-preset/icons'` + `import '@moonshot-ai/vite-preset/worker'`（去内联类型声明）
- Modify: `apps/web/package.json` devDeps 加 `@moonshot-ai/vite-preset: workspace:*`

**接口（Produces）：**
```ts
// packages/vite-preset/src/index.ts
import type { UserConfig } from 'vite';
export interface KimiRendererViteOptions {
  readonly root: string;                 // 消费方根（apps/web 或 apps/desktop）
  readonly iconsDir: string;             // kimi collection 的 SVG 目录（参数化，不硬编码）
  readonly defines?: Record<string, string>;  // __KIMI_* define（可裁剪；desktop 不带 __KIMI_DEV_PROXY_TARGET__）
  readonly target?: string;              // 默认 'es2022'
}
export function kimiRendererViteConfig(opts: KimiRendererViteOptions): UserConfig;
// 内含：vue()、unplugin-icons（compiler:'vue3' + customCollections.kimi=FileSystemIconLoader(iconsDir)）、
//       worker.format:'es'、build.target、define __KIMI_*（按 defines）、resolve 不强注 alias。
```
- Consumes：无（新增包）。`iconsDir` 参数化（图标 `apps/web/src/icons/kimi` 暂留 web；后续可下沉，开放点）。

**`packages/vite-preset/test/preset.test.ts`（TDD）：**
```ts
import { describe, expect, it } from 'vitest';
import { kimiRendererViteConfig } from '#/index';
describe('kimiRendererViteConfig', () => {
  it('emits worker.format es, es2022 target, and kimi icons collection, no alias', () => {
    const cfg = kimiRendererViteConfig({ root: '/x', iconsDir: '/x/icons/kimi', defines: { __KIMI_X__: '1' } });
    expect(cfg.worker).toEqual({ format: 'es' });
    expect(cfg.build?.target).toBe('es2022');
    expect(cfg.define).toMatchObject({ __KIMI_X__: '1' });
    expect((cfg.resolve?.alias ?? {})).toEqual({});
    const plugins = (cfg.plugins ?? []).flat().filter(Boolean).map((p: any) => p?.name).join('|');
    expect(plugins).toMatch(/unplugin-icons/);
  });
});
```

- [ ] **Step 1: 写 preset 包（package.json/tsconfig/src/index.ts+类型声明）+ `pnpm install`**
- [ ] **Step 2: 写 `test/preset.test.ts` → RED → 实现 → GREEN**（`pnpm --filter @moonshot-ai/vite-preset exec vitest run`）
- [ ] **Step 3: 改 `apps/web/vite.config.ts` 用 preset + `env.d.ts` 改 import preset 类型**
- [ ] **Step 4: 三绿 + 配置等价核对**：web build / typecheck / vitest 全 PASS；`diff <(node -e "console.log(JSON.stringify(require('./apps/web/vite.config.ts').default.worker)))"` 等关键字段（worker.format/build.target/define/icons collection）与改前一致（报告贴等价证据）；`apps/web/vite.config.ts` 行数显著减少（配置下沉 preset）
- [ ] **Step 5: Commit**

```bash
git -C "$W" add -A
git -C "$W" commit -m "feat(vite-preset): add shared kimi renderer vite config and migrate web to it"
```

---

## Task 4.1：web 侧 facade provide + `KimiWebClientFacadeKey`（为 web-shell inject 复用铺路；`useKimiWebClient.ts` 不动）

> **范围调整（human 决议，2026-07-10）**：`useKimiWebClient.ts` **保持现状不动**（web 模块级单例 facade，零重写、零 BLOCKED 风险）。web 与 desktop **暂时各写一套 facade**：web 用 `useKimiWebClient.ts`（旧单例），desktop 在 Task 4.5 自写 `buildDesktopClient`（`createKimiWebClientCore` + `DaemonKimiWebApi` + desktop computed/actions）。两端共享 `packages/*`（状态机核 + daemon api + reduce + web-ui/web-shell/web-i18n），重复只在 facade 薄层（后续稳定后再合并到共享包消除重复）。
>
> 本 task 只做一件小事：让 `apps/web` 把现状单例 facade 经 `provide` 暴露给（未来下沉的）`web-shell` 组件，使 `web-shell` 组件能经 `inject(KimiWebClientFacadeKey)` 拿 facade、而**不 import** `useKimiWebClient.ts`（为 4.3 web-shell 下沉铺路）。`useKimiWebClient.ts` 内部不动，24 处 `useKimiWebClient()` 调用不变。

**Files:**
- Create: `packages/web-core/src/KimiWebClientFacadeKey.ts`
- Modify: `packages/web-core/src/index.ts` re-export `KimiWebClientFacadeKey` + `KimiWebClientFacade`（type）
- Modify: `apps/web/src/main.ts` —— `import { useKimiWebClient } from './composables/useKimiWebClient'` + `import { KimiWebClientFacadeKey } from '@moonshot-ai/web-core'`；`app.provide(KimiWebClientFacadeKey, useKimiWebClient())`

**接口（Produces）：**
```ts
// packages/web-core/src/KimiWebClientFacadeKey.ts
import type { InjectionKey } from 'vue';
import type { KimiClientState } from './api/daemon/eventReducer';
export interface KimiWebClientFacade extends KimiClientState {
  // 壳组件用到的 computed/actions 子集（执行时按 Sidebar/ConversationPane 等实际用法补齐）
  sendMessage?: (...args: unknown[]) => unknown;
  setActiveSession?: (id: string) => void;
}
export const KimiWebClientFacadeKey: InjectionKey<KimiWebClientFacade> = Symbol('KimiWebClientFacade');
```

- [ ] **Step 1: grep 将下沉 web-shell 的组件（`Sidebar`/`ConversationPane`/`SessionRow`/`WorkspaceGroup`/`settings`/`chat`）对 `useKimiWebClient()` 的字段使用，定 `KimiWebClientFacade` 子集类型；写 `KimiWebClientFacadeKey.ts` + index re-export**
- [ ] **Step 2: `apps/web/src/main.ts` `import { useKimiWebClient } from './composables/useKimiWebClient'` + `import { KimiWebClientFacadeKey } from '@moonshot-ai/web-core'`；`app.provide(KimiWebClientFacadeKey, useKimiWebClient())`**
- [ ] **Step 3: 验证**：三绿（web build/typecheck/vitest）+ `grep -c "useKimiWebClient()" apps/web/src` 调用点计数 = 现状（不变）+ web GUI 冒烟（会话/收发不破）
- [ ] **Step 4: Commit** `feat(web): provide useKimiWebClient facade via KimiWebClientFacadeKey for shell injection`

> 以下为旧 4.1a / 4.1b（§F 全量工厂化），**已作废，执行以上方新内容为准**。

> 阶段 3 推迟项，阶段 4 硬前置。目标：`useKimiWebClient()` 从模块级单例改为 `buildClient()` 每实例工厂 + `provide/inject`，24 处调用签名/扁平返回形态不变，非单例单测两实例隔离。拆 4.1a（facade 工厂化 + 引用不断）+ 4.1b（client/* deps + main.ts provide + 兼容）。

### Task 4.1a：facade 工厂化（`buildClient` 每实例，computed/actions 闭包引用同一 rawState，不包外层 Proxy）

**Files:**
- Modify: `apps/web/src/composables/useKimiWebClient.ts`（2675→重构）：把模块级 `rawState`(≈362) / `eventConn`(≈707) / ≈150 computed / 顶层副作用（≈123/127/499 visibilitychange）从**模块作用域**移到 `buildClient(deps)` **工厂闭包**；返回扁平对象（rawState 字段 + computed + actions 挂同一 reactive 根，保引用）。
- Create: `apps/web/src/composables/buildKimiWebClient.ts`（若拆文件）或内联在 `useKimiWebClient.ts`（依文件体量，plan 不强制 split）。
- Create: `apps/web/test/buildKimiWebClient.test.ts`

**接口（Produces，扁平返回形态逐字段不变）：**
```ts
// apps/web/src/composables/useKimiWebClient.ts（重构后）
import { reactive, computed, inject } from 'vue';
import { createInitialState, reduceAppEvent, type KimiClientState } from '@moonshot-ai/web-core';
import type { DaemonKimiWebApi } from '@moonshot-ai/web-core/api';
import type { Tracer } from '@moonshot-ai/web-core/contracts';

export interface ExtendedState extends KimiClientState { /* apps/web UI 字段：connected/permission/thinking/planModeBySession/workspaces/gitStatusBySession/sideChat*/… */ }
export interface BuildClientDeps {
  api: DaemonKimiWebApi;
  t: (k: string, p?: Record<string, unknown>) => string;
  tracer?: Tracer;
  /* shell deps（confirm/routing/notification 等，4.1b 补全） */
}
export interface KimiWebClientFacade {
  /* 现状 useKimiWebClient() 返回的 ≈100+ 扁平字段（rawState 字段 + computed + actions），逐字段保留 */
  install(): void;   // 注册 window.storage / visibilitychange / connectEvents（deps.api + reduce 改 rawState）
  dispose(): void;   // 解注册
}
export function buildClient(deps: BuildClientDeps): KimiWebClientFacade {
  const rawState = reactive({ ...createInitialState(), /* ExtendedState UI 字段初值 */ }) as ExtendedState;
  // computed（turns/tasks/swarms/status/permission/…）= computed(() => rawState.x)  ← 闭包引用同一 rawState
  // actions = createActions(rawState, deps)（4.1b）
  // eventConn = deps.api.connectEvents(e => { const next = reduceAppEvent(rawState, e, meta, { t: deps.t }); Object.assign(rawState, next); })
  // install/dispose 注册/解注册监听（原 :462-501 / :123/127）
  return { ...rawState, /* computed */, /* actions(4.1b) */, install() {/*…*/}, dispose() {/*…*/} };
}
```
**引用不断的实现**：`rawState` 是单一 `reactive` 根（ExtendedState 全字段在 apps/web 创建，reducer 只改 12 raw 字段、UI 字段不动），computed/actions 在工厂闭包内引用**同一** `rawState`（与现单例同构，仅从模块作用域移到工厂闭包）；返回对象直接挂 rawState 字段 + computed + actions（不要 `reactive({...rawState})` 复制、不要外层 Proxy）。视图层 `toRefs` 解构保响应。

- [ ] **Step 1: 把模块级 rawState/eventConn/computed 移进 `buildClient` 闭包（actions 留 4.1b，先返回 rawState+computed+install/dispose 占位）**
- [ ] **Step 2: 写 `test/buildKimiWebClient.test.ts`（两 buildClient 实例 rawState 隔离 + computed 引用同一 rawState 不断裂）→ RED → GREEN**

```ts
import { describe, expect, it } from 'vitest';
import { buildClient } from '#/composables/useKimiWebClient';
describe('buildClient facade', () => {
  it('isolates state and keeps computed reactive to the same rawState', () => {
    const api = {} as any;
    const a = buildClient({ api, t: (k) => k });
    const b = buildClient({ api, t: (k) => k });
    a.activeSessionId = 'x';
    expect(b.activeSessionId).not.toBe('x');
    // computed 引用同一 rawState：改 raw 字段，computed 跟着变（不断裂）
    // …据真实 computed 补一条
  });
});
```

- [ ] **Step 3: 三绿 + 单测**（web build/typecheck/vitest 全 PASS）
- [ ] **Step 4: Commit** `refactor(web): move useKimiWebClient module singleton into buildClient factory`

### Task 4.1b：`client/*` deps 改写 + `main.ts` provide + 兼容 `useKimiWebClient()`

**Files:**
- Modify: `apps/web/src/composables/client/{useWorkspaceState,useModelProviderState,useSideChat,useTaskPoller}.ts` —— `getKimiWebApi()`(×≈30/16/3/3）→`deps.api`；`i18n.global.t`→`deps.t`（机械改写，不改文件边界、不 split 91KB useWorkspaceState）；返回 actions 工厂 `createActions(rawState, deps)`。
- Modify: `apps/web/src/composables/useKimiWebClient.ts`：`buildClient` 接 actions（`createActions(rawState, deps)`），返回补 `...actions`；保留**兼容** `useKimiWebClient()` 内部 `inject(KimiWebClientCoreKey?)` → 实际取 main.ts provide 的 facade（见下）。
- Create: `apps/web/src/composables/KimiWebClientFacadeKey.ts`（`InjectionKey<KimiWebClientFacade>`）
- Modify: `apps/web/src/main.ts`：`const facade = buildClient({ api, t: (k,p)=>i18n.global.t(k,p), tracer: webTracer, /* shell deps */ })` + `app.provide(KimiWebClientFacadeKey, facade)` + `facade.install()`（`onMounted` 调 install / `onUnmounted` dispose，或 main.ts 顶层调）。
- Verify: 24 处 `useKimiWebClient()` 调用签名/解构不变（grep 计数）。

- [ ] **Step 1: client/* 机械改写（getKimiWebApi→deps.api、i18n→deps.t）→ `createActions(rawState, deps)`**
- [ ] **Step 2: buildClient 接 actions；兼容 `useKimiWebClient()`（inject facade + 扁平返回形态不变）**
- [ ] **Step 3: main.ts buildClient + provide + install**
- [ ] **Step 4: 三绿 + web vitest + grep**：`grep -rn "getKimiWebApi\|i18n.global.t" apps/web/src/composables/client` = 0；`grep -c "useKimiWebClient()" apps/web/src` 调用点 = 现状计数（不变）
- [ ] **Step 5: web GUI 冒烟**（会话列表/收发消息/markdown/theme，与阶段 3 同口径，必须不破）
- [ ] **Step 6: Commit** `refactor(web): inject api and translator into client actions; provide facade`

> 4.1 整体验证标准（4.1a+4.1b 都过）：`useKimiWebClient` 模块级单例已解（`buildClient` 每实例 + `provide/inject`；非单例单测两实例隔离；24 处调用零改动；web 三绿 + web GUI 不破）。

---

## Task 4.2：`web-i18n` 下沉（locale + `createKimiI18n` 工厂）+ 收口 I-1（`web-markdown` 全局 vue-i18n）

**Files:**
- Create: `packages/web-i18n/package.json`（exports: `{ ".": "./src/index.ts" }`，peerDeps `vue ^3.5.35`、deps `vue-i18n ^11.4.5` 与 apps/web 锁定一致）、`tsconfig.json`
- Create: `packages/web-i18n/src/index.ts` + `createKimiI18n.ts` + `KimiI18nKey.ts`
- Move (git mv): `apps/web/src/i18n/locales/{en,zh}/*.ts` → `packages/web-i18n/src/locales/{en,zh}/*.ts`；`apps/web/src/i18n/index.ts` 逻辑（detect + createI18n）抽进 `createKimiI18n.ts`
- Modify: `packages/web-markdown/src/Markdown.vue`（收口 I-1）—— `import { useI18n } from 'vue-i18n'` + `useI18n()`（`:82`）→ `import { useKimiI18n } from '@moonshot-ai/web-i18n'`；`const { t } = useKimiI18n()`
- Modify: `apps/web/src/main.ts` —— `createKimiI18n({ locale })` + `app.use(i18n)` + `app.provide(KimiI18nKey, i18n.global)`
- Modify: `apps/web/package.json` deps 加 `@moonshot-ai/web-i18n: workspace:*`；`packages/web-markdown/package.json` deps 加 `@moonshot-ai/web-i18n: workspace:*`

**接口（Produces）：**
```ts
// packages/web-i18n/src/index.ts
import { createI18n, type I18n } from 'vue-i18n';
import type { InjectionKey } from 'vue';
import en from './locales/en';
import zh from './locales/zh';
export const messages = { en, zh };
export interface KimiI18nApi {
  readonly t: (key: string, params?: Record<string, unknown>) => string;
  readonly locale?: string;
}
export const KimiI18nKey: InjectionKey<KimiI18nApi> = Symbol('KimiI18n');
export function createKimiI18n(opts: { locale?: string }): I18n;       // 封装 detect + createI18n(legacy:false)
/** inject 优先；消费方未 provide 时回退全局 vue-i18n；再无则 t=(k)=>k（不抛） */
export function useKimiI18n(): KimiI18nApi;
```

- [ ] **Step 1: 写 web-i18n 包（package.json/tsconfig/src/index.ts+createKimiI18n+KimiI18nKey）+ git mv locales + `pnpm install`**
- [ ] **Step 2: 单测 `test/i18n.test.ts`（`createKimiI18n({locale:'zh'}).global.t('ns.key')` 返回中文；`useKimiI18n` inject 优先于全局）→ RED → GREEN**
- [ ] **Step 3: Markdown.vue 改 `useKimiI18n()`（收口 I-1）+ apps/web main.ts createKimiI18n + provide**
- [ ] **Step 4: 三绿 + 单测 + grep**：`grep -rn "from 'vue-i18n'\|useI18n(" packages/web-markdown/src` = 0（I-1 收口，web-markdown 不再硬依赖全局 vue-i18n）；web GUI 文案正常（中英切换）
- [ ] **Step 5: Commit** `feat(web-i18n): extract locale and createKimiI18n factory; inject translator into web-markdown`

---

## Task 4.3：~~web-shell 下沉~~ **已取消（human 决议 2026-07-10）**

> **范围调整**：连续两个 BLOCKED（4.1a §F 工厂化、4.3a web-shell 下沉）表明 web 端代码（`useKimiWebClient.ts` + 壳组件）深度耦合 `apps/web` 私有（Vite define `__KIMI_*` / 视图类型 / views / dialogs / storage / workspaceOrder / debug/trace），抽共享复用代价过高。改为 **desktop 自写 UI shell + facade**：用 `web-core`（`createKimiWebClientCore` + `DaemonKimiWebApi` + `reduceAppEvent`）+ `web-ui` 基础组件 + **自写 UI shell**（Sidebar / ConversationPane / settings / 文件树 / 终端 桌面版）+ **自写 facade**（computed / actions）。web 端 `useKimiWebClient.ts` + 壳组件留 `apps/web` 不动（零影响）。
>
> **联动**：**Task 4.6（web 复用 web-shell）同步取消**（web-shell 不存在，web 继续用 `apps/web` 壳组件）。**Task 4.5 desktop 原生 UI 全自写**（不复用 web-shell，用 web-ui 基础组件 + web-core + 自写 UI shell + 自写 facade）。保留 Task 4.0（preset）/ 4.1（facade provide，潜在 inject 留路，无害）/ 4.2（web-i18n，desktop 要用 i18n）。
>
> 下文 4.3a / 4.3b 旧内容保留供参考，**全部作废，不执行**。

> 拆 4.3a（基础 shell）+ 4.3b（聊天主区）。前置：4.1 已工厂化（壳组件从 `useKimiWebClient()` 单例改 `inject(KimiWebClientCoreKey)` / `inject(KimiWebClientFacadeKey)`）。

### Task 4.3a：基础壳（Sidebar / TopBar / SessionRow / WorkspaceGroup / settings / SettingsDialog / dialogs）

**Files:**
- Create: `packages/web-shell/package.json`（exports: `{ ".": "./src/index.ts" }`，deps `@moonshot-ai/web-core/web-ui/web-i18n: workspace:*`，peerDeps `vue ^3.5.35`）、`tsconfig.json`
- Move (git mv): `apps/web/src/components/Sidebar.vue`、`TopBar.vue`(MobileTopBar)、`SessionRow.vue`、`WorkspaceGroup.vue`、`settings/SettingsDialog.vue`、`dialogs/*.vue`(通用壳：ConfirmDialog+Host / BottomSheet / ServerAuthDialog?) → `packages/web-shell/src/components/`
- Create: `packages/web-shell/src/index.ts`（named export 各组件）
- Modify: 壳组件内 `useKimiWebClient()` → `inject(KimiWebClientCoreKey)`（拿 core.state）+ 必要时 `inject(KimiWebClientFacadeKey)`（actions）；`import … from '@moonshot-ai/web-ui'` / `'@moonshot-ai/web-i18n'`；相对 `../ui/X` → `@moonshot-ai/web-ui`
- Modify: `apps/web` 引用壳组件处改 `import { … } from '@moonshot-ai/web-shell'`；`apps/web/package.json` deps 加 `@moonshot-ai/web-shell: workspace:*`

**接口（Produces）：** `packages/web-shell/src/index.ts`：`export { default as Sidebar } from './components/Sidebar.vue'` 等（named export 全部下沉壳组件）。Consumes：`web-core`（`KimiWebClientCoreKey` / `useIsDark` / `useAppearance`）、`web-ui`、`web-i18n`。

- [ ] **Step 1: 写 web-shell 包（package.json/tsconfig/src/index.ts）+ git mv 基础壳组件 + `pnpm install`**
- [ ] **Step 2: 壳组件 `useKimiWebClient()` → inject core/facade；UI/i18n 引用改包名**
- [ ] **Step 3: apps/web 引用改 `@moonshot-ai/web-shell`**
- [ ] **Step 4: 三绿 + grep**：`apps/web/src/components/Sidebar.vue` 等已空；`grep -rn "apps/web" packages/web-shell/src` = 0（无反向依赖）；web GUI 侧栏/会话/设置渲染与改前等价
- [ ] **Step 5: Commit** `feat(web-shell): extract base shell components (sidebar, topbar, session, workspace, settings, dialogs)`

### Task 4.3b：聊天主区（ConversationPane + 消息项 + 输入框）

**Files:**
- Move (git mv): `apps/web/src/components/ConversationPane.vue`(若存在；否则 `chat/` 下主区组件) + `apps/web/src/components/chat/{MessageItem,ChatInput,TurnBlock,…}.vue`(聊天主区相关) → `packages/web-shell/src/components/chat/`
- Modify: `packages/web-shell/src/index.ts` 增 export
- Modify: 聊天组件内 `useKimiWebClient()` → inject；`import { Markdown } from '@moonshot-ai/web-markdown'`（消息渲染）；UI/i18n 改包名
- Modify: `apps/web` 引用改 `@moonshot-ai/web-shell`

**接口（Produces）：** `ConversationPane` / `MessageItem` / `ChatInput` 等 named export。Consumes：`web-core`、`web-ui`、`web-markdown`、`web-i18n`。

- [ ] **Step 1: git mv 聊天主区组件到 `packages/web-shell/src/components/chat/`**
- [ ] **Step 2: inject + import 改包名（含 Markdown from web-markdown）**
- [ ] **Step 3: apps/web 引用改 `@moonshot-ai/web-shell`**
- [ ] **Step 4: 三绿 + grep 无反向依赖 + web GUI 聊天主区渲染/发消息/markdown 与改前等价**
- [ ] **Step 5: Commit** `feat(web-shell): extract conversation pane and chat components`

> 4.3 整体验证：`apps/web/src/components/` 仅剩 desktop/web 特有或根级（`App.vue`/`DesignSystemView`），壳组件全在 `packages/web-shell`；`apps/web` 经 `@moonshot-ai/web-shell` 复用；无反向依赖；web GUI 全口径不破。

> **⛔ 检查点 A（地基组完成）**：Task 4.0–4.3 全绿 + web GUI 全口径（侧栏/会话/聊天/设置/文案/markdown/theme）不破 + 三包/四包 typecheck+单测绿。用户确认后进 desktop 组（Task 4.4）。

---

## Task 4.4：desktop renderer 工程（独立 vite → `desktop-dist`；protocol 改指；preload/IPC 扩展）

> 产出：`apps/desktop/src/renderer/` 入口 + 独立 vite build（preset）→ `desktop-dist`；`app://renderer` 改指 `desktop-dist`；`apps/web` 三绿不破、CLI SEA `sync:web` 链路不变；preload/IPC 经 contextBridge 白名单扩展并测试覆盖。`App.vue` 本 task 仅占位（hello + 主题 + 一个 `web-ui` Button 验证 preset/IPC 通），完整 UI 在 4.5。

**Files:**
- Create: `apps/desktop/src/renderer/index.html`、`main.ts`、`App.vue`（占位）、`bootstrap.ts`（tracer/credentialStore 占位，projector 在 4.5a 接）、`env.d.ts`（`import '@moonshot-ai/vite-preset/icons'` + `'.../worker'`）
- Create: `apps/desktop/vite.renderer.config.ts` —— `kimiRendererViteConfig({ root: __dirname, iconsDir: '<repo>/apps/web/src/icons/kimi', defines: { __KIMI_DESKTOP__: 'true' } })`（**不带** `__KIMI_DEV_PROXY_TARGET__`）
- Modify: `apps/desktop/package.json` —— deps 加 `@moonshot-ai/{web-ui,web-markdown,web-core,web-i18n,web-shell}: workspace:*` + `vue` + `vue-i18n`（与 apps/web 锁定）；devDeps 加 `vite` + `@moonshot-ai/vite-preset: workspace:*` + `vue-tsc` + `typescript`；scripts 加 `"build:renderer": "vite build --config vite.renderer.config.ts"`，并把 `prebuild` 由 `copy-web-dist.mjs` 改为 `node scripts/build-renderer.mjs`（或 `npm run build:renderer`，产物 `desktop-dist/`）
- Delete/Retire: `apps/desktop/scripts/copy-web-dist.mjs`（desktop 不再拷 web-dist；保留文件但 build 链路改 build:renderer，避免误用）
- Modify: `apps/desktop/src/main/protocol.ts` —— `webDistRoot()` 改名 `rendererDistRoot()` 改指 `desktop-dist`（dev `<appPath>/desktop-dist`、packaged `<resourcesPath>/desktop-dist`）；`rendererUrl()` 不变；`server.ts` 的 `webAssetsDir`（静态兜底）指向同一 `desktop-dist`（与 renderer 一致；server 主要 serve API，静态是 fallback，需在 review 确认无副作用）
- Modify: `apps/desktop/electron-builder.config.cjs` —— `files`/`extraResources` 收 `desktop-dist/**`（替换原 `web-dist/**`）；`out/**`（主进程）保留；`asarUnpack node-pty` 保留
- Modify: `apps/desktop/src/main/preload.ts` —— 扩展 `contextBridge.exposeInMainWorld('kimiDesktop', { … })` 白名单：在现有 `{ setTheme, onMenu, openExternal }` 上加 `onMenuAction(cb)`、`onShortcut(cb)`、`showOpenDialog(opts)`、`showSaveDialog(opts)`（禁暴露 `ipcRenderer`/`node`，全部经白名单方法）
- Modify: `apps/desktop/src/main/index.ts` —— `webDistRoot()`→`rendererDistRoot()`；注册 `ipcMain.handle('kimi:dialog-open')`、`('kimi:dialog-save')`、`Menu` 项 click → `webContents.send('kimi:menu-action', id)`、`globalShortcut.register` → `send('kimi:shortcut', accel)`（4.5 接 UI）
- Test: `apps/desktop/src/main/preload.test.ts`（contextBridge 只暴露白名单 API，不暴露 `ipcRenderer`/`node`/`require`）+ `apps/desktop/src/main/protocol.test.ts`（`app://renderer/<path>` 映射 `desktop-dist` + 三层防 `..` 穿越，复用阶段 2 测试扩展）

**接口（Produces）：**
```ts
// apps/desktop/src/renderer/main.ts（占位）
import { createApp } from 'vue';
import { createKimiI18n, KimiI18nKey } from '@moonshot-ai/web-i18n';
import '@moonshot-ai/web-ui/style.css';
import App from './App.vue';
const i18n = createKimiI18n({});
createApp(App).use(i18n).provide(KimiI18nKey, i18n.global).mount('#app');
```

- [ ] **Step 1: 建 renderer 工程（index.html/main.ts/App.vue 占位/bootstrap.ts 占位 + vite.renderer.config.ts 用 preset）+ `pnpm install`**
- [ ] **Step 2: `package.json` 依赖 + scripts（build:renderer、prebuild 改 build:renderer）+ `protocol.ts rendererDistRoot()` + `electron-builder.config.cjs` 收 desktop-dist + retire copy-web-dist**
- [ ] **Step 3: preload 扩展白名单 + 主进程 IPC handle/send（菜单/快捷键/对话框）**
- [ ] **Step 4: 写 `preload.test.ts` + `protocol.test.ts`（RED→GREEN）**
- [ ] **Step 5: 验证**：`pnpm --filter @moonshot-ai/kimi-desktop run build:renderer`（产 `desktop-dist/`，icons/tokens/`?worker` 经 preset 全通）；三绿（web build/typecheck/vitest 不破）+ `sync:web`（SEA 不变）；`pnpm --filter @moonshot-ai/kimi-desktop exec electron .` 起窗口 → `app://renderer` 指 `desktop-dist`，渲染占位 App.vue（主题 + 一个 web-ui Button + DevTools 无 CORS 红）
- [ ] **Step 6: Commit** `feat(desktop): add native renderer build (desktop-dist) and expand preload IPC whitelist`

---

## Task 4.5：desktop 原生 UI **全自写**（web-ui + web-core + 自写 UI shell + 自写 facade）

> **范围调整（human 决议 2026-07-10，D1）**：不复用 web-shell（已取消）。desktop UI shell（Sidebar / ConversationPane / settings / 文件树 / 终端）**全部自写**（用 web-ui 基础组件 + web-core `createKimiWebClientCore` + `DaemonKimiWebApi` + `reduceAppEvent`），facade 自写（computed / actions，`createKimiWebClientCore` + `DaemonKimiWebApi`）。下文 4.5a / 4.5b 旧内容（用 web-shell 组装）**已作废，执行以 D1 全自写为准**。拆 4.5a（bootstrap + `buildDesktopClient` facade + `App.vue` 骨架 + 会话侧栏 + 主区聊天 + 输入框）+ 4.5b（设置 + 文件树 + 终端经 server WS + 快捷键/菜单/通知）。

> 拆 4.5a（bootstrap + projector/toolMeta 下沉 web-core + App.vue 骨架 + 会话侧栏 + 主区聊天 + 输入框）+ 4.5b（设置 + 文件树 + 终端经 server WS + 快捷键/菜单/通知）。这是阶段 4 体量最大、最易 BLOCKED 的 task，严格小步、每步三绿 + desktop GUI 验证。

### Task 4.5a：bootstrap + `createAgentProjector`/`toolMeta` 下沉 web-core + `App.vue` 骨架（侧栏 + 主区聊天 + 输入框）

**Files:**
- Move (git mv): `apps/web/src/api/daemon/agentEventProjector.ts` + `apps/web/src/lib/toolMeta.ts` → `packages/web-core/src/api/daemon/agentEventProjector.ts` + `packages/web-core/src/lib/toolMeta.ts`（toolMeta 纯数据；projector 内 `i18n.global.t` → `deps.t` 注入，与 eventReducer 同模式；apps/web 改 import from `@moonshot-ai/web-core`）
- Create: `apps/desktop/src/renderer/bootstrap.ts` —— 复用 apps/web `bootstrap.ts` 模式但 desktop 自有一份（不能 import apps/web）：`new DaemonKimiWebApi({ identity, tracer: desktopTracer, credentialStore: desktopCredentialStore, projectorFactory: () => createAgentProjector({ t }) })`，`desktopTracer` 默认 `noopTracer`（desktop 无 debug/trace，可后续接），`desktopCredentialStore.getToken()` 读 `serverTokenPath`（经 preload 或主进程 IPC 拿 token，**不**直接读 fs——经 `kimiDesktop.getServerToken()` 白名单）；
- Modify: `apps/desktop/src/renderer/App.vue` —— 用 `web-shell` 的 `Sidebar` + `ConversationPane` + `ChatInput` + `web-ui` 基础组件组装骨架；`createKimiWebClientCore({ api, t })` + `buildDesktopClient(core.state, deps)`（desktop ExtendedState + computed + actions，闭包引用同一 rawState，保引用；同 4.1a buildClient 范式）+ `provide(KimiWebClientFacadeKey, facade)` + `facade.install()`
- Create: `apps/desktop/src/renderer/buildDesktopClient.ts`（desktop 的 facade 工厂，参考 `apps/web/src/composables/buildKimiWebClient.ts`，ExtendedState 字段按桌面 UI 定）

**接口（Produces）：**
```ts
// apps/desktop/src/renderer/bootstrap.ts
import { DaemonKimiWebApi } from '@moonshot-ai/web-core/api';
import { createAgentProjector } from '@moonshot-ai/web-core/api/daemon/agentEventProjector';
import { noopTracer } from '@moonshot-ai/web-core/contracts';
export function createDesktopApi(opts: { origin: string; identity: object; token?: string; t: (k,p?)=>string }) {
  return new DaemonKimiWebApi({
    identity: opts.identity,
    tracer: noopTracer,
    credentialStore: { getToken: () => opts.token, markAuthRequired: () => {} },
    projectorFactory: () => createAgentProjector({ t: opts.t }),
  });
}
```

- [ ] **Step 1: git mv `agentEventProjector.ts` + `toolMeta.ts` → web-core（projector `i18n.global.t`→`deps.t`；apps/web 改 import from web-core；三绿 + web GUI 不破）**
- [ ] **Step 2: desktop `bootstrap.ts`（tracer/credentialStore/projectorFactory 桥，token 经 `kimiDesktop.getServerToken()` 白名单）+ preload 增 `getServerToken()`**
- [ ] **Step 3: `buildDesktopClient.ts`（desktop ExtendedState + computed + actions，闭包引用同一 rawState）**
- [ ] **Step 4: `App.vue` 组装 `Sidebar` + `ConversationPane` + `ChatInput`（web-shell）+ createKimiWebClientCore + provide facade + install**
- [ ] **Step 5: 验证**：desktop renderer build 绿；三绿（web 不破）+ `sync:web`；desktop GUI：会话侧栏列出 sessions、选会话、主区聊天渲染、输入框发消息 + 收回复（api + 状态机端到端）、markdown 渲染、theme IPC
- [ ] **Step 6: Commit** `feat(desktop): wire desktop renderer bootstrap and assemble session sidebar + conversation`

### Task 4.5b：设置 + 文件树/工作区 + 终端（server WS）+ 快捷键/菜单/通知

**Files:**
- Modify: `apps/desktop/src/renderer/App.vue` —— 接入 `SettingsDialog`（web-shell）+ `WorkspaceGroup`（web-shell 文件树，经 `kimiDesktop.showOpenDialog()` 选目录）+ `Terminal`（下沉 `apps/web/src/components/Terminal.vue` 到 web-shell 或 web-ui，经 server WS `api.list/createTerminal` + `connectEvents({onTerminalOutput,onTerminalExit})`，复用 server-mediated pty，**不**在主进程 spawn）+ 菜单/快捷键 action 监听（`kimiDesktop.onMenuAction`/`onShortcut` 触发 UI action）+ 通知（`Notification` API 或主进程）
- Move (git mv): `apps/web/src/components/Terminal.vue` + `useTerminal.ts` → `packages/web-shell/src/components/Terminal.vue` + `packages/web-shell/src/composables/useTerminal.ts`（经 server WS，server-mediated；apps/web 改 import from web-shell）

- [ ] **Step 1: git mv Terminal.vue+useTerminal → web-shell（server-mediated pty）+ apps/web 改 import**
- [ ] **Step 2: App.vue 接 SettingsDialog + WorkspaceGroup（showOpenDialog）+ Terminal + 菜单/快捷键 action 监听 + 通知**
- [ ] **Step 3: 验证**：desktop renderer build 绿；三绿 + `sync:web`；desktop GUI 全口径：设置面板、文件树选工作区（dialog）、终端 spawn/输入/输出（server-mediated）、全局快捷键、菜单项 action、通知
- [ ] **Step 4: Commit** `feat(desktop): add settings, workspace tree, terminal, shortcuts and menu actions to native UI`

> 4.5 整体验证：desktop 原生 `App.vue` 完整桌面 UI（会话侧栏 + 主区聊天 + 设置 + 文件树 + 终端 + 主题 + 快捷键 + 菜单），端到端冒烟全过；`apps/web` 三绿不破、CLI SEA `sync:web` 不变；preload 白名单测试覆盖。

> **⛔ 检查点 B（desktop 原生 UI 完成）**：desktop `dev:desktop` 原生 UI 端到端全口径通过（不再套 web-dist，app://renderer 指 desktop-dist）+ web 三绿不破 + SEA 不变。用户确认后进复用组（Task 4.6）。

---

## Task 4.6：`apps/web` 复用 `web-shell`（消除 shell 双份）

**Files:**
- Modify: `apps/web/src/App.vue`（1284 行）—— 删内置 `Sidebar` / `ConversationPane` / `SettingsDialog` 等壳组件（已下沉 web-shell），改 `import { Sidebar, ConversationPane, SettingsDialog, WorkspaceGroup, TopBar, SessionRow, MessageItem, ChatInput } from '@moonshot-ai/web-shell'`；`App.vue` 变组装壳（行数显著减少）。
- Delete: `apps/web/src/components/` 已下沉的空目录 / 残留（`Sidebar.vue`、`SessionRow.vue`、`WorkspaceGroup.vue`、`settings/`、`dialogs/Confirm*`、`chat/ConversationPane.vue` 等）。

**验证：**
- `grep -rn "Sidebar\|ConversationPane\|SettingsDialog" apps/web/src/components` = 0（壳已下沉）
- 三绿（web build/typecheck/vitest）+ web GUI 全口径（侧栏/会话/聊天/设置/输入/markdown/theme）与 4.3 后等价（但 App.vue 用 web-shell 同一组件，消双份）
- CLI SEA `sync:web` 链路不变（dist 形态不变）
- [ ] **Step 1: App.vue 改 import web-shell + 删内置壳组件**
- [ ] **Step 2: 三绿 + web GUI 全口径验证 + grep 无残留**
- [ ] **Step 3: Commit** `refactor(web): consume web-shell components and drop duplicated shell code`

---

## Task 4.7：文档 + final whole-branch review

**Files:**
- Create/Modify: `packages/vite-preset/README.md`（`kimiRendererViteConfig({ root, iconsDir, defines })` 用法 + `iconsDir` 参数化 + **不强注 alias** + 消费方 web/desktop renderer 示例）+ `packages/web-i18n/README.md`（`createKimiI18n` + `KimiI18nKey` provide + `useKimiI18n` inject 优先）+ `packages/web-shell/README.md`（壳组件清单 + `inject(KimiWebClientCoreKey)` / `inject(KimiWebClientFacadeKey)` 契约 + projector/toolMeta 来自 web-core）
- Modify: `apps/desktop/README.md`（不再 SEA / 不再套壳：原生 renderer `desktop-dist` + `app://renderer` + preload/IPC 白名单 + 多窗口开放点）
- Modify: `code-app/AGENTS.md`（阶段状态：阶段 4 done；目录地图加 `vite-preset` / `web-i18n` / `web-shell` / `apps/desktop/src/renderer`；硬约束加「bundler 配置只许一份共享 vite preset」「preload/IPC 经 contextBridge 白名单」；dist 解耦说明）
- Run final whole-branch review（reviewer subagent，范围 Task 4.0–4.6 全部 commit；跨仓 `kimi-code-2` 仅作上下文，本阶段不改子仓）
- changeset：code-app 全 `private` 无发布，**N/A**（同阶段 3，plan 标注 N/A，不跑 gen-changesets）

- [ ] **Step 1: 写三包 README + apps/desktop/README.md**
- [ ] **Step 2: 更新根 AGENTS.md（阶段状态 + 目录地图 + 硬约束）**
- [ ] **Step 3: final whole-branch review（reviewer subagent）**
- [ ] **Step 4: Commit** `docs: document desktop native shell, web-shell, web-i18n and vite-preset`

---

## 风险与回退

1. **§F 工厂化半成品（最大风险）**：分 4.1a/4.1b；facade 引用不断用 `rawState` 闭包内 computed/actions（单一 reactive 根，不包外层 Proxy）；非单例单测 + web GUI 每步验证；`apply()` 字段写回集中（4.1b 收口 I-3：`Object.assign(state, next)` 或字段白名单，避免增字段漏拷）。
2. **bundler preset 漂移**：preset 单测锁关键字段（`worker.format:'es'` / `build.target` / `define` / kimi icons collection / **无 alias**）；`iconsDir` 参数化；web 禁 alias（preset 不强注）。
3. **shell 双份**：4.3 下沉 + 4.6 web 复用消双份；`createAgentProjector`/`toolMeta` 4.5a 下沉 web-core（`deps.t` 注入），web/desktop 复用。
4. **preload/IPC 安全**：contextBridge 白名单 + `preload.test.ts` 覆盖；token 经 `kimiDesktop.getServerToken()` 白名单，renderer 不直接读 fs；禁暴露 `ipcRenderer`/`node`。
5. **多窗口**：本期**单窗口**（多窗口留开放点；届时每窗独立 `createKimiWebClientCore` + facade，server 单例共享 port/token，`KimiClientState` 不跨窗）。
6. **dist 解耦**：CLI SEA `apps/web/dist → sync:web` 不变；desktop 用 `desktop-dist`；`server.ts webAssetsDir`（静态兜底）指 `desktop-dist`（review 确认 server API 不受影响）。
7. **回退**：每 task 独立 commit，红则 `git revert` 单 task 回到上一绿点；检查点 A / B 可停。

## 阶段 4 完成定义（DoD）

- `packages/{vite-preset,web-i18n,web-shell}` 存在，`exports → src/*.ts`，各自 typecheck + 单测绿；`apps/web` 改用 preset、web-i18n、web-shell。
- `useKimiWebClient` 单例已解（`buildClient` 每实例 + `provide/inject`；非单例单测两实例隔离；24 处调用签名/扁平返回形态不变）。
- `apps/desktop/src/renderer/` 存在，独立 vite build（preset）→ `desktop-dist`；`app://renderer` 改指 `desktop-dist`；主进程 server 正常；preload/IPC 扩展经 contextBridge 白名单 + 测试覆盖。
- desktop 原生 `App.vue` 完整桌面 UI（会话侧栏 + 主区聊天 + 设置 + 文件树 + 终端经 server WS + 主题 + 快捷键 + 菜单），`dev:desktop` GUI 端到端冒烟通过。
- `apps/web` 复用 `web-shell`（消双份），三绿 + web GUI 不破；CLI SEA `sync:web` 链路不变。
- 文档（README + AGENTS.md）+ final whole-branch review Yes。

## 开放点（不在本阶段）

- 多窗口（每窗独立 client + 主进程窗口管理）。
- 自动更新（electron-updater + 签名）。
- node-pty 主进程原生 spawn（本期 server-mediated 已通；本地 shell 需求时再做）。
- `iconsDir` 图标下沉（`apps/web/src/icons/kimi` 暂留 web，preset 参数化；后续可下沉 `web-ui/icons` 包）。
- `web-i18n` locale 按需加载（本期全量 en/zh）。
- 阶段 3 遗留 Minor（Icon `name:string` dev warn / check-style web-ui 豁免 / `FrameRoute` / provenance 注释 / clipboard 重复 / `FilePreviewRequest` 漂移 / README 语言统一）。
- `design.md:113`「原生骨架」与阶段 3 合并表述的纠偏（设计文档同步）。

---

## Self-Review

1. **Spec coverage**：用户选 (a) 全量原生 UI → Task 4.0–4.7 覆盖：preset→4.0、§F 工厂化→4.1、web-i18n→4.2、web-shell（含 projector/toolMeta 下沉 web-core）→4.3 / 4.5a、desktop renderer 工程→4.4、desktop 原生 UI→4.5、web 复用→4.6、文档/review→4.7。两个前置地基（§F + preset）+ 全量原生 UI 均覆盖；检查点 A / B 组间暂停。无遗漏。
2. **Placeholder scan**：关键接口（`kimiRendererViteConfig` / `buildClient` / `createKimiI18n` / `KimiI18nKey` / web-shell named exports / `createDesktopApi` / preload 白名单）给真实签名；组件/文件移动用 `git mv` 清单（壳组件 / 聊天 / projector / toolMeta / Terminal 来自 explore 清单）；测试用例真实（preset.test / buildKimiWebClient.test / i18n.test / preload.test / protocol.test）。无 TBD/TODO。4.5 desktop `App.vue` 全量 UI 是**组装现有 web-shell + web-ui 组件**（非新写业务逻辑），plan 给组件清单 + bootstrap 接口，不逐行写 1284 行 `App.vue`（合理）。
3. **Type consistency**：`kimiRendererViteConfig` / `KimiRendererViteOptions`（4.0）、`buildClient` / `BuildClientDeps` / `KimiWebClientFacade` / `KimiWebClientFacadeKey` / `ExtendedState`（4.1）、`createKimiI18n` / `KimiI18nApi` / `KimiI18nKey` / `useKimiI18n`（4.2）、web-shell named exports（4.3）、`createDesktopApi`（4.5）、preload 白名单 API（4.4）跨 task 一致；`KimiWebClientCoreKey`（web-core 已存在，4.1/4.3/4.5 引用一致）；`createAgentProjector({ t })`（4.5a 下沉 web-core，deps.t 注入）与 eventReducer ctx.t 模式一致。
