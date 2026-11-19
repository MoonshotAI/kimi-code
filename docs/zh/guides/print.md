# 在脚本与 CI 中使用

通过 `kimi -p`（`--prompt`）可以在不进入终端交互界面的情况下单次执行一条指令，将结果输出到标准输出并在完成后自动退出——适合 Shell 脚本、Git Hooks 与 CI/CD 流水线。

## 基本用法

### 纯文本输出（默认）

```sh
kimi -p "用三句话总结最近一次提交的改动"
```

默认输出格式为 `text`：

- **`stdout`**：只输出 Assistant 的回复正文（每段以 `• ` 开头，折行缩进两格），可直接重定向到文件或交给下游管道；
- **`stderr`**：输出思考过程（thinking）、工具执行进度与结束时的会话恢复提示（`To resume this session: kimi -r <session_id>`），不会混入重定向文件。

### 结构化 JSONL 输出（`stream-json`）

需要在脚本或流水线中按字段解析结果时，加上 `--output-format stream-json`（也可设置环境变量 `KIMI_MODEL_OUTPUT_FORMAT=stream-json`）：

```sh
kimi -p "列出当前目录下所有导出函数" --output-format stream-json
```

`stdout` 每行输出一个独立的 JSON 对象（JSONL）：

```json
{"role":"assistant","content":"","tool_calls":[{"type":"function","id":"call_1","function":{"name":"Grep","arguments":"{\"pattern\":\"export function\"}"}}]}
{"role":"tool","tool_call_id":"call_1","content":"..."}
{"role":"assistant","content":"当前目录共导出以下函数：..."}
{"role":"meta","type":"session.resume_hint","session_id":"session_01...","command":"kimi -r session_01...","content":"To resume this session: kimi -r session_01..."}
```

- 回复正文与工具调用输出为 `role: "assistant"`（调用工具时附带 `tool_calls`）；
- 工具执行结果输出为 `role: "tool"`；
- 步骤重试提示与会话结束信息输出为 `role: "meta"`（如 `type: "turn.step.retrying"`、`type: "session.resume_hint"`）。

配合 `jq` 提取最终回复正文：

```sh
kimi -p "生成本次变更的 commit message" --output-format stream-json \
  | jq -r 'select(.role == "assistant" and .content != null and (.tool_calls | not)) | .content' \
  | tail -n 1
```

## 常见用法

### 传入上下文（命令替换与文件）

将 `git diff`、构建日志拼进提示词，或直接指定待分析文件路径：

```sh
# 审查暂存区改动
kimi -p "审查以下暂存区 diff，指出潜在 bug 与边界遗漏：$(git diff --cached)"

# 分析失败构建日志
kimi -p "读取 /tmp/ci-test.log，定位失败原因并给出修复建议"
```

### 多步串行接续同一会话

每次 `-p` 执行都会自动保存会话，并在结束时输出 `session_id`。需要在脚本中分步串行追问时，用 `-S <session_id>`（或在同一项目目录下用 `-c` 接续最近一次会话）：

```sh
# 第一步：完成修改并取出 session_id
RUN=$(kimi -p "给 src/retry.ts 补齐指数退避参数校验" --output-format stream-json)
SID=$(printf '%s\n' "$RUN" | jq -r 'select(.type == "session.resume_hint") | .session_id')

# 第二步：在同一会话上下文基础上跑测试并修复问题
kimi -S "$SID" -p "运行单测，如果有失败请一并修掉"
```

### 指定模型、自定义 Agent 与额外目录

```sh
# 指定本次使用的模型
kimi -m kimi-code/kimi-for-coding -p "解释最新一次 diff"

# 使用自定义审查 Agent 创建新会话
kimi --agent reviewer -p "审查当前分支相对于 main 的改动"

# 允许额外访问其他目录
kimi --add-dir ../shared-types -p "对齐前后端接口类型定义"
```

## 权限策略与退出码

- **权限策略**：`-p` 在无人值守模式下运行，不弹出交互式审批确认——常规文件读写与命令执行默认自动放行，配置文件中的 `deny` 规则照常拦截（无需额外传入 `--auto` 或 `--yolo`）。
- **退出码**：
  - `0`：任务正常完成；
  - `1`：命令行参数错误、模型鉴权未就绪或执行出错；
  - `4`：通过 `-S` / `-c` 指定的会话正被另一个进程占用（`stream-json` 模式下同时在 `stdout` 输出 `{"type":"error",...}`）。

## 下一步

- [在其他 Agent 中使用](./other-agents.md) — 在 Claude Code、Codex、Cursor 等 Agent 中调用与交接 Kimi Code 会话
- [Agent 与 subagent](../customization/agents.md#自定义-agent) — 编写 `--agent` / `--agent-file` 自定义角色
- [`kimi` 命令参考](../reference/kimi-command.md) — 完整命令行参数列表
