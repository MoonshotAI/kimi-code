# 接入 v2 分组会话视图与 session.archived 事件

日期：2026-08-20
状态：待实施
上游：kimi-code PR [#3114](https://github.com/MoonshotAI/kimi-code/pull/3114)（`GET /api/v2/sessions?view=by_workspace` + `event.session.archived` / `event.workspace.*` 事件落地）

## 背景

上游 PR #3114 给 kap-server 加了三个能力：

1. **`GET /api/v2/sessions?view=by_workspace`**：把现有 v2 sessions 的过滤/排序结果按工作区分组返回。每组带该工作区排序后的前 `group.page_size` 条（默认 5）+ 该组完整匹配数 `total`；组间按组内首条的排序键排序、workspace id 打平；`page`/`page_token` 翻页对象是组（沿用 query 指纹绑定，条件漂移 40922）。同 PR 新增 `meta.has_prompt=true|false` 过滤（对应 v1 `exclude_empty` 语义），并做 workspace 别名归并（legacy 拆分 id 合并为一组）。
2. **`event.session.archived`**：此前 core 发布但 broadcaster 丢弃，现在向所有 `/api/v1/ws` 连接广播，live 归档与冷归档两条路径都有。payload 带 `workspace_id`；真实 session id 在 payload 里（envelope 的 `session_id` 是 `__global__` 水位标记）。dispatch 绕过 `ensureState`，冷归档必定送达。
3. **`event.workspace.created/updated/deleted`**：此前只有 wire schema 声明、没有发布方，现在由 `IWorkspaceService` 在每条变更路径发布（包括建会话时隐式的 `createOrTouch`），payload 是带 `session_count` 的完整 workspace wire（deleted 是 `{ workspace_id, root }`）。

我们客户端的对应现状：

- 侧栏分组视图每次全量刷新（`load()`）对每个工作区发一个 v1 请求（`useWorkspaceState.ts` `loadInitialSessionsByWorkspace` → `loadInitialSessionsForWorkspace`，`pageSize: 5, excludeEmpty: true`），请求数随工作区数线性增长。
- `event.session.archived` 在 wire/mapper 里没有声明。未知事件会落 reducer 的 "truly unknown" 分支，**每帧弹一条 `warnings.unhandledEvent` toast**（`eventReducer.ts`）。服务端一上线这就是用户可见的 bug。
- `event.workspace.*` 客户端已预埋完整通路（`wire.ts` / `mappers.ts` / `useKimiWebClient.ts` → `applyWorkspaceEvent`），从没被真实流量跑过。

## 目标

1. 服务端 PR 上线后客户端零警告、归档跨客户端实时同步。
2. 侧栏分组视图的全量刷新从 N 个请求（N = 工作区数）降为 ~1 个，旧服务端自动回退现有行为。
3. 验证 workspace 事件通路在真实流量下无回归。

非目标：平铺视图 / 已完成列表的数据源改造（已是 v2 flat，不受影响）；`meta.has_prompt` 替换平铺视图的客户端空会话过滤（可选优化，不在本方案）；会话管理页（`useSessionAdmin`）改动。

## 决策记录

- **丢弃 recency-window 续页**：现在首屏每工作区会续页到 12 小时边界（`SESSIONS_RECENT_WINDOW_MS`）。分组视图每组固定 `group.page_size` 条，无法一次请求复制该行为。决定：首屏每组固定 5 条 + `total` 驱动 hasMore，用户手动展开。回退路径（旧服务端）保留原行为。
- **远程归档走与本地归档完全一致的和解路径**：复用 `applySessionsArchivedLocally`，不新造流程。
- **远程归档同样做工作区回填**（`backfillWorkspaceSessions`）：保持本地/远程归档后侧栏行数表现一致。
- **组内「展开更多」继续走 v1 `before_id` 游标**：v1 路由保持 byte 兼容，无需改动 `loadMoreSessions`。

## PR 拆分

- **PR 1**：`event.session.archived` 接入（改动小、独立、有紧迫性，先发）。
- **PR 2**：`view=by_workspace` 分组视图接入 + workspace 事件通路验证。

两个 PR 均需 changeset（`patch`，只写 `kimi-code-app`）。

---

## PR 1：`event.session.archived` 接入

### 帧形状（以真实服务端验证为准）

```jsonc
{
  "type": "event.session.archived",
  "seq": 123,
  "session_id": "__global__",        // envelope 水位标记，不是真实 session id
  "timestamp": "...",
  "payload": {
    "workspace_id": "wd_...",
    "sessionId": "sess_..."           // 真实 session id（camelCase，与 kimi-inspect 的消费方式一致）
  }
}
```

### 改动点

**`packages/app-core/src/api/daemon/wire.ts`**

- 新增 `WireEventSessionArchived = WireEventBase<'event.session.archived', { workspace_id: string; sessionId?: string; session_id?: string }>`，加入 `WireEvent` union。payload 同时容忍 camel/snake 两种 session id 写法。

**`packages/app-core/src/api/daemon/mappers.ts`（`toAppEvent`）**

- 新增 case：session id 取 `payload.sessionId ?? payload.session_id`（envelope 是 `__global__` 不可用）；取不到或为空串时返回 `{ type: 'unknown', raw: { _noop: true, _wireType } }`（畸形帧静默，不弹警告）；否则返回 `{ type: 'sessionArchived', sessionId, workspaceId: payload.workspace_id }`。

**`packages/app-core/src/api/types.ts`**

- `AppEvent` union 新增 `{ type: 'sessionArchived'; sessionId: string; workspaceId?: string }`。

**`packages/app-core/src/api/daemon/eventReducer.ts`**

- 新增 `case 'sessionArchived': break;`，注释说明与 workspace 事件一样在 composable 层处理（保持 switch 穷尽性；正常路径不会进 reducer）。

**`packages/app-client/src/client/useWorkspaceState.ts`**

- 新增 `applyRemoteSessionArchived(sessionId: string, workspaceId?: string): Promise<void>`：
  1. 会话不在池里且不是活跃会话（本端归档的回声、重复帧、从未加载）→ 仅 `notifySessionDestroyed` 由调用方做，本函数直接 no-op 返回。
  2. 变更前先取回填输入（镜像 `archiveSession`）：`archived` 行、`workspaceIdForSession`（参数 `workspaceId` 优先，本地推导兜底）、`loadedInWorkspace(workspaceId).length`。
  3. `await applySessionsArchivedLocally([sessionId], true)`——现成的全套和解：折叠进「已完成」列表、`forgetSession` teardown（退 WS 订阅、清消息/plan/审批/goal/游标）、sideChat/titleGen 清理、活跃会话切换 + URL `replace`。
  4. fire-and-forget `void backfillWorkspaceSessions(workspaceId, sessionId, archived.updatedAt, target)`（`archived` 行与 `workspaceId` 都存在时）。
- 导出该方法。

**`packages/app-client/src/client/useKimiWebClient.ts`（`onEvent`）**

- 在 workspace 事件拦截的同款位置新增：
  ```ts
  if (appEvent.type === 'sessionArchived') {
    notifySessionDestroyed(appEvent.sessionId); // desktop 终端 teardown，与 sessionUpdated 路径对齐；幂等
    void workspaceState.applyRemoteSessionArchived(appEvent.sessionId, appEvent.workspaceId);
    return; // 绕过 reducer，同 workspace 事件
  }
  ```

### 去重与竞态

- **本端归档回声**：本地 `archiveSession` 已完成 `applySessionsArchivedLocally`，回声到达时池里已无该行 → no-op。
- **与 `sessionUpdated archived=true` 并存**（live 归档两帧都可能到）：`sessionUpdated` 只把池里的行替换成 archived 版本；随后 `sessionArchived` 到达时行仍在池里 → 正常和解。反序到达：`sessionArchived` 先删行，`sessionUpdated` 的 reducer map 找不到 id → no-op。两个顺序都收敛。
- **pinned**：与本地归档一致，不动 pin（下次 load 时 stale pin 自动清理）。

### 测试

- `app-core` mappers 单测：camel/snake/envelope 三种 session id 位置、缺失 id → `_noop`、`workspace_id` 透传。
- `app-client` 单测（`applyRemoteSessionArchived`）：池内会话归档（出池、进 done 列表、触发回填）；活跃会话归档（切换到下一个 / 清空 + URL replace）；未知会话（完全 no-op，不发回填）；回声场景（本地已归档后不再副作用）。

---

## PR 2：`view=by_workspace` 分组视图接入

> 本节为实施后的最终设计。**仓规硬约束：web/desktop 不做旧服务端兼容逻辑**（AGENTS.md）——无形状守卫、无 v1 fan-out 回退、无旧 daemon 降级路径；旧服务端上的失败按普通错误处理（保留旧列表、下次重试）。

### 响应形状

```jsonc
// GET /api/v2/sessions?view=by_workspace&group.page_size=5&meta.has_prompt=true
{
  "data": {
    "groups": [
      {
        "workspace": { "id": "wd_...", "cwd": "/path" },
        "sessions": [ /* 该工作区排序后前 group.page_size 条，V2Session 结构同 flat */ ],
        "total": 17                          // 该工作区完整匹配数
      }
    ],
    "total": 3,                              // 组数（≠ 会话数，注意与 flat 语义不同）
    "has_more": false,
    "next_page_token": null
  }
}
```

### 改动点

**`packages/app-core/src/api/daemon/wire.ts` / `types.ts`**

- 新增 wire 与 app 侧类型：`WireV2SessionGroup` / `WireV2SessionGroupsPage`、`V2SessionGroup` / `V2SessionGroupsPage`（`{ groups, total, hasMore, nextPageToken }`）、`ListSessionGroupsV2Input`（`groupPageSize` / `hasPrompt` / `sort` / `pageSize` / `pageToken` / `workspaceIds` / `statuses` / `archived`）。

**`packages/app-core/src/api/daemon/client.ts`**

- 新增 `listSessionGroupsV2(input?: ListSessionGroupsV2Input): Promise<V2SessionGroupsPage>`：
  - query：`view: 'by_workspace'`、`group.page_size`、`meta.has_prompt`（`String(boolean)`）、`sort` / `page_size` / `page_token` / `meta.archived` / `workspace.id` / `activity.status`，序列化方式与 `listSessionsV2` 一致。
  - 不带 `include=git`：分组行不展示 PR badge（平铺行才展示），省掉 git resolve 开销。

**`packages/app-client/src/client/useWorkspaceState.ts`**

- 新增 `loadInitialSessionsGrouped(): Promise<AppSession[] | undefined>`：
  - 调 `listSessionGroupsV2({ groupPageSize: SESSIONS_INITIAL_PAGE_SIZE, hasPrompt: true })`；组数超过单页（默认 50 组）时按 `pageToken` 串行 drain 直至耗尽，无上限。
  - 请求失败返回 `undefined`：保留旧列表与分页状态，等自然重试（单请求失败 = 全失败）。
  - 成功：每组 sessions 经 `toAppSessionFromV2` 入列；合并去重、按 `updatedAt` 倒序；填充分页状态——
    - `sessionsHasMoreByWorkspace[id] = group.sessions.length < group.total`；
    - `sessionsCursorByWorkspace[id]` = 组内末条 id（v1 `before_id` 游标语义不变，`loadMoreSessions` 不动；v1/v2 服务端均自行解析 workspace 别名）；
    - `sessionsInitialCountByWorkspace[id] = max(loaded, SESSIONS_INITIAL_PAGE_SIZE)`；
    - 没有组的（空）工作区：`hasMore=false`、`cursor=undefined`、`count=SESSIONS_INITIAL_PAGE_SIZE`；
    - 组与工作区按 id 匹配、root 兜底（服务端 canonical 归并别名）。
  - 组内 running/approval/question 行：v2 activity domain 无主 turn 标记，在**池提交后**按 id 走 v1 `GET /sessions/{id}` 水合 `mainTurnActive`（只合并活动字段、跳过已有更新实时事件的行），水合完成后再进 goal 回填。
- `setSessionsPreservingLiveUsage` 保留非空 live `model`（v2 行 `model:''`，避免重载后活跃会话退回全局默认模型）。
- 组内「展开更多」与归档回填仍走 v1 `before_id` 游标。

### 测试

- `app-core` client 单测：query 序列化（`view` / `group.page_size` / `meta.has_prompt` / 可重复 `workspace.id`）、响应映射。
- `app-client` 单测：多工作区分组入池与排序；`hasMore` 由 `total` 驱动；空工作区默认值；别名 root 匹配；组页 drain 至耗尽（超 10 页）；请求失败保留旧列表；live 行水合（含不回滚实时更新、goal 回填等待）；model 保留。

---

## workspace 事件通路验证（随 PR 2）

`event.workspace.*` 客户端通路已预埋（`wire.ts:917-919` → `mappers.ts:602-613` → `useKimiWebClient.ts:1467-1486` → `applyWorkspaceEvent`），服务端 PR 上线后首次有真实流量。手动验证：

1. 另一客户端 create / rename / delete 工作区 → 本端侧栏实时增删改。
2. **隐藏工作区里建会话**（`createOrTouch` 会发 `workspace.updated`）→ 确认不会把隐藏工作区"复活"到侧栏（`upsertWorkspacePreserveOrder` 对 hidden roots 的分支，`useWorkspaceState.ts:1490-1519`）。有问题单独修，不阻塞 PR 2 主体。
3. 建会话触发的 `workspace.updated` 携带新 `session_count` → 侧栏计数标签实时更新，无刷新风暴（该 handler 是纯内存 upsert，无需防抖）。

---

## 联调与验收

双仓工作流（不改 submodule）：

```bash
# kimi-code 工作克隆里 checkout PR #3114（或合并后的 main），起 server：
gh pr checkout 3114 && KIMI_CODE_CORS_ORIGINS="app://renderer,http://127.0.0.1:5174" pnpm dev:server
# code-app 指过去：
KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm dev:web      # 或 dev:desktop
```

验收清单：

- [ ] 归档会话（本端 / 另一客户端 / 冷归档）→ 侧栏实时移除、进「已完成」、无 `unhandled event` toast。
- [ ] 归档当前活跃会话 → 自动切换 / 清空，URL replace。
- [ ] 多工作区（≥3，含一个空工作区、含一个 >5 会话的工作区）全量刷新 → Network 里会话列表请求为 1 个 `view=by_workspace`；每组 5 条 + hasMore 正确；「展开更多」正常（v1）。
- [ ] 旧服务端（不带 PR 的 server）→ 自动回退，行为与现状一致，无报错。
- [ ] workspace 事件三项验证（见上节）。
- [ ] web + desktop 两端各过一遍；亮色/暗色无 UI 变化（本方案无 UI 改动）。

交付前：`pnpm typecheck && pnpm lint && pnpm test`；改两端共有文件后同步检查 `apps/web` 与 `apps/desktop` 副本一致（本方案改动集中在 `packages/app-core` / `packages/app-client` 共享层，两端天然一致）；更新 `apps/desktop/docs/native-todos.md` 侧栏条目的数据源描述；PR 前走 `changeset` skill（`patch`，只写 `kimi-code-app`）。

## 风险

- **帧形状偏差**：`sessionId` 在 payload 的位置/大小写以真实服务端帧为准，mapper 已做双读兜底；联调第一步先用 wscat/日志确认实际帧。
- **单请求全失败语义**：分组路径失败容忍度低于逐工作区并发（部分失败 → 全失败保留旧列表）。可接受：失败场景保留旧数据，下次刷新自然重试。
- **`createOrTouch` 的 `workspace.updated` 流量**：每次建会话一次全局广播，handler 为廉价内存操作，无请求放大。
