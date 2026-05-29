# Hooks

Hooks 让你在 Kimi Code CLI 的关键生命周期点运行本地命令。它适合做轻量的策略检查、审计记录、桌面通知或与本地自动化脚本联动，例如在危险工具调用前拦截，或在后台子 Agent 完成后触发通知。

Hook 命令在本地 Shell 中运行，Kimi Code CLI 会把事件 payload 以 JSON 写入命令的 stdin。命令的 stdout、stderr 和退出码决定 hook 的结果；除明确阻断的情况外，hook 失败时默认放行（fail-open），不会让主流程因为脚本异常而中断。

::: warning 注意
Hooks 适合做本地提醒和轻量拦截，不应作为唯一安全边界。脚本报错、超时或返回普通非零退出码时会默认放行（fail-open）；高风险工具调用仍应依赖权限审批和人工确认。
:::

## 配置

在 `~/.kimi-code/config.toml` 中使用 `[[hooks]]` 数组表声明 hook：

```toml
[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "node ~/.kimi-code/hooks/check-bash.mjs"
timeout = 5

[[hooks]]
event = "Notification"
matcher = "task\\.completed"
command = "terminal-notifier -title Kimi -message 'Background task finished'"
```

字段含义如下：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `event` | `string` | 是 | 事件名，取值必须是下文「事件」表中的某一项；其他值会让整份配置加载失败 |
| `matcher` | `string` | 否 | 用于匹配事件目标的正则表达式；缺省或空字符串表示匹配全部 |
| `command` | `string` | 是 | 要运行的 Shell 命令，长度不能为零 |
| `timeout` | `integer` | 否 | 超时时间，单位秒，范围 1–600；未设置时默认为 30 秒 |

每个 `[[hooks]]` 表只允许出现这四个字段，写错或多写字段会导致配置文件解析失败。

同一次事件触发时，命中的多个 hook 会并行运行；如果多个配置项的 `command` 完全相同，只会运行一次。`matcher` 使用 JavaScript 正则表达式语义；非法正则会被静默跳过，等同于不匹配。

Hook 命令通过 Shell 启动（等价于 `sh -c <command>`），子进程的工作目录就是当前会话的 `cwd`。在非 Windows 平台上，子进程会被放入独立的进程组，超时或会话被中断时会先发送 `SIGTERM`、100 毫秒后再发送 `SIGKILL`，确保 hook 内部 fork 出的子进程也能被一并清理。

传给 hook 的 JSON 字段统一使用 snake_case。每个 payload 都包含：

```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "session_abc",
  "cwd": "/path/to/project"
}
```

其余字段由事件类型决定，见下文事件表。

## 返回值

Hook 命令的退出码和 stdout 会被解释为以下结果：

| 结果 | 行为 |
| --- | --- |
| 退出码 `0` | 放行；如果 stdout 是 JSON，可从 `message` 或 `hookSpecificOutput.message` 读取文本 |
| 退出码 `2` | 阻断；stderr 会作为阻断原因 |
| 其他非零退出码 | 默认放行（fail-open） |
| 超时或进程异常 | 默认放行（fail-open） |

当 stdout 是 JSON，并且 `hookSpecificOutput.permissionDecision` 为 `deny` 时，也会被视为阻断：

```json
{
  "hookSpecificOutput": {
    "permissionDecision": "deny",
    "permissionDecisionReason": "Use rg instead"
  }
}
```

阻断只对支持控制流的事件生效。例如 `PreToolUse` 可以阻断工具调用，`Stop` 可以让当前轮次追加一次继续消息。观察型事件（例如 `PostToolUse`、`PostToolUseFailure`、`PostCompact`、`SubagentStop`、`StopFailure`、`Notification`）以「即发即忘（fire-and-forget）」方式异步触发，返回值被忽略，不会改变主流程。`PreCompact` 使用 `trigger`（而非 `triggerBlock`）调用，返回值同样被完全忽略，不属于可阻断事件。

阻断生效时，如果脚本未通过 stderr 或 JSON 输出提供原因，CLI 会回退到 `Blocked by <event> hook` 作为占位原因。`PreToolUse` 阻断会作为工具失败结果写回上下文，模型可以根据原因选择替代方案。

## 事件

当前会自动触发的事件如下：

