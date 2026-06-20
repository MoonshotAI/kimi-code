# SessionQueryService

## 职责

`ISessionQueryService` 拥有 Session 的读模型：list / search / filter / count / children。global list 和 workspace list 是同一个 query 的不同 scope。

## 拥有

- global list。
- workspace scoped list。
- children list。
- search、filter、sort、pagination。
- archived 可见性控制。
- `workspaceId → workDir` 在查询路径上的解析。

## 不拥有

- create / update / archive（→ `ISessionService`）。
- runtime status（→ `ISessionRuntimeService`）。
- workspace 注册项的读写（→ `IWorkspaceService`）。
- Session aggregate 的真相写入。

## 接口

```ts
interface ISessionQueryService {
  list(query: SessionListQuery): Promise<PageResponse<SessionSummary>>;
  count(query: SessionListQuery): Promise<number>;

  listByWorkspace(
    workspaceId: string,
    query?: Omit<SessionListQuery, "scope">,
  ): Promise<PageResponse<SessionSummary>>;

  listGlobal(
    query?: Omit<SessionListQuery, "scope">,
  ): Promise<PageResponse<SessionSummary>>;

  listChildren(
    parentSessionId: string,
    query?: Omit<SessionListQuery, "scope">,
  ): Promise<PageResponse<SessionSummary>>;
}
```

共享类型（`SessionSummary`、`SessionListQuery`、`SessionQueryScope`、`PageResponse`、`CursorQuery`）见 [`types.md`](types.md)。

## 依赖

- `ISessionIndex`：读取列表读模型和计数。
- `IWorkspaceService`：把 `workspaceId` 解析成 `workDir`。

## 关键约束

- `listByWorkspace` / `listGlobal` / `listChildren` 都是 `list()` 的薄封装，不复制实现。
- 列表查询读 `ISessionIndex`，不触发 agent resume、不读取 runtime 投影。
- 过滤、排序、分页、归档可见性逻辑只有一份实现。
- `archived` 默认 `"exclude"`；`orderBy` 默认 `"updatedAt"`，`orderDir` 默认 `"desc"`。

## 决策记录

- **DR-Q1：global / workspace / children 共用同一查询模型。** 区别只是 `scope`。
- **DR-Q2：list 不依赖 runtime。** 状态增强由 `ISessionRuntimeService` 按 id 按需提供。
- **DR-Q3：业务标识解析在 Service 层。** transport 不承载 `workspace_id → workDir`。
