# 人群与 surface 清单

`review-pr` 第三遍用的仓库专属清单：谁在依赖现有行为，diff 里碰到什么就必须列行为变化。它会过时，每次回归复盘后补一行，见 `SKILL.md` 的"复盘回填"。

## 一、人群：谁在依赖现有行为

### 客户端与入口

| 人群 | 说明 | 契约位置 |
|---|---|---|
| TUI 交互用户 | `kimi` 默认入口 | `apps/kimi-code/src/tui/` |
| print 模式用户 | `kimi -p`，含解析 `--output-format stream-json` 输出的脚本。脚本解析者算二等人群，但输出格式变化必须写进 changeset（#3146） | `apps/kimi-code/src/cli/options.ts` |
| desktop 与 web 用户 | 源码在 code-app 仓库，只消费 kap-server 的 `/api/v1` REST 与 `/api/v1/ws`。本仓 diff 看不到它们的用法，改契约时必须点名让作者去对方仓库核对 | `packages/kap-server/src/routes/`、`packages/kap-server/src/transport/ws/`、`docs/en/reference/server-api.md` |
| VS Code 扩展用户 | 走 SDK 事件适配层，webview 有自己的渲染契约（#3250：v2 不再发 `display` 字段导致卡片空白） | `apps/vscode/` |
| ACP 客户端用户 | Zed 等，`kimi acp`。stdio MCP 是 ACP 的默认传输，客户端会无条件发（#3167）；能力矩阵是公开承诺（#3081） | `packages/acp-server/`、`docs/en/reference/kimi-acp.md` |
| SDK 调用方 | `@moonshot-ai/kimi-code-sdk` 的导出面；其中 `KimiForCodingProvider` 走 kosong 的 provider 实现，CLI 与服务端不用 kosong | `packages/node-sdk/src/index.ts`、`packages/node-sdk/package.json` 的 `exports`、`packages/kosong/src/providers/` |
| 远程控制用户 | `kimi web --remote-control`，凭据槽位与 relay 按登录区域选择（#3969） | `packages/remote-control/` |

### provider 方言

| 人群 | 说明 |
|---|---|
| Kimi 官方 | 默认路径，OAuth 托管登录，区域与 relay 差异 |
| `openai` Chat Completions 兼容网关 | 最杂的一群：new-api 等中转、OpenRouter 形态（`reasoning` 字符串与 `reasoning_details` 数组并存，#3900）、只发 `reasoning_content` 的、严格校验历史消息的（#2819）、第三方模型对 `anyOf` 参数的处理（#3383） |
| `anthropic`、`openai_responses`、`google-genai`、`vertexai` | 各自的 thinking、工具调用、usage 字段形态 |
| 自定义模型配置 | `api_key_env`、models.dev catalog 导入、手动配置的 thinking 参数（#3448）、`[secondary_model]` 与 subagent model pool（#3192、#3903） |

代码位置：`packages/agent-core-v2/src/human/llm/requester/bases/`。

### 平台与环境

| 人群 | 已知敏感点 |
|---|---|
| Windows | 深路径与递归监听压力（#3931 的动机）、驱动器根与 UNC（#2876）、IME 组合输入（#3915）、CSI-u 键盘序列 |
| Linux | 无 hardlink 的文件系统（#3535）、根目录海量文件导致的 OOM（#3892） |
| macOS | 默认开发环境，最容易被当成"全体用户" |
| 网络代理 | 后台子 agent 重试（#3721） |
| native 二进制 vs npm 安装 | 启动路径、更新机制不同 |
| 安装渠道 | npm 包、各平台 native 二进制、VS Code 市场包、内置 web 产物，由发布与打包工作流决定，`src/` 一行不动也能丢掉一个平台 |

### git 仓库形态

