# Desktop 内置终端（Electron 原生，desktop-only）

## 决策（已与用户确认）

- **只做 desktop**，web 不涉及。
- **不依赖 server 接口**：PTY 由 Electron 主进程直接 `node-pty` 托管，renderer 经 IPC 桥交互。kimi-code submodule 零改动。
- **底部可折叠面板**（VS Code 风格）：全宽 grid 行、可拖拽调高、高度持久化。
- **多 tab**：tab 栏 + 每 tab 一个 PTY 实例。
- **cwd 跟随当前会话工作区**：开新 tab 时取 `client.visibleWorkspace.value?.root ?? client.status.value.cwd`，主进程兜底 home。**终端状态按 sessionId 分桶**（2026-07-28 需求变更，取代此前的"切工作区全杀"）：切 session 只换可见桶，旧桶 PTY/xterm 保留、切回恢复原样；上限 10 个 session，LRU 驱逐杀 PTY。
- **shell 固定最优默认（不做选择器）**：macOS/Linux 用 `$SHELL`，Windows 按 pwsh → powershell → cmd 探测链；平台分流见下文「Shell 默认策略」。

## 平台与 shell 差异处理

### Shell 默认策略（主进程 `terminal.ts` 内纯函数）

- **macOS / Linux**：`process.env.SHELL || '/bin/zsh'`（shell-env 探测后 `$SHELL` 即用户 login shell，Mac 上通常就是 zsh）；交互式非登录启动（不带 `-l`），`.zshrc`/`.bashrc` 照常 source，PATH/Homebrew/nvm 从继承的 env 可用。
- **Windows**：探测链 `pwsh.exe`（`%ProgramFiles%\PowerShell\7\pwsh.exe` + PATH）→ `powershell.exe`（System32 恒有）→ `process.env.COMSPEC`（cmd）兜底；**不用 COMSPEC 当首选**（几乎恒为 cmd，体验差）。
- **macOS locale 修补**：GUI/launchd 启动缺 `LANG`/`LC_*`，终端里中文与 UTF-8 工具会乱码——POSIX 下 spawn env 缺 `LANG` 且无 `LC_ALL` 时补 `LANG=zh_CN.UTF-8 / en_US.UTF-8`（按 `app.getLocale()`，VS Code 同款做法）。
- 不支持 Git Bash / WSL（无选择器入口，后续要加再立探测 + 下拉）。

### 平台相关已知限制

- node-pty Windows 走 conpty（1.1 默认开），Win10+ 可用；Win 侧行为需真机单独验证。

## 现状基础（已核实）

