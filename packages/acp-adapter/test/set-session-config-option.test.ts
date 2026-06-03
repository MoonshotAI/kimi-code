import { describe, expect, it } from 'vitest';

import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import type {
  ApprovalHandler,
  Event,
  KimiHarness,
  PermissionMode,
  Session,
} from '@moonshot-ai/kimi-code-sdk';

import { AcpServer } from '../src/server';
import { AUTHED_STATUS, makeModelsMap } from './_helpers/harness-stubs';

class CapturingClient implements Client {
  readonly notifications: SessionNotification[] = [];
  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('CapturingClient.requestPermission should not be called');
  }
  async sessionUpdate(n: SessionNotification): Promise<void> {
    this.notifications.push(n);
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('CapturingClient.writeTextFile should not be called');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('CapturingClient.readTextFile should not be called');
  }
}

function makeInMemoryStreamPair(): {
  agentStream: ReturnType<typeof ndJsonStream>;
  clientStream: ReturnType<typeof ndJsonStream>;
} {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable);
  const clientStream = ndJsonStream(clientToAgent.writable, agentToClient.readable);
  return { agentStream, clientStream };
}

interface FakeSessionHandle {
  session: Session;
  planModeCalls: boolean[];
  setPermissionCalls: PermissionMode[];
  setModelCalls: string[];
  setThinkingCalls: string[];
}

function makeFakeSession(sessionId: string): FakeSessionHandle {
  const planModeCalls: boolean[] = [];
  const setPermissionCalls: PermissionMode[] = [];
  const setModelCalls: string[] = [];
  const setThinkingCalls: string[] = [];
  const session = {
    id: sessionId,
    prompt: async () => undefined,
    cancel: async () => undefined,
    onEvent: (_fn: (event: Event) => void) => () => undefined,
    setApprovalHandler: (_handler: ApprovalHandler | undefined) => undefined,
    setPlanMode: async (enabled: boolean) => {
      planModeCalls.push(enabled);
    },
    setPermission: async (mode: PermissionMode) => {
      setPermissionCalls.push(mode);
    },
    setModel: async (model: string) => {
      setModelCalls.push(model);
    },
    setThinking: async (level: string) => {
      setThinkingCalls.push(level);
    },
  } as unknown as Session;
  return { session, planModeCalls, setPermissionCalls, setModelCalls, setThinkingCalls };
}

function makeHarness(handle: FakeSessionHandle): KimiHarness {
  return {
    auth: { status: async () => AUTHED_STATUS },
    createSession: async () => handle.session,
    getConfig: async () => ({
      providers: {},
      defaultModel: 'kimi-coder',
      models: makeModelsMap([
        { id: 'kimi-coder', name: 'Kimi Coder', thinkingSupported: true },
        { id: 'kimi-v2', name: 'Kimi v2', thinkingSupported: false },
      ]),
    }),
  } as unknown as KimiHarness;
}

async function openSession(
  harness: KimiHarness,
): Promise<{ client: ClientSideConnection; capturing: CapturingClient; sessionId: string }> {
  const { agentStream, clientStream } = makeInMemoryStreamPair();
  new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
  const capturing = new CapturingClient();
  const client = new ClientSideConnection((_a) => capturing, clientStream);
  const response = await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
  return { client, capturing, sessionId: response.sessionId };
}