| 人群 | 已知敏感点 | 契约位置 |
|---|---|---|
| 子模块或 worktree 内启动的用户 | `core.worktree` 已设置；路径含符号链接时（macOS `/tmp`、链接的 home、Windows 映射盘）realpath 与字面路径不一致。#3964 的 git 探针在这里整体失败，已随 #4013 回滚 | `packages/agent-core-v2/src/app/git/gitService.ts` |
| git-lfs、git-crypt 用户 | `.git/config` 里的 filter 驱动带 `required = true`；任何"清空 filter 命令"的加固都会让 `git status` 对已修改的被过滤文件直接 fatal，除非同时清 `required`。#3964 踩过，已随 #4013 回滚 | 同上 |
| 大仓库用户 | 依赖 `core.fsmonitor`；footer 的后台 git 有超时预算，超时后静默当作 clean | `apps/kimi-code/src/utils/git/` |
| 要求签名提交或 husky hooks 的仓库 | 任何自动提交路径（Tower 等）关闭 hooks 或签名都会改变提交结果 | `packages/agent-core-v2/src/features/tower/` |

### 配置状态

| 人群 | 说明 | 契约位置 |
|---|---|---|
| 默认配置用户 | 任何默认值翻转对他们都是行为变更 | `packages/agent-core-v2/docs/config-manifest.toml` |
| experimental flag 用户 | `[experimental]` 与 `KIMI_CODE_EXPERIMENTAL_*`；flag 的 `default` 翻成 true 等于面向全体发布 | `packages/agent-core-v2/src/app/flag/flagRegistry.ts`、各域的 `flag.ts` |
| legacy flag 用户 | `KIMI_CODE_LEGACY_FLAG`（#3820：TUI 与 print 模式静默忽略） | |
| 自定义 agent 用户 | `--agent` 的 `disallowedTools` 等策略（#3417） | |
| 配了 hooks 的用户 | 事件名与载荷是外部脚本的契约；配了 hook 时审批面板不渲染并被静默批准（#3888）、v2 不触发 PreToolUse（#3431） | `packages/agent-core-v2/src/features/externalHooks/internal/types.ts`、`docs/en/customization/hooks.md` |
| skills、plugins、MCP 用户 | 含 stdio MCP、用户级 skill 根目录、`[watch]` 热加载（#3931 关掉默认，#4015 翻回；关掉时连带 AGENTS.md 变更提醒失效，`/reload` 只覆盖 config 与 skills） | `docs/en/customization/` |
| 环境变量用户 | 同一个变量在 TUI、print 模式、kap-server 三个入口要行为一致（#3498：三个入口两种行为） | `docs/en/configuration/env-vars.md` |
| 主题、键位、TUI 模式自定义用户 | `tui.toml` | `docs/en/customization/themes.md`、`docs/en/reference/keyboard.md` |

### 数据年代

| 人群 | 说明 | 契约位置 |
|---|---|---|
| 旧版本写的会话 | wire 日志、turn 编号、压缩后的 transcript（#3561、#3866、#3922）；新版本能否读、回滚后能否读 | `packages/agent-core-v2/docs/wire-manifest.d.ts`、`packages/agent-core-v2/docs/state-manifest.d.ts` |
| `kimi migrate` 迁来的会话 | 从 `~/.kimi/` 迁到 `~/.kimi-code/` | `packages/migration-legacy/` |
| 搜索索引 | minidb 快照与 WAL | `packages/minidb/` |
| 后台任务与 cron 持久化 | 非正常退出后的恢复（#3924） | |
| 目录布局 | 任何读写 `~/.kimi-code/` 的代码 | `docs/en/configuration/data-locations.md` |

### 外部自动化

| 人群 | 契约 |
|---|---|
| 解析 `stream-json` 的脚本 | 事件形态与顺序 |
| hook 脚本 | 事件名、载荷字段、返回值语义 |
| `kimi export` 的消费者 | 导出格式 |
| 关闭遥测的用户 | `KIMI_DISABLE_TELEMETRY` 在所有入口生效 |

### 模型行为人群

prompt 文本改动影响全体用户，且没有测试能证明"无影响"。已知依赖具体句子的人群：

