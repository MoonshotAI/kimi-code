# Tool Permission Decision Model

本文记录 tool call permission 判断模型：一个已经通过前置校验、可以被执行的 tool call 如何被分类为 `approve` / `deny` / `ask`。本文不覆盖工具是否存在、是否启用、参数 schema 是否合法、ask 交互过程、以及工具执行时报错。

**设计目标：**

- Permission policy 模块化、单队列。每个 H2 对应一个 `PermissionPolicy`，按文档顺序执行，首个命中的 policy 给出最终 decision。
- Permission 层不硬编码每个 tool 的参数结构或 UI 文本。

**Execution contract：**

- 文件安全边界由 `execution.accesses` 表达，policy 基于它判断 cwd 外、敏感文件、git control path 等规则
- 用户配置规则的括号参数由 `execution.matchesRule(ruleArgs)` 解释
- `matchesRule` 接收 `ToolName(...)` 括号内的原始字符串，不由通用 rule parser 拆分逗号或解释字段语义
- `matchesRule` 必须是同步纯函数，只基于 `resolveExecution(args)` 已经解析好的信息判断，不做 IO
- 内置 tool 提供 `matchesRule` 时沿用 permission DSL 的旧匹配语义：空 pattern 命中，leading `!` 表示取反；路径 subject 使用 path glob 语义，普通字符串 subject 使用 glob 语义
- 如果 execution 没有提供 `matchesRule`，则使用稳定序列化后的完整 tool args 作为 fallback subject；匹配语义参考 kimi-cli hook matcher：空 pattern 命中，非空 pattern 按 regex search 判断，非法 regex 不命中
- fallback matching 是兼容机制，不表达 tool 专属语义；需要自然、精确的参数规则时，tool 应实现 `matchesRule`
- approval UI 使用 `execution.display` / `execution.description`；需要状态型审批 UI 的 tool（例如 `ExitPlanMode` 的 plan 内容与选项）也必须由自己的 `resolveExecution` 返回展示信息；`PermissionPolicy` 不返回、不拼接、不改写 UI 展示文本

**Telemetry contract：**

- `PermissionPolicy` 不直接打 telemetry；单队列执行器在 policy 命中和 approval 完成时统一打点
- `PermissionPolicy` 可以返回开放结构的 `reason` object；`reason` 只放额外的非敏感 primitive 摘要，没有额外信息时省略
- Policy 命中时记录 `permission_policy_decision`
  - `policy_name`: 命中的 policy name，例如 `cwd-outside-file-access-ask`
  - `decision`: `approve` / `deny` / `ask`
  - `tool_name`, `permission_mode`
  - 如果 policy 返回 `reason`，展开记录其中的非敏感摘要，例如 file access operation、是否 cwd 外、是否敏感路径、是否 git control path
- 用户完成 ask 时记录 `permission_approval_result`
  - `policy_name`: 发起 ask 的 policy name
  - `result`: `approved` / `approved_for_session` / `rejected` / `cancelled` / `error`
  - `tool_name`, `permission_mode`
  - 可记录 `has_feedback`、`approval_surface`、`duration_ms`、`session_cache_written`
- `reason` 和 telemetry 都不记录 raw tool args、raw path、raw command、用户配置 rule 原文、approval UI 文本
- 用户配置规则命中时只记录非敏感匹配摘要，例如 `rule_decision`、`has_rule_args`、`match_strategy`，其中 `match_strategy` 可为 `tool_name_only` / `matches_rule` / `stable_args_fallback` / `single_field_fallback`

## pre-tool-call-hook: PreToolCall Hook Decision

- Hook 返回 `block` -> `deny`
- Hook 返回 `allow` 或无结果 -> 继续后续判断

## auto-mode-ask-user-question-deny: Auto Mode AskUserQuestion Deny

- `permissionMode=auto` 且 tool 是 `AskUserQuestion` -> `deny`

## plan-mode-guard-deny: Plan Mode Guard Deny

- plan mode active 且当前没有 plan file path 时调用 `Write`/`Edit` -> `deny`
- plan mode active 且 `Write`/`Edit` 目标不是当前 plan file -> `deny`
- plan mode active 且 tool 是 `TaskStop` -> `deny`

## user-configured-deny: User Configured Deny Rules

