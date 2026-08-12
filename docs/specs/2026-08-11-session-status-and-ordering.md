# Session 状态流转与排序规则 spec

> 2026-08-11。本文档是侧栏 session「状态展示 + 排序」的唯一正本：前两章固化现状事实（代码引用为准），第三章是本次新增的状态枚举设计，后四章描述已拍板的改动。改动落地后更新本文档。

## 背景

session 没有单一状态字段，侧栏看到的一切状态都是**多个字段组合派生**的结果；排序也不是单纯的「按更新时间」，而是「server `updated_at` 倒序契约 + 客户端 attention 分层 + 手动序」三套叠加。本次要解决的问题（用户已拍板）：

0. **客户端收敛出单一状态枚举**（本次新增的设计决策）：现状状态是 7 个字段的组合派生，规则散落在 `sessionRowStatus` flags、各 computed、托盘投影里，讨论与测试都没有统一词汇；
1. 改名 / 归档 / 取消归档 / fork 会改变排序（根因：server 对任何 meta 变更都无脑 bump `updated_at`）；
2. 取消归档后会话显示「刚刚」并顶到最上；
3. fork 出来的新会话顶到最上；
4. ~~置顶区是纯手动序，有动静的会话不浮上来~~ → **最终决策（2026-08-11 晚，推翻"两者并存"方案）：全部按时间序，不做注意力分层**——平铺列表撤掉既有 attention 分层，置顶区从手动序改为时间序（拖入置顶/拖出取消保留，区内手动排序随之取消）；

明确**不做**的（已拍板）：待授权/待回答两个 pill 不二合一（枚举里仍是两个独立状态值）；Aborted 标记不加「已查看消失」。~~分组视图组间手动序不动~~ → **2026-08-12 推翻**：组间恢复「手动 / 按最近活动」可选排序（manual 默认），见 `docs/plans/2026-08-12-workspace-recency-sort.md`。

---

## 一、状态模型（现状事实）

### 1.1 事实字段

`AppSession`（`packages/app-core/src/api/types.ts:94`）上没有枚举状态，侧栏状态由以下字段派生：

| 字段 | 含义 | 来源 |
|---|---|---|
| `busy` / `mainTurnActive` | 有活跃 turn（任意 agent / 仅主 agent） | WS `sessionWorkChanged` / `turnActiveChanged`（`eventReducer.ts:428,911`） |
| `pendingInteraction` | `'none' \| 'approval' \| 'question'`，列表级兜底 | server 聚合下发；approval/question 同时挂时 **approval 优先**（v1 `sessionService.ts:147`、v2 `sessionActivityService.ts:187` 同一规则） |
| `approvalsBySession` / `questionsBySession` | 待授权/待回答真实计数（详情加载后接管） | WS `approvalRequested` / `questionRequested` |
| `lastTurnReason` | `'completed' \| 'cancelled' \| 'failed'`，最近一轮主 turn 结局 | server 下发；新 turn 开始时 server 省略该字段即清除（`eventReducer.ts:444` 注释） |
| `unreadBySession` | 未读点 | **纯客户端 localStorage**（`kimi-web.unread`，`storage.ts:109`），server 不知情 |

v2 列表契约的 activity 枚举（`types.ts:150`）：`'running' | 'approval' | 'question' | 'failed' | 'idle'`，与上表同源映射（不含 unread——那是客户端本地位）。

### 1.2 派生规则（`packages/app-core/src/lib/sessionRowStatus.ts:30`，本次收敛为枚举，见第三章）

- **运行中**：`busy` → spinner；有待授权/待回答 pill 时 spinner 让位（平铺行互斥；分组行 lead 槽目前直读 `session.busy`，待办期间 spinner 与 pill 并存——枚举落地时统一，见 3.3）。
- **待授权 / 待回答**：两个独立 Badge（warning "Approve" / info "Answer"），目前可同时存在。
- **异常中断（Aborted）**：`!busy && 无待办交互 && lastTurnReason === 'failed'` → 红色 Badge。**不看已读/未读**，挂上后常驻，直到下一轮新 turn 把它冲掉。用户手动停止（`cancelled`）永不出现该标记。
- **未读点**：仅当「非当前查看会话的主 turn 以 `idle`（正常完成）结束」时点亮（`useKimiWebClient.ts:3500`）；aborted（cancelled/failed/blocked）**刻意不点**（注释：aborted 没有新结果可读）。查看会话时清除（含跨 tab storage 事件同步，`useKimiWebClient.ts:608`）。