- `node-pty ^1.1.0` 已是 desktop 生产依赖；tsdown `neverBundle`（`apps/desktop/tsdown.config.ts:43`）、electron-builder `asarUnpack` + 重编译 + 公证全部配好——主进程 `require('node-pty')` 开箱即用。
- 主进程启动时已把用户 login shell env 填进 `process.env`（`src/main/shell-env.ts`），PTY spawn 直接继承。
- `@xterm/xterm` + `@xterm/addon-fit` 已在 renderer devDeps；现有孤儿组件 `src/renderer/components/Terminal.vue`（走 daemon 链路）提供 xterm 初始化范本（等字体加载再测量、fit 防抖、动态 import），但**不直接复用/修改它**（它是 web 共享文件且绑定 server 链路）。
- IPC 三件套模式：`ipc-channels.ts`（channel 常量）→ `ipc.ts`（handler + 运行时校验 + `event.sender === win.webContents` 检查）→ `preload.ts`（白名单方法 + 结构校验）→ `tests/main/preload.test.ts` 钉映射。
- 快捷键体系：`lib/keymap.ts` action 注册表 + `composables/useShortcuts.ts` + `App.vue` 全局 dispatcher；菜单 accelerator 跟随走 `kimi:menu-shortcut` → `src/main/menu.ts` `MENU_SHORTCUT_DEFAULTS`；`Backquote` 已在 `CODE_PUNCT` 映射里，`` ctrl+` `` 可表达（默认取 ⌃` 对齐 VS Code，避让 macOS 系统窗口切换键 ⌘`）。
- 面板机制参照：`.app` grid `auto 0 minmax(0,1fr) 0 auto`（`App.vue:1517`），右侧 aside 宽度过渡 0↔`var(--preview-w)`（`App.vue:1267-1271` 注释）；`composables/useResizable.ts` 持久化拖拽（宽）+ `components/ResizeHandle.vue`。

## 实现步骤

### 1. 主进程：PTY 管理器 `src/main/terminal.ts`（新文件）

- `createTerminalManager(deps)` 依赖注入（照 `trace.ts` 模式），模块级单例；`node-pty` 经动态 `require` 懒加载（CJS 主进程，external）。
- shell 解析为模块内纯函数（上文「Shell 默认策略」：`resolveDefaultShell(platform, env, deps)` 可注入探测依赖便于测试；`defaultShellEnv(platform, locale, env)` 做 macOS LANG 修补）。
- 状态：`Map<id, { pty, shell, cwd }>`，id 用 `crypto.randomUUID()`。
- `create({cwd, cols, rows})`：spawn 参数 `{name: 'xterm-256color', cwd（不存在/非目录回退 home）, env: defaultShellEnv 修补后的 process.env, cols, rows}`；`cols/rows` 钳 1–500。返回 `{id, shell, cwd}`（shell = 可执行 basename，展示用）。
- `pty.onData` → 经回调推 `kimi:terminal-output`（id + data）；`onExit` → 推 `kimi:terminal-exit`（id + exitCode）并从 Map 移除。
- `write(id, data)`（data 为 string，截 1MB 上限）、`resize(id, cols, rows)`、`close(id)`（kill + 移除）、`killAll()`。
- 生命周期：`app 'before-quit'` 调 `killAll()`；renderer `render-process-gone` 与跨文档 `did-start-navigation`（照 window.ts 就绪位先例）时 `killAll()`——终端状态不跨 renderer 重载保留。
- 主进程可见文案：无（shell label 是 zsh/PowerShell 等专名不翻译，终端内容来自用户 shell），无双语要求。

### 2. IPC 三件套

- `ipc-channels.ts`：新增 `terminalCreate` / `terminalInput` / `terminalResize` / `terminalClose` / `terminalOutput` / `terminalExit` 六个 `kimi:terminal-*` channel；`RendererEventChannel` 加 output/exit。
- `ipc.ts`：注册 handler——create 用 `ipcMain.handle`（校验 cwd/cols/rows + `event.sender === win.webContents`），input/resize/close 用 `ipcMain.on`（payload 逐字段校验，畸形丢弃）。
- `preload.ts`：`KimiDesktopApi` 加 `createNativeTerminal(opts)` / `nativeTerminalInput` / `nativeTerminalResize` / `closeNativeTerminal` / `onNativeTerminalOutput` / `onNativeTerminalExit`（类型结构性复制 + 入参白名单校验，订阅方法返回退订函数）。
- `tests/main/preload.test.ts` 同步白名单 + 通道断言。

### 3. renderer：desktop-only composable `composables/useNativeTerminal.ts`（新文件，不同步 web）

- 照 `useFullscreen.ts`/`useTrayAttention.ts` 模式：模块级单例、桥探测（`window.kimiDesktop.createNativeTerminal` 在不在，缺桥整体 no-op）、`tests/renderer/` 钉行为。
- 状态：tabs 数组 `[{id, shell, title, cwd, status: 'running'|'exited', exitCode}]`、`activeTabId`、面板 `open`（localStorage `kimi-web.terminal-panel-open` 持久化）。
- 方法：`toggle()` / `openPanel()` / `closePanel()` / `newTab()`（cwd 取当前工作区 root）/ `closeTab(id)` / `activateTab(id)` / `restartTab(id)` / per-tab `write/resize`；`onOutput(tabId, cb)` 订阅。
- 启动时订阅一次 `onNativeTerminalOutput/onNativeTerminalExit`，按 tab id 路由到各 tab 的输出 handler 与 exit 状态。

### 4. renderer：面板组件 `components/terminal/TerminalPanel.vue`（新文件，desktop-only）

- 结构：顶部工具栏（tab 列表可点击切换/关闭，tab 标题 = shell 名；「+」新 tab；右侧收起按钮）+ xterm 宿主区。
- xterm 封装子组件 `TerminalView.vue`：照现有 `Terminal.vue` 的初始化范本（`document.fonts.ready` 后建实例、JetBrains Mono 字体栈、亮暗 ITheme 跟随 `useIsDark`、FitAddon + ResizeObserver 100ms 防抖、`onData → write`、`onResize → resize`）；主题色沿用现有硬编码值及其注释原因（xterm 画 canvas 不解析 CSS var）。
- 每 tab 一个 TerminalView，`v-show` 保活切换；激活/面板尺寸变化后 `fit()` 并上报 resize。exit 后 tab 标记 exited、终端内打印 `[process exited …]`，工具栏给 restart。
- 样式只用 token；亮暗双主题验证。

### 5. 布局：App.vue 加底部 grid 行

- `.app` 加 `grid-template-rows: minmax(0, 1fr) auto`；既有 5 列不变，各列钉 `grid-row: 1`。
- 新增 `<section class="terminal-panel">`：`grid-column: 3; grid-row: 2`——只占会话列下方，侧栏与右侧面板 `grid-row: 1 / -1` 通高（VS Code 布局），照 aside 模式做高度过渡 0 ↔ `var(--terminal-h)`（`--terminal-h` 由父级 `style.setProperty` 命令式写入，照 `--preview-w` 先例避免逐帧 Vue 重渲染）；关闭时高度 0、`aria-hidden`，TerminalPanel 内容 `v-if`（tab/PTY 在 panel 关闭期间保留，重开重新挂载视图）。
- 拖拽调高：`useResizable` 加向后兼容的 `axis?: 'x' | 'y'` 选项（默认 'x' 零行为变化；y 轴用 clientY、row-resize/n-resize/s-resize 光标），新建 desktop-only `components/terminal/TerminalResizeHandle.vue`（水平条，4px 高，margin -2px 0 覆盖描边，照 ResizeHandle 视觉）。`useResizable.ts` 是共享文件 → 改动**同步 apps/web**（web 不使用新选项，文件保持一致）。高度存 `kimi-web.terminal-panel-height`，min 120 / max 视口 60%。
- App.vue 的改动属 desktop 分叉块，登记 native-todos。

### 6. 快捷键 + 菜单入口

- `lib/keymap.ts`：`SHORTCUT_ACTIONS` 加 `` { id: 'toggleTerminal', scope: 'global', defaultBinding: 'ctrl+`' } ``（global scope，App.vue dispatcher 消费，overlay 打开时不响应）。
- App.vue dispatcher 分支：`toggleTerminal` → `useNativeTerminal().toggle()`。
- 菜单：`src/main/menu.ts` View 菜单加「切换终端 / Toggle Terminal」项（双语，MENU_STRINGS 模式），click → `showMainWindow()` + `kimi:menu-action` 发 `'toggle-terminal'`；`MENU_SHORTCUT_DEFAULTS` 加 `` toggleTerminal: 'ctrl+`' ``（accelerator 跟随用户绑定）；App.vue `MENU_ACTION_TO_SHORTCUT` 加映射；ChatHeader 在 OpenIn 菜单右侧加终端图标按钮（desktop 分叉块，桥探测显隐，面板打开时高亮）；空 composer 态（新建会话页，无 ChatHeader）在 ConversationPane 右上角放同款浮动按钮。
- i18n：`packages/web-i18n` en/zh 加 `shortcuts.actions.toggleTerminal.*` 与 `terminal.*`（tab/工具栏/退出态文案）——共享包加 key，web 不使用无副作用（先例：`shortcuts.*`）。

