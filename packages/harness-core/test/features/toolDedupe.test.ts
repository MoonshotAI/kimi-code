import { describe, expect, it } from 'vitest';

import {
  createFeature,
  createHarness,
  createTelemetry,
  createUserMessage,
  extractText,
  MAIN_AGENT_ID,
  MemoryBackend,
  openBlobs,
  openSessionStores,
  Trees,
  useAgent,
  useAgentTools,
  useTelemetryAppender,
  type AgentHandle,
  type FeatureSpec,
  type AgentLlmRequester,
  type Message,
  type SessionStores,
  type TelemetryAppenderRecord,
  type ToolDefinition,
  type ToolResult,
  type TurnOutcome,
} from '@moonshot-ai/agent-core';

import {
  HANDOFF_VETO_TEXT,
  REMINDER_TEXT_1,
  createToolDedupe,
} from '#/features/toolDedupe/index';

import { fakeRequester, testModel, textOutcome } from '../fake-llm';

interface LlmCall {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools: readonly unknown[];
}

type ScriptResponse =
  | { readonly text: string }
  | { readonly toolCalls: readonly { readonly name: string; readonly arguments: string }[] };

function createMockRequester(responses: readonly ScriptResponse[]): {
  requester: AgentLlmRequester;
  calls: LlmCall[];
} {
  const calls: LlmCall[] = [];
  let index = 0;
  return {
    calls,
    requester: fakeRequester((rest, onEvent) => {
      calls.push({
        systemPrompt: rest.profile?.systemPrompt,
        messages: rest.content?.messages ?? [],
        tools: rest.profile?.tools ?? [],
      });
      const response: ScriptResponse =
        index < responses.length ? (responses[index] as ScriptResponse) : { text: 'end' };
      index += 1;
      onEvent?.({
        type: 'llm.streaming.usage',
        usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
      });
      if ('toolCalls' in response) {
        return textOutcome('', response.toolCalls.map((toolCall, i) => ({
          type: 'function',
          id: `call-${calls.length}-${i}`,
          name: toolCall.name,
          arguments: toolCall.arguments,
        })));
      }
      return textOutcome(response.text);
    }),
  };
}

function bindTestLlm(requester: AgentLlmRequester): FeatureSpec {
  return createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setModel(testModel);
      agent.setRequester(requester);
    },
  });
}

function bindTestTools(tools: readonly ToolDefinition[]): FeatureSpec {
  return createFeature('test-tools', {
    agent() {
      useAgentTools(...tools);
    },
  });
}

function bindTelemetryRecorder(records: TelemetryAppenderRecord[]): FeatureSpec {
  return createFeature('test-telemetry-recorder', {
    app() {
      useTelemetryAppender({
        track: (record) => {
          records.push(record);
        },
      });
    },
  });
}

function countingTool(
  name: string,
  executed: string[],
  result: () => ToolResult,
): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', additionalProperties: true },
    execute: async () => {
      executed.push(name);
      return result();
    },
  };
}

async function startApp(opts: {
  responses: readonly ScriptResponse[];
  tools: readonly ToolDefinition[];
  telemetry: TelemetryAppenderRecord[];
}) {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  const stores = await openSessionStores(tree, openBlobs(backend.blobs));
  const { requester, calls } = createMockRequester(opts.responses);
  const app = createHarness({
    features: [
      createTelemetry(),
      bindTelemetryRecorder(opts.telemetry),
      createToolDedupe(),
      bindTestTools(opts.tools),
      bindTestLlm(requester),
    ],
  });
  const session = await app.create({ sessionId: 'sess', stores });
  const main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'host' });
  const dispose = async (): Promise<void> => {
    await app.disposeAsync();
    await stores.dispose();
  };
  return { app, session, main, stores, calls, dispose };
}

