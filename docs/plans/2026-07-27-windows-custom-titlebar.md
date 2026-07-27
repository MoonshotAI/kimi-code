# Windows 自定义标题栏实施计划

> 交给执行者的自包含实施计划。目标是在 Windows desktop 中用 Kimi Code 自有标题栏替换当前原生标题栏和菜单栏，同时保留 Windows 原生窗口控制、Snap Layout、系统缩放与 Electron 原生菜单能力。
>
> 全部产品改动限定在 `apps/desktop`；`apps/web`、macOS、Linux 与 `kimi-code/` submodule 不改。Windows 专属 renderer 分叉必须记录在 `apps/desktop/docs/native-todos.md`。

## 1. 已确认的产品方案

### 1.1 窗口结构

Windows desktop 增加一条独立的 40px 全局标题栏，位于现有应用布局上方：

```text
┌──────────────────────────────────────────────────────────────────┬───┬───┬───┐
│ [Logo Kimi Code]  文件  编辑  视图  帮助        可拖动空白区      │ — │ □ │ × │
├──────────────────────────┬───────────────────────────────────────┴───┴───┴───┤
│                            │ 工作区 / 会话标题 · 分支 · 会话操作               │
├──────────────────────────┼─────────────────────────────────────────────────────┤
│ Sidebar                  │ Conversation / Preview                              │
└──────────────────────────┴─────────────────────────────────────────────────────┘
```

- 全局标题栏最左侧显示完整品牌：机器人 Logo + `Kimi Code`。
- 品牌右侧仅显示四个一级菜单：`文件`、`编辑`、`视图`、`帮助`。
- 不放前进、后退；侧栏切换按钮紧跟在完整品牌右侧，并随折叠状态切换图标。
- 标题栏中间剩余区域为窗口拖动区。
- 最右侧继续使用 Electron Window Controls Overlay 提供的 Windows 原生最小化、最大化、关闭按钮，不自行绘制。
- 更新入口移到全局标题栏“帮助”右侧，Sidebar 不再重复品牌、侧栏按钮或更新入口。
- Windows 不再渲染会话 Header 上绝对定位的浮动展开按钮与新建会话按钮。
- 现有 48px `ChatHeader` 和右侧面板 Header 保持产品导航职责，不与全局标题栏合并。
- 进入全屏后隐藏整条全局标题栏，内容恢复占满窗口。

### 1.2 视觉方向

- 标题栏高度固定为 40px；现有产品 Header 仍为 48px。
- 背景使用 Sidebar 表面 token，让标题栏与左侧 chrome 连续；底部使用 0.5px hairline。
- 品牌、菜单字体、间距、hover、focus、动效全部取 `style.css` token，不新增 ad-hoc 视觉值。
- 原生窗口控制覆盖层使用透明背景，让 renderer 绘制的标题栏表面延伸到三键区域；主进程只同步原生符号的明暗色。
- 菜单按钮为低强调文本按钮：默认无底，hover/open 使用现有 neutral hover wash。
- 非激活窗口降低品牌与菜单文字强调度，但不得降低到不可读。
- 标题栏不引入渐变、玻璃、发光或额外阴影。

### 1.3 菜单信息架构

Windows 当前六个一级菜单收敛为四个；macOS 菜单结构保持原样。

#### 文件

- 新建会话
- 打开文件夹…
- 分隔线
- 设置…
- 分隔线
- 关闭窗口
- 退出 Kimi Code

#### 编辑

- 撤销
- 重做
- 分隔线
- 剪切
- 复制
- 粘贴
- 删除
- 分隔线
- 全选

`全选`继续走 renderer 的作用域全选，不得退回 Electron 原生 `selectAll` role，避免整页选中。

#### 视图

- 重置缩放
- 放大
- 缩小
- 分隔线
- 切换全屏
- 重新加载
- `强制重新加载`与`开发者工具`仅在开发版本显示

#### 帮助

- 检查更新…
- 分隔线
- 文档
- 控制台
- 分隔线
- 关于 Kimi Code

整理规则：

- 删除 Windows 顶层 `Kimi Code` 和 `Window` 菜单。
- `关闭窗口`只保留在“文件”，消除当前三处重复。
- `View`、`Window`等硬编码英文全部进入主进程双语字符串表。
- 设置、更新、重试连接等原有能力必须保留；`重试连接`建议放在“帮助”的更新项附近，或仅在断连状态动态出现。执行前以“不丢功能”为硬约束。
- 菜单快捷键继续服从 renderer 的自定义快捷键设置；快捷键录制期间继续复用现有 `menuSuspended` 静默机制。

