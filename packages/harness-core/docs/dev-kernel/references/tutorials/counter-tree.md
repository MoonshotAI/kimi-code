# 启动、观察并卸载一棵计数树

Tutorial：通过一个完整程序体验宿主启动、异步门控、依赖注入、事件上报与动态卸载。

目录：[准备](#准备) · [运行程序](#运行程序) · [检查结果](#检查结果)

## 准备

1. 按 [代码定位](../reference/source-map.md) 找到含 `human/kernel` 的核心 checkout，并使用其现有 Node / pnpm / tsx 环境。
2. 将下面唯一的 TypeScript 代码块保存到该 checkout 的 `.tmp/kernel-tutorial.ts`；不是 code-app 的 `.tmp/`。
3. 这是可丢弃的学习程序，不加入产品源码或测试套件，不新增依赖。

## 运行程序

```ts
import assert from 'node:assert/strict';
import {
  createToken,
  createUnit,
  inject,
  mountRoot,
  provide,
  ref,
  shallowRef,
  useChildren,
  useFire,
  useNode,
  useOn,
  useReady,
  watchEffect,
  type ChildEntry,
  type Ref,
} from '../packages/agent-core-v2/src/human/kernel/index.ts';

type CounterService = {
  count: Ref<number>;
  increment(): void;
};

type RootProps = {
  children: Ref<ChildEntry[]>;
  loadSeed(signal: AbortSignal): Promise<number>;
};

const Counter = createToken<CounterService>('counter');
const observations: number[] = [];
const events: number[] = [];
const closed: string[] = [];

const Observer = createUnit('observer', () => {
  const counter = inject(Counter);
  const fire = useFire();
  watchEffect(() => {
    const value = counter.count.value;
    observations.push(value);
    fire({ type: 'counter.observed', value });
  });
  return () => { closed.push('observer'); };
});

const Root = createUnit<RootProps>('root', (props) => {
  const node = useNode();
  const count = ref(0);
  const initialized = ref(false);
  provide(Counter, {
    count,
    increment: () => { count.value += 1; },
  });
  useOn<{ type: 'counter.observed'; value: number }>(
    'counter.observed',
    (event) => { events.push(event.value); },
  );
  useReady(props.loadSeed(node.signal).then((seed) => {
    if (node.signal.aborted) return;
    count.value = seed;
    initialized.value = true;
  }));
  useChildren(() => initialized.value ? props.children.value : []);
  return () => { closed.push('root'); };
});

async function main() {
  const children = shallowRef<ChildEntry[]>([
    { key: 'observer', recipe: Observer },
  ]);
  const { node, handle } = mountRoot(Root, {
    children,
    loadSeed: async () => 3,
  });

  try {
    await handle.ready();
    assert.deepEqual(observations, [3]);
    node.resolve(Counter).increment();
    assert.deepEqual(events, [3, 4]);
    children.value = [];
    await handle.ready();
    node.resolve(Counter).increment();
    assert.deepEqual(observations, [3, 4]);
  } finally {
    await handle.unmount();
  }

  assert.deepEqual(closed, ['observer', 'root']);
  assert.equal(node.signal.aborted, true);
  assert.equal(handle.state, 'unmounted');
  console.log('kernel tutorial: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

在核心 checkout 根目录执行：

```bash
pnpm exec tsx .tmp/kernel-tutorial.ts
```

## 检查结果

应输出 `kernel tutorial: ok`，并且所有断言通过：

- Observer 第一次看到 3，而不是初始化前的 0，说明门控生效。
- 宿主通过 node.resolve 取得共享服务并调用 action，无需 setup 上下文。
- 子节点事件被 Root 的监听器接收。
- 从 children 移除 Observer 后，再修改状态不会增加观察记录。
- 子节点先清理，Root 后清理，最终 signal 已取消、handle 已卸载。

下一步按任务选择 [单原语契约](../../llms.txt)；练习完成后删除临时程序。
