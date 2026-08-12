# Session 状态枚举与排序规则 实施方案

> 2026-08-11。行为定义与设计决策见 spec：`docs/specs/2026-08-11-session-status-and-ordering.md`（本文不重复论证，只给"怎么改、怎么测、怎么上"）。

## 总览

| 里程碑 | 仓库 | 内容 | 依赖 |
|---|---|---|---|
| M1 | kimi-code（工作克隆 `kimi-code-5`） | server 收窄 `updated_at` bump + `archivedAt` 透出 + fork 继承源时间 | 无 |
| M2 | code-app | `SessionDisplayStatus` 枚举落地（替代 `sessionRowStatus`） | 无，可最先做 |
| M3 | code-app | 列表插入语义（消灭 front 插入）+ 归档时间切 `archivedAt` + snapshot 合并保留 `pullRequest`（修现行 PR 消失 bug） | M3.1 纯客户端无依赖；M3.2 起在 M1 合并并 bump submodule 后才有体感（先做无回归） |
| M4 | code-app | 置顶区改纯时间序 + 平铺撤掉注意力分层（最终决策） | M2（用枚举谓词做 frontier 豁免） |
| M5 | code-app | goal 多轮抑制未读/通知 + 重载补拉 | 无 |

kimi-code 侧所有改动的工作克隆固定为 **`/Users/moonshot/Desktop/moonshot/kimi-code-5`**（在此仓开分支、过其 CI/review；code-app 的 `kimi-code/` submodule 只读，不直接改，只 bump 指针）。

引擎范围确认：desktop 内嵌 server 与 web 默认 daemon 均为 **kap-server（agent-core-v2）**（`apps/desktop/src/main/server.ts:4`）。legacy v1 引擎（`packages/server` + `packages/agent-core`，updatedAt 走文件 mtime 推导，`session-store.ts:534`）**不在本次范围**；若仍需支持，单独立项。

PR 划分（每个 PR 独立 changeset，一律 `patch`、只写 `kimi-code-app`；kimi-code 仓的 changeset 在其仓内处理）：

- **PR-S**（kimi-code-5 克隆）：M1
- **PR-1**（code-app）：M2 枚举（desktop + web 同步，下同）
- **PR-2**（code-app）：`chore: bump kimi-code submodule` + M3
- **PR-3**（code-app）：M4 置顶分层
- **PR-4**（code-app）：M5 goal 抑制

---

## M1　server 侧（kimi-code-5 克隆）

所有路径相对 `/Users/moonshot/Desktop/moonshot/kimi-code-5`。

### M1.1 `SessionMetadata` touch 语义 + `archivedAt`

> 实施注记：main 上 `update` 已有 `opts.touchUpdatedAt`（仅 turn outcome 镜像在用）；本次在其上补「patch 显式携带 `updatedAt` 优先」的分支（fork 继承用），并给 `setTitle`/`setArchived` 接上 `touchUpdatedAt: false`。

`packages/agent-core-v2/src/session/sessionMetadata/sessionMetadata.ts`：

- `SessionMeta` 加 `archivedAt?: number`（epoch ms）。
- `ISessionMetadata.update` 签名为 `update(patch: SessionMetaPatch, opts?: { touchUpdatedAt?: boolean })`（已有）。`SessionMetaPatch` 已允许携带 `updatedAt`（`Partial<Omit<SessionMeta, 'id' | 'createdAt'>>`），无需改类型。

`sessionMetadataService.ts`：

```ts
private async applyUpdate(patch: SessionMetaPatch, opts?: { touchUpdatedAt: boolean }): Promise<void> {
  await this.ready;
  if (this.disposed) return;
  // 显式 patch.updatedAt 优先（fork 继承源会话 recency）；否则 touchUpdatedAt:false
  // 的管理类写（改名/归档）保持原值，列表不重排。
  const updatedAt =
    patch.updatedAt ?? (opts?.touchUpdatedAt === false ? this.data.updatedAt : Date.now());
  this.data = { ...this.data, ...patch, updatedAt };
  // ...persist + mirror + event 不变
}

async setTitle(title: string): Promise<void> {
  await this.update({ title, isCustomTitle: true }, { touchUpdatedAt: false });
}

async setArchived(archived: boolean): Promise<void> {
  await this.update(
    archived ? { archived: true, archivedAt: Date.now() } : { archived: false, archivedAt: undefined },
    { touchUpdatedAt: false },
  );
}
```