describe('AcpServer session/set_config_option', () => {
  it('configId="model" + known modelId → setModel + 1 config_option_update + response contains full snapshot', async () => {
    const handle = makeFakeSession('sess-model');
    const harness = makeHarness(handle);
    const { client, capturing, sessionId } = await openSession(harness);
    capturing.notifications.length = 0; // ignore newSession-time notifications

    const response = await client.setSessionConfigOption({
      sessionId,
      configId: 'model',
      value: 'kimi-v2',
    });

    expect(handle.setModelCalls).toEqual(['kimi-v2']);
    // The new model is non-thinking-supported, so the toggle is omitted.
    expect(handle.setThinkingCalls).toEqual([]);

    // Exactly one config_option_update notification (no double-emit).
    const updates = capturing.notifications.filter(
      (n) => n.sessionId === sessionId && n.update.sessionUpdate === 'config_option_update',
    );
    expect(updates).toHaveLength(1);
    const update = updates[0]!.update;
    if (update.sessionUpdate !== 'config_option_update') throw new Error('unreachable');
    const modelOpt = update.configOptions.find((o) => o.id === 'model');
    if (modelOpt && modelOpt.type === 'select') {
      expect(modelOpt.currentValue).toBe('kimi-v2');
    }
    // Switching to a non-thinking-supported model drops the toggle entirely.
    expect(update.configOptions.map((o) => o.id)).toEqual(['model', 'mode']);

    // Response carries the same snapshot as the notification.
    expect(response.configOptions).toBeDefined();
    expect(response.configOptions).toHaveLength(2);
    const respModel = response.configOptions.find((o) => o.id === 'model');
    if (respModel && respModel.type === 'select') {
      expect(respModel.currentValue).toBe('kimi-v2');
    }
  });

  it('configId="model" + `${id},thinking` → SDK gets stripped id + setThinking("high") + snapshot shows base id with thinking toggle on', async () => {
    const handle = makeFakeSession('sess-model-thinking');
    const harness = makeHarness(handle);
    const { client, capturing, sessionId } = await openSession(harness);
    capturing.notifications.length = 0;

    const response = await client.setSessionConfigOption({
      sessionId,
      configId: 'model',
      value: 'kimi-coder,thinking',
    });

    expect(handle.setModelCalls).toEqual(['kimi-coder']);
    expect(handle.setThinkingCalls).toEqual(['high']);
    const respModel = response.configOptions.find((o) => o.id === 'model');
    if (respModel && respModel.type === 'select') {
      // Snapshot now carries the bare model id; thinking lives on a separate axis.
      expect(respModel.currentValue).toBe('kimi-coder');
    }
    const respThinking = response.configOptions.find((o) => o.id === 'thinking');
    if (!respThinking || respThinking.type !== 'select') {
      throw new Error('expected thinking toggle in snapshot');
    }
    expect(respThinking.currentValue).toBe('on');
    expect(respThinking.category).toBe('thought_level');
  });

  it('configId="thinking" + "on" → setThinking("high") + 1 config_option_update with currentValue="on"', async () => {
    const handle = makeFakeSession('sess-thinking-on');
    const harness = makeHarness(handle);
    const { client, capturing, sessionId } = await openSession(harness);
    capturing.notifications.length = 0;

    const response = await client.setSessionConfigOption({
      sessionId,
      configId: 'thinking',
      value: 'on',
    });

    expect(handle.setThinkingCalls).toEqual(['high']);
    expect(handle.setModelCalls).toEqual([]);
    const updates = capturing.notifications.filter(
      (n) => n.sessionId === sessionId && n.update.sessionUpdate === 'config_option_update',
    );
    expect(updates).toHaveLength(1);
    const update = updates[0]!.update;
    if (update.sessionUpdate !== 'config_option_update') throw new Error('unreachable');
    const toggle = update.configOptions.find((o) => o.id === 'thinking');
    if (!toggle || toggle.type !== 'select') throw new Error('expected select toggle');
    expect(toggle.currentValue).toBe('on');

    const respToggle = response.configOptions.find((o) => o.id === 'thinking');
    if (!respToggle || respToggle.type !== 'select') throw new Error('expected select toggle');
    expect(respToggle.currentValue).toBe('on');
  });

  it('configId="thinking" + "off" → setThinking("off") + currentValue="off"', async () => {
    const handle = makeFakeSession('sess-thinking-off');
    const harness = makeHarness(handle);
    const { client, capturing, sessionId } = await openSession(harness);
    capturing.notifications.length = 0;

    const response = await client.setSessionConfigOption({
      sessionId,
      configId: 'thinking',
      value: 'off',
    });

    expect(handle.setThinkingCalls).toEqual(['off']);
    const respToggle = response.configOptions.find((o) => o.id === 'thinking');
    if (!respToggle || respToggle.type !== 'select') throw new Error('expected select toggle');
    expect(respToggle.currentValue).toBe('off');
  });

  const MODE_CASES: ReadonlyArray<{
    modeId: 'default' | 'plan' | 'auto' | 'yolo';
    expectedPlan: boolean;
    expectedPermission: PermissionMode;
  }> = [
    { modeId: 'default', expectedPlan: false, expectedPermission: 'manual' },
    { modeId: 'plan', expectedPlan: true, expectedPermission: 'manual' },
    { modeId: 'auto', expectedPlan: false, expectedPermission: 'auto' },
    { modeId: 'yolo', expectedPlan: false, expectedPermission: 'yolo' },
  ];

  for (const { modeId, expectedPlan, expectedPermission } of MODE_CASES) {
    it(`configId="mode" + "${modeId}" → setPlanMode(${expectedPlan}) + setPermission(${expectedPermission}) + 1 config_option_update`, async () => {
      const handle = makeFakeSession(`sess-mode-${modeId}`);
      const harness = makeHarness(handle);
      const { client, capturing, sessionId } = await openSession(harness);
      capturing.notifications.length = 0;

      await client.setSessionConfigOption({ sessionId, configId: 'mode', value: modeId });

      expect(handle.planModeCalls).toEqual([expectedPlan]);
      expect(handle.setPermissionCalls).toEqual([expectedPermission]);
      const updates = capturing.notifications.filter(
        (n) => n.sessionId === sessionId && n.update.sessionUpdate === 'config_option_update',
      );
      expect(updates).toHaveLength(1);
      const update = updates[0]!.update;
      if (update.sessionUpdate !== 'config_option_update') throw new Error('unreachable');
      const modeOpt = update.configOptions.find((o) => o.id === 'mode');
      if (modeOpt && modeOpt.type === 'select') {
        expect(modeOpt.currentValue).toBe(modeId);
      }
    });
  }

  it('unknown configId throws invalid_params (-32602) BEFORE any SDK call and emits zero notifications', async () => {
    const handle = makeFakeSession('sess-bad-configId');
    const harness = makeHarness(handle);
    const { client, capturing, sessionId } = await openSession(harness);
    capturing.notifications.length = 0;

    await expect(
      client.setSessionConfigOption({ sessionId, configId: 'theme', value: 'dark' }),
    ).rejects.toMatchObject({ code: -32602 });

    expect(handle.planModeCalls).toEqual([]);
    expect(handle.setPermissionCalls).toEqual([]);
    expect(handle.setModelCalls).toEqual([]);
    const updates = capturing.notifications.filter(
      (n) => n.update.sessionUpdate === 'config_option_update',
    );
    expect(updates).toEqual([]);
  });

  it('unknown sessionId throws invalid_params (-32602)', async () => {
    const handle = makeFakeSession('sess-known');
    const harness = makeHarness(handle);
    const { client } = await openSession(harness);

    await expect(
      client.setSessionConfigOption({
        sessionId: 'sess-unknown',
        configId: 'mode',
        value: 'plan',
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});
