# WorkspaceService

## 职责

`IWorkspaceService` 拥有 Workspace 这个 aggregate：根目录注册项、display name、recent 状态、root 解析和目录浏览。

## 拥有

- workspace 注册表 CRUD。
- `workspace_id → root` 解析。
- recent workspaces 维护。
- workspace 根目录浏览。
- git 信息探测或缓存（可选）。

## 不拥有

- Session 生命周期。
- Session list / search / count 的具体实现。
- 磁盘目录的真实删除（仅删注册项）。
- 跨 aggregate 的级联删除。

## 接口

```ts
interface IWorkspaceService {
  list(): Promise<Workspace[]>;
  recent(limit?: number): Promise<Workspace[]>;
  get(workspaceId: string): Promise<Workspace>;

  createOrTouch(root: string, name?: string): Promise<Workspace>;
  update(workspaceId: string, input: WorkspaceUpdate): Promise<Workspace>;
  delete(workspaceId: string): Promise<void>;

  resolveRoot(workspaceId: string): Promise<string>;

  browse(input?: WorkspaceBrowseRequest): Promise<WorkspaceBrowseResponse>;
  home(): Promise<WorkspaceHomeResponse>;
}

interface WorkspaceUpdate {
  name?: string;
  pinned?: boolean;
}
```

共享类型（`Workspace`、`WorkspaceBrowseRequest`、`WorkspaceBrowseResponse`、`WorkspaceHomeResponse`）见 [`types.md`](types.md)。

## 依赖

- `IWorkspaceStore`：读写 workspace 注册表。
- `ISessionIndex`：获取 `session_count` 或 recent session 摘要（避免依赖 `ISessionQueryService` 形成循环）。
- 文件系统 / git 基础设施：目录浏览和 git 信息探测。

## 关键约束

- `delete(workspaceId)` 只删除注册项，不动磁盘目录，不删 Session。
- 如果需要删除 workspace 下所有 Session，必须提供独立的高阶命令，例如 `purgeWorkspace(workspaceId, { deleteSessions: true })`，不能藏在 `delete` 里。
- `workspace_id` 可由 `root` 推导，但 `root` 是真相字段。

## 决策记录

- **DR-W1：Workspace 不拥有 Session 生命周期。** Workspace 只是 Session 查询 scope 和 root 解析来源。
- **DR-W2：`delete` 不级联。** 跨 aggregate 删除必须显式命名。
- **DR-W3：`session_count` 依赖 Index，不依赖 Query Service。** 避免 `IWorkspaceService ⇄ ISessionQueryService` 循环。
