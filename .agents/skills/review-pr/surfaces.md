# 人群与触发线索

列行为变化清单时用：谁在依赖现有行为，diff 里碰到什么就必须列行为变化。每次线上回归复盘后，把新发现的人群或触发线索补进来，并在「历史案例」里加一行。

## 一、人群：谁在依赖现有行为

### 客户端与入口

| 人群 | 已知敏感点 |
|---|---|
| TUI 交互用户 | `kimi` 默认入口，`apps/kimi-code/src/tui/` |
| print 模式用户 | `kimi -p`；解析 `--output-format stream-json` 的脚本依赖事件形态和顺序，输出格式变化必须写进 changeset（#3146） |
| desktop 与 web 用户 | 共用 `apps/desktop/src/renderer`；改 kap-server 的 REST 或 WebSocket 时，核对 `packages/app-core/src/api/daemon` 的调用 |
| 通过 KAP 驱动会话的外部 agent 和机器人 | 只有核心会话和对话流接口要求向后兼容，见 `packages/kap-server/AGENTS.md` |
| VS Code 扩展用户 | webview 有自己的渲染契约（#3250：v2 不再发 `display` 字段，卡片空白） |
| ACP 客户端用户 | Zed 等；stdio MCP 是默认传输（#3167），能力矩阵是公开承诺（#3081），见 `docs/en/reference/kimi-acp.md` |
| SDK 调用方 | `packages/node-sdk/src/index.ts` 和 `package.json` 的 `exports` |
| 远程控制用户 | `kimi web --remote-control`，凭据槽位和 relay 按登录区域选择（#3969） |

### 模型服务的接口格式

| 人群 | 已知敏感点 |
|---|---|
| Kimi 官方 | 默认路径，OAuth 托管登录，区域和 relay 差异 |
| `openai` Chat Completions 兼容网关 | 最杂的一群：OpenRouter 形态（`reasoning` 字符串和 `reasoning_details` 数组并存，#3900）、只发 `reasoning_content` 的、严格校验历史消息的（#2819）、对 `anyOf` 参数处理不同的（#3383） |
| `anthropic`、`openai_responses`、`google-genai`、`vertexai` | 各自的 thinking、工具调用、usage 字段形态 |
| 自定义模型配置 | `api_key_env`、models.dev catalog 导入、手动配置的 thinking 参数（#3448）、`[secondary_model]` 和 subagent model pool（#3192、#3903） |

### 平台、仓库和配置

| 人群 | 已知敏感点 |
|---|---|
| Windows | 深路径和递归监听、驱动器根和 UNC（#2876）、IME 组合输入（#3915）、CSI-u 键盘序列 |
| Linux | 没有 hardlink 的文件系统（#3535）、根目录海量文件导致 OOM（#3892） |
| macOS | 默认开发环境，最容易被当成「全体用户」 |
| 网络代理用户 | 后台子 agent 重试（#3721） |
| 不同安装渠道 | npm 包、各平台 native 二进制、VS Code 市场包、内置 web 产物；`src/` 一行不动也可能丢掉一个平台 |
| 子模块或 worktree 里启动的用户 | `core.worktree` 已设置；路径含符号链接时 realpath 和字面路径不一致（#3964） |
| git-lfs、git-crypt 用户 | filter 驱动带 `required = true`，清空 filter 命令会让 `git status` 直接失败（#3964） |
| 大仓库用户 | 依赖 `core.fsmonitor`；footer 的后台 git 超时后静默当作 clean |
| 要求签名提交或 husky hooks 的仓库 | 自动提交路径（Tower 等）关掉 hooks 或签名，会改变提交结果 |
| 默认配置用户 | 任何默认值翻转对他们都是行为变化 |
| experimental flag 用户 | flag 的 `default` 翻成 true，等于面向全体发布 |
| 配了 hooks 的用户 | 事件名和载荷是外部脚本的契约；曾出现审批被静默批准（#3888）、v2 不触发 PreToolUse（#3431） |
| skills、plugins、MCP 用户 | `[watch]` 热加载关掉时，AGENTS.md 变更提醒连带失效（#3931、#4015） |
| 环境变量用户 | 同一个变量在 TUI、print 模式、kap-server 三个入口要行为一致（#3498） |
| 自定义 agent 用户 | `--agent` 的 `disallowedTools` 等策略（#3417） |
| 主题、键位用户 | `tui.toml` |
| 关闭遥测的用户 | `KIMI_DISABLE_TELEMETRY` 要在所有入口生效 |

### 数据年代

| 人群 | 已知敏感点 |
|---|---|
| 旧版本写入的会话 | wire 日志、turn 编号、压缩后的 transcript（#3561、#3866、#3922）；新版本能不能读，回滚后能不能读 |
| `kimi migrate` 迁来的会话 | 从 `~/.kimi/` 迁到 `~/.kimi-code/`，见 `packages/migration-legacy/` |
| 搜索索引 | minidb 快照和 WAL |
| 后台任务和 cron | 非正常退出后的恢复（#3924） |
| `kimi export` 的使用者 | 导出格式 |

