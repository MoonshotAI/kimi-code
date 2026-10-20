import { z } from 'zod';

import {
  createLoop,
  createMaxStepsHook,
  type LoopEmitted,
  type LoopLlmRequester,
  type StepOutcome,
  type TurnOutcome,
} from '#/loop/index';
import { createUserEntry } from '#/history/message';
import {
  createAssistantMessage,
  createUserMessage,
  extractText,
  type AssistantMessage,
  type ContentPart,
  type Message,
  type ToolCall,
} from '#/llm/message';
import type { LlmModelSpec, LlmRequest } from '#/llm/request';
import type { FinishInfo, LlmOutcome, TokenUsage } from '#/llm/response';
import { mergeFields, type LlmRequestPart } from '#/llm/requester';
import { createToolExecutor, defineTool, zodSchema, type ToolResult } from '#/tool/index';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const usage: TokenUsage = { inputOther: 120, output: 24, inputCacheRead: 0, inputCacheCreation: 0 };

function weatherCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_weather_1',
    name: 'get_weather',
    arguments: JSON.stringify({ city: 'Beijing' }),
  };
}

function firstTurnMessage(): AssistantMessage {
  return createAssistantMessage(
    [{ type: 'text', text: 'Let me check the weather for you.' }],
    [weatherCall()],
  );
}

function secondTurnMessage(messages: readonly Message[]): AssistantMessage {
  const tool = messages.findLast((message) => message.role === 'tool');
  const observation = tool === undefined ? '' : extractText(tool);
  return createAssistantMessage([
    { type: 'text', text: `Based on the latest observation (${observation}), Beijing is sunny and 22°C today.` },
  ]);
}

function createFakeRequester(filled: LlmRequestPart = {}): LoopLlmRequester {
  const complete = (part: LlmRequestPart) =>
    mergeFields(filled as Record<string, unknown>, part as Record<string, unknown>) as unknown as LlmRequest;
  return {
    with: (part) => createFakeRequester(complete(part)),
    request: complete,
    generate: async (rest, control): Promise<LlmOutcome> => {
      const onEvent = control.onEvent;
      const messages = complete(rest).content?.messages ?? [];
      const awaitingTool = messages.some((message) => message.role === 'tool');
      const message = awaitingTool ? secondTurnMessage(messages) : firstTurnMessage();
      const finish: FinishInfo = {
        finishReason: message.toolCalls.length > 0 ? 'tool_calls' : 'completed',
        rawFinishReason: null,
      };
      onEvent?.({ type: 'llm.started' });
      const emitted: ContentPart[] = [];
      for (const part of message.content) {
        await sleep(50);
        if (control.signal.aborted) {
          const salvaged = emitted.length === 0 ? null : createAssistantMessage(emitted);
          const outcome: LlmOutcome = {
            type: 'aborted',
            message: salvaged,
            usage: undefined,
            reason: control.signal.reason,
          };
          onEvent?.({ type: 'llm.ended', outcome });
          return outcome;
        }
        emitted.push(part);
        onEvent?.({ type: 'llm.streaming.part', part });
      }
      for (const toolCall of message.toolCalls) {
        onEvent?.({ type: 'llm.streaming.part', part: toolCall });
      }
      onEvent?.({ type: 'llm.streaming.usage', usage });
      onEvent?.({ type: 'llm.streaming.finish', finish });
      const outcome: LlmOutcome = { type: 'done', message, usage, finish };
      onEvent?.({ type: 'llm.ended', outcome });
      return outcome;
    },
  };
}

const weatherTool = defineTool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  schema: zodSchema(z.object({ city: z.string().describe('City name') })),
  async execute({ args, onUpdate }): Promise<ToolResult> {
    onUpdate?.({ key: 'query', text: `querying weather for ${args.city}`, percent: 40 });
    await sleep(200);
    return { content: [{ type: 'text', text: `${args.city}: 22°C, sunny` }] };
  },
});

const tools = createToolExecutor();
tools.register(weatherTool);

const spec: LlmModelSpec = { provider: 'fake', name: 'fake-model' };
const requester = createFakeRequester().with({ model: { spec } });
const loop = createLoop({
  requester: () =>
    requester.with({ profile: { systemPrompt: 'You are a helpful assistant.', tools: [weatherTool] } }),
  executor: tools,
  hooks: [createMaxStepsHook(() => 8)],
});

function describeOutcome(outcome: StepOutcome | TurnOutcome): string {
  if (!('cause' in outcome) || outcome.cause === undefined) return outcome.type;
  return `${outcome.type} (${outcome.cause.by ?? '?'}: ${outcome.cause.message ?? outcome.cause.reason})`;
}

function logEvent(event: LoopEmitted): void {
  switch (event.type) {
    case 'turn.started':
      console.log(`[turn ${event.turnId}] started`);
      return;
    case 'step.started':
      console.log(`[step ${event.step}]`);
      return;
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
    case 'tool.delta':
      console.log(`[tool delta] ${event.update.text}`);
      return;
    case 'tool.ended':
      console.log(`[tool ended] ${event.toolCallId}: ${event.outcome.type}`);
      return;
    case 'step.ended':
      console.log(`[step ${event.step}] ${describeOutcome(event.outcome)}`);
      return;
    case 'turn.ended':
      console.log(`[turn ${event.turnId}] ended: ${describeOutcome(event.outcome)}`);
      return;
    default:
      return;
  }
}

loop.subscribe(logEvent);
const prompt = process.argv.slice(2).join(' ') || "What's the weather in Beijing?";
console.log(`> ${prompt}\n`);
const outcome = await loop.runTurn(
  createUserEntry(createUserMessage(prompt), { promptId: 'demo-1', origin: { kind: 'user' } }),
);
console.log(`runTurn resolved: ${describeOutcome(outcome)}`);

const history = loop.state.messages;
console.log(`\n--- final history (${history.length} entries) ---`);
for (const entry of history) {
  const role = entry.message.role;
  const toolCalls = role === 'assistant' ? entry.message.toolCalls.length : 0;
  const suffix = toolCalls > 0 ? ` (+${toolCalls} tool call)` : '';
  console.log(`${role}${suffix}: ${extractText(entry.message).slice(0, 80)}`);
}
