# kimi 命令

`kimi` 是 Kimi Code CLI 的主命令，用于在终端中启动一次交互式会话。不带任何参数运行时，它会在当前工作目录下开启一个新会话；配合不同的 flag，可以续上历史会话、跳过审批、从 Plan 模式开始，或者指定自定义的 Skills 目录。

```sh
kimi [options]
kimi <subcommand> [options]
```

## 主命令选项

下表列出 `kimi` 主命令支持的全部选项。所有 flag 都是可选的，直接运行 `kimi` 即可进入交互式会话。

| 选项 | 简写 | 说明 |
| --- | --- | --- |
| `--version` | `-V` | 打印版本号并退出。 |
| `--help` | `-h` | 显示帮助信息并退出。 |
| `--session [id]` | `-S` | 恢复一个会话。带 ID 时直接打开指定会话；不带 ID 时进入交互式选择器，从历史会话中挑选。 |
| `--continue` | `-C` | 继续当前工作目录下最近一次的会话，无需手动指定 ID。 |
| `--model <model>` | `-m` | 为本次启动指定模型别名。省略时，新会话使用配置文件中的 `default_model`，恢复会话使用会话当前模型。 |
| `--prompt <prompt>` | `-p` | 非交互执行单次 prompt，并把 Assistant 输出流式写到 stdout。该模式会使用 `auto` 权限处理工具调用，不会打开 TUI。 |
| `--output-format <format>` | | 设置非交互输出格式，支持 `text` 与 `stream-json`。仅可与 `--prompt` 一起使用，默认 `text`。 |
| `--yolo` | `-y` | 自动批准普通工具调用，跳过审批请求；Plan 模式中的 `Bash` 审批和退出审批不会被跳过。 |
| `--auto` | | 以 auto 权限模式启动。工具审批自动处理，Agent 不会向用户提问。 |
| `--plan` | | 以 Plan 模式启动新会话，AI 会优先使用只读工具进行探索和规划，可以写入当前计划文件；Plan 模式中的 `Bash` 按权限模式单独处理。 |
| `--skills-dir <dir>` | | 从指定目录加载 Skills，替换自动发现的用户和项目目录。可重复传入以叠加多个目录。详见下文 [自定义 Skills 目录](#自定义-skills-目录)。 |

`-r` / `--resume` 是 `--session` 的隐藏别名；`--yes` 和 `--auto-approve` 是 `--yolo` 的隐藏别名。它们在帮助信息中不会显示，行为与对应的官方 flag 完全一致。

::: warning 注意
`--yolo` 会跳过普通工具调用的人工确认，包括文件写入和 Shell 命令执行。请只在受信任的工作目录下使用。Plan 模式的退出审批不会被 `--yolo` 跳过；Plan 模式下的 `Bash` 也按 `--yolo` 的普通放行规则处理。
:::

### flag 冲突规则

以下组合会在启动时被拒绝：

- `--continue` 与 `--session` 互斥：两者都表示"恢复历史会话"，含义重叠。
- `--yolo` 不能与 `--continue` 或 `--session` 同时使用：恢复会话时会沿用原会话的审批设置。此规则仅适用于交互式模式；在 `--prompt` 模式下，`--yolo` 已因与 `--prompt` 互斥而被更早拦截。
- `--auto` 不能与 `--continue` 或 `--session` 同时使用：与 `--yolo` 同理。
- `--auto` 不能与 `--yolo` 同时使用：两种权限模式互斥。
- `--plan` 不能与 `--continue` 或 `--session` 同时使用：Plan 模式只对新会话生效。
- `--prompt` 不能与 `--yolo`、`--auto` 或 `--plan` 同时使用：非交互模式固定使用 `auto` 权限，并且不进入 Plan 模式。
- `--prompt` 可以与 `--continue` 或带 ID 的 `--session <id>` 一起使用；不带 ID 的 `--session` 会尝试打开选择器，因此不能用于非交互模式。
- `--output-format` 只能与 `--prompt` 一起使用；交互式 TUI 不支持把完整事件流写成 stdout JSONL。

如果需要在恢复会话时强制使用 YOLO 或 Plan 模式，请改在交互式会话内通过斜杠命令切换。

## 典型用法

最常见的入口是直接运行 `kimi`，在当前目录开启一次全新的会话：

```sh
kimi
```

如果上一次会话被打断（关闭终端、网络断开等），想从断点继续，使用 `--continue`：

```sh
kimi --continue
```

它会自动找到当前工作目录下时间最近的那个会话并恢复。若想挑选其他历史会话，运行 `kimi --session` 进入交互式选择器，或者直接传入已知的 session ID：

```sh
kimi --session 01HZ...XYZ
```

当任务比较琐碎，不希望被频繁的审批请求打断时，可以加上 `--yolo`：

```sh
kimi --yolo
```

希望 Agent 自行处理审批且不再向用户提问时，使用 `--auto`：

```sh
kimi --auto
```

需要先让 AI 阅读代码、产出实现计划，而不是立刻动手修改文件时，使用 `--plan` 进入 Plan 模式：

```sh
kimi --plan
```

### 自定义 Skills 目录

如果需要加载自定义的 Skills 目录，可以通过两种方式指定：

- **CLI flag `--skills-dir <dir>`**：可重复传入，会**替换**自动发现的用户和项目目录，适合临时切换或在脚本中使用。例如同时挂载两个目录：

  ```sh
  kimi --skills-dir /path/to/team-skills --skills-dir ./local-skills
  ```

- **`config.toml` 的 `extra_skill_dirs`**：在配置文件中追加额外目录，与自动发现的目录**叠加**生效，适合长期配置团队共享 Skills（详见 [Agent Skills](../customization/skills.md)）。

## 非交互执行

需要在脚本或 CI 中运行单次 prompt 时，使用 `-p`：

```sh
kimi -p "Summarize the current repository status"
```

输出采用 transcript 样式：thinking 内容和 Assistant 正文都会以 `• ` 开头，换行后使用两个空格缩进。Assistant 正文会输出到 stdout；thinking、工具进度和 `To resume this session: kimi -r <id>` 提示输出到 stderr。`-p` 模式不会请求人工审批，普通工具调用、Plan 审批和 Agent 提问都会按 `auto` 权限策略处理。静态 deny 规则仍然会阻止匹配的工具调用。

需要临时切换模型时，加上 `-m`：

```sh
kimi -m kimi-code/kimi-for-coding -p "Explain the latest diff"
```

如果脚本需要结构化读取输出，可以使用 JSONL：

```sh
kimi -p "List changed files" --output-format stream-json
```

`stream-json` 模式下，stdout 每行都是一个 JSON 对象。普通回复会输出 Assistant 消息；如果模型调用工具，会先输出带 `tool_calls` 的 Assistant 消息，再输出对应的 Tool 消息，最后继续输出后续 Assistant 消息。thinking 内容不会写入 JSONL；工具进度和恢复会话提示仍然写到 stderr。

## 子命令

### `kimi export`

把一个会话打包成 ZIP 文件，便于分享、归档或者提交问题反馈。导出的压缩包包含会话目录下的所有文件，例如上下文记录、状态文件和会话诊断日志（如果该会话已经产生 `logs/kimi-code.log`）。

```sh
kimi export [sessionId] [options]
```

| 参数 / 选项 | 简写 | 说明 |
| --- | --- | --- |
| `sessionId` | | 要导出的会话 ID。省略时会自动选择当前工作目录下最近一次的会话，并要求确认。 |
| `--output <path>` | `-o` | 输出 ZIP 文件路径。省略时写入当前目录下的默认文件名。 |
| `--yes` | `-y` | 跳过默认会话的确认提示，直接导出。 |
| `--no-include-global-log` | | 不打包当前活动的全局诊断日志，即 `~/.kimi-code/logs/kimi-code.log`。默认包含。 |

默认导出包含目标会话目录内的文件；如果会话目录里有 `logs/kimi-code.log`，会一并出现在 ZIP 的 `logs/kimi-code.log`。全局诊断日志 `~/.kimi-code/logs/kimi-code.log` 默认也会打包，因为它可能包含其它会话或其它项目的事件，如果不想分享可以加 `--no-include-global-log`。加上后，ZIP 内路径是 `logs/global/kimi-code.log`，不会包含轮转出来的 `kimi-code.log.1` 等旧文件。

省略 `sessionId` 时，命令会先打印待导出的会话信息并请求确认；用 `-y` 可以跳过确认，适合在脚本里使用：

```sh
# 导出当前工作目录最近一次会话，跳过确认
kimi export -y

# 导出指定会话到自定义路径
kimi export 01HZ...XYZ -o ./bug-report.zip

# 排除全局诊断日志，避免分享其它会话的事件
kimi export 01HZ...XYZ -o ./bug-report.zip --no-include-global-log
```

### `kimi migrate`

将旧版 kimi-cli 的本地数据迁移到 kimi-code。该命令无任何 flag，纯交互式运行，会引导你完成数据迁移的全流程。

```sh
kimi migrate
```

如果你之前使用过旧版 kimi-cli，可以运行此命令将历史会话、配置等数据迁移到 kimi-code 中，避免数据丢失。完整的迁移流程、迁移内容与注意事项见 [从 kimi-cli 迁移](../guides/migration.md)。

### `kimi provider`

在 shell 中管理供应商，相当于 TUI 中 `/provider` 的非交互版本。适合脚本化部署、CI 初始化、以及在新机器上一行完成配置。

```sh
kimi provider <action> [options]
```

包含三个动作：

#### `kimi provider add <url>`

从自定义 registry（一份 `api.json` 文档）批量导入所有供应商。命令会拉取 registry，为每个顶层条目创建 `[providers.<id>]`，为每个模型创建 `[models.<alias>]`，并在每个供应商上写入 `source = { kind = "apiJson", url, api_key }`，使下次 TUI 启动时自动刷新模型列表。

| 参数 / 选项 | 说明 |
| --- | --- |
| `<url>` | Registry 地址，例如 `https://free-tokens.msh.team/v1/models/api.json`。 |
| `--api-key <key>` | 访问 registry 时携带的 Bearer token。未传时回退到环境变量 `KIMI_REGISTRY_API_KEY`。必填。 |

```sh
# 一行导入：registry 中的所有 provider 与 model 全部写入 ~/.kimi-code/config.toml
kimi provider add https://free-tokens.msh.team/v1/models/api.json --api-key YOUR_KEY

# 或通过环境变量，便于 CI / .envrc 等场景
KIMI_REGISTRY_API_KEY=YOUR_KEY kimi provider add https://free-tokens.msh.team/v1/models/api.json
```

如果某个 provider id 已存在，会先删除（包括其残留的模型 alias），再按 registry 重新写入，与 TUI 的行为一致。不会自动设置默认模型 —— 后续可以用 `-m` 或 TUI 内的 `/model` 选择。

#### `kimi provider remove <providerId>`

删除指定供应商及其所有模型 alias。如果被删除的供应商正好是 `default_model` 所属，则同时清空 `default_model`。

```sh
kimi provider remove kohub
```

#### `kimi provider list`

按行打印每个已配置的供应商，包含类型、模型数量、来源（`apiJson(...)`、`oauth` 或 `inline`）。加 `--json` 可输出原始的 `providers` 和 `models` 表，便于程序化处理。

```sh
kimi provider list
kimi provider list --json | jq '.providers | keys'
```

#### `kimi provider catalog list [providerId]`

在不写入任何配置的情况下浏览公开的 [models.dev](https://models.dev/) 模型目录。不传参数时按行打印每个供应商及其推断出的协议类型和模型数量；传 `providerId` 时进入该供应商详情，逐个列出模型，附上下文窗口和能力。

| 参数 / 选项 | 说明 |
| --- | --- |
| `[providerId]` | 可选。要查看的供应商 id。 |
| `--filter <substring>` | 顶层视图下，按 id 或 name 大小写不敏感子串过滤。 |
| `--url <url>` | 覆盖 catalog 地址，默认 `https://models.dev/api.json`。 |
| `--json` | 以 JSON 形式输出匹配片段。 |

```sh
# 浏览供应商
kimi provider catalog list
kimi provider catalog list --filter anthropic

# 查看某个供应商的所有模型
kimi provider catalog list anthropic
```

#### `kimi provider catalog add <providerId>`

按 id 从 catalog 直接导入一个已知供应商。协议类型、base URL、模型标识、上下文限制、能力都由 catalog 提供，你只需要提供 API key。

| 参数 / 选项 | 说明 |
| --- | --- |
| `<providerId>` | catalog 中的供应商 id，例如 `anthropic`、`openai`、`google`。 |
| `--api-key <key>` | 供应商 API key。未传时回退到环境变量 `KIMI_REGISTRY_API_KEY`。必填。 |
| `--default-model <modelId>` | 可选。导入后把 `default_model` 设置为 `<providerId>/<modelId>`。`<modelId>` 必须在 `catalog list <providerId>` 中存在。 |
| `--url <url>` | 覆盖 catalog 地址，默认 `https://models.dev/api.json`。 |

不传 `--default-model` 时保留现有的 `default_model`，后续可以用 `-m` 或 TUI 内的 `/model` 选择。

```sh
# 看可选项
kimi provider catalog list anthropic

# 一行导入并设默认
kimi provider catalog add anthropic --api-key sk-ant-... --default-model claude-opus-4-7
```
