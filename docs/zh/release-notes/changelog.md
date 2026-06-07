# 变更记录

本页记录 Kimi Code CLI 每个版本的变更内容。

## 0.11.0（2026-06-05）

### 新功能

- 新增由环境变量 `KIMI_CODE_EXPERIMENTAL_SUB_SKILL` 控制的实验性子 Skill 发现能力。随附 `sub-skill` 内置包（`sub-skill.review`、`sub-skill.consolidate`），用于盘点 Skill 并将其整理为分层分组。
- 新增以下环境变量：

  - `KIMI_MODEL_TEMPERATURE`、`KIMI_MODEL_TOP_P` —— 全局应用于任意 `kimi` 供应商的采样参数（不绑定到 `KIMI_MODEL_NAME`）。
  - `KIMI_MODEL_THINKING_KEEP` —— Moonshot 的 preserved-thinking 透传（`thinking.keep`），仅在开启 Thinking 时注入。
  - `KIMI_CODE_NO_AUTO_UPDATE`（旧别名 `KIMI_CLI_NO_AUTO_UPDATE`）—— 完全禁用更新预检（不检查、不后台安装、不提示）。
- 将内置 Skill 显示为直接斜杠命令，并将其分组排在外部 Skill 命令之前。

### 修复

- 修复斜杠命令自动补全，让光标位于已有文本之前时也能提交目标文本。
- 修复已排队目标在晋升尝试失败时会丢失或重复的问题。
- 修复编辑或粘贴已排队目标时的待处理目标队列处理。
- 在 YOLO 模式下启动目标前进行询问，方便用户切换到 Auto 来处理无人值守工作。
- 当响应在产生可见输出前被拦截时，显示简洁的供应商过滤错误。
- 输入无效子命令时显示 “unknown command” 而不是 “too many arguments”。
- 将 OpenAI Chat Completions 的 `xhigh` 和 `max` thinking effort 限制为 `high`，除非模型在 `v1/chat/completions` 上支持 `xhigh`。
- 在压缩长对话时保留 thinking effort。
- 当能力变化而模型 ID 未变化时刷新供应商模型元数据。

### 优化

- 让待处理目标的确认样式与目标生命周期消息使用相同的强调处理。
- 当没有活跃目标需要等待时立即启动待处理目标。
  支持在管理待处理目标时进行多行编辑。
- 为子 Agent 使用固定的 30 分钟超时，并在超时后显示简洁的恢复说明。
- 输入斜杠命令时高亮目标队列子命令。

## 0.10.1（2026-06-05）

### 修复

- 修复在 TUI 中启动目标时的崩溃问题。

## 0.10.0（2026-06-04）

### 新功能

- 用户现在可以为 Agent 准备多个目标，让它按顺序逐一处理。当前目标完成后，Agent 会自动从队列中取出下一个目标。使用 `/goal next <objective>` 将目标加入队列，使用 `/goal next manage` 交互式查看和修改队列。
- 新增内置的 `update-config` Skill —— 你现在可以让 Kimi 编辑它自己的配置文件。
- 新增持久化的实验性功能开关，以及一个 TUI 面板，确认后会通过重载当前会话来应用变更。
- 新增 `/reload` 以重载当前会话并应用更新后的配置文件，以及 `/reload-tui` 以仅重载 TUI 偏好设置。
- 新增 doctor 命令，用于校验 Kimi Code 的配置文件。

### 修复

- 将格式错误的 Responses 流速限错误规范化为供应商速率限制失败。
- 让托管的 OAuth 凭据始终限定在其配置的认证和 API 端点范围内。
- 阻止将活跃和已排队的目标带入派生会话。
- Windows 上若缺少 Git Bash，则在启动 CLI 会话前提前失败。
- 在展示前台更新提示前刷新更新目标，确保显示版本与安装版本一致。
- 将会话错误诊断指向 `/export-debug-zip` 命令。
- 设置终端标签页标题时不再重命名运行中的进程。

### 优化

- 启动时的更新检查一旦发现新版本，立即开始自动后台更新。
- 在启动期间将 CLI 进程标题设置为 `kimi-code`。
- 将编辑工具错误中的过期文件内容提示改为小写。

### 重构

- 确保 Nix 打包的 CLI 构建能够找到 ripgrep 和 fd。

### 其他

