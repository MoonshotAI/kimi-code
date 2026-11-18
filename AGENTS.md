# 仓库级 Agent 指南

用和用户相同的语言回复。

这是一个为 agent 协作开发构建的 TypeScript monorepo。根目录的 `AGENTS.md` 只放热路径规则：项目地图、硬约束和工作流要求，也就是每个任务都需要知道的东西。

## 工作原则

- 用第一性原理思考：从真实需求、代码事实和验证结果出发；目标不清楚时，先和用户讨论。
- 以代码为准，不以文档为准。除非用户明确要求，否则不要为了理解实现去读一般的 Markdown。
- 改代码之前，先读相关代码和最新的约束，并遵守目录树里离改动最近的 `AGENTS.md`。
- 改动保持聚焦，不要顺手夹带无关的重构。
- 提交时不要加任何 co-author 署名；也不要在提交说明、PR 描述或任何说明文字里透露 agent 的身份。

## 项目地图

- `apps/kimi-code`：CLI / TUI 应用。它通过 `@moonshot-ai/kimi-code-sdk` 使用核心能力，不得直接依赖引擎包。编写或修改它的终端界面时，使用 `write-tui` 技能（`.agents/skills/write-tui/SKILL.md`）。
- 浏览器 Web UI：**源码已经不在本仓库。** 它在 code-app 仓库（`apps/web`）开发，以提交进本仓库的预构建产物 `apps/kimi-code/dist-web` 发布（该目录被 gitignore，需要强制添加），用 `KIMI_CODE_REPO=<本仓库路径> pnpm run sync:web` 从 code-app 同步。只要 Web UI 的发布内容需要变化，就在同一个改动里同步并提交这份产物。`apps/kimi-code/scripts/check-web-assets.mjs` 在打包时检查产物是否缺失。要在本仓库的服务上开发或调试 Web UI，在这里运行 `pnpm dev:server`，再让 code-app 的 `pnpm dev:web` 通过 `KIMI_SERVER_URL` 指向它。
- `apps/vis`、`apps/vis/server`、`apps/vis/web`：会话和回放的可视化调试工具。
- `packages/agent-core-v2`：DI × Scope 的 agent 引擎（kap-server 背后的 v2 移植版）。三个 `LifecycleScope` 层级 `App` / `Session` / `Agent`（`app/scopes.ts`），加上 L3 单元层（`Service`/`Fiber` 单元、集合贡献点、`src/features/` 里的 Feature 接缝）；`WorkspaceInstance`/`Program` 图在运行时通过 `IWorkspaceInstanceManager` 实例化，App 作用域的 `ISessionManager` 通过 `Program` 为每个工作区创建会话控制器。
- `packages/core`：不依赖 DI 的 Loop、LLM 和工具运行时。LLM 文档按读者组织：[使用结果和事件](packages/core/docs/llm/calling.md)、[构建请求](packages/core/docs/llm/building.md)以及[请求契约参考](packages/core/docs/llm/building-reference.md)；先[理解架构](packages/core/docs/llm/maintaining.md)，再按[维护指南](packages/core/docs/llm/maintenance-guide.md)操作。
- `packages/node-sdk`：公开的 TypeScript SDK 和 harness。
- `packages/oauth`：Kimi OAuth 和托管认证工具。
- `packages/telemetry`：共享的客户端遥测基础设施。
- `packages/session-import`：独立的 Node.js 模块，把外部会话转换成一条用户消息，带上对话内容、完整的有效历史附件和图片引用。它不依赖引擎或 UI；调用方提供目标会话的附件目录和上下文预算。
- `packages/kap-server`：Kimi Code 服务端，基于 `@moonshot-ai/agent-core-v2`；通过 REST + WebSocket（`/api/v1` + `/api/v1/ws`）提供会话，另有 `/api/v1/debug/*` 反射 RPC 接口（`--debug-endpoints`；仅在服务绑定回环地址时启用，并要求 bearer 认证）。
- `packages/remote-control`：Kimi Remote Control 隧道客户端：把本机注册到中继，并把 HTTP/WebSocket 流量转发到本地服务，带全机范围的单实例锁；由 kap-server（`/api/v1/remote-control` 开关）和 CLI（`kimi web --remote-control`）使用。
- `packages/agent-core-v2/src/remote`：引擎内部的远程执行栈。本地 `ExecBridge`（ssh/docker/`command` 启动器）和轻量的 `kimi exec-server` 执行器之间，用一套自成一体、按行分帧的 NDJSON RPC 通信（codex exec-server 方言）；另有一个 provider，把声明的目标注册为 `Environment`（fs/process 的 RPC 存根是 `src/os/backends/remote` 下的一个 OS 后端，与 `node-local` 并列）。这套栈导出为 `@moonshot-ai/agent-core-v2/remote` 和 `/remote/server`。执行器保持轻量：`src/remote/server` 只能导入 node 内置模块、相对路径模块、`#/remote/protocol`、`#/os/interface`、`#/_base/execEnv`，以及它所适配的、不依赖 DI 的 node-local fs/process 后端（由该包的 `lint:imports` 检查）；CLI 只通过 SDK 的轻量子路径 `@moonshot-ai/kimi-code-sdk/exec-server` 访问它，在 `src/cli/exec-server.ts` 里动态加载。
- `packages/klient`：客户端 SDK，一层以契约驱动的 agent-core-v2 门面（`global.*` / `session(id).*` / `agent(id).*`，用 zod 校验）；按子路径入口选择传输方式（`@moonshot-ai/klient/ipc|memory`，两者返回的都是同一种 `Klient`）；e2e 测试套件也放在这里。见 `packages/klient/AGENTS.md`。
- `packages/tree-sitter-bash`：纯 TypeScript 的 bash 解析器（没有运行时依赖，不用 wasm）；`parse(source, { timeoutMs, maxNodes })` 在确定的预算内运行，返回可辨识联合类型的 `ParseResult`。调用方必须把中止或 `hasError` 的语法树当作「无法分析」并降级处理。它只负责解析，不做安全判断；见该包 README 的「Known differences」一节。
- `packages/minidb`：kap-server 搜索索引背后的嵌入式 JSON 文档库（`MiniDb`）：快照 + WAL 持久化（带独占写锁）、支持超出内存数据量的全文检索层，以及持久化的索引代际。见 `packages/minidb/AGENTS.md`。

