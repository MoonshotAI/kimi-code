# 最新动态

记录 Kimi Code 各产品的新功能与核心修复，重点介绍最值得关注的变化。

<div class="wn-timeline">

<!-- ─────────────── v0.8.0 ─────────────── -->
<div class="wn-entry">
<div class="wn-meta">
  <span class="wn-badge">最新</span>
  <span class="wn-product">Kimi Code CLI</span>
  <div class="wn-version">v0.8.0</div>
  <div class="wn-date">2026 年 6 月 2 日</div>
</div>
<div class="wn-content">

**自主 Goal 模式（实验）**：输入 `/goal <目标>` 后，Kimi 会在多个轮次里持续推进同一个目标，直到完成、被暂停或遇到阻塞，省去了一轮一轮手动催的步骤。用 `/goal pause` / `/goal resume` / `/goal cancel` 管理进度，需提前设置 `KIMI_CODE_EXPERIMENTAL_GOAL_COMMAND=1` 启用。→ [自主 goal](/kimi-code-cli/reference/slash-commands#自主-goal实验功能)

**后台结构化提问**：Agent 遇到需要你做选择的问题时，会将提问挂到后台，同时继续处理其他步骤，不再因为一个小问题卡住整个流程。→ [AskUserQuestion](/kimi-code-cli/reference/tools#协作类)

**`kimi provider` 子命令**：直接在 shell 里管理供应商，无需打开 TUI。`kimi provider add <url>` 从自定义 registry 批量导入，`catalog list / catalog add` 从 models.dev 公共目录导入，适合脚本或 CI 场景。→ [kimi provider](/kimi-code-cli/reference/kimi-command#kimi-provider)

此外：**后台自动更新**默认开启（可在 `tui.toml` 中关闭）；**上下文压缩**时会把当前待办列表附在摘要里，防止 Agent 忘记中断前的进度。

</div>
</div>

<!-- ─────────────── v0.7.0 ─────────────── -->
<div class="wn-entry">
<div class="wn-meta">
  <span class="wn-product">Kimi Code CLI</span>
  <div class="wn-version">v0.7.0</div>
  <div class="wn-date">2026 年 6 月 2 日</div>
</div>
<div class="wn-content">

**`/provider` 交互式供应商管理器**：在 TUI 中输入 `/provider` 打开可视化管理界面，查看所有已配置供应商、添加新来源、删除旧条目，切换模型时按供应商分标签页选择，不需要手动改 `config.toml`。→ [平台与模型](/kimi-code-cli/configuration/providers-and-models#provider-与供应商管理)

**`KIMI_MODEL_ADAPTIVE_THINKING` 环境变量**：可强制开启或关闭 adaptive thinking，专为自定义命名端点设计——当模型名无法自动解析 Claude 版本时，用这个变量显式指定，不再依赖自动推断。→ [模型字段](/kimi-code-cli/configuration/configuration-files#models)

此外：定时任务触发时间现在以**本地时区**格式显示，不再是 UTC。

</div>
</div>

<!-- ─────────────── v0.6.0 ─────────────── -->
<div class="wn-entry">
<div class="wn-meta">
  <span class="wn-product">Kimi Code CLI</span>
  <div class="wn-version">v0.6.0</div>
  <div class="wn-date">2026 年 5 月 29 日</div>
</div>
<div class="wn-content">

**`KIMI_MODEL_*` 环境变量通道**：设置 `KIMI_MODEL_NAME` 和 `KIMI_MODEL_API_KEY` 就能让 Kimi Code 使用指定模型，完全不需要修改 `config.toml`，重启后自动失效。供应商类型、Base URL、上下文长度、Thinking 配置均可通过对应的 `KIMI_MODEL_*` 变量覆盖，适合临时测试或 CI 环境快速切换。→ [用环境变量定义模型](/kimi-code-cli/configuration/environment-variables#用环境变量定义模型-kimi-model)

**从 GitHub URL 直接安装 Plugin**：`/plugins install https://github.com/<owner>/<repo>` 安装最新 release，也支持指定分支、tag 或 commit。Plugin 管理器标注来源信任等级：`kimi-official`（官方）、`curated`（精选）、`third-party`（其他）。→ [安装与管理](/kimi-code-cli/customization/plugins#安装与管理)

**移除默认步数上限**：之前每轮 Agent 最多执行 1000 步，现已取消，长任务不再被强制打断。如需重新限制，可在 `config.toml` 里手动设 `max_steps_per_turn`。→ [loop\_control](/kimi-code-cli/configuration/configuration-files#loop_control)

</div>
</div>

<!-- ─────────────── v0.5.0 ─────────────── -->
<div class="wn-entry">
<div class="wn-meta">
  <span class="wn-product">Kimi Code CLI</span>
  <div class="wn-version">v0.5.0</div>
  <div class="wn-date">2026 年 5 月 28 日</div>
</div>
<div class="wn-content">

**定时任务**：在会话里用自然语言设定 cron 计划或一次性提醒，Kimi 会在指定时间自动执行，计划绑定当前会话，`kimi resume` 后重新加载继续触发。

```
每个工作日上午 9 点帮我汇总 CI 失败情况
30 分钟后提醒我检查部署
```

→ [定时任务](/kimi-code-cli/reference/tools#定时任务)

**`/auto` 权限模式**：新增 `/auto` 命令和 `--auto` 启动参数。开启后工具审批自动处理，Agent 不会向用户提问，比 `--yolo` 更克制——保留权限判断，不会盲目执行危险操作，适合无人值守但不想完全放开的场景。→ [交互与输入](/kimi-code-cli/interaction#yolo--auto-模式)

此外：`Ctrl-O` 展开工具输出时 Bash 命令显示完整内容；待办列表面板最多显示 5 行，超出部分显示 `+N more`。

</div>
</div>

<!-- ─────────────── v0.4.0 ─────────────── -->
<div class="wn-entry">
<div class="wn-meta">
  <span class="wn-product">Kimi Code CLI</span>
  <div class="wn-version">v0.4.0</div>
  <div class="wn-date">2026 年 5 月 27 日</div>
</div>
<div class="wn-content">

**Plugin 系统上线**：支持按用户安装 Plugin，每个 Plugin 可以携带 Agent Skills、在会话启动时自动加载 Skill，以及声明自己的 MCP servers。`/plugins` 打开交互式管理器，`Space` 安装或更新，`M` 管理 MCP server 开关。官方 marketplace 同步上线，包含 Kimi Datasource 等官方插件。→ [Plugins](/kimi-code-cli/customization/plugins)

**会话导出**：`/export-md` 把当前会话导出为可读的 Markdown 文件；`/export-debug-zip` 打包会话目录（含诊断日志）为 ZIP，适合提交反馈时附上。→ [会话与上下文](/kimi-code-cli/sessions#导出会话)

**权限系统重构**：工作目录外的只读操作不再触发审批，减少不必要的确认打断；会话级审批现在精确匹配调用，路径匹配改为大小写不敏感。→ [权限配置](/kimi-code-cli/configuration/configuration-files#permission)

</div>
</div>

<!-- ─────────────── v0.2.0 – v0.3.0 ─────────────── -->
<div class="wn-entry">
<div class="wn-meta">
  <span class="wn-product">Kimi Code CLI</span>
  <div class="wn-version">v0.2.0 – v0.3.0</div>
  <div class="wn-date">2026 年 5 月 26 日</div>
</div>
<div class="wn-content">

**OpenAI 兼容推理模型开箱即用**：`openai` 供应商现在自动识别响应中的推理字段（`reasoning_content`、`reasoning_details`、`reasoning`），对含有思考历史的请求自动注入 `reasoning_effort`。DeepSeek、Qwen、One API 等网关托管服务无需额外配置即可使用 thinking。→ [openai 供应商](/kimi-code-cli/configuration/providers-and-models#openai)

**`/logout` 支持选择供应商**：弹出选择器列出所有已登录供应商，当前供应商默认高亮，避免误退出其他供应商的登录态。

**`/connect` 命令**：从 models.dev 公共目录选择供应商并配置，内置搜索过滤，无需手写 TOML。（v0.7.0 起已升级为功能更完整的 `/provider` 命令。）

</div>
</div>

<!-- ─────────────── v0.1.0 ─────────────── -->
<div class="wn-entry">
<div class="wn-meta">
  <span class="wn-product">Kimi Code CLI</span>
  <div class="wn-version">v0.1.0</div>
  <div class="wn-date">2026 年 5 月</div>
</div>
<div class="wn-content">

**Kimi Code CLI 新版首发**，底层从 Python / uv 完整重写为 TypeScript / Node.js。这不是一次渐进式更新，而是一个新起点——核心架构、安装方式、配置格式全面升级。

与旧版 kimi-cli 的主要区别：

| 对比项 | 旧版 kimi-cli | 新版 Kimi Code CLI |
| --- | --- | --- |
| 运行时 | Python + uv | Node.js（无 Python 依赖） |
| 安装 | `uv tool install` | 一行 `curl` 脚本或 `npm install -g` |
| 配置文件 | `~/.kimi/config.toml` | `~/.kimi-code/config.toml`（格式不兼容） |
| 终端界面 | 基础文本输出 | 全功能 TUI（对话视图 + 状态栏 + 审批面板） |
| 启动速度 | 较慢（Python 冷启动） | 更快（Node.js 原生二进制） |
| 多供应商支持 | 有限 | 内置 Anthropic / OpenAI / Gemini / Vertex 等 |
| Agent 子任务 | 不支持 | 内置 coder / explore / plan 三种子 Agent |
| Plugin 系统 | 不支持 | 支持（v0.4.0 起） |
| 定时任务 | 不支持 | 支持（v0.5.0 起） |

已有 kimi-cli 数据（配置、会话、MCP 声明）可通过 `kimi migrate` 一键迁移。→ [版本升级](/kimi-code-cli/cli-migration)

</div>
</div>

</div>

<style>
.wn-timeline {
  margin-top: 2rem;
}
.wn-entry {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 0 2rem;
  padding: 2rem 0;
  border-top: 1px solid var(--vp-c-divider);
}
.wn-entry:last-child {
  border-bottom: 1px solid var(--vp-c-divider);
}
.wn-meta {
  padding-top: 2px;
}
.wn-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  margin-bottom: 6px;
}
.wn-product {
  display: block;
  font-size: 11px;
  font-weight: 500;
  color: var(--vp-c-text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 4px;
}
.wn-version {
  font-size: 14px;
  font-weight: 600;
  color: var(--vp-c-text-1);
  margin-bottom: 4px;
}
.wn-date {
  font-size: 12px;
  color: var(--vp-c-text-3);
  line-height: 1.5;
}
.wn-content {
  font-size: 15px;
  line-height: 1.7;
}
.wn-content p {
  margin: 0 0 1em;
}
.wn-content p:last-child {
  margin-bottom: 0;
}
@media (max-width: 640px) {
  .wn-entry {
    grid-template-columns: 1fr;
    gap: 0.5rem 0;
  }
}
</style>
