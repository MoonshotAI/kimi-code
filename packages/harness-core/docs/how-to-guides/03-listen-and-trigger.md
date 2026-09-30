# 3. 写一个会自动压上下文的 Feature

How-to：自己写 compact。拦 `useBeforeStep` 下决策、订 turn 的压缩请求，另开一次 LLM 把 history 压成摘要，再 `contextReset` 让机器原地换掉 history——整条路径不经过 prompt 队列、不换分支、不需要宿主重挂。事件形状见 [events](../reference/events.md)。完整产品实现（quiesce / drift / 保留最近 user）对照 `src/features/compaction/`。暴露 facade 见 [4](04-expose-facade.md)。

## 要听哪一面

触发与回应都在 `agent.on` 这一面：turn 进 `compacting` 时经父机发出 `turn.compaction_requested`（agent 补 `turnId` 后 emit），随后悬停等 `turn.compaction_finished`——节点事件里没有这个交互，journal 只在 reset 落账时写一条 `context.reset`。streaming / retry / tool 中间态同样只在 `agent.on`。

| 触发 | 订什么 | 然后做什么 |
|---|---|---|
| 本步超预算 | `useBeforeStep`：算 `usedContextTokens`，超 `max * triggerRatio` | 返回 `{ compact: true }` 决策，turn 进 `compacting` |
| 远端 context overflow | 不用订：`llm.ended` 的 failed outcome 且 `error.kind === 'context_overflow'` 时 turn 自己进 `compacting`（失败被吸收，不再外发） | 同上 |
| turn 请求压缩 | `agent.on('turn.compaction_requested')` | 按 `turnId` 计次，≤3 次跑 compact 并 `contextReset({ messages })` 回应；超限 `contextReset({ error })` 让 turn `failed` |
| 用户 abort | `agent.on('turn.aborting')` | abort 正在跑的摘要 turn |

`useBeforeStep` 跑在每步 LLM **之前**。决策是同步返回值，不是抛错：turn 拿到决策先进 `compacting` 悬停，reset 落账回 `gating` 复检（seed 变小自然通过）才会再发请求——超预算的 history 不会再进请求，turn 也不再被杀。

## 1. 配方

需要构造期的 `model` / `requester`，用工厂返回 `FeatureSpec`：

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
  type AgentLlmRequester,
  type FeatureSpec,
  type HistoryMessage,
  type LlmEndpoint,
  type LlmRequestModel,
} from '@moonshot-ai/agent-core';

export function createCompact(deps: {
  model: LlmRequestModel;
  requester: AgentLlmRequester;
  endpoint?: LlmEndpoint;
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
        getModel: () => deps.model,
        getEndpoint: () => deps.endpoint,
        getTools: () => [],
      });
      let running = false;
      let attempts: { turnId?: number; count: number } = { count: 0 };
      let cancel: (() => void) | undefined;
    },
  });
}
```

`agent.on` 在 Feature setup 里会随节点卸载撤掉，不必再手写 `unsubscribe`。

## 2. 另开一次 turn（不是 submit）

摘要请求不进用户 queue，也不读 agent 上的 `setModel` / `setEndpoint` / `setRequester`。`useTurn` 在 setup 里绑一台自己的 turn（空工具、自己的 model / endpoint / requester），返回的 `enqueue` 同实例串行，卸载随节点 `signal` abort。默认等 120s。

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

已经有 `TurnLogic` 时用 `runTurn(logic, input)`：actor 的创建、等待与停止都收在这一条调用里。

## 3. 自动触发

```ts
useBeforeStep(({ messages, tools, systemPrompt }) => {
  const used = usedContextTokens(messages, { systemPrompt, tools });
  const max = deps.maxContextTokens();
  if (max <= 0 || used < max * triggerRatio) return;
  return { compact: true };
});

agent.on('turn.compaction_requested', (event) => {
  if (attempts.turnId !== event.turnId) attempts = { turnId: event.turnId, count: 0 };
  attempts.count += 1;
  if (attempts.count > 3) {
    agent.contextReset({ error: new Error('auto compaction attempts exhausted') });
    return;
  }
  queueMicrotask(() => void run(event.reason, event.history));
});

agent.on('turn.aborting', () => {
  cancel?.();
});
```

先订再触发。决策在 `useBeforeStep` 里同步返回，压缩由请求事件驱动、放微任务里跑。不要在 `useBeforeStep` 里 `await run`：此刻 turn 还停在 gating 等这个 hook 返回，`contextReset` 的回应没人消费，等于自己等自己。

## 4. 压完原地重置

```ts
const run = async (reason: 'budget' | 'overflow', history: readonly HistoryMessage[]) => {
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
    const summary = await summarize(history, scope.signal);
    const ack = agent.contextReset({
      messages: [
        createUserEntry(createUserMessage(summary), { source: 'compaction', key: 'summary' }),
      ],
      reason,
    });
    if (ack === undefined) {
      throw new Error('agent did not accept the context reset');
    }
    await session.stores.session.dispatch({
      type: 'compaction.completed',
      agentId: agent.agentId,
    });
  } catch (error) {
    agent.contextReset({ error });
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

`contextReset({ messages })` 以 `context.reset` emit 为回执：running 时 agent 替换自己的 `messages`、把 `turn.compaction_finished` 转给悬停的 turn，turn 换掉 history、回 `gating` 原地续跑（budget 复检自然通过、overflow 重发失败请求）；journal 写一条 `context.reset`（fold 语义「整段替换 history」，reset 前记录保留）。整个流程在当前分支内完成——live actor 就地应用新 history，没有分支切换，也没有宿主重挂。压缩记录写 **session** journal（`compaction.started|completed|cancelled`），与 agent journal 的 `context.reset` 分工审计。`meta: { source: 'compaction', key: 'summary' }` 是 undo 的边界锚（`isCompactionSummary`），不能省。

产品实现还会：manual 路径先 `pause` + 等 idle 再摘要（turn 悬停即天然 quiesce 的 in-turn 路径不用）、检查 compact 期间 history 有没有漂、seed 里保留开头/最近的 user 并接 continuation 消息。那些是 `src/features/compaction/shape.ts` 与 `machine.ts` 的事，本篇不抄。

## 5. 装上

`createCompact` 不进默认 preset，宿主推进名单：

```ts
features: [
  ...features,
  createCompact({
    model: { spec },
    requester: openAIRequester,
    maxContextTokens: () => spec.maxContextSize ?? 262_144,
  }),
]
```

手动压、取消、看状态放到下一篇 facade。

## 相关文档

- 事件字段 → [events](../reference/events.md)
- 状态机何时 `compacting` / `failed` → [agent-machine](../explanation/agent-machine.md)
- 下一篇：把 compact 暴露出去 → [04](04-expose-facade.md)
