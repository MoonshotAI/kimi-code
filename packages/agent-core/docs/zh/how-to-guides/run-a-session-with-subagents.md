# 运行一个带 subagent 的 session

这是一篇 how-to 文档：只使用 `src/session/` + `src/llm/` 运行持久化的多 agent 会话，不经过 App/unit 层。`example/session.ts` 是用 fake requester 写的可离线运行版本（`pnpm example:session`）。

## 步骤

1. 打开一个 journal 和一个 blob store。journal 就是 session 的全部持久化：要落盘用 `nodeJournal(dir)`（`src/store/backend/node.ts`，会持有 writer 锁），一次性会话用 `memoryJournal()`。blob 同理：`openBlobStore(nodeBlobBackend(dir))` 或内存后端。
2. 用 `createSession({ id, journal, blobs })` 创建 session。session 是普通对象——没有 app、没有 unit 树。之后用同一个 journal 再开一次就是 resume:roster 自动重建（孤儿 agent log 会在打开时登记），每个 agent 的 messages 经 `loopProjection` 回放。如果进程死在某个 turn 中途，重开后该 agent 的 loop 状态是 `interrupted`：调用 `agent.loop.continue()` 续跑这个 turn，或者用 `abort()`(`undo` 之前必须先这样做）或一个新 prompt 把它以 aborted(reason 为 `CRASHED`)收尾。当时仍在运行的后台工具会以 `[async tool aborted]` 通知的形式回来。
3. 用 `session.open('main', caps)` 打开 main agent,caps 就是 loop 的 `{ requester, executor, hooks }`。通过 `agent.loop` 驱动：`runTurn` 以该 turn 的 outcome resolve。耐用事件会自动按微任务批量写入 agent 的 log;`agent.flush()` 强制立即提交。
4. subagent 就是工具。给 main agent 一个工具，在它的 `execute` 里打开同一个 session 的另一个 agent id 并在其上跑一个 turn。`session.open` 对存活 agent 是幂等的，所以 subagent 在多次调用间保留自己的历史；它的 log 独立于 main(`agents/researcher`)，即使 main 被 undo 也不受影响。
5. 用 `session.status()` 读 busy/last-turn 状态，`session.undo(agentId, turns)` 回滚，`session.fork(sourceId, agentId, caps)` 带全量历史分叉一个 agent,`session.close()` 全部 flush 并关闭。

```ts
import { memoryBlobBackend } from '#/blob/backend/memory';
import { openBlobStore } from '#/blob/index';
import { createUserEntry } from '#/history/message';
import { kimiRequester } from '#/llm/builtin/provider/index';
import { createUserMessage, extractText } from '#/llm/message';
import { createMaxStepsHook } from '#/loop/index';
import { endpointFromEnv, PROVIDER_ENV } from '#/node/env';
import { createSession, type AgentCaps } from '#/session/index';
import { memoryJournal } from '#/store/backend/memory';
import type { ToolExecuteInput, ToolResult } from '#/tool/index';

const requester = kimiRequester
  .with({ endpoint: endpointFromEnv(PROVIDER_ENV.kimi) })
  .with({ model: { spec: { provider: 'kimi', name: 'kimi-k2' } } });

const session = await createSession({
  id: 'demo',
  journal: memoryJournal(), // 落盘换 nodeJournal('.sessions/demo')
  blobs: openBlobStore(memoryBlobBackend()),
});

const researcherCaps: AgentCaps = {
  requester: () =>
    requester.with({ profile: { systemPrompt: 'You are a research assistant. Answer briefly.' } }),
  executor: {
    execute: async (): Promise<ToolResult> => ({
      content: [{ type: 'text', text: 'no tools available' }],
      isError: true,
    }),
  },
  hooks: [createMaxStepsHook(() => 4)],
};

const askResearcher = {
  name: 'ask_researcher',
  description: 'Ask the researcher subagent a question and return its answer.',
  parameters: {
    type: 'object',
    properties: { question: { type: 'string', description: 'The research question' } },
    required: ['question'],
  },
  async execute({ toolCall }: ToolExecuteInput): Promise<ToolResult> {
    const { question } = JSON.parse(toolCall.arguments ?? '{}') as { question: string };
    const researcher = await session.open('researcher', researcherCaps);
    const outcome = await researcher.loop.runTurn(
      createUserEntry(createUserMessage(question), {
        promptId: `research-${toolCall.id}`,
        origin: { kind: 'user' },
      }),
    );
    if (outcome.type !== 'done') {
      return { content: [{ type: 'text', text: `researcher turn ended: ${outcome.type}` }], isError: true };
    }
    const reply = researcher.loop.state.messages.findLast((entry) => entry.message.role === 'assistant');
    return { content: [{ type: 'text', text: reply === undefined ? '(no reply)' : extractText(reply.message) }] };
  },
};

const main = await session.open('main', {
  requester: () =>
    requester.with({ profile: { systemPrompt: 'You are a helpful assistant.', tools: [askResearcher] } }),
  executor: askResearcher,
  hooks: [createMaxStepsHook(() => 8)],
});

const outcome = await main.loop.runTurn(
  createUserEntry(createUserMessage('北京天气怎么样？'), {
    promptId: 'demo-1',
    origin: { kind: 'user' },
  }),
);
console.log(outcome.type, session.status());
await session.close();
```

## 不经过 App 层放弃了什么

- 没有 feature unit，也没有带 `sessionId` / `agentId` 富化的冒泡事件——直接逐个订阅 `agent.loop`。
- 没有 session catalog(title / metadata / `lastTurn` 索引)——那是 `SessionSpace` 的职责；多会话宿主可以用 `memorySessionSpace()`，仍不需要 App。
- 每次 `session.open` 都要给全 caps;agent 的 spec(system prompt、工具）不会被持久化。