### 1.3 状态流转

| 事件 | 结果 |
|---|---|
| 提交 prompt | server `updated_at = now`（`prompt-metadata.ts:70` 走 meta update）；`busy=true` |
| turn 结束（完成） | 客户端本地 bump `updatedAt`；非查看中 → 未读点 + 系统通知 |
| turn 结束（用户中断） | `lastTurnReason='cancelled'`；无未读、无通知、无标记 |
| turn 结束（异常） | `lastTurnReason='failed'`；无未读、无通知；挂 Aborted 标记 |
| 新待授权/待回答 | `pendingInteraction` 更新 + 客户端 bump `updatedAt`（`eventReducer.ts:696,740`）+ 系统通知 |
| 打开/查看会话 | 清未读点；**不清** Aborted 标记 |
| goal 中间轮边界 | 同「turn 结束（完成）」——未读点 + 通知每轮都触发（**本次要修**） |

---

## 二、排序规则（现状事实）

- **server 契约**：`GET /api/v2/sessions` 默认 `meta.updated_at_desc`（`types.ts:188`）；平铺列表不在客户端重排，靠 `flatSessionsFrontier` 保证全局序可信。
- **平铺视图**（`useKimiWebClient.ts` `flatSessionsAll`）：**纯 `updatedAt` 倒序，无注意力分层**（2026-08-11 产品决策，取代 2026-08-05 的"注意力优先"分层）——状态只作为行内标记（pill/spinner/未读点）呈现，永不改变位置。frontier 仍约束哪些池内行可渲染，但有状态的行豁免 frontier（可见性豁免，位置仍由时间戳决定——刚跑起来的会话不能因为页还没翻到就消失）。
- **分组视图**：组内 `updatedAt` 倒序；组间 = 工作区手动拖拽序（`sortByWorkspaceOrder`）。**2026-08-12 更新**：组间新增可选的 recency 序（`sortWorkspacesByRecent`，键 = max(持久化 floor, wire `last_opened_at`)；floor 单调不减，归档/删除锚 session 不重排），manual 仍为默认，见 `docs/plans/2026-08-12-workspace-recency-sort.md`。
- **置顶区**：**纯 `updatedAt` 倒序**（同上决策，取代手动拖拽序）。`pinnedSessionIds` 退化为纯成员集合（localStorage 持久化）；拖拽收窄为「拖入置顶 / 拖出取消」，落点不再携带位置语义。
- **客户端本地 bump 白名单**（`eventReducer.ts:216` `bumpSessionRecency`）：仅 主 turn 开始 / 主 turn 结束 / 新待授权 / 新待回答 / prompt 被 block / 队列 prompt 被 abort；per-step、per-tool-call 不 bump。只前进不后退。
- **快照合并保护**（`useKimiWebClient.ts:1976`）：snapshot 同步时仅当 `!mainTurnActive && server.updatedAt > local.updatedAt` 才采纳 server 值——点开会话不重排侧栏。同理保留的本地字段还有 `model` / `usage`；**`pullRequest` 目前漏了**——它是 v2 `include=git` 列表页专属字段，v1 snapshot 路径恒为 `undefined`，整体铺开 `snap.session` 会把它覆盖丢失（列表路径 `setSessionsPreservingLiveUsage` 已保留，snapshot 路径遗漏），即「点开会话 PR chip 消失」的现行 bug，本次修复（4.2-B）。

### 各操作对排序的影响（问题清单的现实映射）

| 操作 | server 端行为 | 客户端行为 | 现状结果 |
|---|---|---|---|
| 改名 | `setTitle` → meta update 无脑 `updatedAt=now`（`sessionMetadataService.ts:101`） | 本地只 patch title（`useWorkspaceState.ts:2842`） | 当下不动，**刷新/重连后顶到最上** |
| 归档 | `setArchived(true)` → bump（`sessionLifecycleService.ts:426`） | 移出列表 | 归档列表把它当「归档时间」展示（`SettingsDialog.vue:989`） |
| 取消归档 | `setArchived(false)` → bump（`sessionLifecycleService.ts:444`） | `upsertSessionFront`（`useWorkspaceState.ts:3051`） | **顶到最上 + 显示「刚刚」** |
| fork | 新 meta（updatedAt=now）+ `targetMeta.update` 再 bump（`sessionLifecycleService.ts:535`） | `upsertSessionFront`（`useWorkspaceState.ts:3108`） | **顶到最上** |
| 置顶/取消置顶 | 不涉及 server | 只改 `pinnedSessionIds` | 不影响排序 ✓ |
| 删除 | — | 移出列表 | ✓ |

