# P20 实施：OpenInMenu 注入式统一

> 主计划：`docs/plans/renderer-refactor-plan.md` §4 P20。本文档是执行细化，数据为 2026-08-26（P18 合并后 main `656f8a5e`）当日复测。

## 1. 目标

定义 `OpenInService` InjectionKey（catalog 列表 + 执行 + 图标解析），两端各实现；OpenInMenu 收敛为单份组件、下沉 `@moonshot-ai/app-components`；desktop 的「探测不到原生桥 → 空 catalog → UI 隐藏整个 Open In 入口」降级契约保持不变。

## 2. 当日复测

### 2.1 组件现状：不是「props 近乎一致」，是整体分叉 + web 死代码

主计划口径「props 形态两端已近乎一致，分叉只是数据源」**已过时**（08-20 之前口径）。实测：

- **desktop**（281 行）：native-todos 登记的整体重写版——紧凑 pill（左=当前选中应用彩色图标、点击只打开不写盘；右=caret 展开菜单，菜单项点击=打开+选中），菜单项带彩色官方图标（`openInAppIcon`）。props：`workDir?` + `availableApps?: Array<{id,label}>`（主进程 catalog）。**这是 canonical**。
- **web**（309 行）：重写前的旧版菜单（fallback 平台 catalog + 复制路径等），props：`workDir?` + `availableApps?: string[]`（daemon app id）。**且 web 从未挂载它**——`git log -S OpenInMenu -- apps/web/src/components/chat/ChatHeader.vue` 为空，全 src 无挂载点，自拆包起就是死组件。
- diff 规模 324 行。

### 2.2 数据源两侧都是活的

- **desktop**：`lib/nativeOpenIn.ts` 全链路主进程（macOS/Windows 应用检测 + 启动；`canOpenInNative()` 桥探测；无桥/失败 → `false`/`[]` = 隐藏入口，**不回退 daemon**，用户明确决策）。选中态单源 `kimi-web.open-in.default-target`（模块级响应式 ref `useDefaultOpenInTarget`，pill 与设置页同 tick 同步；`resolveOpenInTarget` 纯函数）。设置页「打开方式」分组（SettingsDialog desktop 分叉块，`openInAppOptions` null 即整组隐藏）。
- **web（daemon）**：`GET /meta` 返回 `openInApps: string[]`（app-core api types:1229；`useWorkspaceState.availableOpenInApps` 已在跟踪）；执行端点 `api.openInApp(sessionId, appId, path, line?)`（daemon client:1409 → `POST /sessions/:id/fs:open-in`，kap-server 侧活着）；`useWorkspaceState.openInApp(appId)` 现成（:4093）。链路完整，只是没有 UI 消费。

### 2.3 挂载面

- desktop：`ChatHeader.vue`（分叉块：import/onMounted/模板 `showOpenIn` 块）+ `WorkspaceHome.vue`（挂载 + 配套 chip CSS）。
- web：无。ChatHeader 的剩余分叉（终端按钮等）归 P21/后续，本阶段只管 OpenIn 块。

## 3. 关键决策点：web 要不要实现 Open In → **已定：不实现**

主计划的本意是 web 实现 = daemon `availableApps` + 现有回退（web 启用该入口）。**2026-08-26 用户拍板：web 端不实现**——不注册 daemon 服务、不挂载 UI（初版「注册但不挂载」的 daemon 实现也已按用户指示删除，`apps/web/src/App.vue` 与 main 保持一致）。web 侧零改动；未来若要启用，需要新增 daemon 实现 + provide + 挂载三件事一起做。`OpenInMenu` 组件在 web 无 provide 时不会被挂载（inject 无默认值、组件已对 undefined 服务防御），无运行时风险。

## 4. 设计

### 4.1 OpenInService（app-client/contracts 新增 InjectionKey）

```ts
export interface OpenInAppEntry { id: string; label: string }

export interface OpenInService {
  /** 当前可用 catalog；空数组 = 隐藏整个 Open In 入口（既定降级形态）。 */
  catalog(): Promise<OpenInAppEntry[]>;
  /** 执行打开；path 为工作区绝对路径，line 可选。 */
  open(appId: string, target: { path: string; line?: number }): Promise<boolean>;
  /** 菜单项 / pill 图标（彩色官方图或通用回退），返回可 <img> 的 URL/svg data。 */
  icon(appId: string): string;
}
export const OpenInServiceKey: InjectionKey<OpenInService> = Symbol('openInService');
```

