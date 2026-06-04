import { describe, expect, it } from 'vitest';

import {
  AgentSideConnection,
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type ContentBlock,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import type { Event, KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';

import { AcpServer } from '../src/server';
import { AUTHED_STATUS } from './_helpers/harness-stubs';

class CollectingClient implements Client {
  readonly updates: SessionNotification[] = [];

  /**
   * Updates produced AFTER `session/new` returns. Phase 9.3 makes
   * `newSession` emit exactly one `available_commands_update` on
   * creation; existing tests assert only on prompt-driven updates,
   * so we filter that variant out.
   */
  get promptUpdates(): readonly SessionNotification[] {
    return this.updates.filter(
      (n) =>
        (n.update as { sessionUpdate?: string }).sessionUpdate !==
        'available_commands_update',
    );
  }

  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('CollectingClient.requestPermission should not be called in tool-call-stream test');
  }
  async sessionUpdate(n: SessionNotification): Promise<void> {
    this.updates.push(n);
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('CollectingClient.writeTextFile should not be called in tool-call-stream test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('CollectingClient.readTextFile should not be called in tool-call-stream test');
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

function makeScriptedSession(
  sessionId: string,
  script: readonly Event[],
): Session {
  const listeners = new Set<(event: Event) => void>();
  const session = {
    id: sessionId,
    prompt: async (_input: unknown) => {
      for (const ev of script) {
        for (const fn of listeners) fn(ev);
      }
    },
    cancel: async () => undefined,
    onEvent: (fn: (event: Event) => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  } as unknown as Session;
  return session;
}

const textBlock = (text: string): ContentBlock => ({ type: 'text', text });

async function flushNdjson(): Promise<void> {
  // Let queued sessionUpdate writes drain through the ndjson stream.
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe('AcpServer tool-call streaming', () => {
  it('streams tool_call (start) → tool_call_update (delta x N) → end_turn for a single tool call', async () => {
    const sessionId = 'sess-tc-1';
    const turnId = 1;
    const toolCallId = 'tc-abc';
    const session = makeScriptedSession(sessionId, [
      {
        type: 'tool.call.started',
        sessionId,
        agentId: 'main',
        turnId,
        toolCallId,
        name: 'Read',
        args: { path: 'a' },
      } as Event,
      {
        type: 'tool.call.delta',
        sessionId,
        agentId: 'main',
        turnId,
        toolCallId,
        argumentsPart: ', "lim',
      } as Event,
      {
        type: 'tool.call.delta',
        sessionId,
        agentId: 'main',
        turnId,
        toolCallId,
        argumentsPart: 'it": 5}',
      } as Event,
      { type: 'turn.ended', sessionId, agentId: 'main', turnId, reason: 'completed' } as Event,
    ]);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    const response = await client.prompt({ sessionId, prompt: [textBlock('go')] });
    expect(response.stopReason).toBe('end_turn');
    await flushNdjson();

    expect(collecting.promptUpdates).toHaveLength(3);

    // 1) tool_call (creation) with stringified initial args.
    expect(collecting.promptUpdates[0]?.update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: `${turnId}:${toolCallId}`,
      title: 'Read',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: 'a' },
      content: [
        {
          type: 'content',
          content: { type: 'text', text: JSON.stringify({ path: 'a' }) },
        },
      ],
    });

    // 2) first delta — cumulative args = initial + first part.
    const firstCumulative = `${JSON.stringify({ path: 'a' })}, "lim`;
    expect(collecting.promptUpdates[1]?.update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: `${turnId}:${toolCallId}`,
      status: 'in_progress',
      content: [
        { type: 'content', content: { type: 'text', text: firstCumulative } },
      ],
    });

    // 3) second delta — cumulative args = initial + first + second.
    const secondCumulative = `${firstCumulative}it": 5}`;
    expect(collecting.promptUpdates[2]?.update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: `${turnId}:${toolCallId}`,
      status: 'in_progress',
      content: [
        { type: 'content', content: { type: 'text', text: secondCumulative } },
      ],
    });
  });

  it('uses turn-prefixed toolCallId so identical SDK ids across turns do not collide', async () => {
    // We script two consecutive `tool.call.started` events with the
    // SAME SDK `toolCallId` but DIFFERENT `turnId` to assert the ACP
    // wire ids are distinct.
    const sessionId = 'sess-tc-collision';
    const session = makeScriptedSession(sessionId, [
      {
        type: 'tool.call.started',
        sessionId,
        agentId: 'main',
        turnId: 1,
        toolCallId: 'X',
        name: 'Bash',
        args: { cmd: 'ls' },
      } as Event,
      {
        type: 'tool.call.started',
        sessionId,
        agentId: 'main',
        turnId: 2,
        toolCallId: 'X',
        name: 'Bash',
        args: { cmd: 'pwd' },
      } as Event,
      { type: 'turn.ended', sessionId, agentId: 'main', turnId: 2, reason: 'completed' } as Event,
    ]);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    await client.prompt({ sessionId, prompt: [textBlock('go')] });
    await flushNdjson();

    const startUpdates = collecting.updates.filter(
      (n) => (n.update as { sessionUpdate: string }).sessionUpdate === 'tool_call',
    );
    expect(startUpdates).toHaveLength(2);
    const ids = startUpdates.map((n) => (n.update as { toolCallId: string }).toolCallId);
    expect(ids).toEqual(['1:X', '2:X']);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('emits agent_thought_chunk for thinking.delta events', async () => {
    const sessionId = 'sess-thinking';
    const session = makeScriptedSession(sessionId, [
      { type: 'thinking.delta', sessionId, agentId: 'main', turnId: 1, delta: 'hmm' } as Event,
      { type: 'turn.ended', sessionId, agentId: 'main', turnId: 1, reason: 'completed' } as Event,
    ]);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    await client.prompt({ sessionId, prompt: [textBlock('go')] });
    await flushNdjson();

    expect(collecting.promptUpdates).toHaveLength(1);
    expect(collecting.promptUpdates[0]?.update).toMatchObject({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'hmm' },
    });
  });

  it('relays only `status` tool.progress updates as title-bearing tool_call_update', async () => {
    const sessionId = 'sess-progress';
    const turnId = 1;
    const toolCallId = 'tc-prog';
    const session = makeScriptedSession(sessionId, [
      {
        type: 'tool.call.started',
        sessionId,
        agentId: 'main',
        turnId,
        toolCallId,
        name: 'Bash',
        args: { cmd: 'pnpm test' },
      } as Event,
      {
        type: 'tool.progress',
        sessionId,
        agentId: 'main',
        turnId,
        toolCallId,
        update: { kind: 'stdout', text: 'should not stream' },
      } as Event,
      {
        type: 'tool.progress',
        sessionId,
        agentId: 'main',
        turnId,
        toolCallId,
        update: { kind: 'status', text: 'running test suite' },
      } as Event,
      { type: 'turn.ended', sessionId, agentId: 'main', turnId, reason: 'completed' } as Event,
    ]);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    await client.prompt({ sessionId, prompt: [textBlock('go')] });
    await flushNdjson();

    // 1 start + 1 status (stdout is dropped) = 2 updates.
    expect(collecting.promptUpdates).toHaveLength(2);
    const second = collecting.promptUpdates[1]?.update as {
      sessionUpdate: string;
      title?: string;
    };
    expect(second.sessionUpdate).toBe('tool_call_update');
    expect(second.title).toBe('running test suite');
  });

  it('lazy-creates tool_call on the first delta and upgrades on tool.call.started (production event order)', async () => {
    // The agent-core actually emits `tool.call.delta` events DURING
    // the provider's args-streaming phase and only fires
    // `tool.call.started` afterwards. The adapter must therefore
    // lazy-create the wire `tool_call` from the first delta, otherwise
    // Zed sees `tool_call_update` notifications for an unknown id and
    // surfaces "Tool call not found" until the start eventually lands.
    // This test pins the production order delta → delta → started →
    // result → end.
    const sessionId = 'sess-tc-lazy';
    const turnId = 1;
    const toolCallId = 'tc-stream';
    const session = makeScriptedSession(sessionId, [
      {
        type: 'tool.call.delta',
        sessionId,
        agentId: 'main',
        turnId,
        toolCallId,
        name: 'Read',
        argumentsPart: '{"path":',
      } as Event,
      {
        type: 'tool.call.delta',
        sessionId,
        agentId: 'main',
        turnId,
        toolCallId,
        argumentsPart: '"a"}',
      } as Event,
      {
        type: 'tool.call.started',
        sessionId,
        agentId: 'main',
        turnId,
        toolCallId,
        name: 'Read',
        args: { path: 'a' },
        description: 'Reading a',
      } as Event,
      {
        type: 'tool.result',
        sessionId,
        agentId: 'main',
        turnId,
        toolCallId,
        output: 'file content',
        isError: false,
      } as Event,
      { type: 'turn.ended', sessionId, agentId: 'main', turnId, reason: 'completed' } as Event,
    ]);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    const response = await client.prompt({ sessionId, prompt: [textBlock('go')] });
    expect(response.stopReason).toBe('end_turn');
    await flushNdjson();

    // delta(lazy-create) + delta(cumulative) + started(upgrade) + result
    expect(collecting.promptUpdates).toHaveLength(4);

    // 1) Lazy create: `tool_call` MUST land before any update, with
    // `name`-derived title and the first delta fragment as content.
    expect(collecting.promptUpdates[0]?.update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: `${turnId}:${toolCallId}`,
      title: 'Read',
      kind: 'read',
      status: 'pending',
      content: [
        { type: 'content', content: { type: 'text', text: '{"path":' } },
      ],
    });

    // 2) Second delta: cumulative args replace content.
    expect(collecting.promptUpdates[1]?.update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: `${turnId}:${toolCallId}`,
      status: 'in_progress',
      content: [
        { type: 'content', content: { type: 'text', text: '{"path":"a"}' } },
      ],
    });

    // 3) Start arrives after lazy-create: emitted as `tool_call_update`
    // carrying the canonical title (from `description`), `rawInput`,
    // and canonical stringified args. Status flips to `in_progress`.
    expect(collecting.promptUpdates[2]?.update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: `${turnId}:${toolCallId}`,
      title: 'Reading a',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: 'a' },
      content: [
        {
          type: 'content',
          content: { type: 'text', text: JSON.stringify({ path: 'a' }) },
        },
      ],
    });

    // 4) Result: terminal update.
    expect(collecting.promptUpdates[3]?.update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: `${turnId}:${toolCallId}`,
      status: 'completed',
    });
  });

  it('keeps the start-first path unchanged when no deltas precede tool.call.started', async () => {
    // Some providers (or the synthetic / replay paths) emit
    // `tool.call.started` without a preceding args stream. The adapter
    // must still send a `tool_call` CREATE in that case and NOT an
    // update — clients otherwise have no card to update.
    const sessionId = 'sess-tc-startfirst';
    const turnId = 1;
    const toolCallId = 'tc-start';
    const session = makeScriptedSession(sessionId, [
      {
        type: 'tool.call.started',
        sessionId,
        agentId: 'main',
        turnId,
        toolCallId,
        name: 'Read',
        args: { path: 'a' },
      } as Event,
      { type: 'turn.ended', sessionId, agentId: 'main', turnId, reason: 'completed' } as Event,
    ]);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    await client.prompt({ sessionId, prompt: [textBlock('go')] });
    await flushNdjson();

    expect(collecting.promptUpdates).toHaveLength(1);
    expect(collecting.promptUpdates[0]?.update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: `${turnId}:${toolCallId}`,
      title: 'Read',
      status: 'in_progress',
      rawInput: { path: 'a' },
    });
  });
});
