# protocol：五个核心类型

源码：`doing/refact-237-09-16-human-domain-features/packages/agent-core-v2/src/store-v2/store.ts`（protocol 接口已并入 `store.ts` 顶部，无独立 `protocol.ts`；引用一律从 `#/store-v2/store` 导入）

```ts
export interface Event {
  readonly type: string;
}

export interface Entry<E extends Event, C> {
  readonly event: E;
  readonly cursor: C;
}

export interface Journal<E extends Event, C> {
  read(): Promise<readonly Entry<E, C>[]>;
  append(event: E): Promise<Entry<E, C>>;
  close(): Promise<void>;
}

export interface Projection<S, E extends Event, C> {
  initial(): S;
  reduce(state: S, event: E, cursor: C): S;
  restore?(entries: readonly Entry<E, C>[]): S;
}

export interface View<S> {
  getState(): S;
  subscribe(listener: (state: S) => void): () => void;
  dispose(): void;
}

export interface Store<S, E extends Event, C> extends Omit<View<S>, 'dispose'> {
  readonly phase: 'open' | 'failed' | 'closing' | 'closed';
  dispatch(event: E): Promise<Entry<E, C>>;
  onCommit(listener: (entry: Entry<E, C>, state: S) => void): () => void;
  attach<T>(projection: Projection<T, E, C>): View<T>;
  project<T>(projection: Projection<T, E, C>): Promise<View<T>>;
  refresh(change?: () => Promise<unknown>): Promise<void>;
  close(): Promise<void>;
}
```

## 逐条要点

- **Event**：内核只要求 `type: string`。`agentId`/`time`/`seq`/`branch`/版本号不塞进基础类型——它们分属领域归属、业务时间、日志顺序、历史组织、格式版本。
- **Entry**：一次提交的完整落点。`cursor` 由 journal 分配，对内核不透明；projection 的 `reduce` 可以拿到它（turn 索引用它记录切点）。
- **Journal**：只有读全部、追加、关闭三个方法。branch / create / checkout 属于 tree driver 扩展（见 [drivers](drivers.md)）。大字段外置走 [Blobs](blobs.md)，不是 Journal 方法。只读场景只暴露 reader，不伪装成可写 store。
- **Projection.restore?**：可选。没有它时 `replay` 用 `initial + 逐条 reduce` 重建；有它时 `replay` 直接委托。`withHistory` 就是靠安装 `restore` 实现历史视图选择的（见 [composition](composition.md)）。
- **View**：一个投影的只读面。`dispose()` 后 `subscribe` 抛 `View is disposed`；退订函数从 `subscribe` 返回。
- **Store.attach**：v3 用打开后缓存的 `history` 同步 replay 新视图。`project` 把同一次 attach 放进串行队列。
- **Store.phase**：`'open' | 'failed' | 'closing' | 'closed'`，只读。进入 `failed` 后所有后续写操作拒绝，必须重建。

## 类型参数的含义

- `S`：投影状态，不必是 KV——可以是数组、计数器、树、组合状态。
- `E extends Event`：写入 journal 的事件类型，与投影消费的是同一份。
- `C`：cursor 类型，各 driver 自定，对内核只是占位符。