- `{...data, ...patch}` 遇 `archivedAt: undefined` 时 key 残留为 undefined，`JSON.stringify` 会丢弃，持久化文档干净；`normalizeSessionMeta` 无需特判。
- `registerAgent` / `lastPrompt`（`prompt-metadata.ts`）/ `custom` 更新全部走默认 `touch: true`，行为不变。
- 文件头注释更新：补「`touch: false` 的管理类操作（改名/归档）不重排 session 列表」的设计说明（现注释已有"format heal 不 bump"的同款先例）。

### M1.2 fork 继承源 `updatedAt`

`packages/agent-core-v2/src/workspace/sessionLifecycle/sessionLifecycleService.ts` `fork()`（:535 附近）：`targetMeta.update({...})` 显式加 `updatedAt: sourceMeta?.updatedAt ?? Date.now()`。`createdAt` 不动（新 meta 创建时已是 now）。

### M1.3 `archivedAt` 透出链路

1. `app/sessionIndex/sessionIndex.ts`：`SessionSummary` 加 `readonly archivedAt?: number`。
2. `app/sessionIndex/sessionIndexSource.ts`：`buildSessionSummary` fields/返回加 `archivedAt`（字段顺序固定，插在 `archived` 后）；`summaryEquals` 加 `a.archivedAt === b.archivedAt`；磁盘投影函数（:154 附近）从 meta 读 `archivedAt`。
3. `sessionMetadataService.ts` `mirrorToReadModel` 的 `buildSessionSummary({...})` 调用加 `archivedAt: this.data.archivedAt`。
4. 读模型（minidb）：summary 以 JSON 文档存储，新增非索引字段无需 schema 迁移；实现时验证 projector 全量扫描 + reconciliation 对旧文档（无 `archivedAt`）解析为 undefined 即可。
5. `app/sessionLegacy/sessionLegacyService.ts`：`SessionWireFields` 加 `archivedAt?: number`，`updateProfile` 返回及 session 列表投影处补 `archivedAt: meta.archivedAt`。
6. kap-server 路由：
   - v1 `routes/sessions.ts`（:1127 附近 wire 投影）：wire Session 加 `archived_at`（ISO 字符串或 epoch ms——对齐该路由现有 `updated_at` 的表示）。
   - v2 `routes/v2/sessions.ts`：`meta` domain 加 `archived_at: number | null`（Unix ms，与 `created_at`/`updated_at` 同表示）。
7. `packages/klient/src/contract/global/sessions.ts`：wire Session 类型加 `archived_at`。
8. v2 契约文档（飞书 wiki + 本地副本 `.tmp/v2-sessions-api.md`）补 `meta.archived_at` 字段说明。

### M1.4 测试（kimi-code-5）

- `sessionMetadata.test.ts`：`setTitle`/`setArchived` 不 bump `updatedAt`；`archivedAt` 写/清；显式 `updatedAt` patch 优先于 touch；默认 update 仍 bump。
- `sessionLifecycle.test.ts`：fork 继承源 `updatedAt`、`createdAt` 为 now；restore 后 `updatedAt` 不变、`archivedAt` 清除。
- 投影/路由层：v1 list + v2 list 透出 `archived_at`（含存量无字段会话 → null/缺省）。

---

## M2　客户端状态枚举（code-app，两端）

### M2.1 新模块

`packages/app-core/src/lib/sessionDisplayStatus.ts`（按 spec 3.1/3.2 逐字实现）：

- `SessionDisplayStatus` = `'awaiting-approval' | 'awaiting-question' | 'running' | 'aborted' | 'unread' | 'idle'`；
- `SessionDisplayStatusInput` = `{ busy, unread, questionCount, approvalCount, pendingInteraction?, lastTurnReason? }`（无 `renaming`）；
- `sessionDisplayStatus(input)`：awaiting-approval → awaiting-question → running → aborted → unread → idle。
- `packages/app-core/src/lib/index.ts`：导出替代（删 `sessionRowStatus` 导出、加新模块）。
- 删除 `packages/app-core/src/lib/sessionRowStatus.ts`。

