import { describe, expect, it, vi } from 'vitest';

import { createFeature } from '@moonshot-ai/agent-core/app/index';
import { useInject } from '@moonshot-ai/agent-core/kernel/index';
import { createUserEntry } from '@moonshot-ai/agent-core/history/index';
import { createAssistantMessage, createUserMessage, extractText, type ToolCall } from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmErrorMessage, LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';

import {
  TelemetryRef,
  createTelemetry,
  createTracker,
  useTelemetryAppender,
  useTelemetryEvents,
  type TelemetryAppender,
  type TelemetryAppenderRecord,
  type TelemetryContextPatch,
  type TelemetryFace,
} from '#/features/telemetry/index';
import { ConfigRef, createConfig, type ConfigStore } from '#/features/config/index';
import { createHarness, harnessInternals, memoryHarnessSpace, useAgentTools, type Harness } from '#/runtime/index';

type GenerateRest = Parameters<LoopLlmRequester['generate']>[0];
type GenerateControl = Parameters<LoopLlmRequester['generate']>[1];

function textOutcome(text: string, toolCalls: ToolCall[] = []): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls) };
}

function scriptedRequester(
  next: (rest: GenerateRest, control: GenerateControl) => LlmOutcome | Promise<LlmOutcome>,
): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (rest, control) => next(rest, control),
  };
  return self;
}

function failingRequester(error: LlmErrorMessage): LoopLlmRequester {
  return scriptedRequester(() => ({ type: 'failed', error }));
}

function user(text: string) {
  return createUserEntry(createUserMessage(text), { source: 'input' });
}

