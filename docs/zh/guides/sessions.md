# 会话与上下文

Kimi Code CLI 把每次对话持久化为一个「会话」，保留消息历史和元数据，可以随时关闭终端后再回来继续。本页介绍如何恢复会话、管理上下文，以及导出和派生会话。

## 会话存储

所有会话保存在 `$KIMI_CODE_HOME/sessions/` 下（默认 `~/.kimi-code/sessions/`），按工作目录分组存放：

```text
~/.kimi-code/
├── config.toml
├── session_index.jsonl
└── sessions/
    └── <workDirKey>/
        └── <sessionId>/
            ├── state.json
            └── agents/
                ├── main/
                │   └── wire.jsonl
                └── <subagentId>/
                    └── wire.jsonl
```

- `state.json`：会话标题、创建时间等元数据。
- `agents/*/wire.jsonl`：Agent 事件流，用于会话恢复和回放。

::: warning 注意
`sessions/` 目录下的文件请勿手动编辑，否则可能导致会话无法正常恢复。
:::

## 启动与恢复会话

每次直接运行 `kimi` 都会创建新会话。以下方式可以恢复历史会话：

**继续当前目录最近的会话：**

```sh
kimi --continue
```

**恢复指定会话（通过 ID）：**

```sh
kimi --session abc123
```

**交互式浏览历史会话并选择：**

```sh
kimi --session
```

::: warning 注意
`--continue` 与 `--session` 互斥；`--yolo` 和 `--plan` 也不能与它们同时使用。
:::

## 在 TUI 中切换会话

不离开当前终端也可以管理会话，以下斜杠命令仅在 Agent 空闲时可用：

- **`/new`**（别名 `/clear`）：切换到新会话，丢弃当前上下文。
- **`/sessions`**（别名 `/resume`）：浏览并恢复历史会话。
- **`/fork`**：派生当前会话（详见下文）。
- **`/title <text>`**（别名 `/rename`）：设置会话标题方便识别；不带参数时显示当前标题。

## 上下文压缩

对话变长时，Kimi Code CLI 会在上下文接近窗口上限时自动压缩历史消息，释放 token 空间。也可以随时手动触发：

```
/compact
```

压缩时可以附带指引，告诉模型优先保留哪些信息：

```
/compact 保留与数据库迁移相关的讨论
```

## 派生会话

想在不破坏当前对话的前提下尝试新思路，使用 `/fork`：

```
/fork
```

派生后的两个会话彼此独立，互不影响，可以随时通过 `/sessions` 切回原来的会话。已保存的 `/goal` 不会复制到派生会话。如果你想在派生会话中进行自主 goal 工作，需要在那里开始一个新 goal。

## 导出会话

用 `kimi export` 把会话打包为 ZIP，适合分享、归档或提交问题反馈：

```sh
kimi export <sessionId>
```

不传 `sessionId` 时导出当前目录最近的会话（有交互式确认，加 `-y` 跳过）。用 `-o` 指定输出路径：

```sh
kimi export <sessionId> -o ~/Desktop/my-session.zip
```

导出包含会话目录下的所有文件，包括诊断日志。全局诊断日志（`~/.kimi-code/logs/kimi-code.log`）默认也会打包；如不需要，加 `--no-include-global-log` 排除。

也可以在 TUI 内导出，无需离开交互界面：

- **`/export-debug-zip`**：产生与 `kimi export` 相同的调试 ZIP。
- **`/export-md`**（别名 `/export`）：导出为人类可读的 Markdown 对话记录，适合分享或存档。可选接收路径参数；不带参数时写入工作目录下的 `kimi-export-<short-id>-<timestamp>.md`。

::: tip 提示
导出文件可能包含代码、命令输出和路径等敏感信息，分享前请先确认内容。
:::

## 下一步

- [数据路径](../configuration/data-locations.md) — 会话文件的完整目录结构说明
- [kimi 命令](../reference/kimi-command.md) — `--continue`、`--session`、`export` 等命令的完整参数参考