## 2. 技术方案

### 2.1 BrowserWindow：启用 Window Controls Overlay

修改 `apps/desktop/src/main/window.ts`。

提取一个可测试的纯函数，例如：

```ts
export function titleBarWindowOptions(platform: NodeJS.Platform): Partial<BrowserWindowConstructorOptions>
```

Windows 返回：

```ts
{
  titleBarStyle: 'hidden',
  titleBarOverlay: {
    color: '#00000000',
    symbolColor: '<按当前 nativeTheme 解析>',
    height: 40,
  },
}
```

macOS继续返回现有：

```ts
{
  titleBarStyle: 'hidden',
  trafficLightPosition: TRAFFIC_LIGHT_POSITION,
}
```

Linux继续使用默认标题栏。

实现要求：

- 不设置 `frame: false`。
- Windows 必须保留原生 caption buttons，从而保留最大化按钮悬停的 Snap Layout、系统菜单、辅助功能、DPI 适配和窗口 resize frame。
- 创建窗口后显式隐藏传统菜单栏，避免自定义标题栏下方再出现一行原生菜单；应用菜单本身仍通过 `Menu.setApplicationMenu` 注册，以继续承载 accelerator 和 role。
- 不使用 `autoHideMenuBar` 产生“按 Alt 又弹出第二条菜单栏”的重复体验；Alt 键导航由 renderer 标题栏接管。
- Window Controls Overlay 的背景保持透明；renderer 标题栏负责真实表面颜色。
- 新增 `applyWindowsTitleBarOverlay()`，在 Windows 上根据 `nativeTheme.shouldUseDarkColors` 调 `win.setTitleBarOverlay({ color, symbolColor, height })`。
- 监听 `nativeTheme.updated`，主题变化后重设 `symbolColor`。现有 `kimi:theme` 会更新 `nativeTheme.themeSource`，因此不新增第二条主题状态源。
- 窗口销毁后不得继续访问 `setTitleBarOverlay`。

建议颜色策略：

- overlay `color`始终为透明色。
- 浅色符号使用深色中性色，深色符号使用浅色中性色。
- 这些值属于 Windows 原生 API 参数，不是 renderer CSS；集中放在 `window.ts` 的 Windows chrome 常量中，不散落。

### 2.2 平台识别

修改 `apps/desktop/src/renderer/lib/desktopFlag.ts`：

```ts
export const isWindowsDesktop = env.isDesktop && env.platform === 'win32';
```

保留现有 `isMacosDesktop` 语义，不把两者合并成模糊的 `hasCustomTitlebar` 后到处分支。需要共享逻辑时可额外导出：

```ts
export const hasCustomTitlebar = isMacosDesktop || isWindowsDesktop;
```

选择原则：

- 交通灯布局、vibrancy 仍只判断 `isMacosDesktop`。
- Windows 全局标题栏、菜单入口只判断 `isWindowsDesktop`。
- web 无 query flag 时保持原样。

### 2.3 Renderer 标题栏组件

新增：

- `apps/desktop/src/renderer/components/window/WindowsTitleBar.vue`
- `apps/desktop/src/renderer/components/window/WindowsMenuBar.vue`（若单文件超过现有组件合理体量再拆；否则保持一个组件）
- `apps/desktop/src/renderer/lib/windowsMenu.ts`

`WindowsTitleBar.vue`职责：

- 渲染 Logo、`Kimi Code`、四个菜单触发器。
- 提供整个安全区域的 drag region。
- 给 Logo、菜单按钮标记 `-webkit-app-region: no-drag`。
- 根据菜单打开状态设置 `aria-expanded`。
- 处理 Alt/方向键/Escape 的一级菜单键盘导航。
- 不渲染最小化、最大化、关闭按钮；这三个按钮属于系统 overlay。
- 不承载 Sidebar 展开/收起。

品牌资产：

