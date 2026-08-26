# P18 实施：组件 telemetry 走 ProductTracker + provide 纪律清理

> 主计划：`docs/plans/renderer-refactor-plan.md` §4 P18。本文档是执行细化，数据为 2026-08-25（P17 合并后 main `dbba312a`）当日复测。

## 1. 目标

1. 组件层剩余 4 处 desktop-only track 埋点全部改走 `contracts.track` 注入缝（P6 registry 已就绪，web no-op 即现状），P17 已做掉的 3 处（SessionRow / ThinkingBlock / ToolDisclosure）不在本批。
2. 裸字符串 provide key 全部 `InjectionKey<T>` 化（初查 5 个，全量普查后 8 个）。
3. 删除 `KimiWebClientFacadeKey` 死 provide（零 inject 实证）。

与主计划预期的一处修正（见 §2.2）：**本批 4 文件改完 track 后 diff 不归零、均不下沉**——它们的分叉主体是已登记的真实分叉（OpenIn / 终端按钮 / keymap / 内部徽章），track 只占小头。下沉由 P19–P21 的结构性统一承接。

## 2. 当日复测

### 2.1 track 分叉现状

仅 desktop 副本 `import { track } from '…/lib/track'`，web 副本无埋点。改造 = desktop 换 import、web 对**共享代码路径**补上完全相同的调用（web 注册 no-op，行为零变化）——P17 在 SessionRow 上验证过这个模式。**执行修正**：desktop 独有代码路径上的调用不可移植，留在 desktop（见下表「web 镜像」列）。

| 文件 | track 调用点 | 事件 | web 镜像 |
|---|---|---|---|
| `chat/ChatHeader.vue` | 11 处 | `session_menu_action` | 9 处（copyAll / copyFinalSummary / copySessionId / rename / pin·unpin / fork / export / archive / restore）；openChanges / openPr 2 处为 desktop 专属函数（web 模板内联 emit，无对应 handler），留 desktop |
| `chat/ApprovalCard.vue` | 1 处（`act()` 单点） | `approval_decision` | 不可移植：payload 依赖 desktop-only 的 `lib/approvalTelemetry.ts`（`approvalDecisionName`）与 desktop 版 act() 独有的 via / requestId 上下文，留 desktop |
| `UserMenu.vue` | 3 处 | `settings_changed`（theme / language）、`upgrade_clicked` | 3 处全镜像 |
| `Sidebar.vue` | 1 处 | `action_invoked`（searchSessions） | 不可移植：web 无 `onSearchButtonClick` 代码路径，留 desktop |

### 2.2 4 文件 diff 构成（修正主计划「diff 归零随改随下沉」的预期）

| 文件 | 总 diff 行 | 非 track 部分 | 构成 |
|---|---|---|---|
| `chat/ChatHeader.vue` | 86 | ~73 | OpenIn 分叉块（P20 承接）+ 终端按钮分叉块（native-todos 已登记） |
| `chat/ApprovalCard.vue` | 71 | ~66 | iOS 视口修复等一端独有逻辑（主计划 §2 已载 106 行口径的残余） |
| `UserMenu.vue` | 23 | ~19 | 快捷键 Kbd 提示（desktop keymap，web 不同步）+ internalTest 徽章（desktop Canary 通道） |
| `Sidebar.vue` | 507 | ~504 | statusTab / keymap / backend pill / UpdateIndicator / token 写法（P21 承接） |

结论：track 缝做完后 4 文件**全部留 app 侧**，native-todos 的分叉面登记同步更新（track 不再构成分叉）。

### 2.3 裸 provide key 的 provide / inject 矩阵（8 个——初查 5 个，codex review 后全量普查补 3 个）