function collectTurnDones(agent: AgentHandle): {
  outcomes: TurnOutcome[];
  waitFor(count: number): Promise<void>;
} {
  const outcomes: TurnOutcome[] = [];
  const waiters: { count: number; resolve: () => void }[] = [];
  agent.on('turn.done', (event) => {
    outcomes.push(event.outcome);
    for (const waiter of waiters.filter((waiter) => outcomes.length >= waiter.count)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  });
  return {
    outcomes,
    waitFor: (count) => {
      if (outcomes.length >= count) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `timed out waiting for ${String(count)} turn.done (got ${String(outcomes.length)})`,
            ),
          );
        }, 10_000);
        waiters.push({
          count,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    },
  };
}

function toolEntries(stores: SessionStores, agentId: string) {
  return (stores.get(agentId)?.getState().history ?? []).filter(
    (entry) => entry.message.role === 'tool',
  );
}

function assistantTexts(stores: SessionStores, agentId: string): string[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'assistant')
    .map((entry) => extractText(entry.message));
}

function tc(name: string, args: string): ScriptResponse {
  return { toolCalls: [{ name, arguments: args }] };
}

function repeatEvents(records: readonly TelemetryAppenderRecord[]) {
  return records
    .filter((record) => record.event === 'tool_call_repeat')
    .map((record) => [record.properties['repeat_count'], record.properties['action']]);
}