## 环境要求

- **Node.js**：`>=24.15.0`（来自根 `package.json` 的 `engines`；`.nvmrc` 是 `24.15.0`，nvm / fnm / mise 用它选择推荐的最低版本）。
- **pnpm**：`10.33.0`（来自根 `package.json` 的 `packageManager`）。
- Node 版本不满足时，`pnpm install` 会失败，因为 `.npmrc` 设置了 `engine-strict=true`。

## Monorepo 工作区维护

- `pnpm-workspace.yaml` 是工作区成员的唯一依据，但 `flake.nix` 里也有**硬编码**的 `workspacePaths` 和 `workspaceNames` 列表。
- **每次新增或删除工作区包，都必须同时更新 `pnpm-workspace.yaml` 和 `flake.nix`。每个包都要更新，包括没有被任何包依赖的叶子包、测试包和 e2e 包。**
  - `pnpm-workspace.yaml` 用通配符（`packages/*`、`apps/*`），大多数包会自动加入；`flake.nix` 完全是手写的，遗漏都出在这里。
  - `flake.nix` 的 `workspacePaths` 漏了路径，Nix 构建的 `src` 文件集会静默丢掉这些文件。
  - `flake.nix` 的 `workspaceNames` 漏了名字，`pnpmConfigHook` 会失败，因为这个工作区的依赖不会被拉取。
- 自动检查「Check flake.nix workspace sync」（`scripts/check-nix-workspace.mjs`）只校验 **`@moonshot-ai/kimi-code` 的传递依赖闭包**。闭包之外的叶子包（例如没人导入的 e2e 包），即使没写进 `flake.nix` 也不会被发现。所以检查通过**不能**证明 `flake.nix` 完全同步。每次增删包都要手动更新，不要指望检查替你发现遗漏。

## 通用编码规则

- JS/TS 代码里不写注释。`pnpm lint`（`scripts/check-comments.mjs`）会拒绝所有注释，只放行工具指令（`@ts-*`、`oxlint-`/`eslint-` 禁用指令、`prettier-ignore` 等）、shebang、`/// <reference>`，以及 JS 文件里只有一个标签的 JSDoc `@type` 类型断言。用命名、类型和结构表达代码在做什么；要表达一条约束，就把它变成类型、测试或 lint 规则，而不是写一段注释。
- `.commentignore`（gitignore 语法）里列出的路径不受这项检查约束。除非用户要求，不要动这些文件里现有的注释；只有用户要求时，才往 `.commentignore` 里加条目。
- 可选的对象属性，直接传 `undefined`，不要用条件展开。
  - 是：`{ user }`
  - 否：`{ ...(user ? { user } : undefined) }`
- 可选的对象属性，类型里不需要再额外允许 `undefined`。
  - 是：`interface Options { user?: User }`
  - 否：`interface Options { user?: User | undefined }`
- 只有一个参数的内部方法，不要为了风格统一改成 options 对象。
- 只按抽象层级拆分函数：每个函数读起来是同一个层级的叙述（Step-down Rule）；不增加新抽象层级的包装函数，尤其是只有一个调用点的，应该内联而不是抽出来。
- 除了包自己的 `index.ts`，其他 `index.ts` 优先写成 `export * from './module';`。
- 不要新增太多测试文件。优先把测试加到对应组件或模块已有的测试文件里。
- 测试因为用户的修改而失败时，默认先修测试；除非实现确实有 bug，否则不要为了满足旧测试而改实现。
- 除非用户明确要求，不要为了对外兼容牺牲代码质量。破坏性改动走 changeset 和 `major` 版本升级，受下文「工作流要求」里关于 `major` 的规则约束。