- 依赖"不碰工作目录外文件"的（#3879 删除了这条规则）。
- 依赖"cwd 即项目根"的（#3929 删除了这条断言）。
- plan 模式提醒节奏（#3489）。

基于外部基准分析做的 prompt 改动，本质是把一个人群的收益换成另一个人群的损失，必须写明两边各是谁。

## 二、触发线索：diff 里碰到就必须列行为变化

| diff 里出现 | 代表的 surface | 必做的检查 |
|---|---|---|
| `packages/agent-core-v2/src/app/agentProfileCatalog/system.md`，以及 `packages/agent-core-v2/src/**/*.md`（工具描述、提醒、overlay、内置 skill） | 模型行为 | 每删或改一句单独成行：这句改动前约束了什么行为，谁依赖，现在由什么来约束 |
| `packages/agent-core-v2/docs/config-manifest.toml`（由 `src/app/config/configSectionContributions.ts` 生成，`test/app/config/configManifest.test.ts` 守护同步） | 配置键、默认值、校验 | 默认翻转与校验收紧必列；改了 manifest 没改 `docs/en/configuration/config-files.md` 视为文档过时 |
| `packages/agent-core-v2/src/**/flag.ts`、`packages/agent-core-v2/src/app/flag/flagRegistry.ts` | experimental flag | `default` 翻转等于面向全体发布，按行为变更处理 |
| `packages/agent-core-v2/src/human/utils/watch.ts`（热加载开关）以及任何模块级默认常量、`?? true` / `?? false` 兜底被配置键覆盖的地方 | 默认值来源 | 默认翻转必列；退路的 config 路径要有 guard 测试，不能只靠 env；退路是否依赖 ConfigService 先于消费方构造 |
| `packages/agent-core-v2/docs/wire-manifest.d.ts`、`packages/agent-core-v2/docs/state-manifest.d.ts` | 磁盘会话格式 | 旧会话能否读、回滚到上一版能否读、有无迁移 |
| `packages/kap-server/test/__snapshots__/apiSurface.snapshot.test.ts.snap`、`packages/kap-server/src/routes/`、`packages/kap-server/src/transport/ws/` | desktop、web、VS Code 的服务端契约 | 消费方在仓库外，点名让作者去 code-app 核对；上一版客户端连新服务端是否仍可用 |
| `packages/node-sdk/src/index.ts`、`packages/node-sdk/package.json` | SDK 导出面 | 删除或改签名即破坏性变更 |
| `packages/klient/src/` | SDK 与 ACP 下面的客户端门面契约 | 只改 klient 的 PR 碰不到 node-sdk 导出面，按 SDK 调用方与 ACP 客户端两个人群核行为变化 |
| `packages/transcript/src/contract/` | kap-server 发给 desktop、web、VS Code 的 transcript 载荷契约 | 消费方在 code-app，点名让作者去核；上一版客户端能否解析新载荷 |
| `.github/workflows/release.yml`、`_native-build.yml`、`manual-native-bundle.yml`、`vscode-publish.yml`，`apps/kimi-code/scripts/native/`、`apps/kimi-code/scripts/check-web-assets.mjs` | 发布产物 | 按安装方式与平台核：npm 包内容、各平台 native 二进制、VS Code 市场包、内置 web 产物是否仍齐全 |
| `packages/acp-server/` | ACP 客户端 | 对照 `docs/en/reference/kimi-acp.md` 的能力矩阵逐项核对 |
| `apps/kimi-code/src/cli/` | 命令行参数、子命令、`--output-format` | 对照 `docs/en/reference/kimi-command.md` |
| `packages/agent-core-v2/src/features/externalHooks/` | hook 事件与载荷 | 对照 `docs/en/customization/hooks.md` 的事件参考 |
| `packages/agent-core-v2/src/human/llm/requester/bases/` | provider 方言分支 | 枚举每种上游载荷形态改动前后各走哪条分支，尤其是多个字段并存的网关 |
| `packages/agent-core-v2/src/app/git/`、`apps/kimi-code/src/utils/git/` | 后台 git 的调用方式、config 覆盖、超时 | 对照"git 仓库形态"人群逐行核：前置探针失败是否让整个后台 git 静默不可用；覆盖的 config 键是否有 `required`、`gpgSign`、`hooksPath` 这类会把"禁用"变成"失败"的键；Windows 用例是否全部 skip |
| `packages/migration-legacy/`、`packages/minidb/`、任何读写 `~/.kimi-code/` 布局的代码 | 数据年代 | 老数据是否仍可读、可迁移 |
| 任何环境变量读取点的新增、删除或语义变化，不限写法（`process.env.X`、`process.env['X']`、动态键、helper）也不限 `KIMI_` 前缀 | 环境变量 | 对照 `docs/en/configuration/env-vars.md` 的全部条目；TUI、print 模式、kap-server 三个入口是否一致 |
| `packages/agent-core-v2/src/app/scopes.ts`、`packages/agent-core-v2/src/features/featureAssemblyService.ts`、config ready 相关 | 启动顺序与生命周期 | 谁依赖原来的顺序；#3471 在合入 34 分钟后被 #3486 整体 revert |
| `docs/en/**`、`docs/zh/**` 的 reference、configuration、customization 页 | 公开承诺 | 改了行为没改文档，或改了文档没改行为，都要指出 |
| 测试里把旧断言改成新行为 | 行为变化的直接证据 | 逐条对应到行为变化清单 |

