# 不兼容变更

## 未发布

**影响**：所有内置 Agent 和 subagent 均移除专用的 `Read`、`Grep`、`Glob` 工具。文件搜索与普通文本读取改用 `Bash`；`ReadMediaFile` 用于读取 UTF 文本文件和会话附件。`TaskOutput` 支持通过 `offset` 和 `limit` 按字节范围直接读取持久化的任务输出。已有的 `[read]` 设置不再影响文件读取。旁路对话只允许使用 `ReadMediaFile`；`plan` subagent 使用只读 Bash 命令。对于常见读取和搜索命令中的字面敏感文件参数，Bash 会直接拒绝；动态 Shell 命令仍按配置的权限策略执行，不再享有旧工具的自动敏感文件过滤。

**迁移**：使用 `rg --files` 查找文件，使用 `rg` 搜索内容，使用 `sed -n '1,240p' file` 等有界命令读取文本。图片、视频和文本附件使用 `ReadMediaFile`，后台任务日志使用 `TaskOutput` 并按 `next_offset` 翻页。删除不再使用的 `[read]` 设置。更新引用了已移除工具的 Agent 文件允许列表和权限规则。