- 复用现有生成于 `Sidebar.vue` 的透明机器人品牌标几何，不复制另一份手写 SVG。
- 为避免同一品牌 SVG 在两个组件中继续复制，实施时优先把内联品牌标抽成 desktop renderer 可复用的轻量组件，例如 `components/BrandMark.vue`。
- 如果抽组件会破坏 `scripts/build-brand-icons.mjs` 的生成边界，则同步调整生成脚本，让标题栏和 Sidebar 使用同一生成源；不得手改生成区后留下两份漂移资产。
- 不使用带白色方块背景的 app icon，标题栏使用透明机器人 mark。

布局接入：

- 在 `App.vue` 根 `.app` 内仅 Windows desktop 渲染 `WindowsTitleBar`。
- 避免为标题栏重包现有整个应用 DOM。首选让 `.app.windows-desktop` 保持现有 grid，并增加 `padding-top: var(--windows-titlebar-height)`；标题栏绝对定位到 padding 区。
- 如果 CSS Grid 对 padding 后的现有 resize handle 产生坐标问题，再退回 `.app-shell` wrapper。不要在未验证前做大范围模板搬迁。
- 标题栏高度定义为 CSS token，例如 `--windows-titlebar-height: 40px`，所有偏移只引用该 token。
- `--app-height`、移动端 breakpoint、侧栏 resize 与右侧面板 resize 必须保持现状。

Window Controls Overlay 安全区：

- 菜单与拖动内容不得进入三键区域。
- 使用 Chromium 提供的：
  - `env(titlebar-area-x, 0px)`
  - `env(titlebar-area-width, calc(100% - 138px))`
  - `env(titlebar-area-height, var(--windows-titlebar-height))`
- 不把“3 × 46px”作为唯一布局依据；fallback 只用于 WCO 环境变量不可用的异常路径。
- RTL 或系统把窗口控制移位时，安全区仍应生效。

### 2.4 Sidebar

修改 `apps/desktop/src/renderer/components/Sidebar.vue`。

现有 `.ch` 在非 macOS显示：

- 品牌
- Windows 不承载 `UpdateIndicator`，由全局标题栏承载。

调整为：

- web/Linux：保持现状，不受影响。
- macOS desktop：保持现有交通灯拖动条与 resident toggle 行为。
- Windows desktop：
  - `.ch-brand`不渲染品牌。
  - `.ch-tail`右对齐。
  - `.ch-tail`不在 Windows 渲染切换按钮或 `UpdateIndicator`。
  - `UpdateIndicator`无状态时仍然不渲染，不占用标题栏空间。
  - `.ch`不设置 drag region；Windows 窗口拖动只由新的全局标题栏负责。

折叠状态：

- Windows 不渲染 `App.vue` 当前绝对定位的 `.sidebar-toggle-btn` 与 `.new-chat-btn`。
- 展开/收起统一由全局标题栏品牌右侧的常驻按钮负责。
- 收起/展开动画、宽度持久化、resize handle 都不改。

### 2.5 原生菜单弹出桥

目标是“renderer 画入口，主进程弹 Electron 原生菜单”，而不是在 Vue 中复制菜单项。

修改：

- `apps/desktop/src/main/ipc-channels.ts`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/main/preload.ts`
- `apps/desktop/src/main/menu.ts`
- `apps/desktop/tests/main/preload.test.ts`

新增 invoke channel：

```ts
menuPopup: 'kimi:menu-popup'
```

payload：

```ts
type WindowsMenuId = 'file' | 'edit' | 'view' | 'help';

