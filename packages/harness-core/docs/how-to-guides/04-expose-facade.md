# 4. 把 Feature 的 facade 暴露出去

How-to：接着 compaction，用 token + `useExpose` 给出宿主可调用的面。不要让外部 `node.resolve`，不要把可选 Feature 写进 Session 字段。对照：`src/features/compaction/feature.ts`。

## 约定

1. `createToken` 一个 facade 类型。
2. 在拥有该能力的 slot 里 `useExpose(Token, face)`——挂到**父节点**，随本节点撤销。
3. 包入口导出 Token 与类型。
4. 宿主 `handle.resolve(Token)`。`resolve` 从该节点自身再祖先找，不看兄弟和后代。

| facade 挂在哪 | 怎么取 |
|---|---|
| agent slot（`CompactionRef` / `TodoRef` / `UsageRef`） | `agent.resolve(CompactionRef)` |
| session slot（`InteractionRef`） | `session.resolve(InteractionRef)` |
| app slot（`ProviderCatalogRef`） | `app.resolve(ProviderCatalogRef)` |

缺失 token 抛错。

## compaction 的 facade

controller 可以自动跑（[3](03-listen-and-trigger.md)）。宿主还要能手动压、取消、看状态：

```ts
export type CompactionFace = Pick<CompactionController, 'compact' | 'cancel' | 'status'>;

export const CompactionRef = createToken<CompactionFace>('compaction');

export function createCompaction(deps: CreateCompactionDeps): FeatureSpec {
  return createFeature('compaction', {
    agent() {
      const agent = useAgent();
      const session = useSession();
      const controller = createCompactionController({
        ...deps,
        agentId: agent.agentId,
        agent,
        stores: session.stores,
      });
      useBeforeStep(controller.onBeforeStep);
      useExpose(CompactionRef, {
        compact: (instruction) => controller.compact(instruction),
        cancel: () => controller.cancel(),
        status: () => controller.status(),
      });
      pushCleanup(useNode(), () => controller.dispose());
    },
  });
}
```

`compact(instruction?)` 走 `reason: 'manual'`，返回 `{ branchId }`。忙或 agent 不在则抛 `CompactError`。

## 宿主怎么调

```ts
const compaction = agent.resolve(CompactionRef);
compaction.status();
const { branchId } = await compaction.compact('保留最近的决策，丢掉重复的工具输出');
compaction.cancel();
```

有自己的节点事件时，把联合类型挂在配方上：`createFeature<E>('name', …)`，订阅写成 `session.on(feature, type)`。compaction 落盘的是 session journal 上的 `compaction.*` 字符串事件，不是 `createFeature<CompactionEvent>`（那是机器载荷，形状不同）。

Todo 同一套：`agent.resolve(TodoRef).items.value`。

## 相关文档

- 自动触发 → [03](03-listen-and-trigger.md)
- Feature 模型 → [feature-model](../explanation/feature-model.md)
- 下一篇：可后台的 Tool → [05](05-background-tool.md)
