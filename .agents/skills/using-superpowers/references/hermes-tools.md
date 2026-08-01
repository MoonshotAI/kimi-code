# Hermes Agent 工具映射

技能使用 Claude Code 的工具名称。当你在技能中遇到这些工具时，使用你平台的等价工具：

| 技能中引用的工具 | Hermes Agent 等价工具 |
|-----------------|----------------------|
| `Read`（读取文件） | `read_file` |
| `Write`（创建文件） | `write_file` |
| `Edit`（编辑文件） | `patch` |
| `Bash`（运行命令） | `terminal` |
| `Grep`（搜索文件内容） | `search_files` |
| `Glob`（按名称搜索文件） | `search_files` |
| `Skill` 工具（调用技能） | `skill_view` |
| `WebFetch` | `web_extract` |
| `WebSearch` | `web_search` |
| `Task` 工具（分派子智能体） | `delegate_task` |
| 多个 `Task` 调用（并行） | 多个 `delegate_task` 调用 |
| `TodoWrite`（任务跟踪） | `todo` |
| `EnterPlanMode` / `ExitPlanMode` | 无等价工具 — 留在主会话中 |

## 技能管理

Hermes Agent 使用三级渐进式技能加载：

| 操作 | 工具 |
|------|------|
| 列出所有可用技能 | `skills_list` |
| 查看技能完整内容 | `skill_view(name)` |
| 查看技能的引用文件 | `skill_view(name, path)` |
| 管理技能（安装/更新） | `skill_manage` |

## 额外的 Hermes Agent 工具

| 工具 | 用途 |
|------|---------|
| `memory` | 持久化知识供未来会话使用 |
| `session_search` | 搜索历史会话记录 |
| `execute_code` | 在沙箱中执行代码 |
| `process` | 后台进程管理 |
| `vision_analyze` | 图像分析 |
| `image_generate` | 图像生成 |
| `clarify` | 向用户提出澄清性问题 |
| `browser_*` | 浏览器自动化工具集 |
| `mixture_of_agents` | 多智能体高级推理 |
