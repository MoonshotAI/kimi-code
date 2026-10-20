import { memoryBlobBackend } from '#/blob/backend/memory';
import { openBlobStore } from '#/blob/index';
import { createUserEntry } from '#/history/message';
import {
  createAssistantMessage,
  createUserMessage,
  extractText,
  type AssistantMessage,
  type Message,
} from '#/llm/message';
import type { LlmModelSpec, LlmRequest } from '#/llm/request';
import type { FinishInfo, LlmOutcome, TokenUsage } from '#/llm/response';
import { mergeFields, type LlmRequestPart } from '#/llm/requester';
import { createMaxStepsHook, type LoopEmitted, type LoopLlmRequester } from '#/loop/index';
import { createSession, type AgentCaps } from '#/session/index';
import { memoryJournal } from '#/store/backend/memory';
import { createToolExecutor, type ToolExecuteInput, type ToolResult } from '#/tool/index';

const usage: TokenUsage = { inputOther: 80, output: 16, inputCacheRead: 0, inputCacheCreation: 0 };

function fakeRequester(
  script: (messages: readonly Message[]) => AssistantMessage,
  filled: LlmRequestPart = {},
): LoopLlmRequester {
  const complete = (part: LlmRequestPart) =>
    mergeFields(filled as Record<string, unknown>, part as Record<string, unknown>) as unknown as LlmRequest;
  return {
    with: (part) => fakeRequester(script, complete(part)),
    request: complete,
    generate: async (rest, control): Promise<LlmOutcome> => {
      const messages = complete(rest).content?.messages ?? [];
      const message = script(messages);
      const finish: FinishInfo = {
        finishReason: message.toolCalls.length > 0 ? 'tool_calls' : 'completed',
        rawFinishReason: null,
      };
      control.onEvent?.({ type: 'llm.started' });
      for (const part of [...message.content, ...message.toolCalls]) {
        control.onEvent?.({ type: 'llm.streaming.part', part });
      }
      control.onEvent?.({ type: 'llm.streaming.usage', usage });
      control.onEvent?.({ type: 'llm.streaming.finish', finish });
      const outcome: LlmOutcome = { type: 'done', message, usage, finish };
      control.onEvent?.({ type: 'llm.ended', outcome });
      return outcome;
    },
  };
}

const spec: LlmModelSpec = { provider: 'fake', name: 'fake-model' };

function mainScript(messages: readonly Message[]): AssistantMessage {
  const tool = messages.findLast((message) => message.role === 'tool');
  if (tool !== undefined) {
    return createAssistantMessage([
      { type: 'text', text: `Final answer, based on the researcher: ${extractText(tool)}` },
    ]);
  }
  const user = messages.findLast((message) => message.role === 'user');
  const question = user === undefined ? '' : extractText(user);
  return createAssistantMessage(
    [{ type: 'text', text: 'Let me ask the researcher subagent.' }],
    [
      {
        type: 'function',
        id: 'call_research_1',
        name: 'ask_researcher',
        arguments: JSON.stringify({ question }),
      },
    ],
  );
}

function researcherScript(messages: readonly Message[]): AssistantMessage {
  const user = messages.findLast((message) => message.role === 'user');
  const question = user === undefined ? '' : extractText(user);
  return createAssistantMessage([
    { type: 'text', text: `Research finding for '${question}': Beijing is sunny and 22°C today.` },
  ]);
}

const noTools = {
  execute: async (): Promise<ToolResult> => ({
    content: [{ type: 'text', text: 'no tools available' }],
    isError: true,
  }),
};

const session = await createSession({
  id: 'demo',
  journal: memoryJournal(),
  blobs: openBlobStore(memoryBlobBackend()),
});

const researcherCaps: AgentCaps = {
  requester: () =>
    fakeRequester(researcherScript).with({
      model: { spec },
      profile: { systemPrompt: 'You are a research assistant. Answer briefly.' },
    }),
  executor: noTools,
  hooks: [createMaxStepsHook(() => 4)],
};

let researchSeq = 0;

const askResearcher = {
  name: 'ask_researcher',
  description: 'Ask the researcher subagent a question and return its answer.',
  parameters: {
    type: 'object',
    properties: { question: { type: 'string', description: 'The research question' } },
    required: ['question'],
  },
  async execute({ toolCall }: ToolExecuteInput): Promise<ToolResult> {
    const { question } = JSON.parse(toolCall.arguments ?? '{}') as { question?: string };
    const researcher = await session.open('researcher', researcherCaps);
    const outcome = await researcher.loop.runTurn(
      createUserEntry(createUserMessage(question ?? ''), {
        promptId: `research-${++researchSeq}`,
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

function logEvent(event: LoopEmitted): void {
  switch (event.type) {
    case 'llm.streaming.part':
      if (event.part.type === 'text') process.stdout.write(event.part.text);
      else if (event.part.type === 'function')
        console.log(`\n[tool call] ${event.part.name} ${event.part.arguments ?? ''}`);
      return;
    case 'llm.ended':
      process.stdout.write('\n');
      return;
    case 'tool.started':
      console.log(`[tool started] ${event.toolCall.name}`);
      return;
    case 'tool.ended':
      console.log(`[tool ended] ${event.toolCallId}: ${event.outcome.type}`);
      return;
    case 'turn.ended':
      console.log(`[turn ${event.turnId}] ended: ${event.outcome.type}`);
      return;
    default:
      return;
  }
}

const tools = createToolExecutor();
tools.register(askResearcher);

const main = await session.open('main', {
  requester: () => fakeRequester(mainScript).with({ model: { spec } }),
  executor: tools,
  hooks: [createMaxStepsHook(() => 8)],
});

main.loop.setSystemPrompt('You are a helpful assistant.');
main.loop.setTools([askResearcher]);

main.loop.subscribe(logEvent);
const prompt = process.argv.slice(2).join(' ') || 'What is the weather in Beijing?';
console.log(`> ${prompt}\n`);
const outcome = await main.loop.runTurn(
  createUserEntry(createUserMessage(prompt), { promptId: 'demo-1', origin: { kind: 'user' } }),
);
console.log(`runTurn resolved: ${outcome.type}`);
console.log('[status]', session.status());
await session.close();