---

## 三、客户端状态枚举（本次新增）

### 3.1 定义

新文件 `packages/app-core/src/lib/sessionDisplayStatus.ts`（**替代** `sessionRowStatus.ts`）：

```ts
export type SessionDisplayStatus =
  | 'awaiting-approval'  // 有待授权：warning pill
  | 'awaiting-question'  // 有待回答：info pill
  | 'running'            // 有活跃 turn 且无待办交互：spinner
  | 'aborted'            // 安静且 lastTurnReason==='failed'：danger pill
  | 'unread'             // 安静、完成未查看：蓝点
  | 'idle';              // 空闲：无标记

export interface SessionDisplayStatusInput {
  busy: boolean;
  unread: boolean;
  questionCount: number;
  approvalCount: number;
  pendingInteraction?: 'none' | 'approval' | 'question';
  lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

export function sessionDisplayStatus(input: SessionDisplayStatusInput): SessionDisplayStatus;
```

`renaming` 不进 input——重命名期间隐藏标记是 UI 局部态，由调用方处理（`renaming ? 'idle' : sessionDisplayStatus(...)`）。

### 3.2 优先级（互斥，自上而下命中即返回）

1. `awaiting-approval`：`approvalCount > 0 || pendingInteraction === 'approval'`
2. `awaiting-question`：`questionCount > 0 || pendingInteraction === 'question'`
3. `running`：`busy`
4. `aborted`：`lastTurnReason === 'failed'`
5. `unread`：`unread`
6. `idle`

要点：

- **approval 优先于 question**：与 server 单值 `pendingInteraction` 的收敛规则严格对齐（v1/v2 两引擎都是 approval 优先，见 1.1）。**行为变化**：现状两个 pill 可同时挂（如主 agent 挂 question、subagent 挂 approval），互斥枚举只显 approval；其一解决后另一个自动显现，不丢事实（计数仍在，托盘等需要分类计数的投影不受影响）。
- **aborted 优先于 unread**：失败比「有旧内容未读」更该被看见（上一轮的未读位遇上新一轮失败时显 Aborted）。
- `aborted`/`unread` 天然要求不 busy：新 turn 开始时 server 省略 `last_turn_reason` 即清除 failed（1.1），busy 与 failed 不应共存；万一共存，`running` 在前更真实。
- 与 v2 activity 的映射：`running/approval/question` 同名对应；`failed` → 本枚举 `aborted`（quiet 时）；`idle` → `unread` 或 `idle`（取决于客户端本地 unread 位）。

### 3.3 消费方改造

- **等价性**：`sessionDisplayStatus(...) !== 'idle'` 与现 `hasStatus` 集合一致，逐行渲染语义零变化。
- `SessionRow.vue`：四个 flag 全部由枚举驱动（`showApprovalBadge = status === 'awaiting-approval'`、`showQuestionBadge = 'awaiting-question'`、`showAbortedBadge = 'aborted'`、`showBusySpinner = 'running'`、未读点 = `'unread'`）。**有意的微变更**：分组行 lead 槽从直读 `session.busy` 改为枚举驱动，待办期间 spinner 让位 pill——与平铺行既有互斥规则统一（设计语义：一行同一时刻只表达一个状态）。
- `flatSessionsAll`（两端 `useKimiWebClient.ts`）：frontier 可见性豁免的判定换枚举谓词（排序为纯时间序，见 4.2-C）。
- 托盘 attention 投影（`useTrayAttention`）需要分类计数，保留自有投影，词汇对齐枚举。
- 通知逻辑不消费枚举（goal 抑制走 `goalBySession`，见 4.2-C）。
- 测试：`packages/app-core/test/sessionRowStatus.test.ts` 改写为 `sessionDisplayStatus` 用例（优先级矩阵、互斥、unread 本地位、quiet-failed）；该测试现仅存 app-core 单份（web 重复已在 renderer 收编时删除），无双份同步负担。`SessionRow.vue` 两端逐字节一致的要求不变，两端同改。

---

## 四、改动方案

### 4.1 server 侧：收窄 `updated_at` bump 范围（kimi-code 仓）

原则：`updated_at` 只表达「内容最后活动时间」，meta 管理操作不再触碰。

