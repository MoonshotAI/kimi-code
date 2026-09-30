# 11. 让兄弟节点共享状态或能力

How-to：把共享业务契约提供到共同父级，让兄弟节点注入同一对象。

## 选择边界

适用于持续共享状态、读取最新值、调用业务 action。只需一次通知时阅读 [兄弟事件](12-sibling-events.md)：可覆盖的 Ref 只承载最新值，逐条送达的消息走事件面。

```text
Parent：provide(Counter, shared)
├── Writer：useInject(Counter)，调用 increment
└── Reader：useInject(Counter)，观察 count
```

## 实现

片段中的 `Writer`、`Reader` 是已定义的子配方，均在同步 setup 中 `useInject(Counter)`。facade token 返回响应式可空 ref，读 `.value` 并按缺席处理三形态（见 [useInject](../reference/inject.md)）。Reader 使用 `watchEffect` 或 `watch` 观察 count；Writer 在需要时调用 increment。

```ts
interface CounterService {
  count: Ref<number>;
  increment(): void;
}

const Counter = createFacadeToken<CounterService>('counter');

const Parent = createUnit('parent', () => {
  const count = ref(0);
  provide(Counter, {
    count,
    increment: () => { count.value += 1; },
  });
  useChildren([
    { key: 'reader', recipe: Reader },
    { key: 'writer', recipe: Writer },
  ]);
});
```

1. 复用同一个 Token 对象，不在不同模块重新创建同名 token。
2. 先 provide，再挂载消费者。
3. 让共享对象暴露明确的状态与 actions；消费者不依赖兄弟的内部 Node 字段。
4. 把外部订阅的取消函数绑定到订阅者自己的生命周期。

## 孩子把契约挂到共同父级

DI 只沿祖先链解析。孩子若要把 face 提供给宿主 `resolve` 和兄弟 `useInject`，用 [useExpose](../reference/use-expose.md)：它登记在父节点，并把撤销自动绑到当前节点的清理栈。

```ts
const Counter = createFacadeToken<CounterService>('counter');

const Writer = createUnit('writer', () => {
  const count = ref(0);
  useExpose(Counter, {
    count,
    increment: () => { count.value += 1; },
  });
});

const Reader = createUnit('reader', () => {
  const counter = useInject(Counter);
  watchEffect(() => { void counter.value?.count.value; });
});

const Parent = createUnit('parent', () => {
  useChildren([
    { key: 'writer', recipe: Writer },
    { key: 'reader', recipe: Reader },
  ]);
});
```

certain token 的 `useInject` 不等稍后出现的 provider（缺席即抛错）；facade token 的可空 ref 允许任意顺序——provider 到场 / 卸载都会驱动 ref 更新，消费方读 `.value` 并处理 `undefined`。同一轮 `useChildren` 里仍建议「先发布、后消费」，让消费者在 setup 快照里就能拿到值。

挂到父级的条目必须随子提供者卸载而撤销，否则子节点消失后父级仍保留条目——`useExpose` 把这条规则做成了原语。

源码与验收依据：`packages/agent-core/src/kernel/hooks.ts` 的 `useExpose`，`test/kernel/runtime.test.ts` 与 `test/feature/feature.test.ts`。
