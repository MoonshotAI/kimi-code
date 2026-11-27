# 谁在依赖现有行为

列行为变化清单时用：哪些用户依赖现有行为，改到哪些地方必须列出行为变化。每次线上出问题复盘后，把新发现的用户类型或要查的位置补进来，并在「过去出过的问题」里加一行。

## 一、依赖现有行为的用户

### 客户端与入口

| 用户 | 容易出问题的地方 |
|---|---|
| TUI 交互用户 | `kimi` 默认入口，`apps/kimi-code/src/tui/` |
| print 模式用户 | `kimi -p`；解析 `--output-format stream-json` 输出的脚本依赖事件的格式和顺序，输出格式变了必须写进 changeset（#3146） |
| 桌面端和 Web 端用户 | 共用 `apps/desktop/src/renderer`；改 kap-server 的 REST 或 WebSocket 接口时，核对 `packages/app-core/src/api/daemon` 里的调用 |
| 通过 KAP 操作会话的外部 agent 和机器人 | 只有核心的会话和对话接口要求向后兼容，见 `packages/kap-server/AGENTS.md` |
| VS Code 扩展用户 | 扩展界面有自己的渲染约定（#3250：v2 不再发 `display` 字段，卡片变成空白） |
| ACP 客户端用户 | Zed 等；默认用 stdio 连接 MCP（#3167），文档里列出的支持功能是对外承诺（#3081），见 `docs/en/reference/kimi-acp.md` |
| SDK 调用方 | `packages/node-sdk/src/index.ts` 导出的内容和 `package.json` 的 `exports` |
| 远程控制用户 | `kimi web --remote-control`，凭据存放位置和中继服务按登录区域选择（#3969） |

### 不同的模型服务

| 用户 | 容易出问题的地方 |
|---|---|
| 用 Kimi 官方服务的 | 默认路径，OAuth 登录，不同区域的服务地址不同 |
| 用 `openai` Chat Completions 兼容网关的 | 情况最杂：OpenRouter 这类网关会同时发 `reasoning` 字符串和 `reasoning_details` 数组（#3900）；有的只发 `reasoning_content`；有的严格校验历史消息（#2819）；有的对 `anyOf` 参数处理不同（#3383） |
| 用 `anthropic`、`openai_responses`、`google-genai`、`vertexai` 的 | 每家的 thinking、工具调用、用量字段格式都不一样 |
| 自己配置模型的 | `api_key_env`、从 models.dev 导入的模型、手动配置的 thinking 参数（#3448）、`[secondary_model]` 和子 agent 的模型池（#3192、#3903） |

### 平台、仓库和配置

| 用户 | 容易出问题的地方 |
|---|---|
| Windows 用户 | 很深的路径和递归监听目录、驱动器根目录和网络路径（#2876）、输入法组合输入（#3915）、CSI-u 键盘序列 |
| Linux 用户 | 不支持硬链接的文件系统（#3535）、根目录下文件太多导致内存耗尽（#3892） |
| macOS 用户 | 开发者默认的环境，最容易被当成「所有用户」 |
| 走网络代理的用户 | 后台子 agent 的重试（#3721） |
| 不同安装方式的用户 | npm 包、各平台的独立二进制、VS Code 市场包、内置的 Web 页面；`src/` 一行不改，也可能让某个平台的包缺东西 |
| 在 git 子模块或 worktree 里启动的用户 | 设置了 `core.worktree`；路径里有符号链接时，解析后的真实路径和原路径不一致（#3964） |
| 用 git-lfs、git-crypt 的用户 | filter 驱动设了 `required = true`，把 filter 命令清空会让 `git status` 直接报错（#3964） |
| 大仓库用户 | 依赖 `core.fsmonitor`；TUI 底部状态栏在后台跑的 git 超时后，会被悄悄当成没有改动 |
| 要求签名提交或用 husky hooks 的仓库 | 自动提交的功能（Tower 等）如果关掉 hooks 或签名，提交结果会不一样 |
| 用默认配置的用户 | 任何默认值翻转，对他们都是行为变化 |
| 打开实验开关的用户 | 开关的 `default` 改成 true，就等于对所有人发布 |
| 配了 hooks 的用户 | 事件名和传给 hook 的数据是外部脚本依赖的约定；出过审批被悄悄批准（#3888）、v2 不触发 PreToolUse（#3431） |
| 用 skills、plugins、MCP 的用户 | 关掉 `[watch]` 自动重新加载时，AGENTS.md 改动的提醒也跟着失效（#3931、#4015） |
| 用环境变量的用户 | 同一个变量在 TUI、print 模式、kap-server 三个入口要行为一致（#3498） |
| 自定义 agent 的用户 | `--agent` 里的 `disallowedTools` 等限制（#3417） |
| 自定义主题和键位的用户 | `tui.toml` |
| 关闭遥测的用户 | `KIMI_DISABLE_TELEMETRY` 要在所有入口都生效 |

### 旧数据

