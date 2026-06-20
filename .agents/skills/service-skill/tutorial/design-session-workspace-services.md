# Tutorial：从业务需求推导 Session / Workspace Service 拆分

本教程**完全不引用任何现有代码**。我们只从一段产品需求出发，按 skill 的方法走到目标设计。

## 0. 起点：一段业务需求

产品方提出：

> 我们做一个本地 agent 开发工具。用户在一个或多个**项目目录**下工作，每个项目目录可以反复打开（叫 “workspace”）。在每个 workspace 下，用户可以发起多次 agent 对话，每次对话叫 “session”，会保留 title、metadata 和对话历史。
>
> 用户要做这些事：
>
> - 注册 / 看到 / 切换最近打开的 workspace；
> - 在 workspace 下创建 session、列出 session、归档 session、恢复、彻底删除；
> - 在“所有 workspace”视角下列出全部 session（用于全局搜索、整理）；
> - 从某个已有 session 复制出一份 fork，或在其下再开一个 child；
> - 实时看到某个 session 是 idle 还是 running、是否在等用户审批；
> - 浏览磁盘目录，把任意目录注册为新的 workspace。
>
> 删除 workspace 不应该删掉用户的目录，也不应该不知不觉删掉里面的 session。

只看这段话，不看任何代码。

## 1. 建立业务事实

把名词、动词、不变量列出来。

**实体**：

- Workspace：一个根目录上下文，带 name、最近打开时间。
- Session：一次对话，带 title、metadata、归档状态、父子关系。

**用户交互**：

| 交互 | 频次 | 是否改状态 |
|---|---|---|
| 列出最近 workspace | 频繁 | 否 |
| 列出某 workspace 下 session | 频繁 | 否 |
| 全局列出所有 session | 偶尔 | 否 |
| 列出某 session 的 children | 偶尔 | 否 |
| 创建 session | 频繁 | 是 |
| 改 title / metadata | 偶尔 | 是 |
| 归档 / 恢复 / 彻底删除 session | 偶尔 | 是 |
| fork / createChild | 偶尔 | 是 |
| 看 session 当前 status | 频繁 | 否（读投影） |
| 浏览目录 | 偶尔 | 否 |
| 把目录注册为 workspace | 偶尔 | 是 |
| 删除 workspace 注册项 | 偶尔 | 是（仅注册项） |

**不变量与约束**：

- Workspace 真相 = 根目录绝对路径；其它字段都是辅助。
- Session 真相 = 它属于哪个目录 + 自己的 metadata；status 不是真相。
- 删除 workspace 注册项 ≠ 删除 session。
- 删除 session 默认应可恢复。
- 列表常被打开，必须便宜。

## 2. 找 aggregate

按“一致性边界”切：

- Workspace aggregate：`root`、`name`、`pinned`、`lastOpenedAt`。
- Session aggregate：`workDir`、`title`、`metadata`、`archived`、`parentSessionId`、`childKind`。

派生字段（不是 aggregate 的真相）：

- `workspaceId = encodeWorkDirKey(workDir)`：Workspace 派生 id，也是 Session 引用 Workspace 的方式。
- `sessionCount`：Workspace 视角下的派生统计。
- `status` / `liveState`：Session 的运行时投影，不持久化。

## 3. 反面尝试（先犯一次错）

**尝试 A：单个 `SessionService` 干所有事。**

```ts
interface ISessionService {
  create(input): Promise<Session>;
  update(id, input): Promise<Session>;
  delete(id): Promise<void>;

  list(): Promise<Session[]>;
  listByWorkspace(workspaceId): Promise<Session[]>;
  listChildren(id): Promise<Session[]>;
  search(text): Promise<Session[]>;

  getStatus(id): Promise<Status>;
}
```

问题 Red Flag 命中：

- 一个 Service 同时承担 CRUD、多 scope list、运行时 status → **Command / Query / Runtime 混杂**。
- `list` 和 `listByWorkspace` 和 `listChildren` 字段不同、过滤不同 → 实现会**复制三份过滤排序**。
- `getStatus` 在同一个 Service 里 → 列表渲染时为了显示 status 容易触发 **list 触发 resume**。
- `delete(id)` 语义不清：是看不到还是真删？→ **删除语义不显式**。

## 4. 第二次尝试（按本 skill 拆）

按 Command / Query / Runtime 三分 + Workspace 独立：

