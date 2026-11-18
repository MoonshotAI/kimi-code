# apps/kimi-code 开发指南

本文件只包含 `apps/kimi-code` 局部的规则。全仓库通用的规则见根目录的 `AGENTS.md`。

> **要编写或修改 TUI？** 使用 `write-tui` 技能（`.agents/skills/write-tui/SKILL.md`）。它涵盖架构导览、新功能放在哪里、测试放在哪里、主题机制，以及对话框的交互和视觉规范（`DESIGN.md`）。本文件只保留地图、边界和硬约束。

## TUI 文件布局

`apps/kimi-code` 是终端界面 / CLI 应用。入口链路是：

`src/main.ts` -> `src/cli/commands.ts` -> `src/cli/run-shell.ts` -> SDK `KimiHarness` -> `src/tui/kimi-tui.ts`

主要目录：

- `src/constant/`：CLI/TUI 共用的非文案常量，包括产品、协议、路径、终端控制、更新等。
- `src/cli/`：命令行参数、子命令和 CLI 启动。
- `src/tui/`：交互式终端界面。
- `src/tui/kimi-tui.ts`：`KimiTUI` 协调器，把状态、布局、编辑器、会话、SDK 事件和对话框连接在一起，并分发斜杠命令的处理函数。重逻辑委托给 `controllers/`，不在这里堆积。
- `src/tui/tui-state.ts`：`TUIState`、`createTUIState`、`createInitialAppState`，即唯一的全局 UI 状态结构。
- `src/tui/controllers/`：可独立测试的各项职责，包括 `session-event-handler`（SDK 事件路由）、`streaming-ui`（流式渲染）、`session-replay`（恢复/回放）、`tasks-browser`、`editor-keyboard`、`auth-flow`。
- `src/tui/commands/`：斜杠命令的定义、解析、排序，以及技能命令的动态生成。
- `src/tui/components/`：pi-tui 组件，按 UI 类型组织。
- `src/tui/constant/`：TUI 各模块复用的非文案常量，包括符号、终端序列、渲染尺寸、流式参数匹配规则等。
- `src/tui/components/chrome/`：常驻的 UI 外围元素，包括页脚、待办面板、欢迎信息、加载指示器、设备码。
- `src/tui/components/dialogs/`：临时替换编辑器的选择器、审批面板、提问弹窗和设置弹窗。
- `src/tui/components/editor/`：自定义输入框和文件提及 provider。
- `src/tui/components/media/`：图片、diff、代码高亮等媒体展示。
- `src/tui/components/messages/`：对话记录里的消息块，包括助手、用户、工具调用、思考、用量、子 agent 等。
- `src/tui/components/panes/`：右侧 / 活动区的窗格，例如活动窗格和队列窗格。
- `src/tui/reverse-rpc/`：把 SDK 的审批/提问回调桥接到 UI 的适配层。
- `src/tui/theme/`：主题、颜色 token、样式辅助函数、终端背景检测，以及 pi-tui 的 markdown 主题。
- `src/tui/utils/`：只供 TUI 使用的工具函数。
- `src/utils/`：全应用通用的工具，包括剪贴板、git、历史记录、图片、进程、用量等。

## 模块职责

- `cli` 只负责解析命令行输入、组装启动参数并调用 TUI。不要把 TUI 交互逻辑放进 CLI。
- `KimiTUI` 负责协调，不堆积复杂的业务规则。能独立测试的新逻辑，应该优先拆到 `controllers`、`commands`、`components`、`reverse-rpc` 或 `utils` 里。
- `controllers` 承担那些重的、可独立测试的部分（事件路由、流式渲染、会话回放、任务浏览器、编辑器键盘、认证）。事件路由和渲染逻辑属于这里，不属于 `KimiTUI` 类。
- `commands` 只负责斜杠命令的声明、解析和解析结果的类型。实际执行可以由 `KimiTUI` 分发，但复杂逻辑应该继续往下沉。
- `components` 只负责展示和局部交互；不能直接调用 SDK，也不能直接读写会话状态。
- `reverse-rpc` 把 SDK 的审批/提问请求转换成 UI 面板/对话框需要的数据结构，再把用户的选择转换回 SDK 响应。
- `theme` 是颜色和样式的唯一依据。组件不能绕过主题系统直接使用 chalk 命名颜色。
- `utils` 存放不依赖 UI 状态的工具函数。需要 `TUIState` 或组件实例的逻辑，不能放在应用级的 `src/utils` 下。