interface MenuPopupRequest {
  id: WindowsMenuId;
  x: number;
  y: number;
}
```

安全要求：

- IPC handler 验证 `id`白名单。
- `x/y`必须为有限数字，并 clamp 到当前窗口 bounds。
- 只接受来自主窗口 `webContents` 的调用。
- 非 win32 平台直接返回 `{ opened: false }`。
- preload 只暴露窄接口：

```ts
popupWindowsMenu(request): Promise<{ opened: boolean }>;
```

- 不向 renderer 暴露任意 Electron Menu、任意 channel 或任意命令执行能力。

定位：

- renderer 读取触发按钮的 `getBoundingClientRect()`，传入按钮左边和底边。
- 主进程结合 `webContents.getZoomFactor()`把 CSS 坐标换算为 Electron popup 所需的 DIP 坐标。
- 把换算与 clamp 提取成纯函数并单测；必须覆盖 100%、125%、150% DPI/zoom。
- 弹出菜单的 `x/y`相对主窗口内容区域；执行时用 Windows 真机校准一次 top inset，不凭猜测补常量。

菜单生命周期：

- `popupWindowsMenu()`返回 Promise，在 `submenu.popup({ callback })`关闭回调中 resolve。
- renderer 在 Promise pending 期间保持触发器 open 状态。
- 用户点击菜单项、点外部、按 Escape 后 Promise 都应结束，按钮恢复关闭状态。
- 同一时刻只允许一个 native popup；新的请求先关闭/忽略旧请求，避免状态竞争。

### 2.6 `menu.ts`平台模板

重构 `menuTemplate`为平台语义而非单个 `isMac`布尔值，建议：

```ts
type MenuPlatform = 'mac' | 'windows' | 'linux';
menuTemplate(platform, locale, shortcutOverrides, suspended, isDev)
```

要求：

- macOS模板内容与顺序不变。
- Linux模板默认保持当前行为，避免本次顺带改 Linux。
- Windows模板按 §1.3 收敛为四个带稳定 `id`的顶层菜单：
  - `file-menu`
  - `edit-menu`
  - `view-menu`
  - `help-menu`
- 新增 `getMenuSubmenu(id)`或等价受控查询，供 popup IPC 使用。
- 不在 popup 时临时重建第二套菜单；`Menu.setApplicationMenu`持有的同一份 menu 是 accelerator、菜单状态和 popup 的单一事实源。
- locale、快捷键或 suspended 状态变化触发 `buildMenu()`后，popup 查询必须自动指向最新 Menu 实例。
- `about`在 Windows 使用显式 label，不能让 Electron 从包名 `kimi-code-app`派生错误文案。
- `退出 Kimi Code`使用 `app.quit()`对应 role/handler；`关闭窗口`继续遵循现有 hide-on-close 行为。
- “重试连接”不得丢失。若采用动态出现，断连状态同步另立小步骤；第一版可固定放入“帮助”以降低状态复杂度。

### 2.7 键盘与无障碍

`WindowsMenuBar`实现 Windows 菜单习惯：

- Tab 顺序中四个菜单均可聚焦。
- 按一下 `Alt`进入/退出菜单访问模式，并聚焦最近或第一个菜单。
- `Alt+F`打开文件，`Alt+E`打开编辑，`Alt+V`打开视图，`Alt+H`打开帮助。
- 一级菜单聚焦时，左右方向键移动焦点。
- `Enter`、`Space`或向下方向键打开当前菜单。
- `Escape`关闭 popup 并把焦点还给触发器；再次 Escape 退出菜单访问模式。
- 鼠标打开一个菜单后，移动/点击另一一级菜单可切换。
- 菜单文字提供 access-key underline；仅 Alt 模式显示，避免常驻视觉噪声。
- `aria-haspopup="menu"`、`aria-expanded`、可见 focus ring 齐全。
- 系统高对比度/强制色模式下不能只靠背景色表示 hover/open。
- 不劫持已有可自定义快捷键；只处理 Alt 菜单导航组合。

原生 popup 内部的菜单项键盘、disabled、role 和读屏由 Electron/Windows 负责。

### 2.8 窗口状态

需要覆盖：

- 普通窗口：40px标题栏显示。
- 最大化：标题栏显示；边缘不得出现自绘圆角或外阴影。
- 全屏：标题栏隐藏，`.app`顶部 padding 归零。
- 最小化/恢复：菜单 open 状态清空。
- 窗口 blur：关闭 native popup或等待系统自动关闭；renderer open 状态最终必须归零。
- Sidebar折叠：顶栏品牌、切换按钮与菜单不移动，切换按钮图标变为展开。
- 右侧 panel展开/收起：顶栏不重排。
- 更新 pill出现/消失：只影响全局标题栏“帮助”右侧，不影响菜单位置之外的布局。
- light/dark/system切换：renderer表面和原生三键 symbol 同步，不能闪出反色按钮。

## 3. 文件级改动清单

### 主进程

- `apps/desktop/src/main/window.ts`
  - Windows WCO options、symbol theme同步、菜单栏隐藏。
- `apps/desktop/src/main/menu.ts`
  - 三平台模板、Windows四菜单、受控 submenu popup 查询。
- `apps/desktop/src/main/ipc-channels.ts`
  - 新增 menu popup invoke channel与 payload类型。
- `apps/desktop/src/main/ipc.ts`
  - 注册并校验 popup handler。
- `apps/desktop/src/main/preload.ts`
  - 暴露 `popupWindowsMenu`窄桥。

### Renderer

- `apps/desktop/src/renderer/App.vue`
  - Windows titlebar挂载、平台 class、全屏布局。
- `apps/desktop/src/renderer/components/window/WindowsTitleBar.vue`
  - 新组件。
- `apps/desktop/src/renderer/components/Sidebar.vue`
  - Windows Sidebar 省略整个品牌 Header。
- `apps/desktop/src/renderer/lib/desktopFlag.ts`
  - `isWindowsDesktop`。
- `apps/desktop/src/renderer/lib/windowsMenu.ts`
  - bridge探测、菜单 ID、坐标请求与无桥降级。
- `apps/desktop/src/renderer/style.css`
  - 仅放跨组件/根层级的 Windows chrome token和基础规则；组件局部样式留在组件内。
- 品牌 mark组件或生成脚本相关文件
  - 仅在确认需要抽取复用时修改。

### 测试

- `apps/desktop/tests/main/window.test.ts`
- `apps/desktop/tests/main/menu.test.ts`
- `apps/desktop/tests/main/preload.test.ts`
- `apps/desktop/tests/main/ipc.test.ts`（若现有测试组织允许；否则新增）
- `apps/desktop/tests/renderer/windows-titlebar.test.ts`
- `apps/desktop/tests/renderer/windows-menu.test.ts`
- 现有 Sidebar renderer测试按需要补 Windows分支。

### 文档

- `apps/desktop/src/renderer/views/DesignSystemView.vue`
  - 新增 Windows全局标题栏规范、层级、尺寸、菜单状态和 Sidebar Header 平台差异。
- `apps/desktop/docs/native-todos.md`
  - 记录 Windows custom titlebar分叉及同步注意事项。
- `apps/desktop/README.md`
  - 更新窗口 chrome说明和相关文件地图。
- `README.md`
  - 若目录地图/桌面端能力描述涉及标题栏，补一句 Windows WCO。
- `AGENTS.md`
  - 按仓库硬约束，同步新增的结构、平台分叉与关键实现约束。

## 4. 分阶段实施

### Phase 1：主进程窗口 chrome

- [ ] 提取并测试三平台 title bar options。
- [ ] Windows启用 `titleBarStyle: 'hidden'` + `titleBarOverlay`。
- [ ] 隐藏传统菜单栏，但保留 application menu注册。
- [ ] 实现 overlay symbol theme同步。
- [ ] 验证 macOS traffic lights代码路径没有改变。

完成标准：

- Windows启动后原生标题栏和传统菜单栏消失。
- 最小化/最大化/关闭三键仍由系统绘制。
- 最大化按钮 hover仍出现 Snap Layout。
- macOS/Linux创建参数快照测试无回归。

### Phase 2：renderer全局标题栏

- [ ] 新增 `isWindowsDesktop`。
- [ ] 实现并挂载 `WindowsTitleBar`。
- [ ] 接入40px根布局，不重包现有DOM，除非验证证明 padding方案不可行。
- [ ] 接入 WCO safe-area变量。
- [ ] 实现品牌、四菜单入口和 drag/no-drag。
- [ ] 处理fullscreen隐藏。
- [ ] 补窄窗口fallback；虽然 desktop `minWidth=900`，组件仍不得在测试容器中溢出。

完成标准：

- 顶栏完整品牌位于最左。
- 无前进、后退；Sidebar按钮紧跟品牌。
- 原生三键区没有文字或拖动区域重叠。
- 双击空白拖动区可最大化/还原。

### Phase 3：Sidebar与更新入口

- [x] Windows隐藏 Sidebar 品牌。
- [x] 更新入口移到全局标题栏“帮助”右侧。
- [ ] Sidebar折叠后由顶栏常驻按钮重新展开。
- [ ] update无状态、有可用更新、下载中、下载完成、失败五种状态不挤压布局。

完成标准：

- 品牌只在全局标题栏出现一次。
- Sidebar展开/收起全链路可逆。
- 更新 pill状态切换不改变全局标题栏菜单位置。

### Phase 4：Windows菜单重组

- [ ] `menuTemplate`改为明确三平台输入。
- [ ] Windows模板收敛为文件/编辑/视图/帮助。
- [ ] 所有旧能力逐项迁移，不丢菜单项。
- [ ] `View`等文案全部双语。
- [ ] dev-only菜单项生产环境不出现。
- [ ] 快捷键覆盖与shortcut recording suspended行为保持。

完成标准：

- Windows application menu内部只有四个顶层菜单。
- macOS菜单快照与现状一致。
- Linux菜单快照与现状一致。
- `Ctrl+A`仍只作用于当前编辑范围。

### Phase 5：popup IPC与交互

- [ ] 新增channel、IPC handler、preload方法与白名单测试。
- [ ] renderer点击四个入口弹出对应Electron原生submenu。
- [ ] 正确处理zoom/DPI坐标。
- [ ] popup关闭状态回传。
- [ ] 实现Alt、access key、方向键、Enter、Space、Escape。
- [ ] 处理快速切换和重复点击。

完成标准：

- 菜单严格出现在触发文字下方。
- 100%/125%/150%缩放下不漂移。
- 键盘全流程无需鼠标。
- 没有悬空的 `aria-expanded=true`。

### Phase 6：文档与视觉收尾

- [ ] 更新Design System。
- [ ] 更新native todos分叉清单。
- [ ] 同步README与AGENTS。
- [ ] 按changeset skill写patch changeset，只选`kimi-code-app`。
- [ ] 清理过期注释，特别是“Windows保留默认标题栏”的描述。

## 5. 自动化测试计划

### `window.test.ts`

- win32返回hidden + 40px overlay。
- darwin保持hidden + traffic lights。
- linux保持default。
- light/dark symbol颜色正确。
- window destroyed时overlay更新no-op。

### `menu.test.ts`

- Windows只有四个顶层菜单及稳定ID。
- Windows四菜单内容与§1.3一致。
- macOS/Linux模板不回归。
- zh/en所有自有文案完整。
- production隐藏强制刷新与开发者工具。
- dev显示强制刷新与开发者工具。
- 自定义Settings/New Chat/Open Folder快捷键继续映射。
- suspended状态移除非编辑菜单accelerator。
- scoped Select All handler仍向renderer发送事件。

### `preload.test.ts`

- 白名单包含且只包含新增的`popupWindowsMenu`能力。
- 合法payload走invoke。
- callback/Promise结果透传。
- 不允许renderer传任意channel。

### IPC测试

- 非白名单menu ID拒绝。
- NaN/Infinity/字符串坐标拒绝。
- 坐标越界被clamp。
- 非主窗口sender拒绝。
- 非win32返回未打开。
- zoom换算正确。
- popup callback一定resolve。

### Renderer测试

- 非Windows不渲染titlebar。
- Windows渲染一次Logo和四个菜单。
- 顶栏不存在前进/后退按钮，Sidebar按钮紧跟完整品牌。
- 点击菜单调用正确ID与坐标。
- Promise pending期间`aria-expanded=true`，resolve后false。
- Alt+F/E/V/H打开正确菜单。
- 左右键移动一级菜单焦点。
- Escape关闭并恢复焦点。
- fullscreen隐藏titlebar。
- Windows Sidebar 不渲染品牌 Header；更新入口位于全局标题栏。
- Sidebar折叠后顶栏按钮仍可重新展开，且不出现浮动展开/新建会话按钮。

## 6. 视觉与真机验收

UI改动必须在Windows真机验证。构建、typecheck、lint通过不算完成。

### 必验矩阵

| 维度 | 状态 |
|---|---|
| 主题 | light / dark / system |
| 窗口 | active / inactive |
| 大小 | normal / maximized / fullscreen |
| DPI | 100% / 125% / 150% |
| Sidebar | expanded / collapsed / resizing |
| 右侧面板 | closed / open / resizing |
| 更新 | hidden / available / downloading / downloaded / failed |
| 菜单 | hover / keyboard focus / open / switching / dismissed |

### 行为清单

- [ ] 拖动标题栏空白区移动窗口。
- [ ] 双击空白区最大化/还原。
- [ ] 最大化按钮hover出现Snap Layout。
- [ ] 原生关闭按钮hover使用Windows危险态。
- [ ] 四个菜单popup位置准确。
- [ ] Alt与access keys可用。
- [ ] 菜单打开时点击标题栏、Sidebar、会话区均能正常关闭。
- [ ] 菜单打开时不会误拖窗口。
- [ ] Sidebar折叠/展开不推动顶栏品牌和菜单。
- [ ] 全屏没有40px空带。
- [ ] 主题切换时无白闪/黑闪/反色symbol。
- [ ] 窗口失焦后hover/open状态清理。
- [ ] 高对比度模式下边界和focus仍可辨认。

根据仓库约束，未经用户明确许可不得自行启动`pnpm dev:desktop:debug`、连接自动化浏览器或操作桌面UI。实施到视觉验证阶段时：

1. 先向用户说明需要Windows亮/暗色与交互检查；
2. 获得明确许可后再启动debug与浏览器控制；
3. 若未获许可，提供人工验收清单并明确“视觉验证待用户执行”，不得声称已完成视觉验收。

## 7. 验证命令

每个phase至少运行相关定向测试；收尾运行：

```bash
pnpm --filter kimi-code-app run test
pnpm --filter kimi-code-app run typecheck
pnpm --filter kimi-code-web run check:style
pnpm lint
pnpm test
```

说明：

- `check:style`必须确认本次修改文件没有新增§06 findings。
- desktop-only实现不要求同步到`apps/web`，但共享文件若有改动必须确认web构建未受影响。
- 若抽取共享品牌组件或修改`packages/web-ui`，追加相应package测试与两端typecheck。

## 8. 风险与规避

### WCO安全区与DPI漂移

风险：菜单或会话内容进入原生三键区域，popup在125%/150%DPI下偏移。

规避：布局使用`env(titlebar-area-*)`；popup坐标换算提纯函数并按多个zoom单测；真机验收三档DPI。

### 原生菜单与renderer状态脱节

风险：native popup已关闭但按钮仍显示open，或快速切换弹出多个菜单。

规避：popup用Promise包住Electron callback；单例popup控制器；blur/destroy兜底resolve。

### Accelerator被破坏

风险：隐藏菜单栏后快捷键不工作，或自定义快捷键录制被Electron抢键。

规避：继续注册application menu；保留现有shortcut override和suspended机制；把相关测试作为合并门槛。

### drag region吞掉点击

风险：Electron drag区域优先消费pointer事件，菜单、更新或会话操作失效。

规避：只有全局标题栏容器为drag；所有交互节点明确no-drag；菜单open期间可将整个标题栏临时降为no-drag，复用macOS现有overlay-dismiss经验。

### 品牌资产漂移

风险：标题栏和Sidebar各复制一份生成SVG，后续品牌更新只改一处。

规避：标题栏落地后Windows Sidebar不再显示品牌；品牌mark保持单一renderer组件或单一生成源。

### 平台回归

风险：重构`menuTemplate(isMac)`时改变macOS/Linux菜单。

规避：先为现有macOS/Linux模板补快照/结构断言，再改平台参数；Windows分支单独实现。

## 9. 明确非目标

- 不做完全frameless窗口。
- 不自绘最小化、最大化、关闭按钮。
- 不改macOS traffic lights、vibrancy或拖动区。
- 不给web加入全局标题栏。
- 不改Linux标题栏。
- 不新增前进/后退导航。
- 不把前进、后退或新建会话按钮放到全局标题栏。
- 不在renderer复制原生菜单项及业务handler。
- 不在本任务调整Sidebar主体、ChatHeader信息密度或右侧面板设计。
- 不修改`kimi-code/` submodule。

## 10. 完成定义

只有以下条件全部满足才算完成：

- Windows原生标题栏与传统菜单栏被40px自定义标题栏替代。
- 顶栏左侧完整品牌，且品牌在可见窗口chrome中只出现一次。
- 顶栏无前进、后退，Sidebar按钮紧跟完整品牌。
- Sidebar 不保留空白品牌 Header，更新入口位于全局标题栏。
- Sidebar折叠后可从下方会话Header重新展开。
- Windows原生三键与Snap Layout保留。
- 文件/编辑/视图/帮助四个原生popup菜单功能、快捷键和键盘导航完整。
- light/dark/system、普通/最大化/全屏、100%/125%/150%DPI全部验收。
- macOS、Linux、web无行为变化。
- 定向测试、desktop测试、根测试、typecheck、lint、style check通过。
- Design System、native todos、README、AGENTS同步。
- patch changeset只包含`kimi-code-app`。