### M2.2 消费方切换（desktop + web 同改）

- `SessionRow.vue`（两端，改完恢复逐字节一致）：
  - `rowStatus` computed 改为 `status = computed(() => renaming.value ? 'idle' : sessionDisplayStatus({...}))`；
  - 四个 flag 改为枚举等值判断（`showApprovalBadge = status === 'awaiting-approval'` 等）；`flatHasStatus = status !== 'idle'`；
  - **分组行 lead 槽**：`<Spinner v-if="session.busy">` 改为枚举驱动（`'running'` → spinner，`'unread'` → 蓝点，其余空）——待办期间 spinner 让位 pill，与平铺行统一（spec 3.3 的有意微变更）；
  - 文件头与 `.act` 注释里"flag logic lives in sessionRowStatus.ts"等引用改指新模块。
- 两端 `useKimiWebClient.ts` `flatSessionsAll`：`sessionRowStatus({...}).hasStatus` → `sessionDisplayStatus({...}) !== 'idle'`（含注释更新）。

### M2.3 测试

- `packages/app-core/test/sessionRowStatus.test.ts` → 改写为 `sessionDisplayStatus.test.ts`：优先级矩阵（双待办 approval 胜、aborted 胜 unread、running 让位待办）、quiet-failed、`pendingInteraction` 兜底位、全空闲 → idle。保持现有用例粒度（现 10 条）不缩水。
- 托盘投影（`useTrayAttention`）不改逻辑，本 PR 不动。

### M2.4 行为变化声明（写进 PR 描述与 changeset）

1. 双待办并存时只显 approval pill（解决后另一个显现）；
2. 分组行待办期间 lead 槽不再同时显示 spinner。

---

## M3　插入语义 + 归档时间 + snapshot 保真（code-app，两端）

`chore: bump kimi-code submodule` 单独一个 commit 先行：PR-S 合并推送后，在 code-app 的 `kimi-code/` 里 `git fetch origin <branch> && git checkout <commit>`，回仓根 `git add kimi-code` 提交（AGENTS.md 双仓工作流节）。**M3.1 是纯客户端修复、不依赖 bump**，想先出可在本 PR 前拆出独立合入。

### M3.1 snapshot 合并保留 `pullRequest`（修现行 bug：点开会话后 PR chip 消失）

根因：`syncSessionFromSnapshot` 的 `updateSession`（desktop `useKimiWebClient.ts:1966`，web :1926）整体铺开 `snap.session`，而 snapshot 走 v1 路径、恒不带 v2 git domain，`pullRequest` 被覆盖成 `undefined`。列表路径已在 `setSessionsPreservingLiveUsage`（`useWorkspaceState.ts:721`）保留该字段，snapshot 路径漏了。

修复（两端同改，照列表路径同款模式）：

```ts
pullRequest: snap.session.pullRequest ?? s.pullRequest,
```

（用 `??` 不用 `||`：`null` 是「查过、没有 PR」的合法值，只是 v1 路径永远不会产生它。）

### M3.2 有序插入替代 front 插入

`useKimiWebClient.ts`（:588 附近）新增：

```ts
/** Add or replace a session in the pool, keeping updatedAt-desc order. */
function upsertSessionSorted(session: AppSession): void {
  const rest = rawState.sessions.filter((s) => s.id !== session.id);
  const at = rest.findIndex((s) => s.updatedAt < session.updatedAt);
  rawState.sessions = at === -1 ? [...rest, session] : [...rest.slice(0, at), session, ...rest.slice(at)];
}
```

`useWorkspaceState.ts` 调用点替换（`upsertSessionFront` → `upsertSessionSorted`，deps 类型同步）：

- `restoreSession`（:3051）——取消归档回时间原位（配合 M1，server 不再 bump）；
- `forkSession`（:3108）——fork 落源会话时间位（配合 M1.2）；`selectSession(forked.id)` 跳转不变；
- 新建会话（:1548）与 undo 两处（:3164/:3174）——行为等价（新建 updatedAt=now），统一换掉避免留两套语义；
- `upsertSessionFront` 确认无残留调用后删除（`useKimiWebClient.ts:3414` 导出同步移除）。