## 实验特性

- 还没公开的功能，放在实验开关后面。开关由环境变量驱动，默认关闭：`KIMI_CODE_EXPERIMENTAL_<NAME>` 控制单个开关，`KIMI_CODE_EXPERIMENTAL_FLAG` 打开全部。优先级是：单个开关的环境变量 > 配置里的 `[experimental]` > 总开关环境变量 > 开关的 `default`。正式发布时，把对应条目的 `default` 改成 `true`。
  - `packages/agent-core-v2` 和 kap-server 的模块：没有集中的开关目录。在所属领域里用 `registerFlagDefinition` 在导入时声明开关，再用 `IFlagService.enabled(id)` 检查。

## 在哪里更新说明

- 几乎影响每个任务的硬规则：更新根目录的 `AGENTS.md`。
- 只影响某个目录的规则：更新离它最近的子目录 `AGENTS.md`。
- 项目地图的条目保持一到两句；包的深入说明放在包自己的 `AGENTS.md` 里。
- 说明文件的更新要聚焦，并有代码事实支撑。

## 发布流程

- `main` 上累积 changeset；`release/*` 分支维护 `ci: release packages` PR。合并对应的版本 PR 即授权发布，发布在它的合并提交 CI 成功后进行。普通推送不会发布。
- npm 发布和原生产物沿用现有的 Changesets 流程。CDN 上传和路由仍需另行审批。迁移以及与 main 同步的说明见 `.changeset/README.md`。

## 工作流要求

- 读代码优先用 `rg` / `rg --files`。
- 设计改动时，先遵循现有的边界和局部写法。
- 完成任何代码改动之前，运行 `pnpm lint`，它必须以 0 退出。它会运行注释检查、oxlint、agent-core-v2 的导入边界检查，以及 `scripts/checks/` 里的守卫和棘轮。如果报错出现在你没碰过的代码里，先运行 `pnpm install` 再跑一次 lint：安装的依赖比 lockfile 旧时，类型感知规则会报出并不存在的错误。
- lint 报错要在代码里修。不要为了跑通而加禁用指令、修改 `.oxlintrc.json` 或 `.oxlintrc.ratchet.json`、重写 lint 快照，或者调高 `scripts/checks/baselines/` 里的棘轮基线；如果某条规则不适合你的情况，停下来报告。确实需要的禁用指令，要写明规则名，并在 ` -- ` 后面写原因。
- `.oxlintrc.ratchet.json` 里的规则在现有代码中已有违规，按文件冻结在 `scripts/checks/baselines/oxlint-ratchet.json`。新代码不能增加违规；修掉现有违规后，运行 `node scripts/checks/ratchet.mjs --update` 降低基线。
- 不要运行 `pnpm lint:fix`：oxlint 的有些自动修复会改变行为（例如 `unicorn/no-unnecessary-await` 会删掉一个 `await`，后面代码的执行时机就变了）。
- 在公开文本和测试数据里，用中性的占位符（例如 `example.com`、`example.test` 和 `YOUR_API_KEY`）替换真实的内部标识。开 PR 之前，请一个只读 agent 审查 diff，看有没有和具体环境相关的内部标识。
- 创建 PR 时，用 `write-pr` 技能（`.agents/skills/write-pr/SKILL.md`）写 PR 描述。PR 标题必须用 Conventional Commit 格式，例如 `chore: remove legacy format commands`。
- AI agent 创建或更新 PR 时，要填写 `.github/pull_request_template.md`：关联相关 issue 或说明问题，再描述改了什么。不要留下占位文字，也不要只给出泛泛的 diff 摘要。
- 不要提交含糊的、AI 生成的 PR 文字。提交 PR 的人类作者必须足够理解这个改动，能讲清代码、边界情况，以及为什么这个做法适合这个仓库。
- 完成任务后、提交 PR 之前，必须运行 `gen-changesets` 技能（见 `.agents/skills/gen-changesets/SKILL.md`），按它的规则在 `.changeset/` 下生成 changeset。
- changeset 必须严格遵守 `.agents/skills/gen-changesets/SKILL.md` 的规则：只写一句简短的、面向用户的话，只说明改了什么；用户感知不到的改动不写 changeset。
- 生成 changeset 时，**绝不**自行决定 `major` 版本升级：先停下来说明理由，得到用户明确确认后再做；默认用 `minor`，其次用 `patch`。见 `.agents/skills/gen-changesets/SKILL.md`。
- 导入优先用 `import ... from '#/...'`，它和 `import ... from '@/...'` 的作用相同。
- 不要提交临时的草稿或探索性文件。永远不要暂存：
  - agent 的工作笔记，或交接、总结文档（例如 `HANDOVER-*.md`、`HANDOFF-*.md`、`handoff.md`）。
  - 临时的 UI/UX 原型或设计稿（例如仓库根目录或 `design/` 目录下的 `*-designs.html`、`*-mockup.html`、`*-demo(s).html`）。唯一应该被跟踪的 `.html` 文件，是 Vite 的 `index.html` 入口。

  提交或开 PR 之前，运行 `git status` 和 `git diff --staged --stat`，把符合这些模式的文件从暂存区和这次提交里移除。草稿放在 `.tmp/`（已 gitignore），不要放在仓库根目录或源码树里。