| Service | 一句话职责 |
|---|---|
| `IWorkspaceService` | Workspace 注册表、root 解析、目录浏览 |
| `ISessionService` | Session 生命周期命令（含 fork / child / touch） |
| `ISessionQueryService` | Session 多 scope 列表 / 搜索 / 计数 |
| `ISessionRuntimeService` | Session 活状态投影 |

## 5. 统一 list

global、workspace、children 三个列表是同一个查询的不同 scope：

```ts
type SessionQueryScope =
  | { kind: "global" }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "children"; parentSessionId: string };

sessionQueryService.list({ scope, ...filters });

// 便捷封装
sessionQueryService.listByWorkspace(workspaceId, query);
sessionQueryService.listGlobal(query);
sessionQueryService.listChildren(parentId, query);
```

底层只有一份过滤 / 排序 / 分页 / 归档可见性实现。

## 6. 放对标识解析

`workspace_id → workDir` 由 Service 层完成：

```text
SessionQueryService.listByWorkspace(workspaceId)
  └─ WorkspaceService.resolveRoot(workspaceId) → workDir
       └─ SessionIndex.list({ scope: { kind: "workDir", workDir } })
```

REST / WebSocket / CLI / TUI 共享同一规则。

## 7. 把 runtime 拆出去

普通列表读 Index，不依赖 runtime：

```ts
sessionQueryService.listGlobal(query); // 不 resume 任何 Session
```

运行状态单独取：

```ts
sessionRuntimeService.getStatus(id); // 按 id 按需
sessionRuntimeService.onDidChangeStatus.subscribe(handler);
```

避免 list 时 resume 所有 session 的 anti-pattern。

## 8. 把删除语义拆开

```ts
sessionService.archive(id);  // 默认；列表不可见；可恢复
sessionService.restore(id);  // 取消归档
sessionService.purge(id);    // 硬删除；必须显式
```

Workspace 不级联：

```ts
workspaceService.delete(workspaceId); // 仅删注册项
// 真要清掉所有 session：
purgeWorkspace(workspaceId, { deleteSessions: true });
```

## 9. 校验：把交互再映射一遍

回到第 1 步的交互表，每一条都能落到一个方法：

| 交互 | 方法 |
|---|---|
| 列出最近 workspace | `WorkspaceService.recent()` |
| workspace 下列 session | `SessionQueryService.listByWorkspace(id, q)` |
| 全局列 session | `SessionQueryService.listGlobal(q)` |
| 列 children | `SessionQueryService.listChildren(parentId, q)` |
| 创建 session | `SessionService.create({ workspaceId })` 或 `{ workDir }` |
| 改 title / metadata | `SessionService.update(id, ...)` |
| 归档 / 恢复 / 删除 | `SessionService.archive` / `restore` / `purge` |
| fork / createChild | `SessionService.fork` / `createChild` |
| 看 status | `SessionRuntimeService.getStatus(id)` |
| 浏览目录 | `WorkspaceService.browse()` |
| 注册新 workspace | `WorkspaceService.createOrTouch(root)` |
| 删除 workspace 注册项 | `WorkspaceService.delete(id)` |

每个方法都有对应交互；没有“多出来”的方法；没有“没承接”的交互。

## 10. 写决策记录

- DR1：Workspace 不拥有 Session 生命周期。
- DR2：Session 删除默认 archive，硬删走 purge。
- DR3：global / workspace / children list 共用一个 query。
- DR4：普通 list 不依赖 runtime。
- DR5：业务标识在 Service 层解析。
- DR6：`workspace_id` 是 `workDir` 的派生字段。
- DR7：跨 aggregate 删除必须显式命名。

## 11. 归档

设计定稿后归档到：

- 跨 Service 叙述：[`explanation/domains/session-workspace.md`](../explanation/domains/session-workspace.md)
- 单 Service 契约：
  - [`reference/domains/session-workspace/workspace-service.md`](../reference/domains/session-workspace/workspace-service.md)
  - [`reference/domains/session-workspace/session-service.md`](../reference/domains/session-workspace/session-service.md)
  - [`reference/domains/session-workspace/session-query-service.md`](../reference/domains/session-workspace/session-query-service.md)
  - [`reference/domains/session-workspace/session-runtime-service.md`](../reference/domains/session-workspace/session-runtime-service.md)
- 共享类型：[`reference/domains/session-workspace/types.md`](../reference/domains/session-workspace/types.md)

不归档：

- 反面尝试 A（属于教学过程，不是定稿）。
- 任何迁移路径（属于 `plan-lifecycle__*`）。
- 任何现有代码引用（本 skill 不承载代码现状）。
