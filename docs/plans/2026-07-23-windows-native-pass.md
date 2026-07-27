# Windows 体验原生化的第一轮 实施计划

> 交给执行者的实施计划。本文档自包含，不需要其他上下文。
> 现状调研结论见 §1（含文件:行号，执行时不必重查）。全部改动都在 `apps/desktop`（主进程为主），`apps/web` 不涉及；`kimi-code/` submodule 不动。
> 自定义标题栏（frameless + titleBarOverlay）用户明确放到最后单独立项，**不在本计划范围**。

## 1. 背景：Windows 现状（调研结论）

desktop 是 Electron 壳（`apps/desktop`，包名 `kimi-code-app`），主进程在进程内起 kap-server，renderer 经 `app://renderer` 自定义协议加载 `desktop-dist`。macOS 已做了一批原生能力（隐藏标题栏、菜单栏计数、Dock badge、hide-on-close 驻留、OpenIn、桌宠），Windows 侧现状：

1. **关窗即退出**：`window.ts:71` `shouldHideOnClose` 只放行 darwin；`app.ts:27-31` `window-all-closed` 在非 darwin 直接 `app.quit()`。Windows 上点 X = 整个应用（含内嵌 server、托盘）消失。托盘 attention 菜单（`tray.ts`）、OS 级唤起快捷键（`shortcuts.ts`）都依赖应用驻留才有意义，Windows 上形同虚设。
2. **无单实例锁**：双击图标起第二个完整实例（第二个内嵌 server、第二个托盘、第二个窗口）。`app.ts` `main()` 里没有 `requestSingleInstanceLock()`。
3. **离屏窗口恢复**：`window.ts:146` `loadBounds()` 用 `screen.getDisplayMatching()` 选显示器，但**不把 x/y clamp 进 workArea**——拔掉外接屏后窗口开到不可见区域，Windows 笔记本 dock/undock 高频场景的经典 bug。现有 `looksMaximizedBounds` 只处理"存的时候正好最大化"的情况。
4. **托盘交互反 Windows 惯例**：`tray.ts:340-342` win32 下左键弹上下文菜单。Windows 惯例：左键 = 显示主窗口，右键 = 菜单（`setContextMenu` 后右键自动弹，不需要代码）。
5. **待处理提醒在 Windows 无落点**：renderer 经 `kimi:tray-attention` 推送 `{unread, approvals, questions, items}`（`ipc.ts:69-74` → `tray.ts setTrayAttention`），macOS 落点是菜单栏计数 + Dock badge；Windows 上 `Tray.setTitle` 无效、`app.dock` 不存在，只有 tooltip/菜单变化——用户不点托盘永远看不到。任务栏角标（`win.setOverlayIcon`）与闪动（`win.flashFrame`）都没接。
6. **Jump List 缺失**：任务栏右键没有最近工作区/常用任务。主进程不知道工作区列表（数据在 renderer：`useWorkspaceState.ts:955` `api.getFsHome()` 的 `recentRoots` + 当前 workspaces 列表），需要新 IPC 推送。`native-todos.md` 的「最近工作区接入 OS」条目就是这个。
7. **OpenIn 目录 Windows 为空**：`open-in.ts:93` 非 darwin 直接 `return []`，renderer 把整个入口隐藏（`nativeOpenIn.ts` 空目录即隐藏）。该模块是纯函数 + 依赖注入（fs/platform/home），加平台分支即可。Windows 侧目标应用：VS Code、Cursor、Explorer（恒有）、Windows Terminal（`wt.exe`）。

相关既有机制（复用，不重造）：

- macOS hide-on-close 全链路：`window.ts` `isQuitting` / `installQuitWatch` / `markQuitting`（updater 安装前显式标记）、全屏先退再藏（`pendingFullscreenHide`）、`showMainWindow()` un-minimize + show + focus、`activate` 重建。全部平台无关，直接生效。
- 托盘菜单重建：`setTrayAttention` → `renderTray()`，字符串表双语（`TRAY_STRINGS`）。
- 唤起快捷键已调 `showMainWindow()`（`shortcuts.ts`），hide-on-close 后在 Windows 上自动可用。
- OpenIn renderer 侧已按「空目录即隐藏」设计，win32 目录非空后入口自动出现；图标映射在 `src/renderer/lib/nativeOpenIn.ts` 的 `openInAppIcon(id)`。

## 2. 目标 / 非目标