### 依赖提示词具体句子的人群

- 依赖「不碰工作目录外的文件」的（#3879 删了这条）。
- 依赖「cwd 就是项目根」的（#3929 删了这条）。
- plan 模式的提醒节奏（#3489）。

依据外部基准分析改提示词，本质是拿一个人群的收益换另一个人群的损失，PR 要写明两边各是谁。

## 二、触发线索：diff 里碰到就必须列行为变化

契约文件和提示词文本见 `SKILL.md` 的规则，这里不再重复。

| diff 里出现 | 必做的检查 |
|---|---|
| `packages/agent-core-v2/docs/config-manifest.toml` | 默认值翻转和校验收紧必列；没同步 `docs/en/configuration/config-files.md` 算文档过时 |
| `packages/agent-core-v2/src/**/flag.ts`、`packages/agent-core-v2/src/app/flag/flagRegistry.ts` | `default` 翻转按行为变化处理 |
| `packages/agent-core-v2/src/human/utils/watch.ts`，以及任何被配置键覆盖的默认常量或 `?? true` / `?? false` 兜底 | 默认值翻转必列；逃生口的 config 路径要有测试，不能只靠环境变量 |
| `packages/core/src/llm/builtin/protocol/`、`packages/core/src/llm/builtin/provider/` | 枚举每种上游载荷形态改动前后各走哪条分支，尤其是多个字段并存的网关 |
| `packages/klient/src/` | 按 SDK 调用方和 ACP 客户端两个人群核对 |
| `packages/acp-server/` | 对照 `docs/en/reference/kimi-acp.md` 的能力矩阵 |
| `apps/kimi-code/src/cli/` | 对照 `docs/en/reference/kimi-command.md` |
| `packages/agent-core-v2/src/features/externalHooks/` | 对照 `docs/en/customization/hooks.md` 的事件参考 |
| `packages/agent-core-v2/src/app/git/`、`apps/kimi-code/src/utils/git/` | 对照上面的 git 人群：前置探针失败会不会让后台 git 整体静默不可用；覆盖的 config 键里有没有 `required`、`gpgSign`、`hooksPath` |
| `.github/workflows/release.yml`、`_native-build.yml`、`manual-native-bundle.yml`、`vscode-publish.yml`，`apps/kimi-code/scripts/native/`、`apps/kimi-code/scripts/check-web-assets.mjs` | 每个安装渠道的产物是否仍然齐全 |
| `packages/migration-legacy/`、`packages/minidb/`、读写 `~/.kimi-code/` 的代码 | 老数据是否仍然可读、可迁移 |
| 新增、删除或改变语义的环境变量读取点（不限写法和前缀） | 对照 `docs/en/configuration/env-vars.md`；三个入口是否一致 |
| `packages/agent-core-v2/src/app/scopes.ts`、`packages/agent-core-v2/src/features/featureAssemblyService.ts` | 谁依赖原来的启动顺序（#3471 合入 34 分钟后被 #3486 revert） |
| `docs/en/**`、`docs/zh/**` 的 reference、configuration、customization 页 | 改了行为没改文档，或改了文档没改行为 |

## 三、历史案例

| 类型 | 案例 | 当时漏掉了什么 |
|---|---|---|
| 兼容分支收窄 | #3492 引入，#3910 修复 | 没人问谁会两个字段同时发；openai 兼容网关的输入被静默丢弃 |
| 默认值翻转 | #3931，#4015 翻回 | changeset 只写了新默认值，没写运行中改配置、skills、AGENTS.md 不再自动生效，而且没有任何信号 |
| 提示词删句子 | #3879、#3929 | 「没有测试引用这句」被当成没有影响 |
| 重构丢功能 | #2961 引入，#3183 修复 | 删掉了 ACP 本地执行兜底和 stdio MCP，文档承诺还在；ACP 功能整体不可用 |
| 移植漏项 | #3498、#3098、#3250、#3431、#3820 | v2 少了环境变量、上下文用量、卡片字段、hook、legacy flag；没人列过旧路径的功能清单 |
| 修复引入时序变化 | #3471，被 #3486 revert | 延迟装配改变了启动顺序 |
| 输出契约变化 | #3146 | headless 事件输出变了，没写 changelog |
| 静默批准 | #3888 | 配了 hook 时审批面板不渲染，待审调用被静默批准 |
| 安全收紧连带 | #3964，#4013 回滚 | 符号链接路径、`required = true` 的 filter、没有信任入口的 print 和 ACP、`~` 条目，四处都静默失败；PR 没列任何人群 |
