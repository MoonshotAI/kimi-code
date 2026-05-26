# Tool Permission Decision Model

How a tool call that has passed argument validation is classified as `approve` / `deny` / `ask`. Out of scope: whether the tool exists, whether it is enabled, args schema validation, the ask interaction itself, and runtime tool errors.

**Design goals**

- Modular policies, single queue. Each H2 below corresponds to one `PermissionPolicy`. They run in document order; the first hit produces the final decision.
- The permission layer hard-codes neither per-tool args structure nor UI text.
- Telemetry is emitted by the queue executor only — never by individual policies — and never carries raw args, paths, commands, user rules, or UI text.

**Execution contract**

Policies read only these fields from `execution`; the tool owns the semantics behind each one.

- `accesses` — file-safety boundaries (cwd, sensitive files, git control paths).
- `matchesRule(ruleArgs)` — sync pure matcher for the raw string inside `ToolName(...)`. Built-ins reuse the legacy DSL: empty matches; leading `!` negates; path-glob for path subjects, glob otherwise. Absent ⇒ bracketed rules never match.
- `approvalRule` — complete rule string (e.g. `Bash(git status)`) memorized by *Approve for session*. Required.
- `display` / `description` — approval UI. Policies never compose or rewrite UI text.

## pre-tool-call-hook: PreToolCall Hook Decision

- Hook returns `block` → `deny`.
- Hook returns `allow` or no result → continue.

## auto-mode-ask-user-question-deny: Auto Mode AskUserQuestion Deny

- `permissionMode=auto` and tool is `AskUserQuestion` → `deny`.

## plan-mode-guard-deny: Plan Mode Guard Deny

- Plan mode active, no plan file bound, tool is `Write` / `Edit` → `deny`.
- Plan mode active and `Write` / `Edit` target is not the current plan file → `deny`.
- Plan mode active and tool is `TaskStop` → `deny`.

## user-configured-deny: User Configured Deny Rules

- User-configured `deny` rule matches → `deny`.
- Only `deny` rules are evaluated here; `ask` / `allow` rules are handled by their own policies later in document order.
- Rules are scanned in configuration order; the first matching rule for this stage wins.
- `ToolName` without brackets matches by tool name only.
- `ToolName(ruleArgs)` matches tool name first; on a tool-name hit it calls `execution.matchesRule(ruleArgs)`, which must return `true` to count as a match.
- `mcp__server__tool` / `mcp__server__*` match MCP tools by tool name.
- `*(ruleArgs)` is a wildcard tool match; bracketed args are still interpreted by `matchesRule`.
- Path, command, search expression, agent type, skill identity, etc. are defined by the tool's `resolveExecution` / `matchesRule` — never hard-coded in policies.

## auto-mode-approve: Auto Mode Approve

- `permissionMode=auto` → `approve`.
- Any rule that must also block in auto mode must be expressed as `deny` and placed before this policy.

## user-configured-ask: User Configured Ask Rules

- User-configured `ask` rule matches → `ask`.

## exit-plan-mode-review-ask: ExitPlanMode Review Ask

- `ExitPlanMode` with plan mode active, non-empty plan, and `permissionMode != auto` → `ask`.
- Must run before *Session Approval Memorized History*: the plan-review approval object includes the current plan, which a generic session-history rule cannot express.

## user-configured-allow: User Configured Allow Rules

- User-configured `allow` rule matches → `approve`.
- Uses the same matching as user-configured deny.

## session-approval-history: Session Approval Memorized History

- *Approve for session* memorizes `execution.approvalRule`.
- Subsequent requests run the memorized rule through the same parser / matcher as user-configured rules under a `session-runtime` source; on match → `approve`.
- `session-runtime` rules are scoped to this session (replay / parent-child inheritance) and do not participate in `user-configured-*` policies.
- `execution.approvalRule` is mandatory — tools must declare the session-approval memorization boundary explicitly.
- v1.1 → v1.2 wire migration upgrades legacy session approval records (missing `sessionApprovalRule`) best-effort from the old action label. The runtime no longer applies legacy fallbacks at request time.

## plan-mode-tool-approve: Plan Mode Tool Approve

- `EnterPlanMode` → `approve`.
- Plan mode active and `Write` / `Edit` target is the current plan file → `approve`.
- `ExitPlanMode` when plan mode is inactive → `approve`.
- `ExitPlanMode` in plan mode with an empty plan body → `approve`.

## sensitive-file-access-ask: Sensitive File Access Ask

- `execution.accesses` includes a sensitive file (`.env`, SSH private key, credentials path) → `ask`.

## git-control-path-access-ask: Git Control Path Access Ask

- `execution.accesses` includes a `.git` control directory or git control-dir path → `ask`.

## cwd-outside-file-access-ask: CWD Outside File Access Ask

- `execution.accesses` includes a `read` / `write` / `readwrite` / `search` access whose target lies outside cwd → `ask`.

## yolo-mode-approve: YOLO Mode Approve

- `permissionMode=yolo` → `approve`.

## default-tool-approve: Default Tool Approve

- Default-approve list: `Read`, `Grep`, `Glob`, `ReadMediaFile`, `SetTodoList`, `TodoList`, `TaskList`, `TaskOutput`, `WebSearch`, `FetchURL`, `Agent`, `AskUserQuestion`, `Skill` → `approve`.

## git-cwd-write-approve: Git CWD Write Approve

- Tool is `Write` / `Edit`, and the write target in `execution.accesses` is inside the POSIX git cwd and inside the process cwd → `approve`.

## fallback-ask: Fallback

- None of the above matched → `ask`.
