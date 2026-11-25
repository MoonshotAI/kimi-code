# 仓库级 Agent 指南

用和用户相同的语言回复。

这是一个为 agent 协作开发构建的 TypeScript monorepo。根目录的 `AGENTS.md` 只放热路径规则：项目地图、硬约束和工作流要求，也就是每个任务都需要知道的东西。

## 工作原则

- 用第一性原理思考：从真实需求、代码事实和验证结果出发；目标不清楚时，先和用户讨论。
- 从代码确认当前行为。除非用户明确要求，或各级 `AGENTS.md` 指向了特定设计文档，否则不要为理解实现去读一般的 Markdown。文档与代码冲突时，先核对需求和已发布的契约。实现违反契约就修实现，文档确已过时就随改动更正。
- 改代码之前，先读相关代码和最新的约束，并遵守目录树里离改动最近的 `AGENTS.md`。
- 改动保持聚焦，不要顺手夹带无关的重构。
- 提交时不要加任何 co-author 署名；也不要在提交说明、PR 描述或任何说明文字里透露 agent 的身份。

## 项目地图

- `apps/kimi-code`：CLI / TUI 应用，TUI 主路径通过 `@moonshot-ai/kimi-code-sdk` 使用核心能力。
- `apps/desktop`：Electron 桌面应用，与浏览器 Web UI 共用 `apps/desktop/src/renderer`；Web 产物在 CLI 构建时同步，见 `apps/kimi-code/AGENTS.md`。
- `apps/vis`、`apps/vis/server`、`apps/vis/web`：会话和回放的可视化调试工具。
- `apps/vscode`：VS Code 扩展。
- `docs`：用户文档站（VitePress），中文和英文页面分别在 `docs/zh/` 和 `docs/en/`。
- `packages/agent-core-v2`：DI × Scope 的 agent 引擎（kap-server 背后的 v2 移植版），包括 `src/remote` 下的远程执行栈。
- `packages/core`：不依赖 DI 的 Loop、LLM、工具和 Store 运行时；LLM 模块的设计指南是 `packages/agent-core-v2/docs/en/llm.md`。
- `packages/node-sdk`：公开的 TypeScript SDK 和 harness。
- `packages/oauth`：Kimi OAuth 和托管认证工具。
- `packages/telemetry`：共享的客户端遥测基础设施。
- `packages/session-import`：把外部会话转换成一条用户消息的独立 Node.js 模块，不依赖引擎或 UI；调用方提供目标会话的附件目录和上下文预算。
- `packages/kap-server`：Kimi Code 服务端，基于 `@moonshot-ai/agent-core-v2`，通过 REST（`/api/v1`）和 WebSocket（`/api/v1/ws`）对外提供 Kimi Agent Protocol（KAP），详见 `packages/kap-server/AGENTS.md` 和 `packages/kap-server/docs/kap.md`。内部反射 RPC 接口 `/api/v1/debug/*` 只在打开 `--debug-endpoints` 且服务绑定回环地址时启用，并要求 bearer 认证。
- `packages/remote-control`：Kimi Remote Control 隧道客户端，把本机注册到中继并转发本地服务的流量，带全机范围的单实例锁；由 kap-server（`/api/v1/remote-control` 开关）和 CLI（`kimi web --remote-control`）使用。
- `packages/klient`：客户端 SDK，以契约驱动的 agent-core-v2 门面，按子路径（`@moonshot-ai/klient/ipc|memory`）选择传输方式；e2e 测试套件也放在这里。
- `packages/tree-sitter-bash`：纯 TypeScript 的 bash 解析器，只负责解析，不做安全判断；调用方必须把中止或 `hasError` 的语法树当作「无法分析」并降级处理，和 tree-sitter-bash 原版的差异见该包 README 的「Known differences from tree-sitter-bash」一节。
- `packages/minidb`：kap-server 搜索索引背后的嵌入式 JSON 文档库（`MiniDb`）。
- `packages/app-core`：桌面端和 Web 端共用的 KAP 客户端与会话逻辑。
- `packages/app-client`：渲染端的状态、面板与 Vue 组合式函数。
- `packages/app-components`：聊天、设置等产品界面组件。
- `packages/app-composer`：消息编辑器及其输入与发送逻辑。
- `packages/app-i18n`：渲染端的本地化资源。
- `packages/app-markdown`：Markdown 渲染。
- `packages/app-ui`：基础界面组件与样式。
- `packages/vite-preset`：共享的 Vite 构建配置。
- `packages/acp-server`：Agent Client Protocol（ACP）宿主，直接基于 agent-core-v2。
- `packages/product`：客户端和宿主共用的 Kimi Code 产品逻辑。
- `packages/migration-legacy`：把 kimi-cli 的数据（`~/.kimi/`）迁移到 kimi-code（`~/.kimi-code/`）。
- `packages/pi-tui`：终端 UI 库，从上游 `earendil-works/pi` 的 `packages/tui` 引入的 fork。
- `packages/testkit`：假模型与 KAP 夹具。
- `tests/scenarios`：真实 KAP 场景测试。
- `tests/e2e`：新 E2E，同一个场景在 TUI、Web、Desktop、ACP 四个面上跑，只用 testkit 的假模型和夹具。

