# Session / Workspace 共享类型契约

集中定义本 domain 中跨多个 Service 共享的类型。Service 独有的输入 / 输出类型（如 `SessionCreate`、`SessionUpdate`）就近内联在各自 reference 文件中。

## 通用查询与分页

```ts
interface CursorQuery {
  cursor?: string;
  limit?: number;
}

interface PageResponse<T> {
  items: T[];
  nextCursor?: string;
  total?: number;
}
```

## Workspace

```ts
interface Workspace {
  id: string;            // 派生：encodeWorkDirKey(root)
  root: string;          // 真相：绝对路径
  name?: string;
  pinned?: boolean;

  createdAt: number;
  updatedAt: number;
  lastOpenedAt?: number;

  sessionCount?: number; // 由 Index 派生
  git?: WorkspaceGitInfo;
}

interface WorkspaceGitInfo {
  isRepo: boolean;
  branch?: string;
  remoteUrl?: string;
}

interface WorkspaceBrowseRequest {
  path?: string;
  showHidden?: boolean;
}

interface WorkspaceBrowseResponse {
  cwd: string;
  parent?: string;
  entries: Array<{
    name: string;
    path: string;
    kind: "file" | "dir";
    isWorkspace?: boolean;
  }>;
}

interface WorkspaceHomeResponse {
  home: string;
  recent: Workspace[];
}
```

## Session

```ts
interface Session {
  id: string;
  workDir: string;       // 真相
  workspaceId: string;   // 派生：encodeWorkDirKey(workDir)
  cwd: string;

  title?: string;
  metadata?: SessionMetadata;

  parentSessionId?: string;
  childKind?: "fork" | "child";

  archived: boolean;

  createdAt: number;
  updatedAt: number;
  lastOpenedAt?: number;
}

interface SessionSummary {
  id: string;
  workDir: string;
  workspaceId: string;
  parentSessionId?: string;
  childKind?: "fork" | "child";

  title?: string;
  archived: boolean;

  createdAt: number;
  updatedAt: number;
  lastOpenedAt?: number;

  metadata?: SessionMetadata;
}

type SessionMetadata = Record<string, unknown>;
```

## Session 查询

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

## Runtime 状态

```ts
type SessionStatus =
  | "idle"
  | "running"
  | "waiting-approval"
  | "waiting-question"
  | "compacting"
  | "terminated"
  | "unknown"
  | "archived";

interface SessionStatusResponse {
  sessionId: string;
  status: SessionStatus;
  updatedAt: number;
}

interface SessionLiveState {
  sessionId: string;
  status: SessionStatus;

  activeTurnId?: string;
  pendingApprovalId?: string;
  pendingQuestionId?: string;
  promptDraft?: string;
}
```

## Repository / Index 存储型

Repository 的存储型可与对外 `Session` 不同；Index 的 Summary 存储字段是 `SessionSummary` 的子集与派生字段。

```ts
interface StoredSession {
  id: string;
  workDir: string;
  cwd: string;
  title?: string;
  metadata?: SessionMetadata;
  parentSessionId?: string;
  childKind?: "fork" | "child";
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt?: number;
}

interface StoredSessionCreate {
  workDir: string;
  cwd: string;
  title?: string;
  metadata?: SessionMetadata;
  parentSessionId?: string;
  childKind?: "fork" | "child";
}

interface StoredSessionUpdate {
  title?: string;
  metadata?: SessionMetadata;
  archived?: boolean;
  lastOpenedAt?: number;
}
```

## 派生关系

- `workspaceId = encodeWorkDirKey(workDir)`。
- `SessionSummary` 是 `Session` 的轻量字段子集，加上 `archived` 等查询需要的派生标记。
- `SessionStatus` 是投影，由 Runtime 维护，不进入 `Session` / `StoredSession`。
