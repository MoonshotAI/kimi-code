# Dynamic Workflows

Dynamic Workflow（动态工作流）用一个经用户批准的 JavaScript 脚本来编排多个子 Agent。脚本按阶段运行，可以并行 fan-out 子 Agent（同时启动多个并等待全部完成）、让条目在 pipeline 各阶段间流动、用 JSON Schema（一种描述 JSON 数据预期结构的标准格式）校验结构化输出，并返回最终结果。它面向大型的多步骤任务 —— 例如跨多个来源调研一个问题、审查整个仓库 —— 这类任务在普通会话中需要许多轮手动操作。

> Dynamic Workflow 是实验功能，且 token 消耗显著高于普通会话。仅在确实需要这种编排能力时启用。

::: warning 注意
Workflow 脚本运行在 sandbox（隔离环境，限制脚本可访问的能力）中，但 sandbox 只是控制边界，不是安全屏障。因此每次执行 Workflow 之前都必须经过你的明确批准。
:::

## 启用 Dynamic Workflow

该功能由 `dynamic-workflows` 实验 flag 控制，默认关闭。可通过以下三种方式之一启用：

- 用 `/experiments` 打开实验功能面板（Settings → Experiments），开启 **Dynamic workflows**。
- 在启动 Kimi Code CLI 前设置环境变量 `KIMI_CODE_EXPERIMENTAL_DYNAMIC_WORKFLOWS=1`。
- 在 `config.toml` 的 `[experimental]` 下添加 `dynamic-workflows = true`。

## 编写 Workflow 脚本

一个 Workflow 就是一个 `.js` 文件。文件的第一条语句导出描述该 Workflow 的 `meta` 对象；文件其余部分是驱动编排的顶层 async 主体：

```js
export const meta = {
  name: 'repo-audit',
  description: 'Review repository areas in parallel and summarize the findings',
  whenToUse: 'When the user asks for a broad audit of the repository',
  phases: [
    { title: 'Review', detail: 'Fan out one reviewer per area' },
    { title: 'Summarize' },
  ],
};

phase('Review');
const reports = await parallel([
  () => agent('Review src/auth for security issues', { label: 'auth' }),
  () => agent('Review src/api for security issues', { label: 'api' }),
]);

phase('Summarize');
return await agent(`Summarize these audit reports: ${JSON.stringify(reports)}`);
```

`meta.name` 必填，必须是 kebab-case，且与文件名（不含 `.js` 扩展名）一致。`meta.description` 告诉模型该 Workflow 的用途，可选的 `meta.whenToUse` 描述何时使用它，可选的 `meta.argumentHint` 在自动补全弹出框中提示预期的参数格式，`meta.phases` 声明确认对话框和运行浏览器中展示的阶段列表。

### Sandbox API

脚本主体通过一小组全局对象编排子 Agent：

- `args`：调用时传入的参数字符串，例如 `/workflow run deep-research <问题>` 中的 `<问题>`
- `phase(title)`：标记当前阶段；title 应来自 `meta.phases`
- `log(message)`：向本次运行的日志追加一条消息
- `agent(prompt, { label?, phase?, schema? })`：以给定提示词运行一个子 Agent。子 Agent 走正常的权限系统，其工具调用与普通会话一样需要批准。传入 `schema`（JSON Schema）时，子 Agent 返回校验后的对象而非自由文本。如果你拒绝了子 Agent 的审批请求，`agent()` 返回 `null`；失败时抛出异常
- `parallel(fns)`：并发运行给定的一组函数并等待全部结果
- `pipeline(items, ...stages)`：让每个条目依次流经各阶段。条目之间独立流动 —— 阶段之间没有屏障 —— 某个阶段返回 `null` 时，该条目跳过剩余阶段
- `return <值>`：以最终结果结束 Workflow；该值必须可 JSON 序列化

Sandbox 中没有 Node.js API：没有 `process`、`require`、`fs`、网络访问和定时器。`URL`、`URLSearchParams`、`TextEncoder`、`TextDecoder`、`JSON`、`Math` 等标准 JavaScript 内建对象可用。