describe('toolDedupe feature', () => {
  it('executes an identical same-step call once and shares the final result', async () => {
    const executed: string[] = [];
    const records: TelemetryAppenderRecord[] = [];
    const h = await startApp({
      responses: [
        { toolCalls: [{ name: 'Echo', arguments: '{"text":"A"}' }, { name: 'Echo', arguments: '{"text":"A"}' }] },
        { text: 'done' },
      ],
      tools: [countingTool('Echo', executed, () => ({ content: [{ type: 'text', text: 'A' }] }))],
      telemetry: records,
    });
    const dones = collectTurnDones(h.main);
    h.main.submit(createUserMessage('go'));
    await dones.waitFor(1);

    expect(executed).toEqual(['Echo']);
    const texts = toolEntries(h.stores, MAIN_AGENT_ID).map((entry) =>
      extractText(entry.message),
    );
    expect(texts).toEqual(['A', 'A']);
    expect(
      records
        .filter((record) => record.event === 'tool_call_dedup_detected')
        .map((record) => record.properties['dup_type']),
    ).toEqual(['same_step']);
    await h.dispose();
  });

  it('treats argument objects with different key order as the same call', async () => {
    const executed: string[] = [];
    const h = await startApp({
      responses: [
        {
          toolCalls: [
            { name: 'Echo', arguments: '{"a":1,"b":2}' },
            { name: 'Echo', arguments: '{"b":2,"a":1}' },
          ],
        },
        { text: 'done' },
      ],
      tools: [countingTool('Echo', executed, () => ({ content: [{ type: 'text', text: 'SAME' }] }))],
      telemetry: [],
    });
    const dones = collectTurnDones(h.main);
    h.main.submit(createUserMessage('go'));
    await dones.waitFor(1);

    expect(executed).toEqual(['Echo']);
    const texts = toolEntries(h.stores, MAIN_AGENT_ID).map((entry) =>
      extractText(entry.message),
    );
    expect(texts).toEqual(['SAME', 'SAME']);
    await h.dispose();
  });

  it.each([
    { streak: 3, marker: 'what new information you expect', absent: 'Choose exactly one' },
    { streak: 5, marker: 'issued 5 times in a row', absent: 'Write your final response now' },
    { streak: 8, marker: 'Write your final response now', absent: undefined },
  ])('appends the streak reminder at $streak consecutive calls without stopping the turn', async ({ streak, marker, absent }) => {
    const records: TelemetryAppenderRecord[] = [];
    const h = await startApp({
      responses: [
        ...Array.from({ length: streak }, () => tc('Read', '{"p":1}')),
        { text: 'wrapped' },
      ],
      tools: [countingTool('Read', [], () => ({ content: [{ type: 'text', text: 'file' }] }))],
      telemetry: records,
    });
    const dones = collectTurnDones(h.main);
    h.main.submit(createUserMessage('go'));
    await dones.waitFor(1);

    expect(dones.outcomes).toEqual([{ type: 'done' }]);
    expect(h.calls).toHaveLength(streak + 1);
    const texts = toolEntries(h.stores, MAIN_AGENT_ID).map((entry) =>
      extractText(entry.message),
    );
    expect(texts).toHaveLength(streak);
    expect(texts[streak - 1]).toContain('<system-reminder>');
    expect(texts[streak - 1]).toContain(marker);
    if (absent !== undefined) expect(texts[streak - 1]).not.toContain(absent);
    expect(texts[0]).not.toContain('<system-reminder>');
    await h.dispose();
  });

  it('force-stops at 12 consecutive calls and runs a text handoff step', async () => {
    const records: TelemetryAppenderRecord[] = [];
    const h = await startApp({
      responses: [
        ...Array.from({ length: 12 }, () => tc('Read', '{"p":1}')),
        { text: 'handoff answer' },
      ],
      tools: [countingTool('Read', [], () => ({ content: [{ type: 'text', text: 'file' }] }))],
      telemetry: records,
    });
    const dones = collectTurnDones(h.main);
    h.main.submit(createUserMessage('go'));
    await dones.waitFor(2);

    expect(h.calls).toHaveLength(13);
    expect(dones.outcomes).toEqual([{ type: 'done' }, { type: 'done' }]);
    const texts = toolEntries(h.stores, MAIN_AGENT_ID).map((entry) =>
      extractText(entry.message),
    );
    expect(texts[11]).toContain('Write your final response now');
    expect(assistantTexts(h.stores, MAIN_AGENT_ID).at(-1)).toBe('handoff answer');
    expect(repeatEvents(records)).toEqual([
      [2, 'none'],
      [3, 'r1'],
      [4, 'r1'],
      [5, 'r2'],
      [6, 'r2'],
      [7, 'r2'],
      [8, 'r3'],
      [9, 'r3'],
      [10, 'r3'],
      [11, 'r3'],
      [12, 'stop'],
    ]);
    expect(
      records.find((record) => record.event === 'tool_call_repeat_handoff')?.properties,
    ).toMatchObject({ outcome: 'text' });
    await h.dispose();
  });

  it('vetoes tool calls issued during the handoff step and still ends it', async () => {
    const executed: string[] = [];
    const records: TelemetryAppenderRecord[] = [];
    const h = await startApp({
      responses: [
        ...Array.from({ length: 12 }, () => tc('Read', '{"p":1}')),
        tc('Read', '{"p":2}'),
        { text: 'must never be generated' },
      ],
      tools: [countingTool('Read', executed, () => ({ content: [{ type: 'text', text: 'file' }] }))],
      telemetry: records,
    });
    const dones = collectTurnDones(h.main);
    h.main.submit(createUserMessage('go'));
    await dones.waitFor(2);

    expect(h.calls).toHaveLength(13);
    expect(executed).toHaveLength(12);
    const texts = toolEntries(h.stores, MAIN_AGENT_ID).map((entry) =>
      extractText(entry.message),
    );
    expect(texts[12]).toBe(HANDOFF_VETO_TEXT);
    expect(dones.outcomes).toEqual([{ type: 'done' }, { type: 'done' }]);
    expect(
      records.find((record) => record.event === 'tool_call_repeat_handoff')?.properties,
    ).toMatchObject({ outcome: 'vetoed' });
    expect(repeatEvents(records).filter(([count]) => count === 13)).toHaveLength(0);
    await h.dispose();
  });

  it('resets the consecutive streak and turn records at turn boundaries', async () => {
    const records: TelemetryAppenderRecord[] = [];
    const h = await startApp({
      responses: [
        tc('Read', '{"p":1}'),
        tc('Read', '{"p":1}'),
        { text: 'first done' },
        tc('Read', '{"p":1}'),
        { text: 'second done' },
      ],
      tools: [countingTool('Read', [], () => ({ content: [{ type: 'text', text: 'file' }] }))],
      telemetry: records,
    });
    const dones = collectTurnDones(h.main);
    h.main.submit(createUserMessage('go'));
    await dones.waitFor(1);

    h.main.submit(createUserMessage('again'));
    await dones.waitFor(2);

    const texts = toolEntries(h.stores, MAIN_AGENT_ID).map((entry) =>
      extractText(entry.message),
    );
    expect(texts).toHaveLength(3);
    expect(texts[2]).not.toContain('<system-reminder>');
    expect(repeatEvents(records)).toEqual([[2, 'none']]);
    expect(
      records
        .filter((record) => record.event === 'tool_call_dedup_detected')
        .map((record) => record.properties['dup_type']),
    ).toEqual(['cross_step']);
    await h.dispose();
  });

  it('counts identical malformed raw arguments as repeats but not different ones', async () => {
    const records: TelemetryAppenderRecord[] = [];
    const same = await startApp({
      responses: [tc('Strict', '{"command":'), tc('Strict', '{"command":'), { text: 'done' }],
      tools: [countingTool('Strict', [], () => ({ content: [{ type: 'text', text: 'ran' }] }))],
      telemetry: records,
    });
    const dones = collectTurnDones(same.main);
    same.main.submit(createUserMessage('go'));
    await dones.waitFor(1);
    expect(repeatEvents(records)).toEqual([[2, 'none']]);
    await same.dispose();

    const varied: TelemetryAppenderRecord[] = [];
    const different = await startApp({
      responses: [
        tc('Strict', '{"command":'),
        tc('Strict', '{"comand":'),
        tc('Strict', '{"command": "ls"'),
        { text: 'done' },
      ],
      tools: [countingTool('Strict', [], () => ({ content: [{ type: 'text', text: 'ran' }] }))],
      telemetry: varied,
    });
    const dones2 = collectTurnDones(different.main);
    different.main.submit(createUserMessage('go'));
    await dones2.waitFor(1);
    expect(repeatEvents(varied)).toHaveLength(0);
    await different.dispose();
  });

  it('appends the reminder to a trailing text part', async () => {
    const h = await startApp({
      responses: [tc('X', '{}'), tc('X', '{}'), tc('X', '{}'), { text: 'done' }],
      tools: [countingTool('X', [], () => ({ content: [{ type: 'text', text: 'hello' }] }))],
      telemetry: [],
    });
    const dones = collectTurnDones(h.main);
    h.main.submit(createUserMessage('go'));
    await dones.waitFor(1);

    const content = toolEntries(h.stores, MAIN_AGENT_ID).at(-1)?.message.content;
    expect(content).toEqual([{ type: 'text', text: 'hello' + REMINDER_TEXT_1 }]);
    await h.dispose();
  });

  it('pushes a new text part when the trailing part is non-text', async () => {
    const h = await startApp({
      responses: [tc('X', '{}'), tc('X', '{}'), tc('X', '{}'), { text: 'done' }],
      tools: [
        countingTool('X', [], () => ({
          content: [{ type: 'image_url', source: { kind: 'inline', mimeType: 'image/png', data: 'Zm9v' } }],
        })),
      ],
      telemetry: [],
    });
    const dones = collectTurnDones(h.main);
    h.main.submit(createUserMessage('go'));
    await dones.waitFor(1);

    const content = toolEntries(h.stores, MAIN_AGENT_ID).at(-1)?.message.content;
    expect(content?.at(-1)).toEqual({ type: 'text', text: REMINDER_TEXT_1 });
    await h.dispose();
  });

  it('keeps an error result error when force-stopping', async () => {
    const h = await startApp({
      responses: [
        ...Array.from({ length: 12 }, () => tc('Read', '{"p":1}')),
        { text: 'handoff answer' },
      ],
      tools: [
        countingTool('Read', [], () => ({
          content: [{ type: 'text', text: 'boom' }],
          isError: true,
        })),
      ],
      telemetry: [],
    });
    const dones = collectTurnDones(h.main);
    h.main.submit(createUserMessage('go'));
    await dones.waitFor(2);

    const last = toolEntries(h.stores, MAIN_AGENT_ID).at(-1);
    expect(last?.meta.isError).toBe(true);
    expect(extractText(last!.message)).toContain('Write your final response now');
    expect(dones.outcomes).toEqual([{ type: 'done' }, { type: 'done' }]);
    await h.dispose();
  });
});