## 代码评审规则

这些规则适用于每一次 PR 评审，自动评审和人工评审都一样。规则里提到的用户人群和契约文件，列在 `.agents/skills/review-pr/surfaces.md` 里。

### 评审范围：PR 的 diff，而不是整个仓库

- 只评审 PR 相对于 base 的 diff。PR 没有碰到的代码里的问题（base 上原本就有的），只能作为非阻塞的备注提出，不能作为阻塞问题；唯一的例外是 PR 的行为直接触发或放大了的既有代码。
- 一类问题一次报全：一个问题在 diff 里出现在多处时，一次列出所有位置，不要分好几轮提。
- 不提纯风格或个人偏好的问题。每个问题都要标严重程度：P0 阻塞 / P1 应该修 / P2 建议。
- 复审是增量的：只看上次评审之后改动的部分；不要重复针对没改动代码的问题，也不要重新提出已解决的讨论。把已解决的讨论当作定论之前，先核实当前代码：只有问题确实修好了、或者问题已不成立时，才不再报。
- 各领域的规则有各自的正式归属：changeset（`.agents/skills/gen-changesets/SKILL.md`）、注释（「通用编码规则」）、PR 文字（`write-pr` 技能）。按这些归属评审，不要按临时的个人口味评审。

### 列出改变了的行为，而不只是找 bug

改动之前能正常工作的任何输入，都必须在改动之后表现一致，除非 PR 声明了这项变化。这些输入包括：配置项、环境变量、CLI 参数、模型服务返回的结构、旧版本写入的会话、客户端请求、hook 载荷。对每一个被删除或收窄的分支、条件、默认值或提示词句子，问：以前谁会走到这里，现在他们去了哪里。对每一个新增的条件，问：哪些现有输入会先匹配上它。PR 声称某条路径「没变」，而它的分支条件其实移动了，要指出来。

### 翻转默认值或删除行为，必须说明损失并提供逃生口

所有使用旧默认值的人都会受影响。要求做到三件事：changeset 写明用户失去的行为，而不只是新的默认值；提供配置、环境变量或开关形式的逃生口，或者在 PR 里有维护者的明确签字；有一个测试，为仍然使用旧行为的人群固定住旧行为。

### 提示词文本就是行为

编辑或删除 `packages/agent-core-v2/src/**/*.md` 下的句子（系统提示词、工具描述、提醒、覆盖层、内置技能），会改变所有收到这段提示词的用户的 agent 行为。「没有测试引用这句话」不能证明没有影响。要求 PR 写明：哪些人群会收到这段文本（每个会话、plan 模式、Tower 这类由开关控制的功能）、这句话原来约束了什么、谁依赖它、现在由什么来约束。

### 契约文件是绊线

这些文件会被仓库之外的使用方消费：`packages/agent-core-v2/docs/` 下的清单文件（`config-manifest.toml`、`wire-manifest.d.ts`、`state-manifest.d.ts`）、`packages/kap-server/test/__snapshots__/apiSurface.snapshot.test.ts.snap`、`packages/node-sdk/src/index.ts`、`packages/agent-core-v2/src/features/externalHooks/`、`packages/acp-server/` 和 `apps/kimi-code/src/cli/`。使用方包括 code-app 里的桌面端和 Web 端、VS Code 扩展、Zed 等 ACP 客户端、SDK 用户、hook 脚本，以及解析无界面输出的程序。这些文件变化时，要求 PR 写明有哪些使用方，以及上一个版本的数据和客户端怎样继续正常工作。

### 移植和重构要带上旧路径的功能清单

一个改动替换或绕开现有路径时，要求列出旧路径做过的事（支持的环境变量、回退逻辑、接受的输入），并写明每一项在新路径里的位置。悄悄丢掉的一项是回归，不是清理。

### 静默失败比崩溃更严重

让产品悄悄忽略配置、悄悄批准或跳过某个动作、悄悄丢数据的改动，是最严重的问题：用户收不到任何信号，也就无从报告。
