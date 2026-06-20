# SessionService

## 职责

`ISessionService` 拥有 Session aggregate 的生命周期命令：创建、读取、更新、归档、恢复、硬删除、fork、child、touch。

## 拥有

- Session create / get / update。
- archive / restore / purge。
- fork / createChild。
- title、metadata、parent / child 关系的写入。
- create 时解析 `workspaceId` 或 `workDir`。
- `lastOpenedAt` 维护（`touch`）。
- 生命周期事件的发布。

## 不拥有

- list / search / count（→ `ISessionQueryService`）。
- runtime status（→ `ISessionRuntimeService`）。
- workspace 注册表（→ `IWorkspaceService`）。
- 列表排序、分页、过滤。

## 接口

```ts
interface ISessionService {
  create(input: SessionCreate): Promise<Session>;
  get(id: string): Promise<Session>;
  update(id: string, input: SessionUpdate): Promise<Session>;

  archive(id: string): Promise<{ archived: true }>;
  restore(id: string): Promise<Session>;
  purge(id: string): Promise<{ deleted: true }>;

  fork(id: string, input: SessionFork): Promise<Session>;
  createChild(id: string, input: SessionChildCreate): Promise<Session>;

  touch(id: string): Promise<void>;
}

type SessionCreate =
  | {
      workspaceId: string;
      cwd?: string;
      title?: string;
      metadata?: SessionMetadata;
    }
  | {
      workDir: string;
      cwd?: string;
      title?: string;
      metadata?: SessionMetadata;
    }
  | {
      workspaceId: string;
      workDir: string;
      cwd?: string;
      title?: string;
      metadata?: SessionMetadata;
    };

interface SessionUpdate {
  title?: string;
  metadata?: SessionMetadata;
}

interface SessionFork {
  title?: string;
  metadata?: SessionMetadata;
  // 由 domain 进一步定义 fork 起点等参数
}

interface SessionChildCreate {
  title?: string;
  metadata?: SessionMetadata;
  // 由 domain 进一步定义 child 类型等参数
}
```

共享类型（`Session`、`SessionMetadata`）见 [`types.md`](types.md)。

## 依赖

- `ISessionRepository`：单条 Session 持久化读写。
- `ISessionIndex`：创建 / 更新 / 删除后维护读模型。
- `IWorkspaceService`：解析或创建 workspace。
- 事件总线：发布 Session 生命周期事件。

## 关键约束

- `workspaceId` 和 `workDir` 同时传入时，必须校验 `encodeWorkDirKey(workDir) === workspaceId`。
- Session 的持久化真相是 `workDir`；`workspace_id` 是对外暴露的派生字段。
- 删除默认是 `archive`；硬删除必须叫 `purge`。
- 任意状态变更后必须触发 `ISessionIndex.upsert`，保证读模型一致。

## 决策记录

- **DR-S1：删除默认 archive。** 硬删除走显式 `purge`。
- **DR-S2：create 接受多形态标识。** `workspaceId` 与 `workDir` 共存的 union；同时传入校验一致。
- **DR-S3：`workspace_id` 是派生字段。** Session 真相是 `workDir`。
- **DR-S4：派生构造命名业务化。** `fork` 与 `createChild` 命名反映业务语义，不统一叫 `create`。