## TUI 编码约定

- 不要过度封装，尤其是只有一两行的函数：不要引入两层包装，直接内联。
- 没有状态 / UI 副作用的函数，不应该做成 `KimiTUI` 类的私有方法；把它们放到外部的 utils 里。
- 常量必须放在对应的 `constant` 目录里，不能散落在组件或逻辑代码中。
- 在 `handleInput(data)` 里比较可打印字符（字母、数字、空格、标点）时，**禁止**写 `data === 'q'` 这样的字面量比较。在 VSCode 这类终端里启用 Kitty 键盘协议后，这些按键会以 CSI-u 序列发送（例如 `\x1b[113u`），直接比较永远匹配不上。先用 `src/tui/utils/printable-key.ts` 里的 `printableChar(data)` 解码，再比较；功能键继续用 `matchesKey(data, Key.*)`；控制字符（码点 < 32）仍然可以和原始的 `data` 比较。`test/tui/printable-key-guard.test.ts` 在 CI 中强制执行这条规则。

## 颜色规则（规范性）

主题的应用/切换机制写在 `write-tui` 技能里。下面这些规则是硬性规则，由守卫强制执行：

- 不要直接使用 `chalk.red`、`chalk.cyan`、`chalk.white`、`chalk.gray`、`chalk.dim` 或 `chalk.yellow` 这类 chalk 命名颜色。
- 组件里已经有 `colors` 时，用 `chalk.hex(colors.<token>)(text)`。
- 组件里已经有 `state.theme.styles` 或传入的 styles 时，优先用 `styles.error(text)`、`styles.dim(text)` 这类辅助函数。
- 新的视觉语义没有对应的 token 时，先在 `ColorPalette` 里加一个语义字段，并同时填好 `darkColors` 和 `lightColors`。
- 浅色主题里，文字 token 相对白色背景的对比度至少要 4.5:1；边框和大块 UI 外围元素至少要 3:1。
- 不要在模块顶层缓存带样式的 chalk 函数。主题切换必须在一次渲染内生效，所以样式必须在渲染路径上根据当前调色板生成。
- 非注释代码里不能出现 `chalk.white`、`chalk.cyan`、`chalk.red`、`chalk.green`、`chalk.gray`、`chalk.yellow`、`chalk.blue`、`chalk.magenta`、`chalk.whiteBright` 或 `chalk.blackBright` 这类 chalk 命名颜色。`test/tui/chalk-named-color-guard.test.ts` 在 CI 中强制执行这条规则。

## 通用编码要求

- 工作区信任关卡之前的启动路径（`KimiTUI.start()` -> `maybeRunWorkspaceTrustPrompt()`）上，不能用裸命令名启动子进程：在 Windows 上，cmd.exe / CreateProcess 会先从当前目录解析命令名，所以被植入不受信任工作区的二进制文件，会在用户确认信任之前就运行。确实避免不了外部命令时，用 `src/utils/process/resolve-command.ts` 里的 `resolveCommandPath` 解析：它返回在 PATH 中命中的绝对路径，并拒绝位于 cwd 内的匹配。
- 可选的对象属性，类型里不需要再额外允许 `undefined`。
- 只有一个参数的内部方法，不要为了风格统一改成 options 对象。
- 除了包自己的 `index.ts`，其他 `index.ts` 优先写成 `export * from './module'`。