**目标**

1. Windows 关窗 = 隐藏驻留托盘（真退出走托盘「退出」/ 更新器安装），行为与 macOS 对齐。
2. 单实例：二次启动聚焦已有窗口，不再起第二实例。
3. 窗口位置恢复永不落到屏幕外。
4. 托盘左键显示窗口、右键菜单，符合 Windows 惯例。
5. 有待处理项时任务栏图标有角标；新增待处理且窗口未聚焦时任务栏闪动。
6. 任务栏 Jump List：「新建会话」task + 最近工作区（点击直达该工作区）。
7. OpenIn 在 Windows 可用：VS Code / Cursor / Explorer / Windows Terminal。

**非目标（不要做）**

- 不做自定义标题栏 / `titleBarOverlay`（用户明确放到最后，单独立项）。
- 不改 macOS 任何既有行为（所有平台门控新增 win32 分支，不动 darwin 分支逻辑）。
- 不动 `apps/web`、`packages/*`、`kimi-code/` submodule。
- 不做 Windows 签名、不做原生通知、不做桌宠 Windows 版、不做 NSIS 安装器定制（后续单独立项）。
- 不做多窗口。

## 3. 任务分解

任务 1-4 互相独立、都是小改动，可按序一个 PR 或分 PR；任务 5/7 中等；任务 6 最大（跨 argv/IPC/renderer 三段），放最后。每个任务完成都要：补测试、`pnpm --filter kimi-code-app run typecheck && pnpm --filter kimi-code-app run test` 过、`pnpm test`（根 vitest）过、按 `changeset` skill 生成 patch changeset（只选 `kimi-code-app`）、更新 `apps/desktop/docs/native-todos.md` 对应条目。

### 任务 1：Windows 关窗驻留托盘（hide-on-close 扩展到 win32）

- `window.ts` `shouldHideOnClose(platform, quitting)`：`platform === 'darwin'` 改为 `(platform === 'darwin' || platform === 'win32')`，quitting 语义不变。
- 全屏隐藏分支（`win.isFullScreen()` → 先 `setFullScreen(false)` 再 hide）在 Windows 同样成立（F11 全屏），无需改。
- `app.ts` `window-all-closed` → 非 darwin `app.quit()` **保留**：hide-on-close 下正常路径不再触发窗口销毁，它是「窗口真被销毁」的兜底，语义刚好正确。
- 退出路径已闭环：托盘「退出」→ `app.quit()` → `before-quit` → `isQuitting = true` → close 放行销毁；updater 安装走 `markQuitting()`。菜单 File →「关闭窗口」（close role）在 Windows 也变成隐藏，与 macOS Cmd+W 语义对齐，可接受。
- 注意 `tray.ts` 头部注释与 `window.ts` 各注释里「macOS hide-on-close」的表述要随代码同步更新（行为变了，注释不能留旧描述）。
- 测试：更新 `tests/main/window.test.ts` 的 `shouldHideOnClose` 用例（win32 true、win32+quitting false、linux false）。
- 真机验证（`pnpm dev:desktop`）：点 X 窗口隐藏、托盘还在；托盘「显示主窗口」/ 唤起快捷键秒回（不重载 renderer）；托盘「退出」真退出；更新安装流程不受阻。

### 任务 2：单实例锁

- `app.ts` `main()` 最前（`registerRendererScheme()` 之后、其余注册之前）：`const gotLock = app.requestSingleInstanceLock()`；`!gotLock` → `app.quit()` + return（不注册 IPC、不起 server、不建窗）。
- `app.on('second-instance', () => showMainWindow())` 挂在拿到锁的分支里。任务 6 会扩展这里解析 argv。
- 三平台统一生效（macOS 正常路径不触发 second-instance，无害）；dev 与打包版 userData 目录不同（name vs productName 派生），锁互不影响，保留「dev 与正式版同机并存」的既有调试能力（tray 标题 `dev` 前缀的注释验证了这是既有意图）。
- 无合理单测姿势（app.ts 是 Electron 编排层），真机验证：双击第二次图标 → 旧窗口被聚焦，无新托盘/新窗口。

### 任务 3：离屏窗口 clamp

