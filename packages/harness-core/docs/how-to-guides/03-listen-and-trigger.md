# 3. 写一个会自动压上下文的 Feature

How-to：自己写 compact。订机器事件、拦 `useBeforeStep`，另开一次 LLM 把 history 压成摘要，再 `switchBranch`。不要 `agent.submit`，也不要把内置 `createCompaction` 引进来当例子。事件形状见 [events](../reference/events.md)。完整产品实现（quiesce / drift / 保留最近 user）对照 `src/features/compaction/`。暴露 facade 见 [4](04-expose-facade.md)。

## 要听哪一面

自动压缩不能订 `session.on('turn.ended')` 当唯一触发：overflow 发生在机器 `turn.failed` 上，载荷是 `failure`，节点事件只有 `outcome` / `errorMessage`。streaming / retry / tool 中间态同样只在 `agent.on`。

| 触发 | 订什么 | 然后做什么 |
|---|---|---|
| 本步超预算 | `useBeforeStep`：算 `usedContextTokens`，超 `max * triggerRatio` | `queueMicrotask` 跑 compact，并抛错让当前 turn `failed` |
| 远端 context overflow | `agent.on('turn.failed')`，`failure.error.kind === 'context_overflow'` | 再开 compact，最多 3 次 |
| 用户 abort | `agent.on('turn.aborting')` | abort 正在跑的摘要 turn |
| 回合正常结束 | `agent.on('turn.done')` | 清 overflow 计数 |

`useBeforeStep` 跑在每步 LLM **之前**。抛错后 turn 直接失败，不会带着超预算的 history 再请求一次。

## 1. 配方

需要构造期的 `config` / `requester`，用工厂返回 `FeatureSpec`：

```ts
import {
  createFeature,
  createUserEntry,
  createUserMessage,
  extractText,
  useAgent,
  useBeforeStep,
  useSession,
  useTurn,
  usedContextTokens,
  type FeatureSpec,
  type HistoryMessage,
  type LlmRequestConfig,
  type LlmRequester,
} from '@moonshot-ai/agent-core';

export function createCompact(deps: {
  config: LlmRequestConfig;
  requester: LlmRequester;
  maxContextTokens: () => number;
  triggerRatio?: number;
}): FeatureSpec {
  return createFeature('compact', {
    agent() {
      const agent = useAgent();
      const session = useSession();
      const triggerRatio = deps.triggerRatio ?? 0.85;
      const enqueue = useTurn({
        requester: deps.requester,
        getConfig: () => deps.config,
        getTools: () => [],
      });
      let running = false;
      let overflowAttempts = 0;
      let cancel: (() => void) | undefined;
    },
  });
}
```

`agent.on` 在 Feature setup 里会随节点卸载撤掉，不必再手写 `unsubscribe`。

## 2. 另开一次 turn（不是 submit）

摘要请求不进用户 queue，也不读 agent 上的 `setConfig` / `setRequester`。`useTurn` 在 setup 里绑一台自己的 turn（空工具、自己的 requester），返回的 `enqueue` 同实例串行，卸载随节点 `signal` abort。默认等 120s。

```ts
const summarize = async (history: readonly HistoryMessage[], signal: AbortSignal) => {
  const output = await enqueue({
    history: [
      ...history,
      createUserEntry(createUserMessage('把以上对话压成一段可继续工作的摘要。'), { source: 'input' }),
    ],
    parentSignal: signal,
    maxSteps: 1,
  });
  if (output.type !== 'done') {
    throw new Error('summary failed');
  }
  const last = output.produced.findLast((entry) => entry.message.role === 'assistant');
  const text = last === undefined ? undefined : extractText(last.message);
  if (text === undefined || text.trim().length === 0) {
    throw new Error('empty summary');
  }
  return text;
};
```

已经有 `TurnLogic` 时用 `runTurn(logic, input)`。不要手写 `createActor` / `waitFor` / `stop`。

## 3. 自动触发

```ts
const isOverflow = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { kind?: unknown }).kind === 'context_overflow';

useBeforeStep(({ messages, tools, systemPrompt }) => {
  const used = usedContextTokens(messages, { systemPrompt, tools });
  const max = deps.maxContextTokens();
  if (max <= 0 || used < max * triggerRatio) return;
  queueMicrotask(() => void run('budget'));
  throw new Error('context budget exceeded; compacting before next step');
});

agent.on('turn.failed', (event) => {
  const error = event.failure.reason === 'error' ? event.failure.error : undefined;
  if (!isOverflow(error) || overflowAttempts >= 3) return;
  overflowAttempts += 1;
  queueMicrotask(() => void run('overflow'));
});

agent.on('turn.done', () => {
  overflowAttempts = 0;
});

agent.on('turn.aborting', () => {
  cancel?.();
});
```

先订再触发。`useBeforeStep` 里不要 `await run`：当前 turn 必须立刻失败，compact 放到微任务。

## 4. 压完切分支

```ts
const run = async (reason: 'budget' | 'overflow') => {
  if (running) return;
  running = true;
  const scope = new AbortController();
  cancel = () => scope.abort();
  await session.stores.session.dispatch({
    type: 'compaction.started',
    agentId: agent.agentId,
    reason,
  });
  try {
    await agent.pause();
    const store = session.stores.get(agent.agentId);
    if (store === undefined) {
      throw new Error(`unknown agent: '${agent.agentId}'`);
    }
    const history = store.getState().history;
    const turnId = store.getState().turnIndex.nextTurnId;
    const summary = await summarize(history, scope.signal);
    const { branchId } = await session.stores.switchBranch(agent.agentId, {
      reason: 'compaction',
      seed: [
        { type: 'turn.started', turnId },
        {
          type: 'message.appended',
          message: createUserEntry(createUserMessage(summary), { source: 'compaction', key: 'summary' }),
        },
        { type: 'turn.ended', turnId, outcome: 'done' },
      ],
    });
    await session.stores.session.dispatch({
      type: 'compaction.completed',
      agentId: agent.agentId,
      branch: branchId,
    });
  } catch (error) {
    await session.stores.session.dispatch({
      type: 'compaction.cancelled',
      agentId: agent.agentId,
      cause: 'failed',
      errorMessage: String(error),
    });
  } finally {
    running = false;
    cancel = undefined;
  }
};
```

`pause` 等到机器回执 `agent.paused`。live actor **不会**跟着 `switchBranch` 走，由宿主重挂。压缩记录写 **session** journal（`compaction.started|completed|cancelled`），不写 agent journal。

产品实现还会：等到 snapshot 进 idle、检查 compact 期间 history 有没有漂、seed 里保留开头/最近的 user 和未跑完的 queue。那些是 `src/features/compaction/shape.ts` 与 `machine.ts` 的事，本篇不抄。

## 5. 装上

`createCompact` 不进默认 preset，宿主推进名单：

```ts
features: [
  ...features,
  createCompact({
    config: { model },
    requester: openaiProvider.requesters.openai,
    maxContextTokens: () => model.maxContextSize ?? 262_144,
  }),
]
```

手动压、取消、看状态放到下一篇 facade。

## 相关文档

- 事件字段 → [events](../reference/events.md)
- 状态机何时 `failed` → [agent-machine](../explanation/agent-machine.md)
- 下一篇：把 compact 暴露出去 → [04](04-expose-facade.md)
