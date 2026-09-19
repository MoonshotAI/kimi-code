# 8. 开发一个 Feature

How-to：在 `packages/harness-core/src/features/<name>/` 落地一个产品能力，能被 preset 或宿主名单装上，卸载后不留工具、订阅和 facade。

对照样板：Todo 三块见 [2](02-add-todo-feature.md)；可后台工具见 [5](05-background-tool.md)；facade 见 [4](04-expose-facade.md)。最小用 agent-core `builtin/wait-for`；带构造依赖用 `createCompaction` / `createMedia`。

## 1. 定层和目录

跨会话单例 → `app()`。会话共享 → `session()`。跟 agent journal / 工具 / turn hook 绑定 → `agent()`。可以同时占多层。

```text
src/features/<name>/
  feature.ts      # 唯一的 createFeature
  index.ts        # 导出 FeatureSpec、token、类型
  projection.ts   # 自有事件的 fold（可选）
  tool.ts         # 单工具；多工具用 tools/<name>.ts
  <name>.md       # 工具说明，?raw 导入
```

测试放包根 `test/features/<name>.test.ts`，不放 `src/`。

## 2. 写 setup

setup 必须同步。`await` 之后不能再调 hook。异步就绪用 `useReady`。

```ts
import { createFeature, useAgent, useAgentStore, useAgentTools } from '@moonshot-ai/agent-core';
import { computed, createToken, useExpose, type Ref } from '@moonshot-ai/agent-core/kernel/index';

export interface DemoFace {
  readonly items: Ref<readonly string[]>;
}

export const DemoRef = createToken<DemoFace>('demo');

export const demo = createFeature('demo', {
  agent() {
    const store = useAgentStore();
    const state = store.fold(demoProjection);
    useAgentTools(createDemoTool(store));
    useExpose(DemoRef, { items: computed(() => state.value.items) });
  },
});
```

`index.ts` 导出 `demo`、`DemoRef`、类型。需要事件泛型时写成 `createFeature<DemoEvent>('demo', …)`。

## 3. 选贡献点

| 目的 | hook |
|---|---|
| 给模型一个工具 | `useAgentTools(definition)` |
| 叠一段 system prompt | `useSystemPrompt({ id, text, priority? })`，`id` 不能是 `host` |
| 每步 LLM 前拦截 | `useBeforeStep` |
| 改 / 拒工具 | `useBeforeTool` / `useAfterTool` |
| 拦或改用户 prompt | `usePromptGate` |
| 订机器事件做副作用 | `useAgent().on('turn.started', …)` |
| 自有持久化状态 | `store.dispatch` + `store.fold` |
| 给宿主 facade | `useExpose` |
| 发节点事件 | `useFire()`，type 建议 `featureName.*` |

工具 `execute` 不在 setup 里跑，不能在 execute 里 `inject`。需要 `WaitForTasks` 时在 setup 闭包捕获 `useWaitForTasks()`。

## 4. 自有事件与投影

agent journal 是开放的 `RecordEvent`。`decodeAgent` 只认识 `input.submitted` / `message.appended` / `turn.started` / `turn.ended`，其它 type 原样留下，供 Feature 投影：

```ts
export const DEMO_UPDATED = 'demo.updated';

export const demoProjection: Projection<DemoState, RecordEvent, BranchRef> = {
  initial: () => ({ items: [] }),
  reduce: (state, event) => {
    if (event.type === DEMO_UPDATED) {
      return { items: event['items'] as string[] };
    }
    return state;
  },
};
```

reducer 同步、确定、不做 I/O。大字段先 `useBlobs().put`，事件只带 `ref`。

session 级事实（compaction 记录、roster）走 `useSessionStore()`。

## 5. 多层与清理

session 持有、agent 消费：

```ts
export const interaction = createFeature<InteractionEvent>('interaction', {
  session() {
    const fire = useFire();
    const interactions = openInteractions({ fire });
    useExpose(InteractionRef, interactions);
    pushCleanup(useNode(), () => interactions.stop());
  },
  agent() {
    const interactions = useInteractions();
    useAgentTools(createAskUserQuestionTool(interactions, { /* ids */ }));
    pushCleanup(useNode(), () => {
      interactions.cancelAgent(useAgent().agentId, 'agent_closed');
    });
  },
});
```

`use*` 贡献点已经 `pushCleanup`。自己开的表、actor、timer 必须显式 `pushCleanup`。不要假定父节点会扫后代资源。

## 6. 推进名单

常量 Feature 写进 `src/preset.ts` 的 `features`。工厂 Feature 留给宿主：

```ts
mountApp({
  features: [...features, createMedia({ source, cache }), createCompaction(deps)],
});
```

包入口 `src/index.ts` 转导出 spec 与 token。跨 Feature 只 export token / collection，不 export 对方内部模块。

## 7. 宿主怎么验

```ts
const session = await app.open({ sessionId: 's' });
const face = session.resolve(DemoRef);
session.on(demo, 'demo.updated', (event) => { /* … */ });
```

HTTP 不是默认能力。要 REST 就把 `createHttp({ listen })` 推进名单，路由里用 `useApp().get` / `session.get`，缺 `agent_id` 写 `MAIN_AGENT_ID`。

## 相关文档

- 模型 → [feature-model](../explanation/feature-model.md)
- hook 表 → [contribution-hooks](../reference/contribution-hooks.md)
- 外部操作 → [01](01-run-a-turn.md)
