# 让兄弟节点共享状态或能力

How-to：把共享业务契约提供到共同父级，让兄弟节点注入同一对象，而不是互相查找 Node。

## 选择边界

适用于持续共享状态、读取最新值、调用业务 action。只需一次通知时阅读 [兄弟事件](sibling-events.md)；不要用一个可覆盖的 Ref 冒充必须逐条送达的消息队列。

```text
Parent：provide(Counter, shared)
├── Writer：inject(Counter)，调用 increment
└── Reader：inject(Counter)，观察 count
```

## 实现

片段中的 `Writer`、`Reader` 是已定义的子配方，均在同步 setup 中 `inject(Counter)`。Reader 使用 `watchEffect` 或 `watch` 观察 count；Writer 在需要时调用 increment。

```ts
interface CounterService {
  count: Ref<number>;
  increment(): void;
}

const Counter = createToken<CounterService>('counter');

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

DI 只沿祖先链解析。孩子若要把 face 提供给宿主 `resolve` 和兄弟 `inject`，用 [useExpose](../reference/use-expose.md)，不要手写 `parent.provide` 再自己绑撤销。

```ts
const Counter = createToken<CounterService>('counter');

const Writer = createUnit('writer', () => {
  const count = ref(0);
  useExpose(Counter, {
    count,
    increment: () => { count.value += 1; },
  });
});

const Reader = createUnit('reader', () => {
  const counter = inject(Counter);
  watchEffect(() => { void counter.count.value; });
});

const Parent = createUnit('parent', () => {
  useChildren([
    { key: 'writer', recipe: Writer },
    { key: 'reader', recipe: Reader },
  ]);
});
```

Writer 必须先于 Reader 挂载：`inject` 不等稍后出现的 provider。Feature slot 由产品节点 `provide` 之后再 `useChildren`，同一轮里列表顺序仍要满足「先发布、后消费」。

不要手工向父级 provide 后忘记把 withdraw 绑定到子提供者的清理，否则子节点消失后父级可能仍保留条目。`useExpose` 就是这条规则的原语。

源码与验收依据：v3 `kernel/hooks.ts` 的 `useExpose`，`test/kernel/runtime.test.ts` 与 `test/feature/feature.test.ts`。
