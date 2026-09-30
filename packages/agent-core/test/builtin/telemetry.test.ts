import { describe, expect, it, vi } from 'vitest';

import { createHarness, type AppHandle } from '#/app/index';
import { ConfigRef, createConfig } from '#/builtin/config/index';
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
} from '#/builtin/telemetry/index';
import { createFeature, useAgentTools } from '#/feature/index';
import type { LlmErrorMessage, LlmRemoteErrorMessage } from '#/llm/errors';
import { createUserMessage, extractText } from '#/llm/message';
import { UNKNOWN_CAPABILITY, type LlmModel } from '#/llm/model';
import type { LlmRequester } from '#/llm/requester/requester';
import { openBlobs } from '#/store/blob';
import { MemoryBackend, Trees } from '#/store/tree';
import { openSessionStores, type SessionStores } from '#/stores/session';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

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

async function testStores(): Promise<{ stores: SessionStores }> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  return { stores: await openSessionStores(tree, openBlobs(backend.blobs)) };
}

function mountTelemetryApp(props?: { enabled?: boolean; context?: TelemetryContextPatch }): {
  app: AppHandle;
  recorder: { records: TelemetryAppenderRecord[]; appender: TelemetryAppender };
  ready: Promise<void>;
} {
  const recorder = createRecorder();
  const app = createHarness({ features: [createTelemetry(props), recorderFeature(recorder)] });
  return { app, recorder, ready: app.ready() };
}

function failingRequester(
  failure:
    | { type: 'llm.failed.syntax'; error: LlmErrorMessage<'syntax'> }
    | { type: 'llm.failed.remote'; error: LlmRemoteErrorMessage },
): LlmRequester {
  return {
    generate: (_config, _input, { onEvent }) => {
      onEvent?.(failure);
      return Promise.resolve();
    },
  };
}

