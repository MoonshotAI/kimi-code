# SessionRuntimeService

## 职责

`ISessionRuntimeService` 拥有 Session 的运行时活状态：status、active turn、approval、question、prompt 状态。

## 拥有

- `getStatus(id)`。
- `getLiveState(id)`。
- 状态变化事件。
- runtime projection 的读取与维护。

## 不拥有

- Session 元数据持久化（→ `ISessionService`）。
- Session list（→ `ISessionQueryService`）。
- workspace 解析（→ `IWorkspaceService`）。
- archive / restore / purge。

## 接口

```ts
interface ISessionRuntimeService {
  getStatus(id: string): Promise<SessionStatusResponse>;
  getLiveState(id: string): Promise<SessionLiveState>;

  readonly onDidChangeStatus: Event<{
    sessionId: string;
    status: SessionStatus;
  }>;
}
```

共享类型（`SessionStatus`、`SessionStatusResponse`、`SessionLiveState`）见 [`types.md`](types.md)。

## 依赖

- Runtime projection 源（如事件流、外部进程通信）。

## 关键约束

- 普通 list 不依赖 runtime。
- 若列表需要展示状态，只对当前页或用户明确打开的 Session 做增强查询（per-id `getStatus`）。
- Runtime 状态是投影，不写回 Session aggregate 真相。
- 冷态读取（aggregate 已归档 / 运行时不存在）必须返回明确枚举值，不静默返回默认。

## 决策记录

- **DR-R1：投影 ≠ 真相。** 进程重启后由事件流重建，不写回真相。
- **DR-R2：list 与 runtime 分离。** Query Service 不依赖 Runtime Service。
- **DR-R3：状态增强按 id 按需。** 不作为 list 默认字段。
