# Runtime Service Pattern

## 适用场景

某个 aggregate 存在**不属于持久化真相的活状态**：status、active turn、当前 approval、prompt 状态、连接情况等。这些状态：

- 由进程内对象 / 事件流推导；
- 在重启后可由真相 + 事件回放重建；
- 不应该写回 aggregate 真相，也不该让普通列表为了显示它而 resume 全部对象。

## 拥有

- 按 id 读取活状态：`getStatus(id)` / `getLiveState(id)`。
- 活状态变化事件订阅。
- 从事件流到投影的维护逻辑。

## 不拥有

- aggregate 的持久化（→ Repository）。
- list / search / count（→ Query Service）。
- 写入 aggregate 真相字段（→ Command Service）。
- 跨 aggregate 的编排。

## 通用接口骨架

```ts
interface IRuntimeService<Status, LiveState> {
  getStatus(id: string): Promise<Status>;
  getLiveState(id: string): Promise<LiveState>;

  readonly onDidChangeStatus: Event<{ id: string; status: Status }>;
}
```

## 决策点

- **投影 ≠ 真相。** 明确说明该 Service 的输出是投影；重启后由事件流重建，不是 aggregate 字段。
- **列表不依赖 runtime。** Query Service 的 list 不能在内部调用 Runtime Service。
- **状态增强是 per-id、按需触发。** 例如展示当前页时，对当前页里 N 条 id 分别调 `getStatus`，而不是把 status 作为 list 默认字段。
- **事件订阅的传播范围。** 决定订阅是进程内还是跨进程；是 push 还是 long-poll；订阅断开后如何重连和补偿。
- **冷态读取语义。** 如果 aggregate 已归档或对应运行时不存在，`getStatus` 返回什么？显式定义“冷态” / “未知” / “已终止”等枚举值，不要静默返回默认值。