## 三、历史案例：用来校准等级

| 类型 | 案例 | 当时漏掉的问题 | 事后等级 |
|---|---|---|---|
| 方言分支收窄 | #3492 引入，#3900 用户报告，#3910 修复 | PR 正文写明"只有没有数组时才读字符串"，没人问谁会两个字段同时发 | L2 无退路，输入被静默丢弃升 L3，openai 兼容网关人群 |
| 默认值翻转 | #3931，五天后 #4015 翻回默认开 | changeset 只写新默认，没写运行中编辑 config、skills、AGENTS.md、agent 文件、mcp.json 不再自动生效；AGENTS.md 变更提醒随之失效，`/reload` 与 `/new` 不重读 AGENTS.md；review 未覆盖行为变化 | L1 有退路，但改了文件不生效也无任何信号，静默升 L2；changeset 没点明失去的行为，config 路径的退路无 guard 测试 |
| prompt 删句子 | #3879、#3929 | "没有测试引用这句"被当成无影响证据 | L2 无退路，全体用户；行为公开可见，不算静默 |
| 重构丢功能 | #2961 引入，#3081、#3167 用户报告，#3183 修复 | 重构删掉了 ACP 本地执行兜底与 stdio MCP 接受，文档承诺仍在 | L3，功能整体不可用，ACP 人群，报错响亮但无退路 |
| 移植漏项 | #3498、#3098、#3250、#3431、#3820 | v1 路径有、v2 路径没有：env 变量、上下文用量、卡片字段、hook、legacy flag；没人列过旧路径功能清单 | L2 无退路，配置被静默忽略升 L3 |
| 修复引入时序变化 | #3471 合入后 34 分钟被 #3486 revert | 延迟装配改变了启动顺序 | 全体用户 |
| 输出契约无声变化 | #3146 | headless 事件输出变了，没有 changelog | L2，脚本解析者 |
| 静默批准 | #3888 | 配了 hook 时审批面板不渲染，待审调用被静默批准 | L3，安全边界 |
| 安全收紧连带 | #3964（2.1.0），两天后 #4013 整体回滚 | 盲审列出四条：后台 git 探针在子模块 + 符号链接路径下整体失败；filter 驱动 `required = true` 仓库 `git status` fatal；print、ACP、SDK 无信任入口导致 `additional_dir` 静默为空；`~` 条目让 local.toml 整文件失效并静默退出。PR 正文未列任何人群 | L3 候选，四条均无退路、changeset 未提；回滚后代码已不在 main |