### M3.3 `archivedAt` 客户端透出

- `packages/app-core/src/api/daemon/wire.ts`：v1 wire Session 加 `archived_at`；`mappers.ts`：`toAppSession` 映射 `archivedAt`。
- `packages/app-core/src/api/types.ts`：`AppSession` 加 `archivedAt?: string`（注释：归档时刻；无存量的老会话缺省）；`V2Session.meta` 加 `archived_at: number | null`；`toAppSessionFromV2` ms→ISO 映射。
- `SettingsDialog.vue:547,989` 与 `MobileSettingsSheet.vue:242,477`：排序键与「归档时间」展示改 `archivedAt ?? updatedAt`（老会话 fallback）。

### M3.4 测试

> 实施注记：snapshot 合并的字段保护（`model`/`usage`/`updatedAt`/`pullRequest`）抽成了纯函数 `mergeSnapshotSession`（`packages/app-core/src/api/daemon/mappers.ts`，两端 facade 共用），四守则一并进入单测——顺带补上 recency guard 此前无覆盖的债。

- M3.1：`mergeSnapshotSession` 单测（`packages/app-core/test/mergeSnapshotSession.test.ts`）：placeholder usage 保留/adopt、空 model 保留、updatedAt 新旧/mid-turn 双向、pullRequest 保留（含 null）/采纳。
- M3.2：`insertSessionByRecency` 纯函数单测（空池/头部/中部/尾部/同 id 替换/同时间戳稳定）；restore/fork 路由 + 顺序用例（`apps/web/test/workspace-state.test.ts`，upsertSessionSorted mock 用真实 `insertSessionByRecency` 实现）。
- 纯函数落在 app-core：`insertSessionByRecency`（`lib/sessionRecency.ts`），facade 的 `upsertSessionSorted` 调它。

---

## M4　置顶区改为纯时间序 + 平铺撤掉注意力分层（code-app，两端）

> 实施注记：本里程碑最初按「attention 分层 + 手动序并存」实施并已落地（`tierPinnedSessions`/`reorderPinnedQuiet`），后经产品决策改为**全部按时间序、不做注意力分层**，分层实现已撤除。以下按最终形态记录。

### M4.1 平铺列表（`flatSessionsAll`，两端）

- 撤掉 attention/rest 双层：过滤后纯 `updatedAt` 倒序。
- frontier 约束保留，但**有状态行（`sessionDisplayStatus(...) !== 'idle'`）豁免 frontier**——只是可见性豁免（刚跑起来的会话不因页未翻到而消失），位置仍由时间戳决定。

### M4.2 置顶区（两端）

- facade `pinnedSessions`：`partitionByPinned` 成员划分后按 `updatedAt` 倒序；`pinnedSessionIds` 退化为纯成员集合。
- 移除 facade 的 `reorderPinnedSessions` / `pinSessionAt` 及导出；移除 `pinnedAttentionIds`。
- `PinnedSessionList.vue`（两端逐字节一致）：移除 reorder/落点指示/`attentionIds`；行拖出取消置顶保留；外部拖入区内任意位置 = `dropPin`（区容器 accent 框高亮，落点不带位置语义）。
- `Sidebar.vue` / `App.vue`：`reorderPinned`/`pinAt`/`pinnedAttentionIds` 接线移除，改 `drop-pin → client.pinSession`（幂等成员添加）。
- `packages/app-core/src/lib/pinnedSessions.ts`：收敛为 `SESSION_ROW_DRAG_MIME` / `pinSessionId` / `unpinSessionId` / `partitionByPinned`；`mergePinnedOrder` / `insertPinnedAt` / `tierPinnedSessions` / `reorderPinnedQuiet` 删除。

### M4.3 测试与文档

- `apps/web/test/pinned-sessions.test.ts`：收敛为成员集合与 partition 用例（分层/落点用例随实现删除）。
- `apps/desktop/docs/native-todos.md:12` 条目更新为最终语义（平铺纯时间序、置顶时间序、拖拽收窄为拖入置顶/拖回取消）。
- 两端 `DesignSystemView.vue`：§07 lead 槽枚举表述 + Pinned head 一行的排序表述。