## 结束前的验证

结束任何代码改动之前，必须运行 `pnpm lint`；类型检查和测试，按改动涉及的范围从下表里选。

| 检查 | 命令 | 说明 |
|---|---|---|
| lint 和仓库检查 | `pnpm lint` | 必须以 0 退出。它会运行注释检查、oxlint、agent-core-v2 的导入边界检查，以及 `scripts/checks/` 里的守卫、棘轮和说明文件检查。如果报错出现在你没碰过的代码里，先运行 `pnpm install` 再试：安装的依赖比 lockfile 旧时，类型感知规则会报出并不存在的错误 |
| 单个项目的类型检查 | `pnpm exec tsc -p <目录>/tsconfig.json --noEmit` | CI 单独检查 CLI 和各包，`packages/app-*` 随桌面端由 `pnpm --filter kimi-code-app run typecheck` 检查。`pnpm typecheck` 会先构建各库 |
| 受影响的测试 | `pnpm exec vitest run --reporter=agent <文件或目录>` | 只输出失败。不要默认跑全量 |
| minidb | `pnpm --filter @moonshot-ai/minidb test` | 不在根目录的测试里，CI 也不跑 |
| pi-tui | `pnpm --filter @moonshot-ai/pi-tui test` | 用的是 `node --test` |

- 修 bug 要带修复前会失败的回归测试。选择能稳定复现故障、观察到对应契约的最小边界。模块公开接口能复现时就测该接口。跨层故障从真实入口验证，例如 kap-server、klient 一致性测试（`packages/klient/test/helpers/conformance.ts`）或 TUI 虚拟终端（`packages/pi-tui/test/virtual-terminal.ts`）。覆盖同一 bug 的其他触发方式。
- 常规 PR 测试运行在 Linux。涉及桌面端等特定路径时还跑 Windows 专项测试。改动涉及路径、子进程、shell 或终端输入时，在 PR 里写明在哪些平台核对过、怎么核对的。
- 只汇报你实际运行过的命令和结果。某项检查没法运行，就写「未验证」和原因；不要把已有的失败写成通过。

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
- `scripts/check-nix-workspace.mjs` 只校验 `@moonshot-ai/kimi-code` 的传递依赖闭包。即使检查通过，也要手动核对闭包外的包。

## 通用编码规则

- JS/TS 代码里不写注释。`pnpm lint`（`scripts/check-comments.mjs`）会拒绝所有注释，只放行工具指令（`@ts-*`、`oxlint-`/`eslint-` 禁用指令、`prettier-ignore` 等）、shebang、`/// <reference>`，以及 JS 文件里只有一个标签的 JSDoc `@type` 类型断言。用命名、类型和结构表达代码在做什么；要表达一条约束，就把它变成类型、测试或 lint 规则，而不是写一段注释。
- `.commentignore`（gitignore 语法）里列出的路径不受这项检查约束。除非用户要求，不要动这些文件里现有的注释；只有用户要求时，才往 `.commentignore` 里加条目。
- 可选的对象属性，类型里不需要再额外允许 `undefined`。
  - 是：`interface Options { user?: User }`
  - 否：`interface Options { user?: User | undefined }`
- 只有一个参数的内部方法，不要为了风格统一改成 options 对象。
- 只按抽象层级拆分函数：每个函数读起来是同一个层级的叙述（Step-down Rule）；不增加新抽象层级的包装函数，尤其是只有一个调用点的，应该内联而不是抽出来。
- 除了包自己的 `index.ts`，其他 `index.ts` 优先写成 `export * from './module';`。
- 除非用户明确要求，不要为了对外兼容牺牲代码质量。但行为不能悄悄改变：每项行为变化都写进 PR 的行为变化表；破坏性改动走 changeset 并升 `major`；写 `major` 之前，先停下来等用户确认（见「工作流要求」里的 changeset 规则）。

## 测试

- 先读[测试指南](tests/AGENTS.md)，模块内无合适测试文件时才新建。
- 测试失败时，先从 issue、需求规格或已发布的契约确认预期，再定位故障。不要照抄当前输出作为期望值。
  - 需求有意改变行为时，同步更新实现、断言和相关文档，并填入 PR 的行为变化表。
  - 实现违反契约就修实现。夹具、工具或运行环境出错，就修正对应环节再验证。
  - 如果怀疑旧断言本身有误，在 PR 里列出疑点及契约依据。不要为了本次改动通过而改断言。
