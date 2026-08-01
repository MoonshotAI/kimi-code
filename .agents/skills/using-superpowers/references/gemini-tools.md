# Gemini CLI 工具映射

Skills 使用 Claude Code 的工具名称。在 Gemini CLI 中遇到这些名称时，请使用对应的平台等价工具：

| Skill 中的引用 | Gemini CLI 等价工具 |
|---------------|-------------------|
| `Read`（读取文件） | `read_file` |
| `Write`（创建文件） | `write_file` |
| `Edit`（编辑文件） | `replace` |
| `Bash`（执行命令） | `run_shell_command` |
| `Grep`（搜索文件内容） | `grep_search` |
| `Glob`（按名称搜索文件） | `glob` |
| `TodoWrite`（任务跟踪） | `write_todos` |
| `Skill` 工具（调用 skill） | `activate_skill` |
| `WebSearch` | `google_web_search` |
| `WebFetch` | `web_fetch` |
| `Task` 工具（派遣子 agent） | 无等价工具——Gemini CLI 不支持子 agent |

## 不支持子 Agent

Gemini CLI 没有 Claude Code `Task` 工具的等价物。依赖子 agent 派遣的 skills（`subagent-driven-development`、`dispatching-parallel-agents`）将退化为通过 `executing-plans` 进行单会话执行。

## Gemini CLI 额外工具

以下工具在 Gemini CLI 中可用，但 Claude Code 中没有对应工具：

| 工具 | 用途 |
|------|------|
| `list_directory` | 列出文件和子目录 |
| `save_memory` | 将信息持久化到 GEMINI.md，跨会话保留 |
| `ask_user` | 向用户请求结构化输入 |
| `tracker_create_task` | 丰富的任务管理（创建、更新、列表、可视化） |
| `enter_plan_mode` / `exit_plan_mode` | 切换到只读研究模式，在修改前先调研 |
