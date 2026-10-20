# Run a session with subagents

This is a how-to guide: durable, multi-agent sessions using `src/session/` + `src/llm/`, without the App/unit layer. `example/session.ts` is a runnable offline version with a fake requester (`pnpm example:session`).

## Steps

1. Open a journal and a blob store. The journal is the session's entire persistence: `nodeJournal(dir)` (`src/store/backend/node.ts`, takes a writer lock) for durable logs, `memoryJournal()` for a throwaway session. Blobs likewise: `openBlobStore(nodeBlobBackend(dir))` or the memory backend.
2. Create the session with `createSession({ id, journal, blobs })`. The session is a plain object — no app, no unit tree. Reopening the same journal later is a resume: the roster is rebuilt (orphan agent logs are registered on open) and each agent's messages replay through `loopProjection`. If the process died mid-turn, the reopened agent's loop reports status `interrupted`: call `agent.loop.continue()` to resume that turn, or `abort()` (required before `undo`) or a new prompt to end it as aborted with reason `CRASHED`. Background tools that were still running come back as `[async tool aborted]` notifications.
3. Open the main agent with `session.open('main', caps)`, where caps is the loop's `{ requester, executor, hooks }`. Drive it through `agent.loop`: `runTurn` resolves with the turn's outcome. Durable events are batched into the agent's log automatically; `agent.flush()` forces a commit.
4. Subagents are tools. Give the main agent a tool whose `execute` opens another agent id in the same session and runs a turn on it. `session.open` is idempotent for a live agent, so the subagent keeps its own history across calls; its log is independent (`agents/researcher`), so it also survives the main agent's undo.
5. Use `session.status()` for busy / last-turn state, `session.undo(agentId, turns)` to rewind, `session.fork(sourceId, agentId, caps)` to branch an agent with its full history, and `session.close()` to flush and close everything.

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
  journal: memoryJournal(), // nodeJournal('.sessions/demo') to persist
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
  createUserEntry(createUserMessage('What is the weather in Beijing?'), {
    promptId: 'demo-1',
    origin: { kind: 'user' },
  }),
);
console.log(outcome.type, session.status());
await session.close();
```

## What you give up without the App layer

- No feature units, and no bubbling events enriched with `sessionId` / `agentId` — subscribe to each `agent.loop` directly.
- No session catalog (title / metadata / `lastTurn` index) — that is the `SessionSpace` concern; `memorySessionSpace()` covers multi-session hosts without the App.
- Caps are supplied on every `session.open`; nothing about the agent's spec (system prompt, tools) is persisted.