- 不许靠削弱断言、删测、用 sleep 或超时同步、重试到通过或不看 diff 就重写快照来让测试通过。在 lint 覆盖的 Vitest 文件中，`.only` 会报错，禁用测试的违规数（含 `.skip`）按文件冻结。pi-tui 和 `.mjs` 的 `node:test` 用例靠评审检查。
- flaky 测试也一样不许跳过、加 sleep 或重试：先找根因并修掉。找不到根因时可以删掉它，这是唯一允许删除失败测试的情况。
- 改写、移植或搬家删掉了测试时，把它的断言搬到新的代码路径上，除非是有意去掉这个行为。
- 删测时在 PR 里写明用例、原有覆盖、删除原因，以及哪个用例继续验证该契约。如果这是最后一处覆盖，明确列出会失去的保障，由维护者决定是否接受。
- 修改或删除守护契约文件（见「代码评审规则」）的测试或快照之前，先停下来问用户。
- 同一个失败修了三次还没过，就停下来，汇报试过什么、怀疑什么。推送之后，CI 失败最多修两轮；还不过，就停下来交给人。

## 改行为之前

- 移植、改写或搬家，不要和行为改动放在同一个 PR 里。
- 新增状态、名单或映射表之前，先找这件事现有的归属，复用它，不要另抄一份。
- 新增事件、消息类型或枚举成员时，更新所有按它分支的地方；`default` 分支不能把它静默吞掉。
- 对照这个仓库里过去的 bug 漏掉过的情形，检查你的改动：
  - 旧版本写入的会话被恢复或回放；
  - 会话进行到一半时服务端或 CLI 重启；
  - 回合进行中到达的事件：后台任务的结果、排队或插话的消息、审批；
  - 工作还在进行时发生取消、撤销或压缩；
  - 两个客户端连着同一个会话；
  - Windows 路径、CRLF 换行、UTF-8 BOM；
  - 无效或不完整的配置：必须报错说明，不能被忽略。
- 开 PR 之前，先用下面的「代码评审规则」检查自己的 diff，并补上它们要求的内容。

## 实验特性

- 还没公开的功能，放在实验开关后面。开关由环境变量驱动，默认关闭：`KIMI_CODE_EXPERIMENTAL_<NAME>` 控制单个开关，`KIMI_CODE_EXPERIMENTAL_FLAG` 打开全部。优先级是：单个开关的环境变量 > 配置里的 `[experimental]` > 总开关环境变量 > 开关的 `default`。正式发布时，把对应条目的 `default` 改成 `true`。
  - `packages/agent-core-v2` 和 kap-server 的模块：没有集中的开关目录。在所属领域里用 `registerFlagDefinition` 在导入时声明开关，再用 `IFlagService.enabled(id)` 检查。

## 技能

技能在 `.agents/skills/` 下。技能的操作细则写在技能里，不要抄进 `AGENTS.md`；「工作流要求」里关于 changeset 的几条是硬约束，有意保留在这里。

| 技能 | 什么时候用 |
|---|---|
| `write-tui` | 编写或修改 `apps/kimi-code/src/tui` 下的终端界面 |
| `write-pr` | 创建或更新 PR 描述 |
| `gen-changesets` | 生成 changeset：判断要不要写、写哪个包、升哪一级、怎么措辞 |
| `gen-docs` | 代码改动影响了产品行为或用户体验，需要更新用户文档时 |
| `translate-docs` | 在 `docs/zh/` 和 `docs/en/` 之间翻译、同步双语文档 |
| `review-pr` | 评审 PR；只在用户明确要求时使用 |
| `review-duplication` | 实现前查找可复用的能力，提 PR 前自查或评审时核对平行实现 |
| `pre-changelog` | 合并发版 PR 前预览 CLI 和桌面端的中文更新日志 |
| `sync-changelog` | 同步 CLI 发布日志到文档站，或为桌面端更新对话框准备双语日志 |

## 说明文件怎么维护

- 代码改动让某份 `AGENTS.md` 写的事实（路径、命令、地图条目）不再成立时，在同一个 PR 里更新它。
- 新增或修改团队流程、经验性规则时，单独提 PR。新接口的契约、随实现生效的架构约束、有明确风险依据的预防措施，在引入它们的同一 PR 中评审。
- 几乎每个任务都需要的规则写进根 `AGENTS.md`，局部规则写进最近的子目录 `AGENTS.md`。
- 项目地图里，每个工作区包写一行，而且只写一行；包的深入说明放在包自己的 `AGENTS.md` 里。
- 如果 lint 规则、测试或脚本能拦住这类错误，就加检查而不是写规则；有检查执行的规则，旁边写明是哪个检查。
- 说明文件的改动要聚焦，并有代码事实支撑。
- 把经验写成团队规则前，确认同类失误至少出现过两次、规则会改变 agent 的做法，并且半年后仍然适用。
- `pnpm lint` 里的 `scripts/checks/instructions.mjs` 会检查：所有 `AGENTS.md` 里的行内链接和反引号里的仓库路径是否存在。指向本仓库之外的路径或构建产物时，把它加进 `scripts/checks/instructions.json` 的 `unresolved`，并写明理由。

