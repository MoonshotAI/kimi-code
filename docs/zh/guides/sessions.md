# 会话与上下文

Kimi Code CLI 把每次对话持久化为一个「会话」，保留消息历史和元数据，可以随时关闭终端后再回来继续。本节介绍恢复会话、上下文压缩和 TUI 内的管理方法。

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

- `state.json` — 会话标题、元数据等。
- `agents/*/wire.jsonl` — Agent 事件流。

::: warning 注意
`sessions/` 目录下的文件手动修改后可能导致会话无法恢复，建议不要手工编辑。
:::

## 启动与恢复会话

默认每次执行 `kimi` 都会创建新会话。如果想接着上一次继续：

**继续当前目录最近的会话：**

```sh
kimi --continue
```

**恢复指定会话：**

```sh
kimi --session abc123
```

也可以带 `-r` / `--resume`，效果相同。

**交互式选择：**

```sh
kimi --session
```

::: warning 注意
`--continue` 与 `--session` 互斥；`--yolo` 和 `--plan` 也不能与它们共用。
:::

## 在 TUI 中切换会话

- `/new`（`/clear`）：切换到新会话。
- `/sessions`（`/resume`）：浏览并恢复历史会话。
- `/fork`：派生当前会话（详见下文）。
- `/title <text>`（`/rename`）：设置会话标题，方便识别。不带参数时显示当前标题。

`/sessions`、`/new`、`/fork`、`/compact` 仅在空闲时可用。流式输出或上下文压缩期间，需先按 `Esc` 或 `Ctrl-C` 中断当前操作。

## 上下文压缩

对话变长时，Kimi Code CLI 会在上下文接近窗口上限时自动压缩历史消息。你也可以手动触发：

```text
/compact
```

带上自定义指引，告诉模型压缩时优先保留哪些信息：

```text
/compact 保留与数据库迁移相关的讨论
```

## 派生会话

想在不破坏当前对话的前提下尝试新思路，使用 `/fork`：

```text
/fork
```

派生后的会话彼此独立，不影响原会话，你随时可以切回。

## 导出会话

用 `kimi export` 打包会话为 ZIP：

```sh
kimi export <sessionId>
```

不传 `sessionId` 时导出当前目录最近的会话（会交互式确认，加 `-y` 跳过）。用 `-o` 指定输出路径：

```sh
kimi export <sessionId> -o ~/Desktop/my-session.zip
```

未指定 `-o` 时，ZIP 写入当前工作目录。会话目录里的诊断日志会一并打包；此外，全局诊断日志 `$KIMI_CODE_HOME/logs/kimi-code.log`（记录 TUI 启动、登录等不属于任何会话的事件）默认也会包含进来，不需要时加 `--no-include-global-log` 跳过。

也可以在不离开 TUI 的情况下导出当前会话。`/export-debug-zip` 产生与 `kimi export` 相同的调试 ZIP，而 `/export-md`（别名 `/export`）会写出一份人类可读的 Markdown 对话记录，适合分享或归档可读的会话内容。`/export-md` 可选接收一个路径参数；不带参数时，写入工作目录下的 `kimi-export-<short-id>-<timestamp>.md`。

::: tip 提示
导出文件可能包含敏感信息，分享前请确认内容。
:::
