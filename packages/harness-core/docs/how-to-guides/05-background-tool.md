# 5. 写一个可以后台的 Tool，并使用 WaitFor

How-to：用 Interaction 的 `AskUserQuestion` 说明怎么 `detach`，让 turn 先结束、答案以后当 notification 回来；同时装 builtin `waitFor`，模型在同一回合里等到结果。对照：`features/interaction/tool.ts`、`agent-core` 的 `builtin/wait-for/`。

## Interaction 在哪一层

提问表是 session 拥有的内存登记，不是状态机、不是进程单例。session slot `useFire` + `openInteractions`，`useExpose(InteractionRef)`。agent slot 取同一份表、挂工具；卸载只 `cancelAgent(..., 'agent_closed')`。不在 `turn.done` 取消，后台 question 可以跨 turn。

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
    useAgentTools(createAskUserQuestionTool(interactions, {
      sessionId: useSession().sessionId,
      agentId: useAgent().agentId,
    }));
    pushCleanup(useNode(), () => {
      interactions.cancelAgent(useAgent().agentId, 'agent_closed');
    });
  },
});
```

宿主答：

```ts
const interactions = session.resolve(InteractionRef);
session.on(interaction, 'interaction.requested', (event) => {
  interactions.respond(event.interaction.id, { answers: { /* … */ } });
});
```

迟到订阅者先 `findAll({ resolved: false })`，再 `wait(id)`。事件不落盘。

## execute 里怎么 detach

`ToolExecuteInput.detach?: (text: string) => void`。调用一次之后，这个 tool actor 从 `turnTools` 挪到 `background`。turn 只收一条 ack 文案（`text`），本步可以继续 drain / 结束。真正的 `execute` Promise 还在跑；完成后机器发 `tool.done`，再变成 `source: 'async-tool'` 的 notification，下一回合 drain 进 history。

`AskUserQuestion` 的 `background: true`：

```ts
async execute({ toolCall, detach }) {
  if (payload.background === true) {
    detach?.(
      `task_id: ${toolCall.id}\nstatus: running\nnext_step: Continue your work; the answer arrives automatically in a later message. Use WaitFor only if you cannot proceed without it.`,
    );
  }
  const response = await interactions.request({ kind: 'question', payload, tags });
  return { content: [{ type: 'text', text: JSON.stringify(response) }] };
}
```

规则：

- `detach` 只调一次，重复调用被工具机丢掉
- ack 文案就是模型本步看到的 tool result
- `task_id` 用 `toolCall.id`，和 WaitFor 的 `task_id` 对齐
- 不要 detach 之后立刻 `return` 而丢掉 `request()`——答案必须等 `respond` 之后作为 async completion 回来
- `execute` 里不能 `inject`；`interactions` 在 setup 闭包捕获

前台提问（`background` 省略 / false）不 detach，turn 停在 `acting`，等人答完。

## builtin WaitFor

`waitFor` 在 agent-core `src/builtin/wait-for/`，已进 harness `features` 名单。它只做一件事：`useAgentTools(createWaitForTool(useWaitForTasks()))`。

`useWaitForTasks()` 看的是本 agent 的 `background` 表。

| 参数 | 含义 |
|---|---|
| `timeout`（必填，秒，1–600） | 上限。超时不是错误，返回仍在跑的 id，可以再调 |
| `task_id`（可选） | 等这一条。省略则等「调用时已在跑的任意一条」结束 |

模型不该在刚 detach 之后立刻 WaitFor——完成会自动 notify。WaitFor 只用于「下一步离开这个结果就做不了」。等待期间不发 LLM。WaitFor 不停止任务；它报过的完成不会再发一份 automatic notification。

`useWaitForTasks` 必须在 setup 捕获。其它后台工具（bash、后台提问）共用这一张表。

## 相关文档

- 工具事件 → [events](../reference/events.md)
- detach 之后机器怎么走 → [agent-machine](../explanation/agent-machine.md)
- 下一篇：bash 与宿主手动 detach → [06](06-bash-and-detach.md)