- 用户配置 `deny` rule 命中 -> `deny`
- 本阶段只处理用户配置 `deny` rule；`allow` rule 在 Auto Mode Approve 之后判断，`ask` rule 在 Session Approval Memorized History 之后判断
- 用户规则按配置顺序扫描，命中第一条本阶段对应 decision 的 rule 即返回
- `ToolName` 无括号参数时只匹配 tool name
- `ToolName(ruleArgs)` 先匹配 tool name；tool name 命中后调用 `execution.matchesRule(ruleArgs)`，返回 `true` 才算命中
- 如果 rule 带括号参数但 execution 没有提供 `matchesRule`，则用 `ruleArgs` 匹配稳定序列化后的完整 tool args
- fallback subject 的稳定序列化必须让 object key 顺序不影响结果，数组顺序和字符串内容保持原样
- fallback 匹配语义参考 kimi-cli hook matcher：空 `ruleArgs` 命中；非空 `ruleArgs` 作为 regex pattern 对 fallback subject 做 search；非法 regex 不命中；不是 fullmatch，也不是 literal substring
- 如果 tool args 是只有一个实际字段的 object，fallback 可以同时把该唯一字段的值作为第二个 subject，并使用同一套 regex search 语义匹配
- `mcp__server__tool` / `mcp__server__*` 仍通过 tool name 匹配 MCP tool name
- `*(ruleArgs)` 可作为全工具匹配模式；tool name 命中所有工具，括号参数仍按 `matchesRule` 或 fallback matching 解释
- 路径、命令、搜索表达式、agent type、skill identity 等参数语义由对应 tool 的 `resolveExecution` / `matchesRule` 定义，不在 policy 中硬编码

## auto-mode-approve: Auto Mode Approve

- `permissionMode=auto` -> `approve`
- 任何在 auto mode 下也必须阻止的规则都必须表达为 deny，并放在本 policy 之前

## user-configured-allow: User Configured Allow Rules

- 用户配置 `allow` rule 命中 -> `approve`
- 使用与 User Configured Deny Rules 相同的 rule 匹配方式

## session-approval-history: Session Approval Memorized History

- `Approve for session` 记住的是本次 tool call 的 exact key：tool name + 完整 tool args
- 后续请求只有在 tool name 相同，且规范化后的完整 tool args 与已记住记录完全一致时 -> `approve`
- tool args 比较使用结构化数据的稳定序列化结果；object key 顺序不应影响匹配，数组顺序和字符串内容必须保持精确匹配
- 当用户选择 `Approve for session` 时，把本次 tool name + 完整 tool args 写入 session history
- session history 只表达用户在本 session 内对同一 tool call 参数的临时批准，不等价于用户配置的 allow rule；持久化或跨 session 的信任应进入用户配置规则

## user-configured-ask: User Configured Ask Rules

- 用户配置 `ask` rule 命中 -> `ask`

## plan-mode-tool-approve: Plan Mode Tool Approve

- `EnterPlanMode` -> `approve`
- plan mode active 且 `Write` / `Edit` 目标是当前 plan file -> `approve`
- `ExitPlanMode` 不在 plan mode active 状态 -> `approve`
- `ExitPlanMode` 在 plan mode active 但没有有效 plan 内容 -> `approve`

## sensitive-file-access-ask: Sensitive File Access Ask

- `execution.accesses` 中存在敏感文件 `.env` / SSH private key / credentials path -> `ask`

## git-control-path-access-ask: Git Control Path Access Ask

- `execution.accesses` 中存在 `.git` 控制目录或 git control dir path -> `ask`

## cwd-outside-file-access-ask: CWD Outside File Access Ask

- `execution.accesses` 中存在 `read` / `write` / `readwrite` / `search` file access，且目标 path 在 cwd 外 -> `ask`

## exit-plan-mode-review-ask: ExitPlanMode Review Ask

- `ExitPlanMode` 且 plan mode active 且 plan 内容非空且 `permissionMode!=auto` -> `ask`

## yolo-mode-approve: YOLO Mode Approve

- `permissionMode=yolo` -> `approve`

## default-tool-approve: Default Tool Approve

- 默认 `Read` / `Grep` / `Glob` / `ReadMediaFile` / `Think` / `SetTodoList` / `TaskList` / `TaskOutput` / `WebSearch` / `FetchURL` / `Agent` / `AskUserQuestion` / `Skill` -> `approve`

## git-cwd-write-approve: Git CWD Write Approve

- tool name 为 `Write` / `Edit`，且 `execution.accesses` 中的写目标在 POSIX git cwd 内、目标在 cwd 内 -> `approve`

## fallback-ask: Fallback

- 以上全部未命中 -> `ask`