1. **`SessionMetadata.update` 增加 touch 语义**（`sessionMetadataService.ts`）：
   - 签名改 `update(patch: SessionMetaPatch, opts?: { touch?: boolean })`，`touch` 默认 `true`（保持现状：`lastPrompt`、`agents`、`custom` 等更新照常 bump）。
   - `applyUpdate` 计算：`updatedAt = patch.updatedAt ?? (touch ? Date.now() : this.data.updatedAt)`；`SessionMetaPatch` 允许显式携带 `updatedAt`（fork 用，见 4）。
2. **`setTitle` → `touch: false`**。改名（含 emoji 改名的 rename 路径）不再影响排序。注意：首条 prompt 的自动标题走 `applyPromptMetadataUpdate`，与 `lastPrompt` 同一次 update，照常 bump（提交 prompt 是合法活动），不受影响。
3. **`setArchived` → `touch: false`，并新增 `SessionMeta.archivedAt?: number`**：`setArchived(true)` 时写 `archivedAt = Date.now()`；`setArchived(false)` 时清除。透出链路：`buildSessionSummary`（`sessionIndexSource.ts`）→ session index / read model → kap-server v1 sessions 路由（`archived_at`）+ v2 `meta` domain → klient 契约。
4. **fork 继承源会话的 `updatedAt`**：`fork()` 的 `targetMeta.update({...})` 显式传 `updatedAt: sourceMeta?.updatedAt ?? Date.now()`。fork 落到源会话的时间位旁边，不再顶到最上；`createdAt` 保持 now（创建事实）。
5. **兼容**：存量已归档会话没有 `archivedAt`——客户端显示层 fallback 到 `updatedAt`（旧行为下那正好就是归档时间），无需数据迁移。

不在本次范围：`registerAgent` 真实变更时的 bump（subagent 注册 mid-turn bump，客户端快照合并保护已兜住）；undo 的 `lastPrompt` 回写照常 bump。

### 4.2 client 侧（code-app，desktop 先行、同步 web）

#### A. 状态枚举落地

按第三章定义实施：`sessionDisplayStatus.ts` 替代 `sessionRowStatus.ts`（`lib/index.ts` 导出新模块、移除旧导出），`SessionRow.vue` 与两端 `useKimiWebClient.ts` 的 `flatSessionsAll` 一并切换；测试改写见 3.3。

#### B. 列表插入语义：消灭「front 插入」+ snapshot 合并保真

先修现行 bug：`syncSessionFromSnapshot` 的 `updateSession`（desktop `useKimiWebClient.ts:1966`，web :1926）补一行 `pullRequest: snap.session.pullRequest ?? s.pullRequest`（`??` 而非 `||`：`null` 是「查过无 PR」的合法值），两端同改。

视图层 computed 本就按 `updatedAt` 自排序，front 插入只在 server 时间戳说谎时才有体感。server 修好后：

- `restoreSession`（`useWorkspaceState.ts:3048`）、`forkSession`（:3103）：`upsertSessionFront` 改为**按 `updatedAt` 倒序插入池**（新 helper，如 `upsertSessionSorted`）；fork 后仍 `selectSession(forked.id)` 跳转不变。
- 审计其余 `upsertSessionFront` 调用点（`useWorkspaceState.ts:1548` 新建会话、:3164/:3174 undo 相关）：统一换有序插入。新建会话 `updatedAt=now`，行为不变。

#### C. 置顶区：纯时间序（最终决策，取代"分层 + 手动序并存"方案）

- `useKimiWebClient.ts` `pinnedSessions` computed：`partitionByPinned`（成员划分）后按 `updatedAt` 倒序投影；`pinned` 标记、flat 行样式（`cwdLabel`）不变。`pinnedSessionIds` 退化为纯成员集合。
- `PinnedSessionList.vue` 拖拽收窄：行可拖出（取消置顶，路径在 Sidebar/WorkspaceGroup，不动）；外部会话行拖入区内任意位置 = 置顶（`dropPin`，落点不带位置语义）；移除区内手动排序（reorder/落点指示整体删除）。
- `pinnedSessions.ts` 纯函数收敛为成员集合操作（`pinSessionId` / `unpinSessionId` / `partitionByPinned`）；`mergePinnedOrder` / `insertPinnedAt` / 分层与拖拽提交函数随之删除。facade 的 `reorderPinnedSessions` / `pinSessionAt` 移除，App/Sidebar 接线改 `drop-pin → pinSession`。
- 平铺列表 `flatSessionsAll` 同步撤掉 attention 分层（纯时间序；有状态行仅豁免 frontier 可见性约束）。