- `window.ts` 新增纯函数 `clampBoundsToWorkArea(bounds, workArea)` 并导出：x/y 溢出 workArea 时 clamp 到边缘（保留至少 ~100px 可见即可，简单 clamp 不做居中）；size 不动。
- `loadBounds()` 在现有 `looksMaximizedBounds` 检查后过一遍 clamp。
- 测试：`tests/main/window.test.ts` 加用例（完全离屏 → clamp 回边缘、部分离屏 → clamp、正常 → 原样、无 x/y → 默认）。

### 任务 4：托盘交互对齐 Windows 惯例

- `tray.ts` win32 分支：`tray.on('click', ...)` 由弹菜单改为 `actions.showMainWindow()`；右键菜单是 `setContextMenu` 的系统默认行为，无需代码。可补 `double-click` → `showMainWindow()`（部分用户习惯双击）。
- 同步更新 `tray.ts:8-9` 头部注释（旧行为描述）。
- 测试：tray 模块的纯函数不受影响；交互行为真机验证（左键出窗口、右键出菜单、attention 菜单点击跳会话不回退）。

### 任务 5：任务栏 attention（overlay icon + flashFrame）

- 新模块 `src/main/taskbar.ts`（依赖方向 `tray.ts → taskbar.ts → window.ts`，无环；window.ts 不 import 这两个）：
  - `setTaskbarAttention(total: number)`：win32 且 `total > 0` → `win.setOverlayIcon(badge, tooltip)`；`total === 0` → `setOverlayIcon(null, '')`。其他平台 no-op。
  - 闪动：total **从 0 升到 >0**（或比上次增大）且窗口未聚焦（`!win.isFocused()`，含隐藏）→ `win.flashFrame(true)`；`win.on('focus')` / total 归零 → `flashFrame(false)`。Windows 上 flashFrame(true) 会一直闪到聚焦，符合惯例。
  - 角标资产：新增 `build/overlay-badge.png`（16/20/24/32 多尺寸或单 32px，红色圆点 + 白色计数数字渲染成本高，第一版用**纯红点**，tooltip 文案带分类汇总——复用 `trayAttentionSummary`）。资产走 `extraResources` 的 `build/` + filter 既有模式，filter 列表加 `overlay-*`（注意 `electron-builder.config.cjs` 注释的坑：`from` 不吃 glob，在 `filter` 数组里加）。
  - 缺资产时 `nativeImage.isEmpty()` 降级为只闪动不角标（照 tray.ts:326 的 loud-degrade 模式）。
- `tray.ts` `setTrayAttention` 里调 `setTaskbarAttention(total)`（macOS 上 no-op，mac 已有菜单栏计数 + Dock badge）。
- 测试：新建 `tests/main/taskbar.test.ts`——mock window 对象断言 overlay 设置/清除、闪动触发条件（0→N 且未聚焦触发、聚焦时不触发、归零清除）、非 win32 no-op、缺资产降级。

### 任务 6：Jump List（新建会话 + 最近工作区）

分三段，最大的一项：

- **推送链路**：新 IPC channel `kimi:jump-list`（`ipc-channels.ts` + `ipc.ts` handler + `preload.ts` 白名单方法 `setJumpList(items)` + `tests/main/preload.test.ts`）。renderer 新 composable `src/renderer/composables/useJumpList.ts`（desktop-only，无桥 no-op，照 `useTrayAttention.ts` 模式）：watch 当前 workspaces 列表（名称 + 路径，按最近活动排序，上限 9 条）推给主进程；主进程校验（结构 + 条数上限）后 win32 调 `app.setJumpList`：
  - `tasks` 段：「新建会话」`{ program: process.execPath, args: '--new-chat', iconPath: process.execPath }`；
  - custom 段「最近」（双语，走 tray.ts 字符串表同款模式）：每个工作区一个 `{ type: 'task', program: process.execPath, args: '--workspace=<path>', title: <name> }`。**不用 `type: 'file'`**——目录没有文件关联，点了不可靠；task + argv 自己解析才可控。