## 发布流程

- `main` 上累积 changeset；`release/*` 分支维护 `ci: release packages` PR。合并版本 PR 即授权正式发布，在合并提交的 CI 通过后发布对应版本。普通推送不会发布正式版。
- CLI 发布到 npm 和 GitHub，桌面安装包发布到 GitHub Release，VS Code 扩展发布到扩展市场。CDN 上传和路由需另行审批。迁移和回同步见 `.changeset/README.md`。

## 工作流要求

- 读代码优先用 `rg` / `rg --files`。
- 设计改动时，先遵循现有的边界和局部写法。
- lint 报错要在代码里修。不要为了跑通而加禁用指令、修改 `.oxlintrc.json` 或 `.oxlintrc.ratchet.json`、重写 lint 快照，或者调高 `scripts/checks/baselines/` 里的棘轮基线；如果某条规则不适合你的情况，停下来报告。确实需要的禁用指令，要写明规则名，并在 ` -- ` 后面写原因。改 `.oxlintrc.json` 会被 `scripts/checks/guards.mjs` 发现，新增违规会被 `scripts/checks/ratchet.mjs` 拦住；改 `.oxlintrc.ratchet.json` 或基线文件，只能靠评审发现。
- `.oxlintrc.ratchet.json` 里的规则在现有代码中已有违规，按文件冻结在 `scripts/checks/baselines/oxlint-ratchet.json`。新代码不能增加违规；修掉现有违规后，运行 `node scripts/checks/ratchet.mjs --update` 降低基线。
- 不要运行 `pnpm lint:fix`：oxlint 的有些自动修复会改变行为（例如 `unicorn/no-unnecessary-await` 会删掉一个 `await`，后面代码的执行时机就变了）。
- 在公开文本和测试数据里，用中性的占位符（例如 `example.com`、`example.test` 和 `YOUR_API_KEY`）替换真实的内部标识。开 PR 之前，请一个只读 agent 审查 diff，看有没有和具体环境相关的内部标识。
- 创建 PR 时，用 `write-pr` 技能（`.agents/skills/write-pr/SKILL.md`）写 PR 描述。PR 标题必须用 Conventional Commit 格式，例如 `chore: remove legacy format commands`（由 `.github/workflows/pr-title-checker.yml` 检查）。
- AI agent 创建或更新 PR 时，要填写 `.github/pull_request_template.md`：关联相关 issue 或说明问题，再描述改了什么。不要留下占位文字，也不要只给出泛泛的 diff 摘要。
- 不要提交含糊的、AI 生成的 PR 文字。提交 PR 的人类作者必须足够理解这个改动，能讲清代码、边界情况，以及为什么这个做法适合这个仓库。
- 完成任务后、提交 PR 之前，必须运行 `gen-changesets` 技能（见 `.agents/skills/gen-changesets/SKILL.md`），按它的规则在 `.changeset/` 下生成 changeset。
- CLI、桌面端或 VS Code 扩展有用户可感知的变化时，按产品各写一句简短的英文 changeset。库源码改动按技能规则写技术条目，纯文档、测试和忽略包的处理见该技能。
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

以下文件定义跨组件或对外契约：`packages/agent-core-v2/docs/` 下的清单文件（`config-manifest.toml`、`wire-manifest.d.ts`、`state-manifest.d.ts`）、`packages/kap-server/schema/contract.txt`、`packages/kap-server/docs/kap.md`、`packages/node-sdk/src/index.ts`、`packages/agent-core-v2/src/features/externalHooks/`、`packages/acp-server/` 和 `apps/kimi-code/src/cli/`。使用方包括本仓库的桌面端和 Web 端、通过 KAP 驱动核心会话和对话流程的外部 agent 和机器人、VS Code 扩展、Zed 等 ACP 客户端、SDK 用户、hook 脚本，以及解析无界面输出的程序。这些文件变化时，要求 PR 写明有哪些使用方，以及上一个版本的数据和客户端怎样继续正常工作。

### 移植和重构要带上旧路径的功能清单

一个改动替换或绕开现有路径时，要求列出旧路径做过的事（支持的环境变量、回退逻辑、接受的输入），并写明每一项在新路径里的位置。悄悄丢掉的一项是回归，不是清理。

### 静默失败比崩溃更严重

让产品悄悄忽略配置、悄悄批准或跳过某个动作、悄悄丢数据的改动，是最严重的问题：用户收不到任何信号，也就无从报告。