## Workflow 目录

Kimi Code CLI 按四个作用域扫描 Workflow 目录，越具体的作用域优先级越高：**项目 > 用户 > 额外 > 内置**。同一作用域内，Kimi 专属（品牌）目录优先于通用目录。

**项目级**（项目根目录 = 从工作目录向上找到的最近一个包含 `.git` 的目录）：
- `.kimi-code/workflows/`
- `.agents/workflows/`

**用户级**（对所有项目生效）：
- `$KIMI_CODE_HOME/workflows/`（默认：`~/.kimi-code/workflows/`）
- `~/.agents/workflows/`

Kimi 专属的用户 Workflow 目录随 `KIMI_CODE_HOME` 移动，因此隔离的数据根目录也会得到隔离的 Workflow。通用的 `~/.agents/workflows/` 目录固定在真实的系统 home 下，以便跨工具共享。

**额外目录**：通过 `config.toml` 中 `[workflows]` 下的 `extra_workflow_dirs` 声明：

```toml
[workflows]
extra_workflow_dirs = ["~/team-workflows"]
```

**内置 Workflow** 随 CLI 分发，优先级最低；参见 [内置 `deep-research` Workflow](#内置-deep-research-workflow)。

内容非法的 Workflow 文件 —— 例如缺少或格式错误的 `meta` 块 —— 会被跳过并给出说明原因的警告，不影响其他 Workflow。

## 运行 Workflow

`/workflow` 斜杠命令（别名 `/workflows`）用于在终端界面中管理 Workflow：

| 命令 | 说明 |
| --- | --- |
| `/workflow list` | 列出所有发现的 Workflow |
| `/workflow run <name> [args]` | 按名称运行 Workflow，并把 `args` 传给脚本 |
| `/workflow runs` | 打开运行浏览器（见 [监控运行](#监控运行)） |
| `/workflow show <name>` | 查看某个 Workflow 的元数据和脚本 |
| `/workflow cancel <runId>` | 取消正在运行的 Workflow |
| `/workflow save <runId> [--user]` | 保存某次运行的脚本以便复用（见 [保存 Workflow 以便复用](#保存-workflow-以便复用)） |
| `/workflow reload` | 重新扫描 Workflow 目录 |
| `/workflow on` | 启用 Dynamic Workflow 模式（见下方说明） |
| `/workflow off` | 禁用 Dynamic Workflow 模式 |

当你输入 `/workflow run ` 时，自动补全弹出框会列出可用的 Workflow 及其参数提示，帮助你快速找到需要的 Workflow。`/workflow`（不加参数）直接打开运行浏览器。

你也可以直接用自然语言让 Kimi 创建或运行 Workflow —— 例如「用一个 workflow 调研我们的 auth 流程如何刷新 token」。模型会通过 `Workflow` 工具提出一个**提案**，在你批准之前不会执行任何内容。

无论运行来自 `/workflow run` 还是来自模型，执行前都会先弹出确认对话框，展示 Workflow 的名称、描述和阶段、token 消耗警告、已配置的限制，以及查看完整脚本的选项。只有在你明确确认后，Workflow 才会运行。

## 监控运行

Workflow 在后台运行，不会阻塞你的会话。`/workflow runs` 打开运行浏览器，列出每次运行的状态、当前阶段（`N/M`）、已发起的 `agent()` 调用次数和日志输出，运行结束后还会展示最终结果或错误。浏览器中的快捷键可以取消运行、保存脚本或查看脚本。

Workflow 的开始和完成事件也会直接出现在会话中，并且每次运行会以 `workflow` 类型的后台任务出现在 `/tasks` 中，与其他后台工作并列。任务浏览器会显示 Workflow 的名称、当前阶段进度和子 Agent 调用次数。

## Dynamic Workflow 模式

通过 `/workflow on` 启用后，**Dynamic Workflow 模式**会让模型先分析任务，对于大型或多阶段的复杂任务，使用 `Workflow` 工具主动创建动态 Workflow 脚本提交给你审批，而不是直接执行。提案与普通 Workflow 走相同的确认流程——在你批准之前不会运行任何内容。

Um `Dynamic Workflow` no terminal footer mostra que o modo está ativo. Desative a qualquer momento com `/workflow off`.

Dynamic Workflow 模式与所有现有模式兼容：

- **Plan 模式**：规划期间 agent 阅读代码库、撰写计划；退出 plan 模式后，agent 可以将审批通过的计划转换为 Workflow 脚本。
- **Swarm 模式**：swarm 用于独立子任务的 fan-out；workflow 模式用于编排有先后顺序的阶段。两者独立，可以同时启用。
- **Goal 模式**：goal 驱动自主多轮对话；在一轮对话中 agent 可以创建 Workflow，Workflow 在后台运行，goal 继续推进。
- **权限模式**：每次 Workflow 运行仍然要求明确审批（`workflow-run-review-ask` 策略）；在 `auto` 模式下自动批准，与 goal 和 swarm 的语义一致。

## 保存 Workflow 以便复用

当某次运行的脚本确实有用时 —— 包括模型根据自然语言请求临时编写的脚本 —— 可以在运行期间或运行结束后保存它：

```sh
/workflow save <runId>          # 保存到项目（.kimi-code/workflows/）
/workflow save <runId> --user   # 保存到用户目录（~/.kimi-code/workflows/）
```

保存后的 Workflow 会成为普通的可发现 Workflow，之后可以用 `/workflow run <name> [args]` 按名称执行。

## 内置 `deep-research` Workflow

Kimi Code CLI 预置了一个内置 Workflow：`deep-research`，即带对抗性校验的多来源深度调研。它按五个阶段工作 —— Scope、Search、Fetch、Verify 和 Synthesize —— 在产出最终报告前对发现的内容进行交叉核对。

```sh
/workflow run deep-research How does our billing service handle proration?
```

## 配置

`config.toml` 的 `[workflows]` 节用于调整运行限制并声明额外的 Workflow 目录：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `max_concurrency` | `integer` | `4` | 单个 Workflow 同时运行的子 Agent 数量上限（`1`–`16`） |
| `max_agent_calls` | `integer` | `50` | 单次运行允许发起的 `agent()` 调用次数上限 |
| `max_duration_ms` | `integer` | `1800000`（30 分钟） | 单次运行允许的最长时间（毫秒） |
| `max_script_bytes` | `integer` | `262144`（256 KB） | Workflow 脚本的最大字节数；超过的文件在发现时会被跳过 |
| `extra_workflow_dirs` | `array<string>` | — | 额外的 Workflow 目录，按额外作用域扫描 |

完整字段说明见 [配置文件 —— `workflows`](../configuration/config-files.md#workflows)。

## 失败行为

Workflow 绝不会虚报成功。子 Agent 失败会从 `agent()` 抛出异常；被拒绝的审批请求返回 `null`，脚本可以借此显式放弃；取消运行会将其标记为已取消而非已完成。如果一次运行提前结束 —— 无论是由于错误、达到限制还是被取消 —— 运行浏览器都会连同原因一起报告部分结果。

## 当前限制

- Dynamic Workflow 是实验功能：脚本格式和 `/workflow` 子命令可能在版本之间发生变化。
- 仅支持本页文档所述格式的 `.js` 脚本；Workflow 脚本与 Claude Code 不兼容。
- 自然语言请求总是先产生提案 —— 模型绝不会在未经你确认的情况下直接执行 Workflow。

## 下一步

- [Agent 与子 Agent](./agents.md) —— 子 Agent 的工作方式及自定义方法
- [Agent Skills](./skills.md) —— 更轻量的可复用指令封装方式
- [配置文件](../configuration/config-files.md#workflows) —— 完整的 `[workflows]` 字段说明
- [斜杠命令](../reference/slash-commands.md#dynamic-workflows) —— `/workflow` 子命令参考
