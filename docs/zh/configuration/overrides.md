# 配置覆盖

Kimi Code CLI 的运行参数来自用户配置文件、命令行选项，以及若干在进程级环境变量上读取的运行时路径、端点与开关。三者面向不同场景 —— 配置文件保存长期偏好，命令行选项做本次启动的临时切换，环境变量主要负责定位数据目录、切换 OAuth 端点和少量运行时开关。

环境变量在 Kimi Code CLI 中**不是配置字段的通用后备来源**：它们分成下面三类，作用范围互不相同，不能简单合并成一条线性优先级。

## 环境变量的三类作用

1. **配置文件定位**：`KIMI_CODE_HOME` 决定配置文件、会话、日志等所在的数据根目录，配置文件路径变为 `$KIMI_CODE_HOME/config.toml`，否则使用 `~/.kimi-code/`。这是先于其它解析的"在哪里找配置"步骤，不是普通参数的后备来源；也无法通过 `KIMI_CONFIG_PATH` 之类的变量任意切换配置文件路径。
2. **运行时开关**：`KIMI_DISABLE_TELEMETRY` 等少量开关会直接关闭对应子系统。即便 `config.toml` 中 `telemetry = true`，只要这个变量被设置成真值，遥测仍会被关闭——它对相关子系统的语义是"额外禁用"，而不是"普通覆盖"。
3. **运行端点与诊断**：`KIMI_CODE_OAUTH_HOST`、`KIMI_OAUTH_HOST`、`KIMI_CODE_BASE_URL`、`KIMI_LOG_LEVEL` 等供 OAuth 与诊断子系统初始化时读取。完整列表见 [环境变量](./env-vars.md)。

## 普通运行参数的优先级

对其它运行参数（模型别名、Plan / yolo 模式、Skills 目录等），按下面顺序解析：

1. **命令行选项**：本次启动指定的参数，覆盖所有其他来源；仅对本次启动生效。
2. **用户配置文件**：`$KIMI_CODE_HOME/config.toml`（缺省为 `~/.kimi-code/config.toml`），保存长期偏好。

少数环境变量会明确覆盖配置文件中的相关字段，例如 `KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT` 的优先级高于 `[background].keep_alive_on_exit`。这类例外会在 [环境变量](./env-vars.md) 与对应的 [配置文件](./config-files.md) 字段说明里标出。