- 在 Windows 安装说明中补充 Git Bash 前置条件。

## 0.9.0（2026-06-03）

### 新功能

- 支持 `kimi acp` 子命令：kimi-code 现在可通过 stdio 使用 [Agent Client Protocol 0.23](https://agentclientprotocol.com/)，因此 IDE（Zed、JetBrains AI Chat、自定义客户端）可以直接驱动会话；覆盖矩阵、Zed 配置和破坏性预发布说明见 [kimi acp 子命令页面](https://moonshotai.github.io/kimi-code/zh/reference/kimi-acp.html)。
- 新增 `/btw`，用于进行不会引导当前主轮次的侧通道对话，并允许 `/btw` 在输入问题前打开侧通道面板。

### 修复

- 修复 Windows 上外部编辑器（Ctrl+G），移除对 `/bin/sh` 的依赖，并为临时文件路径使用平台感知的 shell 引号处理。
- 使用新版 Chat Completions 模型所需的 OpenAI completion token 字段。
- 使用已配置的模型输出上限作为 completion token 上限。
- 修复适用于 OpenAI 兼容供应商的 goal budget 工具 schema。
- 在访问已保存的子 Agent 时再惰性恢复它们。

### 优化

- 统一 TUI 对话框和选择器的交互与视觉效果。
- 启动时记录已启用的实验性 flag。

### 重构

- 允许 SDK 运行时创建使用单独的 RPC client，同时保留本地 CLI 启动流程。

## 0.8.0（2026-06-02）

### 新功能

- 新增实验性 goal 模式，用于需要多轮处理的较长任务。在启动 Kimi 前设置 `KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1` 即可开启。

  在终端界面中使用 `/goal <objective>` 让 Kimi 跨轮次持续专注于同一任务。例如：

  ```text
  /goal Fix the failing checkout test
  ```

  Kimi 会在终端界面中显示目标，并在工作过程中保持进度可见。使用 `/goal status`、`/goal pause`、`/goal resume`、`/goal cancel` 和 `/goal replace <objective>` 来管理该目标。该功能仍处于实验阶段，欢迎试用并反馈改进建议。
- 新增 `kimi provider` CLI 子命令，支持 `add`、`remove`、`list` 以及 `catalog list` / `catalog add` 操作，可在不启动终端界面的情况下导入和管理来自自定义 registry（api.json）或公开 models.dev 目录的供应商。
- 新增后台结构化提问，让 Agent 在等待用户回答时也能继续工作。
- 新增后台自动更新，可在 tui.toml 中关闭。
- 新增 `/undo` 斜杠命令，用于从对话历史中撤回上一条提示词，并在撤回时保持回放记录同步。
- 新增 `kimi upgrade` 命令，用于手动检查并升级 Kimi Code CLI。
- 新增审批生命周期 hook 事件，用于观察待处理和已完成的权限提示。
- 允许子 Agent 使用在其父 Agent 上注册的自定义工具。
- 支持用 glob 搜索显式的绝对路径（工作空间之外）。

### 修复

- 修复跨供应商回放时因不兼容的工具调用 ID 和未签名的 Claude thinking 历史导致失败的问题。
- 修复自定义 registry 供应商在重新导入时的处理问题，防止多供应商条目丢失，并移除过时的供应商及其模型别名和默认模型引用。
- 修复工具输出预览的渲染效果：去除尾部空行、为多行 Bash 命令标题附加省略号，并按视觉换行而非原始换行数裁切过长的单行输出。
- 修复斜杠激活的 skill 因缺少系统提示词包装器而未被模型识别的问题。
- 修复在过窄终端上 `/sessions` 选择器崩溃的问题，通过将每行渲染宽度限制在终端宽度内。
- 在括号展开前规范化 glob 模式，防止不正确的路径匹配。
- 防止退出 CLI 后仍出现修改过的键盘释放序列。
- 修复 Windows 上的 Git Bash 路径检测，额外搜索 `usr\bin\bash.exe` 路径，这是许多 Git for Windows 安装中 bash 所在的位置（这些安装中 `bin\bash.exe` 不存在）。

### 优化

- 在欢迎面板中展示 MCP server 摘要，并在 /mcp 命令输出中增加配置提示。
- 在欢迎界面及未配置模型时的提示中，将用户引导至 `/provider` 而非已移除的 `/connect` 命令。
- 将当前 todo 列表以 markdown 形式附加到压缩摘要中，再写入历史记录。
- 在页脚状态栏中显示完整模型名称，不再截断供应商前缀。
- 在长任务中提醒模型刷新 TodoList，并加强 TodoList 进度追踪引导。
- 将会话目录警告中的 chalk 具名颜色替换为主题感知的十六进制色值。

### 重构

- 将后台任务管理统一到 Agent 后台运行时中。

## 0.7.0（2026-06-02）

### 新功能

- 新增用于管理 AI 供应商的 `/provider` 命令，支持自定义 registry 导入，并引入标签页式模型选择器。该命令替代了已废弃的 `/connect`，请改用 `/provider`。
- 在终端界面中以独立样式渲染定时提醒，向 SDK 客户端暴露 cron 触发事件，并在报告 cron 触发时间时附带本地时区偏移。
- 新增 `KIMI_MODEL_ADAPTIVE_THINKING`（以及对应的 `adaptive_thinking` 模型别名字段），用于强制开启或关闭自适应 thinking（`thinking: { type: 'adaptive' }`），覆盖基于 Anthropic 模型名的版本推断。这样一来，背后由支持自适应能力的模型驱动、且使用自定义名称的兼容端点，即使模型名没有编码出可解析的 Claude 版本，也能选择启用该能力。

### 修复

- 清晰地报告被截断的压缩摘要，并在受支持的各供应商上应用有效的补全 token 额度。
- 修复 glob 模式的反斜杠转义，并在截断消息中包含匹配数量。

### 优化

- 明确 Kimi Platform API 密钥登录的标签和提示细节。
- 优化终端界面中的一处细微视觉交互。

## 0.6.0（2026-05-29）

### 新功能

- 新增 `KIMI_MODEL_*` 环境变量通道，让你无需编辑 `config.toml` 即可让 Kimi Code 使用指定模型（供应商类型、base URL、API 密钥、上下文大小、能力以及 thinking 设置）。
- 支持直接从 GitHub 仓库 URL 安装 plugin，并在 plugin 管理器中展示每次安装的来源和信任级别（kimi-official、curated、third-party）。

### 修复

- 在对话记录中显示后台 Agent 真实的最终状态，使丢失、失败和被终止的 Agent 不再显示为已完成；并在失败通知中包含用于恢复的 agent id 和恢复说明，让模型能够可靠地恢复。
- 在长对话中从供应商模型的 token 限制错误中恢复。
- 当模型响应流在传输中途被中断（`terminated` 错误）时自动重试，而不是让该轮次失败。
- 在各供应商的响应中一致地处理上下文溢出错误。
- 将失败的压缩重试按模型上下文窗口的固定一段进行退避。
- 修复原生自更新程序在安装命令实际失败时仍报告更新成功的问题。
- 将持久化的 hook 消息和被拦截的提示词消息投射到模型上下文中。
- 让被拦截的提示词 hook 的对话在后续的模型轮次中保持可用。
- 修复恢复不存在的会话时页脚泄漏到终端的问题。
- 修复当临时文件位于另一个文件系统上时 ripgrep 自动安装的问题。

### 优化

- 移除每轮 1000 步的默认上限。用户仍可在配置中设置 `max_steps_per_turn` 来强制使用自定义上限。
- 支持在 listSessions 中通过 sessionId 或 workDir 查询会话，并在从其他工作目录恢复会话时显示一条便捷的 cd 命令。
- 扩充页脚轮换提示，展示更多命令和快捷键，并更突出地呈现较新和重要的内容。
- 改进终端界面中的用量信息展示。
- 将 plugin 信任徽章限制为仅匹配 Kimi 托管的 plugin CDN URL 模式。
- 明确子 Agent 和后台任务的停止消息为用户主动发起。
- 将数据源 plugin 对齐到通用的双工具工作流。

### 重构

- 引入 `ModelProvider` 接口和 `SingleModelProvider`，将 `Agent` 与 `ProviderManager` 解耦。
- 将 `RuntimeConfig` 拆分为 `Kaos` 和 `ToolServices`，并相应更新所有引用。
- 精简 LLM 诊断日志，使用更少、更紧凑的字段。
- 将共享的工具服务类型定义迁移到工具支持层。

## 0.5.0（2026-05-28）

### 新功能

- 新增定时任务：

  你现在可以让 Agent 在指定时间提醒你、按重复的 cron 计划运行任务（例如每 5 分钟检查一次部署，或每个工作日上午 9 点生成一份日报），也可以让它在几分钟后自动回来继续之前的工作。

  定时任务使用标准的 5 字段 cron 语法。

- 新增 `/auto` 斜杠命令和 `--auto` CLI 参数，用于启用 auto 权限模式。
- 在 `Write` 和 `Edit` 的审批提示中显示文件内容与 diff，并通过 `Ctrl-E` 在专用的全屏查看器中打开。

### 修复

- 修复压缩流程在无可压缩消息时的边界情况处理，并改进重试逻辑。
- 修复官方数据源工具，保留完整的响应内容，并写入返回的结果文件。
- 修复迁移把旧版 `default_yolo` 键映射到已废弃的 `yolo` 字段、而非 `default_permission_mode` 的问题。

### 优化

- 在更新提示中新增可点击的变更记录链接。
- 用 `Ctrl-O` 展开 Bash 工具卡片时显示完整的 Bash 命令。卡片标题仍会将过长命令截断至 60 个字符，但展开后的视图现在会在输出上方显示完整的多行命令。
- 将写入终端窗口/标签页的会话标题从 80 个字符缩短到 32 个字符，避免较长的首条消息或粘贴内容把标签栏拉伸到难以阅读的宽度。
- 将嵌入式待办面板上限设为 5 行，并显示 `+N more` 指示器，避免较长的任务列表填满整个屏幕。
- 明确 plugin 管理器的键盘快捷键，并在原地显示 plugin 状态变化。
- 在 plugin 管理器的摘要中报告检测到的 plugin Skill。
- 将 `wire.jsonl` 中的大型 base64 媒体内容卸载到外部 blob 文件，减小 wire 体积，降低会话回放时的内存压力。同时为 `BlobStore` 增加内存级直读缓存，避免重复重建时产生多余的磁盘读取。
- 在 `AskUserQuestion` 对话框中对过长的问题、正文和选项文本进行换行显示，而不是用省略号截断。问题提示、正文描述、选项标签、选项描述以及提交标签页的复核条目现在会以悬挂缩进的方式分多行显示。

### 重构

- 重构终端界面的代码结构。

## 0.4.0（2026-05-27）

### 新功能

- 新增用户全局的 plugin 安装能力，包括交互式 plugin 管理、plugin 提供的 Skill，以及 plugin 自带的 MCP server。
- 在第二次粘贴时展开折叠的粘贴标记。
- 重做工具权限：cwd 之外的读取不再触发提示，会话级授权按完整调用精确匹配，基于路径的规则改为大小写不敏感。
- 新增 `/export-debug-zip` 斜杠命令，可直接在终端界面将当前会话导出为调试用 ZIP 归档。
- 新增 `/export-md` 斜杠命令，可将当前会话导出为 Markdown 文件。

### 修复

- 在启动时若 pull request 查询失败，避免终端界面崩溃。
- 修复在空 Thinking 增量产生孤立 Thinking 组件时，Thinking 旋转图标残留到轮次结束之后的问题。
- 派生会话后显示原始的会话恢复命令。
- 限制 plugin zip 安装：仅接受 manifest 位于归档根目录或单层包装目录的情况。
- 将带会话标签的日志条目独占地路由到会话 sink，不再同时写入全局 sink；并对所有携带 `agentId=main` 的会话日志行，统一省略主 Agent 中稳定不变的上下文键。

### 重构

- 重构终端界面中的会话恢复回放逻辑。
- 在常规轮次与压缩中，对瞬时 LLM 失败采用统一的重试分类。

### 其他

- 增强 `kimi export`，在 manifest 中记录更多诊断信息。

## 0.3.0（2026-05-26）

### 新功能

- `/logout` 现在会打开一个选择器，让你选择要登出的供应商，而不再总是登出当前模型所对应的供应商。当前供应商默认高亮，因此按 Enter 即可保持与此前一致的行为。该命令同时以 `/disconnect` 别名提供。
- `openai` 供应商现在开箱即用地支持 OpenAI 兼容的 reasoner 模型：自动识别响应中的 Thinking 字段（`reasoning_content` / `reasoning_details` / `reasoning`），并在历史包含 Thinking 时自动注入 `reasoning_effort`。DeepSeek、Qwen、One API 等网关服务无需再手工设置 `reasoning_key`，该字段仍可作为非标准网关的显式覆盖项。

### 修复

- 在流式输出或压缩上下文期间，阻止运行 `/model` 和 `/sessions` 斜杠命令。
- 在通过 `/connect` 配置 OpenAI 兼容模型时，保留模型目录中声明的 interleaved reasoning 字段。
- 修复 API 密钥输入对话框在空白状态下显示掩码点的问题。
- 修复 `~/.agents/` 下的用户 Skill 未被加载的问题。
- 恢复终端界面中运行中的子 Agent 的实时 token 显示。
- 在会话恢复时，若所有待办均已完成则隐藏待办面板。
- 在工具返回结果格式错误或缺失时，始终发出配对的工具结果，避免下一次请求因缺少 `tool_call_id` 而失败。
- 修复 Plan 模式下的会话重置：新会话在 Plan 评审被拒后不再失败，并能在初始化错误后继续接收事件。
- 在控制终端消失时及时退出。终端界面现在会处理 `SIGHUP` / `SIGTERM` 信号以及 stdout/stderr 的 `EIO` / `EPIPE` / `ENOTCONN` 错误，避免父 shell 或终端复用器异常退出后残留占用 CPU 核心的 `kimi` 进程。
- 避免本地补全上限过小，导致摘要生成前推理被截断。

### 重构

- 让 `AgentRecords` 直接持有 `Agent` 实例，并将恢复时的派发逻辑内联。

### 其他

- 改进 `Write` 工具的交互体验。

## 0.2.0（2026-05-26）

### 新功能

- 新增 `/connect` 命令，可从模型目录中配置供应商和模型。
- `/connect` 的供应商和模型选择器现支持键入即搜索过滤，长列表会自动分页；配置了较多模型时，`/model` 选择器同样支持分页。
- 在终端界面输入框中新增 `Ctrl-J` 作为插入换行的额外快捷键。
- 在会话回放过程中新增 wire 记录迁移处理。
- 在首次启动迁移期间，将用户 Skill 从 `~/.kimi/skills/` 迁移到 `~/.kimi-code/skills/`；已存在的目标 Skill 会被保留。
- 在 stream-json 输出格式中以结构化 meta 消息形式发出会话恢复提示。

### 修复

- 在 OAuth 设备信息中改为上报 macOS 产品版本，而不是 Darwin 内核版本。
- 将 `X-Msh-Platform` 请求头的取值修正为 `kimi_code_cli`。
- 在未配置模型时，澄清提示词模式下的错误提示，引导用户走登录流程。
- 在会话选择器中隐藏空的当前会话，同时保留其他空会话可见。
- 不再在迁移界面中提及 OAuth 凭据 —— 它们从不会被迁移，此前的 "needs /login" 提示会被误读为失败。仅使用 OAuth 的安装不再触发迁移界面。
- 在反馈、用量、登录和模型设置失败时，展示 API 返回的错误信息。
- 将终端界面中的模型选择持久化到默认配置，并在新会话中遵循已配置的默认 Thinking 状态。
- 在更新对话历史之前，对不包含摘要的压缩响应进行重试。
- 避免大体量流式工具参数导致的 CPU 峰值，并合并高频的流式 UI 更新。
- 在 wire 协议版本较新时改为继续恢复会话而不是失败。终端界面会显示一条警告，并在不进行迁移的情况下回放记录。
- 当 tmux 的扩展按键设置可能导致带修饰键的 Enter 快捷键无法工作时，向 tmux 用户发出提示。
- 默认让 Kimi 请求使用剩余的上下文窗口作为补全 token 的额度，同时将显式设置的环境变量上限作为硬上限保留。

### 重构

- 将工具调用数据扁平化，把工具名和参数内联到顶层，并限制旧版记录迁移仅重写匹配的工具调用数据。
- 将 wire 元数据处理移动到记录层，并将持久化后端的职责限制在存储操作上。

### 其他

- 当未配置模型时，`/model` 和欢迎面板现在会引导用户使用 `/login`（针对 Kimi）和 `/connect`（针对其他供应商）。