- **argv 解析与路由**：主进程新增纯函数 `parseLaunchArgs(argv): { newChat: boolean; workspace?: string }`（`--new-chat` / `--workspace=<path>`）。两个入口：首实例启动（`process.argv`，在 `connect()` 完成、renderer ready 后经 `sendToRenderer` 下发——用 window.ts 现有的「renderer 未就绪先排队」同款模式，别新造队列）和 `second-instance`（任务 2 的回调扩展，解析 `argv` 再下发）。下发走新的 renderer event channel `kimi:launch-action`（payload `{action: 'new-chat'} | {action: 'open-workspace', path}`）。
- **renderer 消费**：`App.vue` 订阅（desktop 分叉块）：`new-chat` → 复用 `handleCreateSession()`；`open-workspace` → 复用 add-workspace 全链路（`createAddWorkspaceEntry` 的 `addWorkspace` 路径——工作区已存在则选中，不存在则添加并选中）。preload 白名单加 `onLaunchAction`。
- macOS 不注册 Jump List（无此 API），argv 解析保留无害。
- 测试：`tests/main/` 新增——`parseLaunchArgs`（各形态/畸形）、payload 校验、Jump List 模板构建（双语）；`tests/renderer/useJumpList.test.ts`（无桥 no-op、推送去重、排序截断）；preload 白名单同步。
- 真机验证：打包后验证 Jump List 条目出现与点击行为（dev 下 `process.execPath` 是 electron 二进制，Jump List 仅打包版可见，计划内说明即可）；dev 下可用命令行 `--workspace=...` 验证 argv 路由。

### 任务 7：OpenIn Windows 目录

- `open-in.ts` 加 win32 分支（现有 DI 模式不变，deps 加 `env`/`which` 探针）：
  - **VS Code** / **Cursor**：探测固定安装路径（`%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe`、`%LOCALAPPDATA%\Programs\cursor\Cursor.exe`，再退 `%ProgramFiles%` 变体）；启动 `spawn(exe, [dir], { detached, stdio: ignore })`。
  - **Windows Terminal**：`wt.exe` 在 PATH 上（Store 安装）；探测走 PATH 扫描；启动 `wt -d <dir>`。
  - **Explorer**：系统恒有；启动 `explorer.exe <dir>`——注意 explorer 成功也常返回 exit code 1，用 detached + `unref`，不把 exit code 当失败（单独处理，别污染 vscode 的错误判定）。
  - id 复用现有 `OpenInAppId` 的 `vscode` / `cursor`，新增 `explorer` / `windows-terminal`（类型与 `OPEN_IN_APP_IDS` 同步）。
- 菜单顺序保持「编辑器 → 文件管理器 → 终端」的既有约定。
- renderer 图标：`nativeOpenIn.ts` `openInAppIcon` 加新 id 映射；`src/renderer/assets/app-icons/` 需要 Explorer / WT 的图标资产（无法像 macOS 从 icns 提取，用商标官方 PNG 或先回退到既有的 tabler 图标——执行时按资产可得性定，缺图标时菜单项必须有无图标兜底渲染，先确认 `OpenInMenu.vue` 对无 icon 的行为）。
- `listAvailableOpenInApps` / `openInApp` 的平台门控从 `!== 'darwin' return []` 改为 darwin / win32 双分支，linux 仍空。
- 测试：`tests/main/open-in.test.ts` 加 win32 用例（平台门控、四应用探测命中/未装、argv 构造、explorer exit-code 特例、未装回传）；mac 用例不动。
- 同步 `native-todos.md` 的 OpenIn 条目（「已知限制：第一版仅 macOS」更新）。

## 4. 验证与收尾（每个 PR 都要）

```bash
pnpm --filter kimi-code-app run typecheck
pnpm --filter kimi-code-app run test
pnpm test        # 根 vitest
pnpm lint
```

- 真机：本机就是 Windows，`pnpm dev:desktop` 逐项过行为（任务 1/2/3/4/5 都可 dev 验证；任务 6 的 Jump List 弹出需打包，可用 `electron-builder --dir` 出免安装目录验证，不必全量打包）。
- `apps/desktop/docs/native-todos.md`：每完成一项更新对应条目（已完成项打勾并补实现要点，OpenIn 条目改「已知限制」表述）。
- 根 `AGENTS.md` 与 `apps/desktop/README.md` 如涉及结构/行为约定变化（hide-on-close 跨平台、单实例），同步一句。
- 每个任务（或批次）按 `changeset` skill 写 patch changeset，只选 `kimi-code-app`。

## 5. 建议执行顺序

1. 任务 2（单实例）→ 任务 1（hide-on-close）：先保证二次启动不炸，再改变关窗语义。
2. 任务 3（clamp）、任务 4（托盘交互）：独立小项，可与 1 同一批。
3. 任务 5（任务栏 attention）。
4. 任务 7（OpenIn Windows）。
5. 任务 6（Jump List）：最大，且依赖任务 2 的 second-instance 钩子。