| 数据 | 容易出问题的地方 |
|---|---|
| 旧版本保存的会话 | wire 日志、turn 编号、压缩后的对话记录（#3561、#3866、#3922）；新版本能不能读，回滚后能不能读 |
| `kimi migrate` 迁移过来的会话 | 从 `~/.kimi/` 迁到 `~/.kimi-code/`，见 `packages/migration-legacy/` |
| 搜索索引 | minidb 的快照和预写日志 |
| 后台任务和定时任务 | 程序异常退出后的恢复（#3924） |
| `kimi export` 导出的文件 | 导出格式 |

### 依赖提示词里具体句子的用户

- 依赖「不碰工作目录以外的文件」的（#3879 删了这句）。
- 依赖「当前目录就是项目根目录」的（#3929 删了这句）。
- plan 模式里提醒出现的频率（#3489）。

根据外部评测结果改提示词，等于拿一部分用户的收益去换另一部分用户的损失，PR 要写明两边各是谁。

## 二、改到这些地方要查

契约文件和提示词文本由 `SKILL.md` 的规则管，这里不再重复。

| 改到的地方 | 要查什么 |
|---|---|
| `packages/agent-core-v2/docs/config-manifest.toml` | 默认值翻转和校验收紧必须列出；没同步 `docs/en/configuration/config-files.md`，算文档过时 |
| `packages/agent-core-v2/src/**/flag.ts`、`packages/agent-core-v2/src/app/flag/flagRegistry.ts` | 开关的 `default` 翻转，按行为变化处理 |
| `packages/agent-core-v2/src/human/utils/watch.ts`，以及会被配置项覆盖的默认常量、`?? true` / `?? false` 这类默认值 | 默认值翻转必须列出；恢复旧行为的配置项要有测试，不能只靠环境变量 |
| `packages/core/src/llm/builtin/protocol/`、`packages/core/src/llm/builtin/provider/` | 每种模型服务返回的数据格式，改动前后各走哪个分支，尤其是会同时发多个字段的网关 |
| `packages/klient/src/` | 分别从 SDK 调用方和 ACP 客户端的角度核对 |
| `packages/acp-server/` | 对照 `docs/en/reference/kimi-acp.md` 列出的支持功能 |
| `apps/kimi-code/src/cli/` | 对照 `docs/en/reference/kimi-command.md` |
| `packages/agent-core-v2/src/features/externalHooks/` | 对照 `docs/en/customization/hooks.md` 的事件说明 |
| `packages/agent-core-v2/src/app/git/`、`apps/kimi-code/src/utils/git/` | 对照上面和 git 相关的几类用户：启动前的检查失败，会不会让后台 git 整个悄悄不能用；改写的 git 配置里有没有 `required`、`gpgSign`、`hooksPath` |
| `.github/workflows/release.yml`、`_native-build.yml`、`manual-native-bundle.yml`、`vscode-publish.yml`，`apps/kimi-code/scripts/native/`、`apps/kimi-code/scripts/check-web-assets.mjs` | 每种安装方式的包是否还齐全 |
| `packages/migration-legacy/`、`packages/minidb/`、读写 `~/.kimi-code/` 的代码 | 旧数据是否还能读、能迁移 |
| 新增、删除或改变含义的环境变量读取（不管怎么写、是不是 `KIMI_` 开头） | 对照 `docs/en/configuration/env-vars.md`；三个入口是否一致 |
| `packages/agent-core-v2/src/app/scopes.ts`、`packages/agent-core-v2/src/features/featureAssemblyService.ts` | 谁依赖原来的启动顺序（#3471 合入 34 分钟后被 #3486 撤回） |
| `docs/en/**`、`docs/zh/**` 的 reference、configuration、customization 页面 | 改了行为没改文档，或者改了文档没改行为 |

## 三、过去出过的问题

| 类型 | PR | 当时漏掉了什么 |
|---|---|---|
| 兼容分支变窄 | #3492 引入，#3910 修复 | 没人问谁会两个字段同时发；openai 兼容网关的输入被悄悄丢掉 |
| 默认值翻转 | #3931，#4015 改回 | changeset 只写了新默认值，没写运行中改配置、skills、AGENTS.md 不再自动生效，而且没有任何提示 |
| 提示词删句子 | #3879、#3929 | 「没有测试引用这句」被当成没有影响 |
| 重构丢功能 | #2961 引入，#3183 修复 | 删掉了 ACP 的本地执行回退和 stdio MCP，文档还写着支持；ACP 整个用不了 |
| 移植漏项 | #3498、#3098、#3250、#3431、#3820 | v2 少了环境变量、上下文用量、卡片字段、hook、旧版开关；没人列过旧代码做过的事 |
| 修复改变了启动顺序 | #3471，被 #3486 撤回 | 把初始化推迟以后，启动顺序变了 |
| 输出格式变化 | #3146 | 无界面模式的事件输出变了，没写 changelog |
| 悄悄批准 | #3888 | 配了 hook 时审批面板不显示，待审批的调用被悄悄批准 |
| 安全收紧带出问题 | #3964，#4013 回滚 | 符号链接路径、`required = true` 的 filter、没有信任入口的 print 和 ACP、`~` 开头的条目，四处都悄悄失败；PR 没写会影响谁 |
