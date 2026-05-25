# Tool Permission Decision Model

本文记录当前讨论中的 tool call permission 判断模型。讨论范围只包含一个已经通过前置校验、可以被执行的 tool call 如何被分类为 `approve` / `deny` / `ask`；不包含工具是否存在、是否启用、参数 schema 是否合法、ask 交互过程、以及工具执行时报错。

- **PreToolCall Hook Decision**
  - Hook 返回 `block` -> `deny`
  - Hook 返回 `allow` 或无结果 -> 继续后续判断

- **User Configured Permission Rules**
  - 用户配置 `deny` rule 命中 -> `deny`
  - 用户配置 `ask` rule 命中 -> `ask`
  - 用户配置 `allow` rule 命中 -> `approve`
  - 同时命中多个用户 rule 时 -> `deny > ask > allow`
  - `Bash(pattern)` 匹配 `command`
  - `Read(pattern)` 匹配 `path`
  - `Write(pattern)` 匹配 `path`
  - `Edit(pattern)` 匹配 `path`
  - `ReadMediaFile(pattern)` 匹配 `path`
  - `Grep(pattern)` 匹配 `pattern`
  - `Glob(pattern)` 匹配 `pattern`
  - `Agent(pattern)` 匹配 `subagent_type`
  - `mcp__server__tool` / `mcp__server__*` 匹配 MCP tool name
  - `ToolName` 无参数模式时只匹配 tool name
  - `*(...)` 可作为全工具匹配模式
  - 路径 rule 匹配应基于 cwd 做规范化比较

- **Session Approval Memorized History**
  - 记住的 `run command` action 命中 -> `approve`
  - 记住的 `read file in cwd` action 命中 -> `approve`
  - 记住的 `read file outside cwd` action 命中 -> `approve`
  - 记住的 `write file in cwd` action 命中 -> `approve`
  - 记住的 `write file outside cwd` action 命中 -> `approve`
  - 记住的 `edit file in cwd` action 命中 -> `approve`
  - 记住的 `edit file outside cwd` action 命中 -> `approve`
  - 记住的 `stop background task` action 命中 -> `approve`
  - 记住的 `call MCP tool: server:tool` action 命中 -> `approve`
  - 记住的 `spawn agent` action 命中 -> `approve`
  - 记住的 `invoke skill` action 命中 -> `approve`
  - 记住的 action 必须按安全边界区分粒度，cwd 内外不能共用同一条 session rule

- **System Deny Queue**
  - `permissionMode=auto` 且 tool 是 `AskUserQuestion` -> `deny`
  - plan mode active 且 `Write` 目标不是当前 plan file -> `deny`
  - plan mode active 且 `Edit` 目标不是当前 plan file -> `deny`
  - plan mode active 且当前没有 plan file path 时调用 `Write` -> `deny`
  - plan mode active 且当前没有 plan file path 时调用 `Edit` -> `deny`
  - plan mode active 且 tool 是 `TaskStop` -> `deny`

- **System Ask Queue**
  - `Read` 目标 path 在 cwd 外 -> `ask`
  - `ReadMediaFile` 目标 path 在 cwd 外 -> `ask`
  - `Write` 目标 path 在 cwd 外 -> `ask`
  - `Edit` 目标 path 在 cwd 外 -> `ask`
  - 目标 path 是敏感文件 `.env` / SSH private key / credentials 时 -> `ask`
  - 目标 path 落在 `.git` 控制目录或 git control dir 内时 -> `ask`
  - `ExitPlanMode` 且 plan mode active 且 plan 内容非空且 `permissionMode!=auto` -> `ask`
  - 其他未来安全边界如果需要用户确认 -> `ask`

- **System Approve Queue**
  - `permissionMode=yolo` -> `approve`
  - `permissionMode=auto` -> `approve`
  - 默认 auto-allow tool `Read` -> `approve`
  - 默认 auto-allow tool `Grep` -> `approve`
  - 默认 auto-allow tool `Glob` -> `approve`
  - 默认 auto-allow tool `ReadMediaFile` -> `approve`
  - 默认 auto-allow tool `Think` -> `approve`
  - 默认 auto-allow tool `SetTodoList` -> `approve`
  - 默认 auto-allow tool `TaskList` -> `approve`
  - 默认 auto-allow tool `TaskOutput` -> `approve`
  - 默认 auto-allow tool `WebSearch` -> `approve`
  - 默认 auto-allow tool `FetchURL` -> `approve`
  - 默认 auto-allow tool `Agent` -> `approve`
  - 默认 auto-allow tool `AskUserQuestion` -> `approve`
  - 默认 auto-allow tool `EnterPlanMode` -> `approve`
  - 默认 auto-allow tool `ExitPlanMode` -> `approve`
  - 默认 auto-allow tool `Skill` -> `approve`
  - `Write/Edit` 在 POSIX git cwd 内、目标在 cwd 内、不是敏感文件、不是 git 控制路径、路径中无 symlink -> `approve`
  - `EnterPlanMode` -> `approve`
  - `ExitPlanMode` 不在 plan mode active 状态 -> `approve`
  - `ExitPlanMode` 在 plan mode active 但没有有效 plan 内容 -> `approve`

- **Fallback**
  - 以上全部未命中 -> `ask`
  - `manual` 下的 `Bash` 通常靠 fallback -> `ask`
  - `manual` 下的 `Write` 通常靠 fallback -> `ask`
  - `manual` 下的 `Edit` 通常靠 fallback -> `ask`
  - `manual` 下的 `TaskStop` 通常靠 fallback -> `ask`
  - `manual` 下的 MCP tool / user tool 通常靠 fallback -> `ask`