| key | provide 方 | inject 方 | 类型 |
|---|---|---|---|
| `pinScroll` | 两端 ConversationPane；包内 SideChatPanel / AgentDetailPanel | 包内 ToolDisclosure / ChatPane / ThinkingBlock / TurnFold / ActivityRun（均带默认 `() => {}`） | `(el: HTMLElement, ms?: number) => void` |
| `resolveImage` | 两端 App.vue（`client.resolveImageUrl`）；包内 FilePreview 转发 | 包内 FilePreview（默认 passthrough）、**app-markdown Markdown.vue** | `(src: string) => Promise<string>`（即 app-core/contracts 的 `ResolveImage`） |
| `resolveAgentTaskId` | 两端 ConversationPane | 包内 AgentTool | `(toolCallId: string) => string \| undefined` |
| `resolveAgentModel`（补） | 两端 ConversationPane | 包内 AgentTool | `(toolCallId: string, agentId?: string) => { display?: string; effort?: string } \| undefined` |
| `resolveAgentTaskState`（补） | 两端 ConversationPane | 包内 AgentTool | `(toolCallId: string, agentId: string \| undefined) => TaskItem['state'] \| undefined` |
| `resolveSwarmMembers`（补） | 两端 App.vue | 包内 SwarmTool | `(toolCallId: string) => SwarmMember[] \| undefined` |
| `modelDisplay` | 两端 App.vue | 两端 ConversationPane；包内 AgentDetailPanel / SwarmTool / SubagentGrid / TasksPane | `(alias: string \| undefined) => string \| undefined` |
| `subagentEffort` | 两端 App.vue | 两端 ConversationPane；包内 AgentDetailPanel / SwarmTool / SubagentGrid / TasksPane | `(effort: string \| undefined) => string \| undefined` |

key 落位：`ResolveImageKey` 放 **app-core/contracts**（与 `ResolveImage` 接口同文件——app-markdown 已依赖 app-client，但 key 与接口同处更内聚，且避免 app-markdown → app-client/contracts 的新 import 面）；其余 7 个放 app-client/contracts。

### 2.4 facade 死 provide 实证

- `KimiWebClientFacadeKey`（`packages/app-core/src/KimiWebClientFacadeKey.ts`，barrel `app-core/src/index.ts:5` 导出）：两端 main.ts 各有一处 `app.provide(...)`，**全仓零 inject**（仅 main.ts 注释提及）。
- `KimiWebClientFacade` 类型本身也零引用——整个文件可删，不只是 key。

## 3. 实施步骤（一个 PR）

### 工作 1：track 缝收尾（4 文件）

1. desktop 4 文件：`import { track } from '…/lib/track'` → `import { track } from '@moonshot-ai/app-client/contracts'`（**全部 16 处调用**，含 desktop 专属路径）。
2. web 镜像共享代码路径的同款调用：ChatHeader 9 处、UserMenu 3 处（锚点匹配移植，调用与 payload 逐字一致）；ApprovalCard / Sidebar 不镜像（原因见 §2.1），web 侧不加 import。
3. 注意：**不可整文件拷贝**——4 文件含 desktop 专属 import（nativeOpenIn / useNativeTerminal / devBackend / useShortcuts / approvalTelemetry 等），拷过去 web 直接编译失败（实施时踩过，已回退改为锚点移植）。
4. 验证目标：4 文件 desktop 侧零 `lib/track` import；web 侧新增调用均为共享路径。

### 工作 2：InjectionKey 化（8 key）

1. `packages/app-core/src/contracts.ts` 新增 `ResolveImageKey`（与 `ResolveImage` 接口同文件）；`packages/app-client/src/contracts.ts` 新增其余 7 个 typed key（contracts 已是 ProductTracker 的家，app-components 与两端 app 都可达）：
   ```ts
   export const PinScrollKey: InjectionKey<(el: HTMLElement, ms?: number) => void> = Symbol('pinScroll');
   export const ResolveImageKey: InjectionKey<ResolveImage> = Symbol('resolveImage'); // app-core/contracts
   export const ResolveAgentTaskIdKey: InjectionKey<(toolCallId: string) => string | undefined> = Symbol('resolveAgentTaskId');
   export const ResolveAgentModelKey: InjectionKey<(toolCallId: string, agentId?: string) => { display?: string; effort?: string } | undefined> = Symbol('resolveAgentModel');
   export const ResolveAgentTaskStateKey: InjectionKey<(toolCallId: string, agentId: string | undefined) => TaskItem['state'] | undefined> = Symbol('resolveAgentTaskState');
   export const ResolveSwarmMembersKey: InjectionKey<(toolCallId: string) => SwarmMember[] | undefined> = Symbol('resolveSwarmMembers');
   export const ModelDisplayKey: InjectionKey<(alias: string | undefined) => string | undefined> = Symbol('modelDisplay');
   export const SubagentEffortKey: InjectionKey<(effort: string | undefined) => string | undefined> = Symbol('subagentEffort');
   ```