async function settleMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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
    const { app, recorder, ready } = mountTelemetryApp({
      context: { provider_type: 'test', mode: 'agent' },
    });
    await ready;
    const telemetry = app.resolve(TelemetryRef)!;
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
    await app.disposeAsync();
  });

  it('shadows the facade per tier with inherited context', async () => {
    const { app, recorder, ready } = mountTelemetryApp();
    await ready;
    const env = await testStores();
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const agent = await session.create({ agentId: 'main' });
    const appTelemetry = app.resolve(TelemetryRef)!;
    const sessionTelemetry = session.resolve(TelemetryRef)!;
    const agentTelemetry = agent.resolve(TelemetryRef)!;
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
    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('drops events while disabled and honors the initial enabled flag', async () => {
    const off = mountTelemetryApp({ enabled: false });
    await off.ready;
    off.app.resolve(TelemetryRef)!.track('ignored');
    expect(off.recorder.records).toHaveLength(0);
    off.app.resolve(TelemetryRef)!.setEnabled(true);
    off.app.resolve(TelemetryRef)!.track('kept');
    expect(eventNames(off.recorder.records)).toEqual(['kept']);
    await off.app.disposeAsync();
    const on = mountTelemetryApp();
    await on.ready;
    const telemetry = on.app.resolve(TelemetryRef)!;
    telemetry.setEnabled(false);
    telemetry.track('ignored');
    telemetry.setEnabled(true);
    telemetry.track('kept');
    expect(eventNames(on.recorder.records)).toEqual(['kept']);
    await on.app.disposeAsync();
  });

  it('flips enabled through config when present and honors the disable env binding', async () => {
    const recorder = createRecorder();
    const app = createHarness({
      features: [createConfig({}), createTelemetry(), recorderFeature(recorder)],
    });
    await app.ready();
    const telemetry = app.resolve(TelemetryRef)!;
    const config = app.resolve(ConfigRef)!;
    telemetry.track('first');
    expect(recorder.records).toHaveLength(1);
    await config.set('telemetry', false, 'memory');
    await settleMicrotasks();
    telemetry.track('dropped');
    expect(recorder.records).toHaveLength(1);
    await config.set('telemetry', true, 'memory');
    await settleMicrotasks();
    telemetry.track('second');
    expect(eventNames(recorder.records)).toEqual(['first', 'second']);
    await app.disposeAsync();
    const envRecorder = createRecorder();
    const envApp = createHarness({
      features: [
        createConfig({ env: { KIMI_DISABLE_TELEMETRY: '1' } }),
        createTelemetry(),
        recorderFeature(envRecorder),
      ],
    });
    await envApp.ready();
    await settleMicrotasks();
    envApp.resolve(TelemetryRef)!.track('dropped');
    expect(envRecorder.records).toHaveLength(0);
    await envApp.disposeAsync();
  });

  it('derives turn lifecycle events and scopes turn context to the turn', async () => {
    const { app, recorder, ready } = mountTelemetryApp();
    await ready;
    const env = await testStores();
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const agent = await session.create({ agentId: 'main' });
    agent.setConfig({ model });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    agent.setRequester({
      generate: (_config, _input, { onEvent }) =>
        gate.then(() => {
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'hi' } });
          onEvent?.({ type: 'llm.done' });
        }),
    });
    const agentTelemetry = agent.resolve(TelemetryRef)!;
    agent.submit(createUserMessage('hello'));
    await waitForEvent(recorder.records, 'turn_started');
    agentTelemetry.track('during_turn');
    release();
    await waitForEvent(recorder.records, 'turn_ended');
    agentTelemetry.track('after_turn');
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
    await app.disposeAsync();
    await env.stores.dispose();
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
    const recorder = createRecorder();
    const app = createHarness({ features: [createTelemetry(), recorderFeature(recorder), tools] });
    await app.ready();
    const env = await testStores();
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const agent = await session.create({ agentId: 'main' });
    agent.setConfig({ model });
    const requester: LlmRequester = {
      generate: (_config, { messages }, { onEvent }) => {
        const last = messages.at(-1);
        if (last !== undefined && last.role === 'user' && extractText(last) === 'go') {
          onEvent?.({
            type: 'llm.streaming.part',
            part: { type: 'function', id: 'call-1', name: 'ping', arguments: '{}' },
          });
        } else if (last !== undefined && last.role === 'user' && extractText(last) === 'bad') {
          onEvent?.({
            type: 'llm.streaming.part',
            part: { type: 'function', id: 'call-2', name: 'bad', arguments: '{}' },
          });
        } else if (last !== undefined && last.role === 'user' && extractText(last) === 'halt') {
          onEvent?.({
            type: 'llm.streaming.part',
            part: { type: 'function', id: 'call-3', name: 'halter', arguments: '{}' },
          });
        } else {
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'done' } });
        }
        onEvent?.({ type: 'llm.done' });
        return Promise.resolve();
      },
    };
    agent.setRequester(requester);
    agent.submit(createUserMessage('go'));
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
    agent.submit(createUserMessage('bad'));
    await vi.waitFor(() => {
      expect(recorder.records.filter((record) => record.event === 'tool_call')).toHaveLength(2);
    });
    const badCall = recorder.records.filter((record) => record.event === 'tool_call')[1];
    expect(badCall?.properties['tool_name']).toBe('bad');
    expect(badCall?.properties['outcome']).toBe('error');
    expect(badCall?.properties['error_type']).toBe('error');
    agent.submit(createUserMessage('halt'));
    await vi.waitFor(() => {
      expect(recorder.records.filter((record) => record.event === 'tool_call')).toHaveLength(3);
    });
    const haltCall = recorder.records.filter((record) => record.event === 'tool_call')[2];
    expect(haltCall?.properties['tool_name']).toBe('halter');
    expect(haltCall?.properties['outcome']).toBe('cancelled');
    expect(haltCall?.properties['error_type']).toBe('cancelled');
    await app.disposeAsync();
    await env.stores.dispose();
    const failed = createRecorder();
    const failApp = createHarness({ features: [createTelemetry(), recorderFeature(failed)] });
    await failApp.ready();
    const failEnv = await testStores();
    const failSession = await failApp.create({ sessionId: 'sess', stores: failEnv.stores });
    const failAgent = await failSession.create({ agentId: 'main' });
    failAgent.setConfig({ model });
    failAgent.setRequester(
      failingRequester({ type: 'llm.failed.remote', error: { kind: 'unknown', message: 'boom' } }),
    );
    failAgent.submit(createUserMessage('go'));
    await waitForEvent(failed.records, 'turn_ended');
    expect(findRecord(failed.records, 'turn_ended').properties['reason']).toBe('failed');
    await failApp.disposeAsync();
    await failEnv.stores.dispose();
  });

  it('derives api_error from llm failures', async () => {
    const { app, recorder, ready } = mountTelemetryApp();
    await ready;
    const env = await testStores();
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const agent = await session.create({ agentId: 'main' });
    agent.setConfig({ model });
    agent.setRequester(
      failingRequester({
        type: 'llm.failed.syntax',
        error: { kind: 'syntax', message: 'bad request', code: 'request_format' },
      }),
    );
    agent.submit(createUserMessage('go'));
    await waitForEvent(recorder.records, 'api_error');
    const apiError = findRecord(recorder.records, 'api_error');
    expect(apiError.properties['error_type']).toBe('syntax');
    expect(apiError.properties['model']).toBe('test-model');
    await waitForEvent(recorder.records, 'turn_ended');
    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('collects late event definitions and tracks through createTracker', async () => {
    const { app, recorder, ready } = mountTelemetryApp();
    await ready;
    const telemetry: TelemetryFace = app.resolve(TelemetryRef)!;
    expect(telemetry.events().map((def) => def.name)).toContain('turn_started');
    const defs = [{ name: 'probe_fired', properties: ['count'] }] as const;
    const late = createFeature('telemetry-late-defs', {
      app() {
        useTelemetryEvents(defs);
      },
    });
    app.installFeature(late);
    await app.ready();
    expect(telemetry.events().map((def) => def.name)).toContain('probe_fired');
    const tracker = createTracker(telemetry, defs);
    tracker('probe_fired', { count: 2 });
    expect(recorder.records.at(-1)?.event).toBe('probe_fired');
    expect(recorder.records.at(-1)?.properties).toEqual({ count: 2 });
    await app.disposeAsync();
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
    const app = createHarness({ features: [createTelemetry(), probe] });
    await app.ready();
    const telemetry = app.resolve(TelemetryRef)!;
    expect(() => telemetry.track('survives')).not.toThrow();
    expect(eventNames(recorder.records)).toEqual(['survives']);
    await expect(telemetry.flush()).resolves.toBeUndefined();
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
    expect(calls).toEqual({ flush: 1, shutdown: 1 });
    await app.disposeAsync();
  });

  it('derives prompt_cache_probe from streaming usage', async () => {
    const { app, recorder, ready } = mountTelemetryApp();
    await ready;
    const env = await testStores();
    const session = await app.create({ sessionId: 'sess', stores: env.stores });
    const agent = await session.create({ agentId: 'main' });
    agent.setConfig({ model });
    agent.setRequester({
      generate: (_config, _input, { onEvent }) => {
        onEvent?.({
          type: 'llm.streaming.usage',
          usage: { inputOther: 10, inputCacheRead: 5, inputCacheCreation: 2, output: 3 },
        });
        onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'hi' } });
        onEvent?.({ type: 'llm.done' });
        return Promise.resolve();
      },
    });
    agent.submit(createUserMessage('hello'));
    await waitForEvent(recorder.records, 'prompt_cache_probe');
    const probe = findRecord(recorder.records, 'prompt_cache_probe');
    const started = findRecord(recorder.records, 'turn_started');
    expect(probe.properties['turn_id']).toBe(started.properties['turn_id']);
    expect(probe.properties['input_tokens']).toBe(17);
    expect(probe.properties['input_cache_read']).toBe(5);
    expect(probe.properties['input_cache_creation']).toBe(2);
    expect(probe.properties['output_tokens']).toBe(3);
    await app.disposeAsync();
    await env.stores.dispose();
  });
});
