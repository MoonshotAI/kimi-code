# 3. 监听 Agent 事件并触发一次请求

How-to：用 compaction 做样板——Feature 订机器事件（或拦 `useBeforeStep`），自己再开一次 LLM 请求。Agent 有哪些事件见 [events](../reference/events.md)。把 compact 暴露给宿主见 [4](04-expose-facade.md)。

`createCompaction` 不进默认 preset。对照：`src/features/compaction/controller.ts`。

## 要听哪一面

自动压缩不能订 `session.on('turn.ended')` 当唯一触发：overflow 发生在机器 `turn.failed` 上，载荷是 `failure`，节点事件只有 `outcome` / `errorMessage`。streaming / retry / tool 中间态同样只在 `agent.on`。

| 触发 | 订什么 | 然后做什么 |
|---|---|---|
| 本步超预算 | `useBeforeStep`：算 `usedContextTokens`，超 `max * triggerRatio` | `queueMicrotask` 跑 compact，并抛 `CompactError('budget-blocked')` 让当前 turn `failed` |
| 远端 context overflow | `agent.on('turn.failed')`，`isContextOverflowError(failure.error)` | 再开 compact，最多 `maxAutoAttempts` 次 |
| 用户 abort | `agent.on('turn.aborting')` | 取消正在跑的 compact |
| 回合正常结束 | `agent.on('turn.done')` | 清 overflow 计数 |

`useBeforeStep` 跑在每步 LLM **之前**。抛错后 turn 直接失败，不会带着超预算的 history 再请求一次。

## 听事件

setup 里拿命令面，订阅随 Feature 卸载撤掉：

```ts
const agent = useAgent();
const session = useSession();

const offFailed = agent.on('turn.failed', (event) => {
  const error = event.failure.reason === 'error' ? event.failure.error : undefined;
  if (!isContextOverflowError(error)) return;
  queueMicrotask(() => void run('overflow'));
});

const offAbort = agent.on('turn.aborting', () => {
  cancelActive();
});

pushCleanup(useNode(), () => {
  offFailed.unsubscribe();
  offAbort.unsubscribe();
});
```

`agent.on` 返回 XState `Subscription`（`.unsubscribe()`）。不要用节点 `on` 的 `off()` 去卸它。

## 触发一次请求

compaction 的请求**不是** `agent.submit`，也不读 agent 上的 `setConfig` / `setRequester`。它另开一台空工具的 `createTurnMachine`，把当前 history + 压缩指令发给 `createSummarize` 自带的 `config` 和 requester。跑完后 `session.stores` 切到新 branch，live actor 保持 pause，由宿主重挂。

```ts
const summarize = createSummarize({ config, requester });

async function run(reason: 'budget' | 'overflow' | 'manual', instruction?: string) {
  const history = session.stores.get(agent.agentId)?.getState().history ?? [];
  const summary = await summarize({
    history,
    instruction,
    signal: AbortSignal.timeout(120_000),
  });
  await session.stores.session.dispatch({
    type: 'compaction.completed',
    agentId: agent.agentId,
    branch: /* switchBranch 之后的 id */,
  });
}
```

自动路径若已有一次 compact 在跑，只记 `pendingAuto`，等 `compaction.completed` 再补跑。手动 `compact()` 在忙时抛 `CompactError('busy')`。

压缩记录写 **session** journal（`compaction.started|completed|cancelled`），不写 agent journal。机器事件 `compaction.blocked` 只走 `onEvent` 回调，不落盘。

装上：

```ts
features: [
  ...features,
  createCompaction({
    summarize: createSummarize({ config, requester }),
    budget: {
      maxContextTokens: () => model.maxContextSize ?? 262_144,
      triggerRatio: 0.85,
    },
  }),
]
```

## 相关文档

- 事件字段 → [events](../reference/events.md)
- 状态机何时 `failed` → [agent-machine](../explanation/agent-machine.md)
- 下一篇：把 compact 暴露出去 → [04](04-expose-facade.md)