2. provide/inject 全部改指 key（约 30 处：两端 App.vue ×4、两端 ConversationPane ×6、包内 SideChatPanel / AgentDetailPanel / FilePreview / ToolDisclosure / AgentTool / ChatPane / ThinkingBlock / TurnFold / ActivityRun / SwarmTool / SubagentGrid / TasksPane、app-markdown Markdown.vue）；inject 的默认值参数保留。
3. 命名沿用 camelCase Symbol 描述（与 KimiWebClientFacadeKey 既有风格一致）；普查方法教训：泛型 inject 的字符串 key 不能用 `inject\([^)]*'key'` 之类的窄模式搜，要按 key 名全仓扫（初查漏了 SwarmTool / SubagentGrid / TasksPane / ChatPane / ThinkingBlock / TurnFold / ActivityRun / Markdown.vue，codex review 兜住）。

### 工作 3：facade 死 provide 删除

1. 两端 `main.ts`：删 `app.provide(KimiWebClientFacadeKey, useKimiWebClient())` 与对应 import / 注释。
2. 删 `packages/app-core/src/KimiWebClientFacadeKey.ts` 与 `app-core/src/index.ts` 的 barrel 行。

### 工作 4：台账

1. `apps/desktop/docs/native-todos.md`：telemetry 条目分叉面清单删除 ChatHeader / ApprovalCard / UserMenu / Sidebar（四个文件的 track 已收口，与 P17 三子并列注明）；Sidebar / ChatHeader / ApprovalCard / UserMenu 条目里「track 埋点」措辞改为「track 已走注入缝（P18）」。
2. 主计划 P18 条目留痕「4 文件不下沉」的修正结论（随本 PR 更新，不等 P35）。

## 4. 验证

- **五件套**：`pnpm test` / `typecheck` / `lint` / `check:style` / `build`。InjectionKey 化是纯类型层改动，typecheck 是主要防线。
- **desktop 埋点冒烟**（P6 同款清单的组件部分）：触发 session_menu_action（copyAll / pin / archive）、approval_decision（审批卡 approve）、settings_changed（UserMenu 切主题）、action_invoked（搜索按钮）、ui_element_toggled（P17 三件回归）——主进程日志 / 常驻 trace 确认事件到达。
- **inject 链路运行时冒烟**（防 key 改错导致 undefined 调用）：transcript 滚动跟随（pinScroll）、AgentTool 子代理任务跳转（resolveAgentTaskId）、dock 任务卡模型名显示（modelDisplay / subagentEffort）、FilePreview 图片渲染（resolveImage）。
- **cmp/grep 留档**：desktop 4 文件零 `lib/track` import 的 grep 输出、web 镜像调用点 diff 摘要贴 PR 描述。

## 5. 风险

- **web 获得 track 调用**（ChatHeader 9 + UserMenu 3，均为共享代码路径）：payload 构造在 web 上也会执行（仅构造对象、随即 no-op），与 P17 三件同款已验证；无 perf 顾虑（对象字面量级别）。desktop 专属路径的调用不移植（payload 依赖不存在的上下文，见 §2.1）。
- **InjectionKey 默认值**：inject 方现有默认值（ToolDisclosure 的 `() => {}`、FilePreview 的 passthrough）原样保留，无 provide 路径行为不变。
- **删除 facade provide**：理论上若有动态 `import()` 的隐藏 inject 会运行时炸——已全仓 grep（含字符串形式 `KimiWebClientFacade`）实证零引用，风险可忽略。