---

## M5　goal 多轮抑制（code-app，两端）

### M5.1 中间边界抑制

`useKimiWebClient.ts` `onMainTurnEnd`（:3485）：

```ts
const goalActive = rawState.goalBySession[sid]?.status === 'active';
// ...
} else if (status === 'idle' && !goalActive) {
  rawState.unreadBySession[sid] = true;
  saveUnread({ [sid]: true });
}
// ...
if (!goalActive && shouldNotifyCompletion(status, hasPendingApproval, hasPendingQuestion)) {
```

`finishPromptLocal`、git/runtime status 刷新不受影响。recency bump（`eventReducer.ts`）刻意不动。

### M5.2 重载缝隙补拉

`useWorkspaceState.ts` 初始 `load()` 完成点（会话池填充后）：对 `s.mainTurnActive === true && rawState.goalBySession[s.id] === undefined` 的会话 `void refreshSessionGoal(s.id)`（fire-and-forget，逐个 `GET /sessions/{id}/goal`，量小不做批量接口）。

### M5.3 测试

desktop `tests/renderer/`（复用现有 client/通知测试基建）：

- goal `active` 的会话 turn 结束 → 无未读、无通知；
- goalUpdated(complete) 先序到达后的最终 turn 结束 → 未读 + 通知恰好一次；
- goal `blocked` / `paused` → 照常未读 + 通知；
- 非 goal 会话回归用例（现有断言不破）。

---

## 验证（每个 PR 的 DoD）

- 通用：`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm --filter kimi-code-web run check:style`（改动文件零新增 findings）。
- UI 涉及 PR（M2/M4）：亮 + 暗主题目测各状态行、hover/focus、拖拽指示；两端 `SessionRow.vue` diff 为空。
- kimi-code PR-S：kimi-code-5 克隆内 `pnpm test` + 路由契约测试，过其仓 CI。
- 联调手测（外部 server 从 kimi-code-5 启动）：

  ```bash
  # 1. kimi-code-5 起 server（CORS 仅 desktop 需要；端口被占顺延，以启动日志为准）
  cd /Users/moonshot/Desktop/moonshot/kimi-code-5
  KIMI_CODE_CORS_ORIGINS="app://renderer,http://127.0.0.1:5174" pnpm dev:server

  # 2. code-app 指过去（desktop 或 web 二选一）
  KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm dev:desktop
  ```

  手测脚本：
  1. 改名 → 刷新 → 位置不变；
  2. 归档 → 取消归档 → 回时间原位、不显示「刚刚」；设置里归档列表显示归档时刻；
  3. fork → 落在源会话时间位、不顶到最上；
  4. 置顶区：制造 running/未读 → 浮顶且层内时间倒序；状态消掉 → 回手动原位；拖安静行 → 刷新后顺序保持；拖 attention 行落区内 → 不重排；
  5. goal 跑 ≥3 轮 → 中间轮无未读无通知；完成时恰好一次未读 + 一次通知；blocked 时照常提醒；
  6. 双待办并存 → 只显 approval pill，解决后显现 question pill；
  7. 平铺视图点进带 PR 的会话 → PR chip 不消失，退回列表仍在。

## 风险与备注

- **M1 是跨仓改动**：在 `kimi-code-5` 克隆开分支，按其仓 AGENTS.md 流程（CI、review）；code-app 侧只 bump submodule 指针。
- **存量数据零迁移**：老会话无 `archivedAt`，客户端 fallback `updatedAt`；v1 格式 state.json（ISO 时间戳）由 `normalizeSessionMeta`/`parseTime` 既有路径兼容。
- **M2 的两个微行为变化**已获拍板（见 spec 3.3），PR 描述要显式写出。
- **两端同步纪律**：M2–M5 每个 PR 都含 apps/web 同步，保留既有分叉块；`SessionRow.vue` 改完必须逐字节一致（CI 目检 + diff 验证）。
- **回滚**：各 PR 独立可 revert；M1 与 M3 解耦（单边先上无回归，见 spec 第五章）；M3.1 更是纯客户端，可随时独立 revert。