::: warning 注意
普通运行参数**不会**从 shell 环境变量取后备值。例如供应商 `api_key` / `base_url` 只读取 `config.toml` 中的字段（包括 `[providers.<name>.env]` 子表），不会回退到 `export KIMI_API_KEY` 这类终端变量；详见下文 [供应商凭证](#供应商凭证)。唯一的例外是显式的 `KIMI_MODEL_*` 通道，它会从 shell 合成出一个模型（及其凭证）；详见 [用环境变量定义模型](./env-vars.md#用环境变量定义模型-kimi-model)。
:::

Kimi Code CLI 目前只读取一份用户级配置文件，没有项目级（仓库内）配置文件机制。如果需要在不同项目之间隔离配置，可以通过 `KIMI_CODE_HOME` 指向不同的数据目录（详见下文 [典型场景](#典型场景)），或在启动时用 CLI 选项临时覆盖具体字段。

## 配置文件

配置文件位置由 `KIMI_CODE_HOME` 环境变量控制，未设置时使用 `~/.kimi-code/`。文件名固定为 `config.toml`，目录会以 `0o700` 权限创建。文件内可声明 `default_provider`、`default_model`、`providers`、`models`、`thinking`、`loop_control` 等长期偏好。具体字段见 [配置文件](./config-files.md)。

## 供应商凭证

供应商凭证（`api_key`、`base_url`）的解析有自己的规则：Kimi Code CLI 只从 `config.toml` 中读取供应商字段，**不会**从 shell 环境变量取后备值。仅在终端里 `export KIMI_API_KEY` 不会让某个 `[providers.<name>]` 自动获得凭证，必须显式写到配置文件里。唯一的例外是显式的 `KIMI_MODEL_*` 通道，它会从 shell 合成出一个模型（及其凭证）；详见 [用环境变量定义模型](./env-vars.md#用环境变量定义模型-kimi-model)。

对单个供应商而言，凭证按以下顺序解析：

1. `[providers.<name>].api_key` —— 配置文件中显式写入的密钥，优先级最高。
2. `[providers.<name>.env]` 子表中的对应键（如 `KIMI_API_KEY`、`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GOOGLE_API_KEY`）—— 把习惯写在 shell 里的环境变量名搬到 TOML 子表里，仅在 `api_key` 留空时生效。这只是配置子表的形式，不会真正修改进程环境。
3. 若两者都缺，启动时会报错并提示对应的供应商缺少凭证。

`base_url` 的解析方式与 `api_key` 类似：先读 `[providers.<name>].base_url`，再读 `[providers.<name>.env]` 中的 `*_BASE_URL` 键（如 `ANTHROPIC_BASE_URL`、`OPENAI_BASE_URL`、`KIMI_BASE_URL`）。供应商类型与字段的完整说明见 [供应商](./providers.md)。

## 进程级环境变量

`process.env` 中的变量在 Kimi Code CLI 启动时被读取，作用分成上文 [环境变量的三类作用](#环境变量的三类作用) 中已说明的三类：

- **数据根目录与日志路径**：`KIMI_CODE_HOME` 切换 `~/.kimi-code/`；`KIMI_LOG_LEVEL` 等控制诊断日志。
- **运行时开关**：`KIMI_DISABLE_TELEMETRY` 关闭遥测（会覆盖 `config.toml` 中 `telemetry = true` 的设置）。
- **OAuth 端点与诊断**：`KIMI_CODE_OAUTH_HOST`、`KIMI_OAUTH_HOST`、`KIMI_CODE_BASE_URL` 控制托管 Kimi 登录端点；`KIMI_LOG_LEVEL` 等控制诊断日志。
- **后台任务退出策略**：`KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT` 覆盖 `[background].keep_alive_on_exit`，用于临时决定本次进程退出时是否保留后台任务。

完整变量与适用范围见 [环境变量](./env-vars.md)。

## 命令行选项

启动时通过 CLI 选项指定的参数优先级最高，仅对本次启动生效。常用选项：

| 选项 | 作用 |
| --- | --- |
| `-S, --session [id]` | 恢复指定 session；不带 id 时进入交互式选择 |
| `-C, --continue` | 续上当前工作目录的上一次 session |
| `-y, --yolo` | 自动批准普通工具调用（别名 `--yes`、`--auto-approve`） |
| `--plan` | 以 Plan 模式启动 |
| `-m, --model <model>` | 指定本次启动使用的模型别名 |
| `-p, --prompt <prompt>` | 以非交互模式执行单次提示词后退出 |
| `--output-format <format>` | 指定 `-p` 模式的输出格式，可选 `text` 或 `stream-json` |
| `--skills-dir <dir>` | 替换自动发现的 Skills 目录（可重复指定多个，仅对本次启动生效） |

选项互斥规则：

- `--output-format` 只能在 prompt 模式（`-p / --prompt`）下使用。
- `--prompt` 不能与 `--yolo` 同用，也不能与 `--plan` 同用。
- `--prompt` 模式下使用 `-S / --session` 必须给出 session id，不接受不带 id 的交互式选择。
- `--continue` 与 `--session` 不能同用。
- 在非 prompt 模式下，`--yolo` 不能与 `--continue` 或 `--session` 组合；`--plan` 不能与 `--continue` 或 `--session` 组合。
- `--yolo` 与 `--plan` 可以同时使用。

::: tip 提示
`--skills-dir` 替换本次启动自动发现的 Skills 目录，适合一次性指定；若需长期追加搜索目录，可在 `config.toml` 顶层写 `extra_skill_dirs`（详见 [Agent Skills](../customization/skills.md)），两者语义不同，可按需选用。
:::

## 典型场景

**切换数据目录用于隔离测试。** `KIMI_CODE_HOME` 会同时影响配置文件、session 存档、ripgrep 缓存等所有数据位置：

```sh
KIMI_CODE_HOME="$PWD/.kimi-sandbox" kimi
```

**在配置文件中预置临时凭证。** 由于供应商凭证只读取 `config.toml`，若要在一次启动里使用另一个 API key，可以预先把它写入 `[providers.<name>.env]` 子表：

```toml
[providers.kimi.env]
KIMI_API_KEY = "sk-test"
```

也可以直接为该供应商写 `api_key`；两者优先级见上文 [供应商凭证](#供应商凭证)。

**本次启动跳过审批。** 适用于已知安全的批处理任务：

```sh
kimi --yolo
```

**本次启动进入 Plan 模式。** 若希望默认行为也如此，可在配置文件中设置 `default_plan_mode = true`：

```sh
kimi --plan
```