- **desktop 实现**（`apps/desktop/src/renderer/lib/nativeOpenIn.ts` 薄封装）：catalog = `canOpenInNative() ? listNativeOpenInApps() : []`；open = `openInNativeApp`；icon = `openInAppIcon`。无桥 → catalog `[]` → 隐藏（契约不变）。
- **web 实现**：**不做**（§3 用户决策）。未来启用时的实现要点留档：catalog 须等 `client.initialized` 后读 `client.availableOpenInApps.value`（否则页面生命周期内恒空）；open 须直取 `api.openInApp(sid, appId, path, line)`——`client.openInApp` 用 session cwd 且无 session 静默 return，不可用；菜单项图标空值需 fallback（组件已内置 Icon 回退）。
- provide 位置：desktop App.vue 组合根（setup provide）。

### 4.2 统一 OpenInMenu（desktop pill 为 canonical）

- 保留 desktop 版全部行为契约：pill 双区（图标直开 / caret 菜单）、菜单项=打开+选中、彩色图标、`-webkit-app-region: no-drag`、菜单打开期间 capture 吞 Escape。
- 内部数据源改为 `inject(OpenInServiceKey)`；`availableApps` prop 删除（catalog 由服务给出；SettingsDialog 设置页继续走自己的 desktop 分叉块，不受影响）。
- **默认目标持久化下沉**：`useDefaultOpenInTarget` / `saveDefaultOpenInTarget` / `resolveOpenInTarget` 从 desktop `lib/nativeOpenIn.ts` 移入 app-components（存储 key 不变 `kimi-web.open-in.default-target`，模块级 ref mirror 模式不变）；desktop 设置页与 desktop OpenInMenu 旧引用改指包——**pill 与设置页同 tick 同步的契约依赖单一模块 ref，必须同源**。
- 下沉路径：`packages/app-components/src/chat/OpenInMenu.vue` + `lib/openInTarget.ts`（持久化模块）。

### 4.3 挂载面收口

- desktop ChatHeader：分叉块改为消费服务（`catalog()` 非空 + `workspaceRoot` 才显示），不再直接 import nativeOpenIn；分叉块因此缩小（终端按钮块照旧）。
- desktop WorkspaceHome：挂载不变，import 改指包。
- web（方案 A）：ChatHeader 与 WorkspaceHome 补上同款挂载（与 desktop 同代码路径）；web WorkspaceHome 是真实分叉文件，OpenIn 块按 desktop 形态补齐。

## 5. 实施步骤（两个 PR）

### PR-A：服务 + 统一组件（desktop 行为不变）

1. app-client/contracts 加 `OpenInServiceKey` + 类型。
2. `useDefaultOpenInTarget` 三件套下沉 app-components `lib/openInTarget.ts`（desktop 引用改指包；单测随行——desktop 现有 `nativeOpenIn.test.ts` 中持久化/解析用例迁包）。
3. OpenInMenu 以 desktop pill 为正本合一、数据源改 inject 服务，下沉包。
4. desktop：App.vue/main.ts 注册原生实现；ChatHeader/WorkspaceHome 改指包 + 服务；SettingsDialog 设置页改从包消费 `useDefaultOpenInTarget`（行为不变）。
5. web：零改动（不实现，§3）；web 旧版 OpenInMenu（从未挂载的死组件）删除。
6. 台账：native-todos「用 xxx 打开」条目改写为注入缝口径。

## 6. 验证

- 五件套 + `nativeOpenIn.test.ts` 迁移用例全绿。
- **desktop 冒烟**：有桥——pill 显示、直开 VS Code、菜单换默认、设置页同步、无 workspaceRoot 隐藏；无桥（模拟 `canOpenInNative=false`）——整组隐藏。
- **持久化**：菜单选中与设置页 Select 同 key 同 tick 同步（desktop 重点回归）。

## 7. 风险

- **web 新增可见 UI**（方案 A）：属产品决策，故 §3 先拍板再动工。
- **持久化 key 同源**：`useDefaultOpenInTarget` 必须单模块下沉，双模块 mirror 会造成 pill/设置页失同步——已列入 PR-A 步骤 2 强制项。
- **desktop pill 的 no-drag / Esc capture 契约**：合一时逐行保留（native-todos 登记的两处坑），PR 描述留档。
