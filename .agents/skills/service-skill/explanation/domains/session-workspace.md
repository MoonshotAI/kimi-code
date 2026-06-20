# Session / Workspace Service 目标架构定稿

本文是**概念定稿**：不引用当前代码结构、不预设迁移路径。只描述目标形态、依赖方向和决策记录。

## 目录

- [结论](#结论)
- [第一性原理](#第一性原理)
- [Service 拆分概览](#service-拆分概览)
- [统一 Session Query 模型](#统一-session-query-模型)
- [关键场景](#关键场景)
- [派生交互映射](#派生交互映射)
- [依赖方向与边界](#依赖方向与边界)
- [决策记录](#决策记录)

## 结论

目标架构里：

- `WorkspaceService` 管“目录上下文”：workspace 注册表、root 解析、最近打开、目录浏览。
- `SessionService` 管“会话生命周期”：create / get / update / archive / restore / purge / fork / child。
- `SessionQueryService` 管“会话读模型”：list / search / count / children。
- `SessionRuntimeService` 管“活状态”：status、active turn、approval、question、prompt 状态。

**workspace 下 list Session 和全局 list Session 不是两套接口，而是同一个 Session Query 的两个 scope。**

接口定义见 `reference/domains/session-workspace/`，本文只承载跨 Service 的概念叙述。

## 第一性原理

### 1. 一个 aggregate 只由一个 Service 拥有

Session 和 Workspace 是两个独立 aggregate：

- Workspace 描述“某个根目录 / 项目上下文”。
- Session 描述“一次会话 / agent 运行上下文”。

因此：

- Workspace 删除注册项，不级联删除 Session。
- Session 引用 Workspace，但生命周期不由 Workspace 拥有。
- Workspace 可作为 Session 查询 scope，但不重复实现 Session list。

### 2. 命令 / 查询 / 运行时状态分开

| 类型 | 关注 | 归属 |
|---|---|---|
| Command | 改变生命周期 | `SessionService` |
| Query | 列表、搜索、筛选、计数 | `SessionQueryService` |
| Runtime | 活状态、运行中信息 | `SessionRuntimeService` |

普通列表不为了显示状态而 resume 所有 Session。列表默认读 index；状态增强只作用于当前页或用户明确打开的 Session。

### 3. 统一查询，而不是按入口重复实现

`workspace 下 list` 和 `全局 list` 只是同一个查询的不同 scope：

```text
listSessions(scope = workspace)
listSessions(scope = global)
listSessions(scope = children)
```

所有过滤、排序、分页、归档可见性只能有一份实现。

### 4. Service 层解析标识

`workspace_id`、`workDir`、`parentSessionId` 都在 Service 层解析和校验，不让 transport 层承载业务规则。

### 5. 持久化真相与派生索引分开

- Repository 保存 aggregate 真相。
- Index 保存用于 list / search / count 的轻量读模型。
- `workspace_id` 是 `workDir` 的派生字段；查询索引可冗余存储以提升效率，但真相是 `workDir`。

## Service 拆分概览

| Service | 一句话职责 | 详细契约 |
|---|---|---|
| `IWorkspaceService` | Workspace 注册表、root 解析、目录浏览 | [reference](../../reference/domains/session-workspace/workspace-service.md) |
| `ISessionService` | Session aggregate 的生命周期命令 | [reference](../../reference/domains/session-workspace/session-service.md) |
| `ISessionQueryService` | Session 的读模型（list / search / count / children） | [reference](../../reference/domains/session-workspace/session-query-service.md) |
| `ISessionRuntimeService` | Session 的活状态（status / live state / 事件） | [reference](../../reference/domains/session-workspace/session-runtime-service.md) |

共享类型见 [types.md](../../reference/domains/session-workspace/types.md)。

## 统一 Session Query 模型

```ts
type SessionQueryScope =
  | { kind: "global" }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "workDir"; workDir: string }
  | { kind: "children"; parentSessionId: string };

interface SessionListQuery extends CursorQuery {
  scope?: SessionQueryScope;

  status?: SessionStatus | SessionStatus[];
  archived?: "exclude" | "include" | "only";

  parentSessionId?: string | null;
  childKind?: "fork" | "child";

  search?: string;
  tags?: string[];

  createdAfter?: string;
  createdBefore?: string;
  updatedAfter?: string;
  updatedBefore?: string;

  orderBy?: "updatedAt" | "createdAt" | "title" | "lastOpenedAt";
  orderDir?: "asc" | "desc";
}
```

默认行为：

- `scope` 省略时等价于 `{ kind: "global" }`。
- `archived` 默认 `"exclude"`。
- `orderBy` 默认 `"updatedAt"`，`orderDir` 默认 `"desc"`。

## 关键场景

### 场景 A：在某个 Workspace 下列 Session

```ts
sessionQueryService.listByWorkspace(workspaceId, query);
```

内部解析：

```text
workspace_id → root → workDir → SessionIndex.list({ scope: { kind: "workDir", workDir } })
```

### 场景 B：全局 list Session

```ts
sessionQueryService.listGlobal(query);
```

内部解析：

```text
SessionIndex.list({ scope: { kind: "global" } })
```

### 场景 C：查看 children

```ts
sessionQueryService.listChildren(parentSessionId, query);
```

内部解析：

```text
SessionIndex.list({ scope: { kind: "children", parentSessionId } })
```

## 派生交互映射

| 用户交互 | 对应 Service 方法 |
|---|---|
| 从 workspace 创建 session | `SessionService.create({ workspaceId })` |
| 从绝对目录创建 session | `SessionService.create({ workDir })` |
| 查看 session 详情 | `SessionService.get(id)` |
| 重命名 session | `SessionService.update(id, { title })` |
| 更新 metadata | `SessionService.update(id, { metadata })` |
| 标记最近打开 | `SessionService.touch(id)` |
| 归档 session | `SessionService.archive(id)` |
| 恢复 session | `SessionService.restore(id)` |
| 永久删除 | `SessionService.purge(id)` |
| fork session | `SessionService.fork(id, input)` |
| 创建 child session | `SessionService.createChild(id, input)` |
| workspace 列表 | `SessionQueryService.listByWorkspace(workspaceId, query)` |
| 全局列表 | `SessionQueryService.listGlobal(query)` |
| 查看 children | `SessionQueryService.listChildren(parentId, query)` |
| 搜索 session | `SessionQueryService.list({ search })` |
| 查看已归档 | `SessionQueryService.list({ archived: "only" })` |
| 查看运行状态 | `SessionRuntimeService.getStatus(id)` |
| 订阅状态变化 | `SessionRuntimeService.onDidChangeStatus` |
| workspace 注册表 | `WorkspaceService.list()` / `WorkspaceService.recent()` |
| workspace 目录浏览 | `WorkspaceService.browse()` |

## 依赖方向与边界

概念分层（不引用任何具体实现层 Service）：

```text
Application Service
  IWorkspaceService
  ISessionService
  ISessionQueryService
  ISessionRuntimeService

Domain / Persistence
  IWorkspaceStore
  ISessionRepository
  ISessionIndex

Infrastructure
  事件总线
  外部进程 / 运行时
  文件系统
```

依赖关系：

```text
ISessionService        → ISessionRepository, ISessionIndex, IWorkspaceService
ISessionQueryService   → ISessionIndex, IWorkspaceService
ISessionRuntimeService → (Runtime projection sources)
IWorkspaceService      → IWorkspaceStore, ISessionIndex
```

禁止的循环：

```text
IWorkspaceService ⇄ ISessionQueryService
```

如果 `WorkspaceService` 需要 `session_count`，依赖低层 `ISessionIndex`，而不是 `ISessionQueryService`。

## 决策记录

- **DR1：Workspace 不拥有 Session 生命周期。** Workspace 只是 Session 查询 scope 和 root 解析来源。
- **DR2：Session 删除默认是 archive。** 硬删除使用显式 `purge`。
- **DR3：global list 与 workspace list 共用同一查询模型。** 区别只是 `scope`。
- **DR4：普通 Session list 不依赖 runtime。** 列表读 index，状态由 `SessionRuntimeService` 单独提供。
- **DR5：业务解析放在 Service 层。** transport 只负责参数映射，不承载 `workspace_id → workDir` 这类业务规则。
- **DR6：`workspace_id` 是 `workDir` 的派生字段。** Session 持久化真相是 `workDir`；同时传入时必须校验一致。
- **DR7：跨 aggregate 删除必须显式命名。** `WorkspaceService.delete` 不删 Session；要级联删除时使用专门的高阶命令。