function setRequester(harness: Harness, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime = session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

function createRecorder(): { records: TelemetryAppenderRecord[]; appender: TelemetryAppender } {
  const records: TelemetryAppenderRecord[] = [];
  return {
    records,
    appender: {
      track: (record) => {
        records.push(record);
      },
    },
  };
}

function recorderFeature(recorder: { appender: TelemetryAppender }) {
  return createFeature('telemetry-recorder', {
    app() {
      useTelemetryAppender(recorder.appender);
    },
  });
}

interface CapturedFaces {
  app?: TelemetryFace;
  session?: TelemetryFace;
  agent?: TelemetryFace;
}

function captureFeature(captured: CapturedFaces) {
  return createFeature('telemetry-capture', {
    app() {
      captured.app = useInject(TelemetryRef).value;
    },
    session() {
      captured.session = useInject(TelemetryRef).value;
    },
    agent() {
      captured.agent = useInject(TelemetryRef).value;
    },
  });
}

function configCaptureFeature(captured: { store?: ConfigStore }) {
  return createFeature('config-capture', {
    app() {
      captured.store = useInject(ConfigRef).value;
    },
  });
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function mountTelemetryApp(props?: { enabled?: boolean; context?: TelemetryContextPatch }) {
  const recorder = createRecorder();
  const faces: CapturedFaces = {};
  const harness = createHarness({ space: memoryHarnessSpace() });
  await harness.app.features.add(createTelemetry(props));
  await harness.app.features.add(recorderFeature(recorder));
  await harness.app.features.add(captureFeature(faces));
  await tick();
  return { harness, recorder, faces };
}

function eventNames(records: readonly TelemetryAppenderRecord[]): string[] {
  return records.map((record) => record.event);
}

function findRecord(
  records: readonly TelemetryAppenderRecord[],
  event: string,
): TelemetryAppenderRecord {
  const record = records.find((entry) => entry.event === event);
  expect(record, `expected record for '${event}'`).toBeDefined();
  return record as TelemetryAppenderRecord;
}

async function waitForEvent(
  records: readonly TelemetryAppenderRecord[],
  event: string,
): Promise<void> {
  await vi.waitFor(() => {
    expect(records.some((record) => record.event === event)).toBe(true);
  });
}

describe('telemetry feature', () => {
  it('composes records from ambient and explicit properties', async () => {
    const { harness, recorder, faces } = await mountTelemetryApp({
      context: { provider_type: 'test', mode: 'agent' },
    });
    const telemetry = faces.app!;
    telemetry.setContext({ session_id: 'sess-1' });
    telemetry.track('custom_event', { extra: 1, provider_type: 'override', dropped: undefined });
    expect(recorder.records).toHaveLength(1);
    const record = recorder.records[0]!;
    expect(record.event).toBe('custom_event');
    expect(record.properties).toEqual({
      mode: 'agent',
      provider_type: 'override',
      sessionId: 'sess-1',
      extra: 1,
    });
    expect(record.context).toEqual({ provider_type: 'test', mode: 'agent', session_id: 'sess-1' });
    await harness.close();
  });

  it('shadows the facade per tier with inherited context', async () => {
    const { harness, recorder, faces } = await mountTelemetryApp();
    const session = await harness.app.create({ sessionId: 'sess' });
    await harness.ensureAgent(session, 'main');
    const appTelemetry = faces.app!;
    const sessionTelemetry = faces.session!;
    const agentTelemetry = faces.agent!;
    expect(appTelemetry.getContext()).toEqual({});
    expect(sessionTelemetry.getContext()).toEqual({ session_id: 'sess' });
    expect(agentTelemetry.getContext()).toEqual({ session_id: 'sess', agent_id: 'main' });
    appTelemetry.track('from_app');
    sessionTelemetry.track('from_session');
    agentTelemetry.track('from_agent');
    expect(recorder.records.map((record) => record.properties)).toEqual([
      {},
      { sessionId: 'sess' },
      { sessionId: 'sess', agent_id: 'main' },
    ]);
    sessionTelemetry.setContext({ mode: 'plan' });
    expect(agentTelemetry.getContext()).toEqual({
      session_id: 'sess',
      agent_id: 'main',
      mode: 'plan',
    });
    expect(appTelemetry.getContext()).toEqual({});
    await harness.close();
  });

  it('drops events while disabled and honors the initial enabled flag', async () => {
    const off = await mountTelemetryApp({ enabled: false });
    off.faces.app!.track('ignored');
    expect(off.recorder.records).toHaveLength(0);
    off.faces.app!.setEnabled(true);
    off.faces.app!.track('kept');
    expect(eventNames(off.recorder.records)).toEqual(['kept']);
    await off.harness.close();
    const on = await mountTelemetryApp();
    const telemetry = on.faces.app!;
    telemetry.setEnabled(false);
    telemetry.track('ignored');
    telemetry.setEnabled(true);
    telemetry.track('kept');
    expect(eventNames(on.recorder.records)).toEqual(['kept']);
    await on.harness.close();
  });

  it('flips enabled through config when present and honors the disable env binding', async () => {
    const recorder = createRecorder();
    const faces: CapturedFaces = {};
    const captured: { store?: ConfigStore } = {};
    const harness = createHarness({ space: memoryHarnessSpace() });
    await harness.app.features.add(createConfig({}));
    await harness.app.features.add(createTelemetry());
    await harness.app.features.add(recorderFeature(recorder));
    await harness.app.features.add(captureFeature(faces));
    await harness.app.features.add(configCaptureFeature(captured));
    await tick();
    const telemetry = faces.app!;
    const config = captured.store!;
    telemetry.track('first');
    expect(recorder.records).toHaveLength(1);
    await config.set('telemetry', false, 'memory');
    await tick();
    telemetry.track('dropped');
    expect(recorder.records).toHaveLength(1);
    await config.set('telemetry', true, 'memory');
    await tick();
    telemetry.track('second');
    expect(eventNames(recorder.records)).toEqual(['first', 'second']);
    await harness.close();
    const envRecorder = createRecorder();
    const envFaces: CapturedFaces = {};
    const envHarness = createHarness({ space: memoryHarnessSpace() });
    await envHarness.app.features.add(createConfig({ env: { KIMI_DISABLE_TELEMETRY: '1' } }));
    await envHarness.app.features.add(createTelemetry());
    await envHarness.app.features.add(recorderFeature(envRecorder));
    await envHarness.app.features.add(captureFeature(envFaces));
    await tick();
    envFaces.app!.track('dropped');
    expect(envRecorder.records).toHaveLength(0);
    await envHarness.close();
  });

  it('derives turn lifecycle events and scopes turn context to the turn', async () => {
    const { harness, recorder, faces } = await mountTelemetryApp({
      context: { model: 'test-model' },
    });
    const session = await harness.app.create({ sessionId: 'sess' });
    const agent = await harness.ensureAgent(session, 'main');
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setRequester(harness, 'sess', 'main', scriptedRequester(() => gate.then(() => textOutcome('hi'))));
    agent.loop.submit(user('hello'));
    await waitForEvent(recorder.records, 'turn_started');
    faces.agent!.track('during_turn');
    release();
    await waitForEvent(recorder.records, 'turn_ended');
    faces.agent!.track('after_turn');
    const started = findRecord(recorder.records, 'turn_started');
    const ended = findRecord(recorder.records, 'turn_ended');
    expect(started.properties['model']).toBe('test-model');
    expect(ended.properties['turn_id']).toBe(started.properties['turn_id']);
    expect(ended.properties['reason']).toBe('completed');
    expect(ended.properties['duration_ms']).toBeTypeOf('number');
    const during = findRecord(recorder.records, 'during_turn');
    expect(during.properties['turn_id']).toBe(started.properties['turn_id']);
    const after = findRecord(recorder.records, 'after_turn');
    expect(after.properties['turn_id']).toBeUndefined();
    expect(after.properties['model']).toBe('test-model');
    expect(after.properties['sessionId']).toBe('sess');
    expect(after.properties['agent_id']).toBe('main');
    await harness.close();
  });

  it('derives tool_call events with paired outcome and reports failed turns', async () => {
    const tools = createFeature('telemetry-tools', {
      agent() {
        useAgentTools(
          {
            name: 'ping',
            description: 'ping',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ content: [{ type: 'text', text: 'pong' }] }),
          },
          {
            name: 'bad',
            description: 'bad',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }),
          },
          {
            name: 'halter',
            description: 'halter',
            parameters: { type: 'object', properties: {} },
            execute: async () => ({
              content: [{ type: 'text', text: 'Tool "halter" was aborted' }],
              isError: true,
            }),
          },
        );
      },
    });
    const { harness, recorder } = await mountTelemetryApp();
    await harness.app.features.add(tools);
    const session = await harness.app.create({ sessionId: 'sess' });
    const agent = await harness.ensureAgent(session, 'main');
    setRequester(
      harness,
      'sess',
      'main',
      scriptedRequester((rest) => {
        const messages = rest.content?.messages ?? [];
        const last = messages.at(-1);
        if (last !== undefined && last.role === 'user' && extractText(last) === 'go') {
          return textOutcome('', [{ type: 'function', id: 'call-1', name: 'ping', arguments: '{}' }]);
        }
        if (last !== undefined && last.role === 'user' && extractText(last) === 'bad') {
          return textOutcome('', [{ type: 'function', id: 'call-2', name: 'bad', arguments: '{}' }]);
        }
        if (last !== undefined && last.role === 'user' && extractText(last) === 'halt') {
          return textOutcome('', [{ type: 'function', id: 'call-3', name: 'halter', arguments: '{}' }]);
        }
        return textOutcome('done');
      }),
    );
    agent.loop.submit(user('go'));
    await waitForEvent(recorder.records, 'tool_call');
    const toolCall = findRecord(recorder.records, 'tool_call');
    expect(toolCall.properties['tool_name']).toBe('ping');
    expect(toolCall.properties['tool_call_id']).toBe('call-1');
    expect(toolCall.properties['outcome']).toBe('success');
    expect(toolCall.properties['error_type']).toBeUndefined();
    expect(toolCall.properties['duration_ms']).toBeTypeOf('number');
    const started = findRecord(recorder.records, 'turn_started');
    expect(toolCall.properties['turn_id']).toBe(started.properties['turn_id']);
    await waitForEvent(recorder.records, 'turn_ended');
    agent.loop.submit(user('bad'));
    await vi.waitFor(() => {
      expect(recorder.records.filter((record) => record.event === 'tool_call')).toHaveLength(2);
    });
    const badCall = recorder.records.filter((record) => record.event === 'tool_call')[1];
    expect(badCall?.properties['tool_name']).toBe('bad');
    expect(badCall?.properties['outcome']).toBe('error');
    expect(badCall?.properties['error_type']).toBe('error');
    agent.loop.submit(user('halt'));
    await vi.waitFor(() => {
      expect(recorder.records.filter((record) => record.event === 'tool_call')).toHaveLength(3);
    });
    const haltCall = recorder.records.filter((record) => record.event === 'tool_call')[2];
    expect(haltCall?.properties['tool_name']).toBe('halter');
    expect(haltCall?.properties['outcome']).toBe('cancelled');
    expect(haltCall?.properties['error_type']).toBe('cancelled');
    await harness.close();
    const failed = await mountTelemetryApp();
    const failSession = await failed.harness.app.create({ sessionId: 'sess' });
    const failAgent = await failed.harness.ensureAgent(failSession, 'main');
    setRequester(failed.harness, 'sess', 'main', failingRequester({ kind: 'unknown', message: 'boom' }));
    failAgent.loop.submit(user('go'));
    await waitForEvent(failed.recorder.records, 'turn_ended');
    expect(findRecord(failed.recorder.records, 'turn_ended').properties['reason']).toBe('failed');
    await failed.harness.close();
  });

  it('derives api_error from llm failures', async () => {
    const { harness, recorder } = await mountTelemetryApp({
      context: { model: 'test-model' },
    });
    const session = await harness.app.create({ sessionId: 'sess' });
    const agent = await harness.ensureAgent(session, 'main');
    setRequester(
      harness,
      'sess',
      'main',
      failingRequester({ kind: 'syntax', message: 'bad request', code: 'request_format' }),
    );
    agent.loop.submit(user('go'));
    await waitForEvent(recorder.records, 'api_error');
    const apiError = findRecord(recorder.records, 'api_error');
    expect(apiError.properties['error_type']).toBe('syntax');
    expect(apiError.properties['model']).toBe('test-model');
    await waitForEvent(recorder.records, 'turn_ended');
    await harness.close();
  });

  it('collects late event definitions and tracks through createTracker', async () => {
    const { harness, recorder, faces } = await mountTelemetryApp();
    const telemetry = faces.app!;
    expect(telemetry.events().map((def) => def.name)).toContain('turn_started');
    const defs = [{ name: 'probe_fired', properties: ['count'] }] as const;
    const late = createFeature('telemetry-late-defs', {
      app() {
        useTelemetryEvents(defs);
      },
    });
    await harness.app.features.add(late);
    await tick();
    expect(telemetry.events().map((def) => def.name)).toContain('probe_fired');
    const tracker = createTracker(telemetry, defs);
    tracker('probe_fired', { count: 2 });
    expect(recorder.records.at(-1)?.event).toBe('probe_fired');
    expect(recorder.records.at(-1)?.properties).toEqual({ count: 2 });
    await harness.close();
  });

  it('fans out flush and shutdown and swallows appender failures', async () => {
    const recorder = createRecorder();
    const calls = { flush: 0, shutdown: 0 };
    const healthy: TelemetryAppender = {
      track: recorder.appender.track,
      flush: () => {
        calls.flush += 1;
      },
      shutdown: () => {
        calls.shutdown += 1;
      },
    };
    const broken: TelemetryAppender = {
      track: () => {
        throw new Error('boom');
      },
      flush: () => Promise.reject(new Error('boom')),
      shutdown: () => {
        throw new Error('boom');
      },
    };
    const probe = createFeature('telemetry-broken-appender', {
      app() {
        useTelemetryAppender(broken);
        useTelemetryAppender(healthy);
      },
    });
    const faces: CapturedFaces = {};
    const harness = createHarness({ space: memoryHarnessSpace() });
    await harness.app.features.add(createTelemetry());
    await harness.app.features.add(probe);
    await harness.app.features.add(captureFeature(faces));
    await tick();
    const telemetry = faces.app!;
    expect(() => telemetry.track('survives')).not.toThrow();
    expect(eventNames(recorder.records)).toEqual(['survives']);
    await expect(telemetry.flush()).resolves.toBeUndefined();
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
    expect(calls).toEqual({ flush: 1, shutdown: 1 });
    await harness.close();
  });

  it('derives prompt_cache_probe from streaming usage', async () => {
    const { harness, recorder } = await mountTelemetryApp();
    const session = await harness.app.create({ sessionId: 'sess' });
    const agent = await harness.ensureAgent(session, 'main');
    setRequester(
      harness,
      'sess',
      'main',
      scriptedRequester((_rest, control) => {
        control.onEvent?.({
          type: 'llm.streaming.usage',
          usage: { inputOther: 10, inputCacheRead: 5, inputCacheCreation: 2, output: 3 },
        });
        return textOutcome('hi');
      }),
    );
    agent.loop.submit(user('hello'));
    await waitForEvent(recorder.records, 'prompt_cache_probe');
    const probe = findRecord(recorder.records, 'prompt_cache_probe');
    const started = findRecord(recorder.records, 'turn_started');
    expect(probe.properties['turn_id']).toBe(started.properties['turn_id']);
    expect(probe.properties['input_tokens']).toBe(17);
    expect(probe.properties['input_cache_read']).toBe(5);
    expect(probe.properties['input_cache_creation']).toBe(2);
    expect(probe.properties['output_tokens']).toBe(3);
    await harness.close();
  });
});
