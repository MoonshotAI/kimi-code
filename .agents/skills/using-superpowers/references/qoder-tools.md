# Qoder 工具映射

Skills 使用 Claude Code 的工具名称。Qoder（阿里 AI IDE）大部分工具与 Claude Code **同名**，只有少数差异：

| Skill 中的引用 | Qoder 等价工具 |
|---------------|---------------|
| `Read` / `Write` / `Edit` | 同名（`Read` / `Write` / `Edit`） |
| `Bash` | 同名 |
| `Grep` / `Glob` | 同名 |
| `Task`（派遣子 agent） | 同名（`Task`） |
| `WebFetch` / `WebSearch` | 同名 |
| `AskUserQuestion` | 同名 |
| `Skill` | 同名 |
| `TodoWrite` | 同名 |
| `EnterPlanMode` / `ExitPlanMode` | **`EnterSpecMode` / `ExitSpecMode`**（Qoder 把"计划模式"称为"Spec 模式"）|

## Task 子 Agent 类型

| Claude Code Agent | Qoder 等价 |
|------------------|-----------|
| `general-purpose` | `general-purpose` |
| `Explore` | `explore-agent` |
| `Plan` | `plan-agent` |
| `claude-code-guide` | `qoder-guide` |

Qoder 额外有 `browser-agent`、`code-reviewer`、`design-agent` 等专用 agent，依任务匹配选用。

## Quest MCP 工具（Qoder 原生）

Qoder 内置 Quest 系统提供以下工具，Claude Code 没有等价物，可在 skill 流程中直接调用：

| 工具 | 用途 |
|------|------|
| `mcp__quest__search_codebase` | 语义化代码搜索（按意图找代码） |
| `mcp__quest__search_symbol` | 按符号名搜索代码及关系 |
| `mcp__quest__get_problems` | 获取文件编译/语法错误 |
| `mcp__quest__run_preview` | 启动本地 Web 服务器预览 |
| `mcp__quest__search_memory` / `update_memory` | 跨会话记忆管理 |
| `mcp__quest__fetch_rules` | 查询规则文件 |

## 加载方式

Qoder 在每个会话自动加载 `.qoder/rules/superpowers-zh.md`（`trigger: always_on`），里面包含 skill 索引。`.qoder/skills/<name>/SKILL.md` 由模型按 description 自主调用，也可输入 `/<skill-name>` 手动触发。