#### D. goal 多轮：中间边界抑制未读与通知

判定谓词：`rawState.goalBySession[sid]?.status === 'active'`（goal 运行中）。时序天然正确：完成轮里 `goalUpdated(complete)` 在工具执行阶段发出、seq 先于该轮 `turn.ended`，reducer 随即清掉 `goalBySession`（`eventReducer.ts:857`），最后一轮边界自动回落为普通完成（未读 + 通知恰好一次）；`blocked`/`paused` 保留在 `goalBySession` 但非 `'active'`，不误伤。

- `onMainTurnEnd`（`useKimiWebClient.ts:3485`）：谓词为真时**跳过未读点与完成通知两个副作用**；`finishPromptLocal`、git status / runtime status 刷新照常。
- **recency bump 保留**：turn 结束就是一次真实活动，时间序下位置本来就该动，刻意不动。
- **重载缝隙**：客户端重载后，后台 goal 会话在收到下一条 goal 事件前 `goalBySession` 为空，第一个中间边界会漏一次提醒。堵法：初始 `load()` 完成后，对 `mainTurnActive` 为真且 `goalBySession` 无条目的会话批量补拉 `refreshSessionGoal`（fire-and-forget）。
- 用户 Esc 中断 goal：turn 结局 `cancelled`，本就不点未读/不通知，无需处理。
- 单测：renderer 层补 goal-active 抑制、complete 回落通知、blocked/paused 不抑制 三类用例。

#### E. 归档时间展示切到 `archivedAt`

- `AppSession` 加 `archivedAt?: string`（`types.ts`、wire、mappers、v2 `toAppSessionFromV2`）。
- `SettingsDialog.vue:547,989` 与 `MobileSettingsSheet.vue:242,477`：排序键与「归档时间」展示改用 `archivedAt ?? updatedAt`。

#### F. 两端同步

改动落在既有同步面内（app-core / `SessionRow.vue` / `PinnedSessionList.vue` / 两端 `useKimiWebClient.ts` / `useWorkspaceState.ts` / i18n 如需）。desktop 先行，完成后按仓库惯例同步 `apps/web`（保留各自分叉块；`SessionRow.vue` 本次有改动，改完恢复逐字节一致）。

---

## 五、落地顺序与双仓工作流

1. **kimi-code 仓先做 4.1**（工作克隆 `/Users/moonshot/Desktop/moonshot/kimi-code-5` 里开分支改、起 server 联调），提交后 code-app bump submodule 指针。两端解耦：server 先上，旧客户端只是 restore/fork 仍 front 插入（现状，无回归）；client 先上，server 未修时 restore/fork 依旧 justnow（现状，无回归）。
2. **code-app 再做 4.2**，`KIMI_SERVER_URL` 指外部 server 联调（AGENTS.md 双仓工作流节）。4.2-A（枚举）独立先行合入亦可——它自洽、不依赖 server 改动。
3. changeset 走 `changeset` skill：一律 `patch`，只写 `kimi-code-app`；kimi-code 仓的 changeset 在其仓内自行处理。
4. 提交规范：Conventional Commits，禁 amend / force-push / Co-Authored-By。

## 六、验证

- code-app：`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm --filter kimi-code-web run check:style`（改动文件不得新增 findings）；UI 改动亮/暗双主题目测（置顶区分层、拖拽指示、枚举驱动后的 SessionRow 各状态）。
- kimi-code：`sessionMetadata` / `sessionLifecycle`（fork/restore 的 updatedAt、archivedAt 写清）单测；v1/v2 路由契约测试。
- 手测脚本：改名→刷新不重排；归档→取消归档→回时间原位；fork→落在源会话时间位；置顶区制造 running/未读→浮顶、消状态→回手动位、拖安静行→顺序持久化；goal 跑多轮→仅完成时一次未读+一次通知；双待办（approval+question）时只显 approval pill、解决后显现 question pill。

## 七、未决与可选（不阻塞）

- goal 完成/阻塞时的通知文案现在是通用「Turn finished」；想要专属文案需从 `goalUpdated` 事件侧另起通知（完成瞬间 `goalBySession` 已清）。本期不做。
- goal 中间轮边界 busy 翻转导致的 spinner 闪烁：存在，不在本期。