### 7. 测试

- `tests/main/terminal.test.ts`：mock node-pty（DI factory）——create 参数/cwd 回退/钳制、默认 shell 解析（POSIX `$SHELL` 优先与兜底、Windows pwsh→powershell→cmd 链）、macOS LANG 修补（缺省补/已有不动）、write/resize/close 路由、onData/onExit 转发、close 幂等、killAll、畸形 payload 丢弃。
- `tests/main/preload.test.ts`：白名单 + 6 通道 + 畸形不发送。
- `tests/main/menu.test.ts`：View 菜单终端项双语 + accelerator 跟随。
- `tests/renderer/useNativeTerminal.test.ts`：无桥 no-op、tab 增删切换、输出按 id 路由、exit 状态、面板开关持久化。
- `tests/renderer/keymap.test.ts`：新 action 默认值 sanity（`` ctrl+` `` 可解析可匹配 Backquote）。
- useResizable `axis: 'y'` 用例（desktop 侧；web 对应测试文件若存在则同步）。

### 8. 文档与收尾

- `apps/desktop/docs/native-todos.md`：新增「内置终端」已完成条目（desktop-only 新文件清单、App.vue/menu.ts 分叉块、`useResizable` 为同步改动非分叉）。
- 根 `AGENTS.md` 目录地图：`src/main/` 职责串提一句 terminal.ts；`apps/desktop/README.md` 如列主进程模块则同步。
- `DesignSystemView.vue`：终端面板若引入新的组件模式（底部面板/tab 条）按规范补登记。
- `pnpm test` / `pnpm typecheck` / `pnpm lint` / `pnpm --filter kimi-code-web run check:style`（改动文件）全绿；dev 下 `pnpm dev:desktop` 真机验证：⌃\` 开关面板、多 tab、亮暗主题、拖拽调高、窗口隐藏后终端保活、退出 app PTY 全清、终端内 UTF-8 中文不乱码。Windows 侧（pwsh 探测链与 conpty 行为）需 Win 真机单独验证。
- 完成后走 `changeset` skill 写 patch changeset（只 `kimi-code-app`）。

## 明确不做

- kimi-code submodule / kap-server WS 接线（不动）。
- web 端终端、`apps/web` 的孤儿 Terminal.vue 保持原样（不删不改）。
- 终端内容跨 renderer 重载恢复（重载即重开）、跨会话共享终端、终端内 AI 集成。
- shell 选择器及 Git Bash / WSL 支持（后续需要再加探测 + 下拉）。
