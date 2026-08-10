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

/**
 * Phase 14.3 funnel — three input paths converge on identical
 * `config_option_update` wire shape:
 *   1. `unstable_setSessionModel({ sessionId, modelId })`
 *   2. `setSessionMode({ sessionId, modeId })`
 *   3. `setSessionConfigOption({ sessionId, configId, value })`
 *
 * Each must emit exactly one `config_option_update` notification
 * carrying the same envelope (discriminator, configOptions array
 * shape, per-option fields). `currentValue` differs by input path
 * but the surrounding structure is identical.
 */

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

function makeFakeSession(sessionId: string): Session {
  return {
    id: sessionId,
    prompt: async () => undefined,
    cancel: async () => undefined,
    onEvent: (_fn: (event: Event) => void) => () => undefined,
    setApprovalHandler: (_handler: ApprovalHandler | undefined) => undefined,
    setPlanMode: async () => undefined,
    setPermission: async (_mode: PermissionMode) => undefined,
    setModel: async () => undefined,
    setThinking: async () => undefined,
  } as unknown as Session;
}

function makeHarness(session: Session): KimiHarness {
  return {
    auth: { status: async () => AUTHED_STATUS },
    createSession: async () => session,
    getConfig: async () => ({
      providers: {},
      defaultModel: 'kimi-coder',
      models: makeModelsMap([
        { id: 'kimi-coder', name: 'Kimi Coder', thinkingSupported: false },
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

/**
 * Extract just the `update` field from the single
 * `config_option_update` notification emitted on `sessionId`.
 * Throws if the count is anything other than 1 so the test fails
 * loudly on funnel regression.
 */
function extractSingleConfigOptionUpdate(
  capturing: CapturingClient,
  sessionId: string,
): SessionNotification['update'] {
  const updates = capturing.notifications.filter(
    (n) => n.sessionId === sessionId && n.update.sessionUpdate === 'config_option_update',
  );
  expect(updates).toHaveLength(1);
  return updates[0]!.update;
}

describe('config_option_update wire-shape funnel', () => {
  it('unstable_setSessionModel emits one config_option_update with `model` currentValue updated', async () => {
    const session = makeFakeSession('sess-funnel-1');
    const harness = makeHarness(session);
    const { client, capturing, sessionId } = await openSession(harness);
    capturing.notifications.length = 0;

    await client.unstable_setSessionModel({ sessionId, modelId: 'kimi-v2' });

    const update = extractSingleConfigOptionUpdate(capturing, sessionId);
    if (update.sessionUpdate !== 'config_option_update') throw new Error('unreachable');
    expect(update.configOptions).toHaveLength(2);
    const modelOpt = update.configOptions.find((o) => o.id === 'model');
    if (modelOpt && modelOpt.type === 'select') {
      expect(modelOpt.currentValue).toBe('kimi-v2');
    }
    const modeOpt = update.configOptions.find((o) => o.id === 'mode');
    if (modeOpt && modeOpt.type === 'select') {
      // Mode unchanged on a model-only switch — stays at the session's default.
      expect(modeOpt.currentValue).toBe('default');
    }
  });

  it('setSessionMode emits one config_option_update with `mode` currentValue updated', async () => {
    const session = makeFakeSession('sess-funnel-2');
    const harness = makeHarness(session);
    const { client, capturing, sessionId } = await openSession(harness);
    capturing.notifications.length = 0;

    await client.setSessionMode({ sessionId, modeId: 'plan' });

    const update = extractSingleConfigOptionUpdate(capturing, sessionId);
    if (update.sessionUpdate !== 'config_option_update') throw new Error('unreachable');
    const modeOpt = update.configOptions.find((o) => o.id === 'mode');
    if (modeOpt && modeOpt.type === 'select') {
      expect(modeOpt.currentValue).toBe('plan');
    }
  });

  it('setSessionConfigOption(mode=yolo) emits one config_option_update with `mode` currentValue updated', async () => {
    const session = makeFakeSession('sess-funnel-3');
    const harness = makeHarness(session);
    const { client, capturing, sessionId } = await openSession(harness);
    capturing.notifications.length = 0;

    await client.setSessionConfigOption({ sessionId, configId: 'mode', value: 'yolo' });

    const update = extractSingleConfigOptionUpdate(capturing, sessionId);
    if (update.sessionUpdate !== 'config_option_update') throw new Error('unreachable');
    const modeOpt = update.configOptions.find((o) => o.id === 'mode');
    if (modeOpt && modeOpt.type === 'select') {
      expect(modeOpt.currentValue).toBe('yolo');
    }
  });

  it('setSessionConfigOption(thinking="on") emits one config_option_update with thinking toggle on', async () => {
    // Catalog needs at least one thinkingSupported entry so the toggle
    // is visible in the snapshot; default model resolves to kimi-coder
    // (the harness's configured default).
    const session = makeFakeSession('sess-funnel-thinking');
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
      getConfig: async () => ({
        providers: {},
        defaultModel: 'kimi-coder',
        models: makeModelsMap([{ id: 'kimi-coder', name: 'Kimi Coder', thinkingSupported: true }]),
      }),
    } as unknown as KimiHarness;
    const { client, capturing, sessionId } = await openSession(harness);
    capturing.notifications.length = 0;

    await client.setSessionConfigOption({
      sessionId,
      configId: 'thinking',
      value: 'on',
    });

    const update = extractSingleConfigOptionUpdate(capturing, sessionId);
    if (update.sessionUpdate !== 'config_option_update') throw new Error('unreachable');
    const toggle = update.configOptions.find((o) => o.id === 'thinking');
    if (!toggle || toggle.type !== 'select') throw new Error('expected select toggle');
    expect(toggle.currentValue).toBe('on');
    expect(update.configOptions.map((o) => o.id)).toEqual(['model', 'thinking', 'mode']);
  });

  it('all three input paths emit the SAME wire envelope (discriminator + option ids + per-option shape)', async () => {
    // Reusable extractor — collects the wire envelope skeleton from
    // each path so we can deep-equal-check structural identity.
    async function envelopeFromPath(
      driver: (
        client: ClientSideConnection,
        sessionId: string,
      ) => Promise<unknown>,
    ): Promise<{
      sessionUpdate: string;
      configOptionIds: string[];
      configOptionCategories: Array<string | null | undefined>;
      configOptionTypes: string[];
    }> {
      const session = makeFakeSession(`sess-envelope-${Math.random().toString(36).slice(2)}`);
      const harness = makeHarness(session);
      const { client, capturing, sessionId } = await openSession(harness);
      capturing.notifications.length = 0;
      await driver(client, sessionId);
      const update = extractSingleConfigOptionUpdate(capturing, sessionId);
      if (update.sessionUpdate !== 'config_option_update') throw new Error('unreachable');
      return {
        sessionUpdate: update.sessionUpdate,
        configOptionIds: update.configOptions.map((o) => o.id),
        configOptionCategories: update.configOptions.map((o) => o.category ?? null),
        configOptionTypes: update.configOptions.map((o) => o.type),
      };
    }

    const viaModel = await envelopeFromPath((c, sid) =>
      c.unstable_setSessionModel({ sessionId: sid, modelId: 'kimi-v2' }),
    );
    const viaMode = await envelopeFromPath((c, sid) =>
      c.setSessionMode({ sessionId: sid, modeId: 'plan' }),
    );
    const viaConfigOption = await envelopeFromPath((c, sid) =>
      c.setSessionConfigOption({ sessionId: sid, configId: 'mode', value: 'yolo' }),
    );

    expect(viaModel).toEqual(viaMode);
    expect(viaMode).toEqual(viaConfigOption);
    expect(viaModel.sessionUpdate).toBe('config_option_update');
    expect(viaModel.configOptionIds).toEqual(['model', 'mode']);
    expect(viaModel.configOptionTypes).toEqual(['select', 'select']);
    expect(viaModel.configOptionCategories).toEqual(['model', 'mode']);
  });
});