| 事件 | Matcher | 主要 payload | 行为 |
| --- | --- | --- | --- |
| `UserPromptSubmit` | 用户提交的文本内容 | `prompt`（`ContentPart[]` 数组） | 仅对真实 User 消息触发。hook 返回的文本会包裹为 hook 结果，写入会话历史用于 transcript/replay，展示给用户，并在当前 LLM 轮次继续前加入模型上下文；若 hook 阻断，阻断原因会作为 Assistant 消息返回给用户，且该轮次不再调用模型；若所有 hook 均无输出，正常 LLM 轮次继续 |
| `PreToolUse` | 工具名 | `tool_name`、`tool_input`、`tool_call_id` | 在权限检查前触发；阻断后工具不会执行 |
| `PostToolUse` | 工具名 | `tool_name`、`tool_input`、`tool_call_id`、`tool_output` | 工具成功后触发；`tool_output` 被截断至前 2000 个字符 |
| `PostToolUseFailure` | 工具名 | `tool_name`、`tool_input`、`tool_call_id`、`error` | 工具失败或被 hook 阻断后触发 |
| `Stop` | 空字符串 | `stop_hook_active` | 模型准备停止时触发；阻断后会把原因直接作为系统触发的 User 消息追加进上下文，并最多继续一次 |
| `StopFailure` | 错误类型 | `error_type`、`error_message` | 当前轮次因非取消错误失败后触发 |
| `SessionStart` | `startup` 或 `resume` | `source` | 新会话主 Agent 创建后，或历史会话恢复完成后触发 |
| `SessionEnd` | `exit` | `reason` | 会话关闭并 flush 元数据后触发 |
| `SubagentStart` | 子 Agent 名称 | `agent_name`、`prompt` | 子 Agent 配置完成、真正开始运行前触发；`prompt` 被截断至前 500 个字符 |
| `SubagentStop` | 子 Agent 名称 | `agent_name`、`response` | 子 Agent 成功完成后异步触发，失败时不触发；`response` 被截断至前 500 个字符 |
| `PreCompact` | `manual` 或 `auto` | `trigger`、`token_count` | 上下文压缩真正开始前触发；此事件使用 `trigger`（非 `triggerBlock`）调用，返回值被完全忽略，阻断决策不会被读取 |
| `PostCompact` | `manual` 或 `auto` | `trigger`、`estimated_token_count` | 上下文压缩成功写入后异步触发；阻断结果不会改变主流程 |
| `Notification` | 通知类型 | `sink`、`notification_type`、`title`、`body`、`severity`、`source_kind`、`source_id` | 当前在后台子 Agent 结果写入上下文时触发；`notification_type` 取值为 `task.completed`、`task.failed`、`task.killed` 或 `task.lost`，sink 为 `context` |

`UserPromptSubmit` 的返回文本会被包裹成一条 hook 结果：

```xml
<hook_result hook_event="UserPromptSubmit">
hook response
</hook_result>
```

如果多个 `UserPromptSubmit` hook 返回文本，每个结果都会拥有独立的 `<hook_result>` 标签。这条消息会带有 hook 结果来源，用于 transcript/replay，并会在原始用户提示词之后发给模型，然后当前轮次继续。

如果 `UserPromptSubmit` hook 阻断请求，阻断原因会使用同样格式返回给用户，但被阻断的轮次不会继续请求模型。被阻断的提示词和阻断原因会保留在会话历史中，并包含在后续模型上下文里。

`Stop` 的阻断原因会直接作为系统触发的 User 消息写入上下文，让当前轮次继续：

```text
continue from hook
```

## 示例：阻断危险 Shell 命令

下面的 hook 会在 `Bash` 工具调用前读取 stdin 中的 `tool_input.command`。如果命令包含 `rm -rf`，脚本以退出码 `2` 结束并把原因写到 stderr：

::: warning 注意
这个示例只演示 hook 如何阻断工具调用，不是完整的 Shell 安全解析器。真实策略更适合使用 allowlist，或用专门的 Shell 解析逻辑处理引号、变量展开、别名和多段命令。
:::

```toml
[[hooks]]
event = "PreToolUse"
matcher = "Bash"
command = "node ~/.kimi-code/hooks/block-dangerous-bash.mjs"
timeout = 5
```

```js
let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const payload = JSON.parse(input);
  const command = payload.tool_input?.command ?? '';
  if (command.includes('rm -rf')) {
    console.error('Blocked dangerous shell command');
    process.exit(2);
  }
});
```

当 hook 阻断工具调用时，Kimi Code CLI 会把阻断原因作为工具失败结果写回上下文，模型可以据此选择更安全的替代方案。
