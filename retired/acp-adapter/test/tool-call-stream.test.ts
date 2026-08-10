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
  it('emits a tool_call create for session.tool.started and resolves with end_turn', async () => {
    const sessionId = 'sess-tc-1';
    const toolCallId = 'tc-abc';
    const session = makeScriptedSession(sessionId, [
      {
        type: 'session.tool.started',
        sessionId,
        agentId: 'main',
        tool_call_id: toolCallId,
        tool_name: 'Read',
        arguments: { path: 'a' },
      } as Event,
      {
        type: 'session.turn.ended',
        sessionId,
        agentId: 'main',
        turn_id: 1,
        stop_reason: 'EndTurn',
        steps: 1,
      } as Event,
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

    // The engine emits no args-streaming deltas — one `tool_call`
    // CREATE per `session.tool.started`, keyed on the raw tool_call_id.
    expect(collecting.promptUpdates).toHaveLength(1);
    expect(collecting.promptUpdates[0]?.update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId,
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
  });

  it('passes the raw engine tool_call_id through verbatim (no turn prefix)', async () => {
    // The engine's `session.tool.started` carries no `turn_id`, so the
    // ACP wire id is the raw tool_call_id — two calls with the same id
    // collide on the wire exactly as the engine emits them (the engine
    // owns id uniqueness on its own stream).
    const sessionId = 'sess-tc-raw';
    const session = makeScriptedSession(sessionId, [
      {
        type: 'session.tool.started',
        sessionId,
        agentId: 'main',
        tool_call_id: 'X',
        tool_name: 'Bash',
        arguments: { cmd: 'ls' },
      } as Event,
      {
        type: 'session.tool.started',
        sessionId,
        agentId: 'main',
        tool_call_id: 'X',
        tool_name: 'Bash',
        arguments: { cmd: 'pwd' },
      } as Event,
      {
        type: 'session.turn.ended',
        sessionId,
        agentId: 'main',
        turn_id: 2,
        stop_reason: 'EndTurn',
        steps: 1,
      } as Event,
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
    expect(ids).toEqual(['X', 'X']);
  });

  it('emits agent_thought_chunk for llm.delta think parts', async () => {
    const sessionId = 'sess-thinking';
    const session = makeScriptedSession(sessionId, [
      {
        type: 'llm.delta',
        sessionId,
        agentId: 'main',
        part: { type: 'think', think: 'hmm' },
      } as Event,
      {
        type: 'session.turn.ended',
        sessionId,
        agentId: 'main',
        turn_id: 1,
        stop_reason: 'EndTurn',
        steps: 1,
      } as Event,
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

  it('emits a tool_call create for session.tool.started with no args stream preceding it', async () => {
    // The engine emits `session.tool.started` directly — there is no
    // args-streaming delta phase, so the CREATE is always the first
    // (and only) wire notification for the call.
    const sessionId = 'sess-tc-startfirst';
    const toolCallId = 'tc-start';
    const session = makeScriptedSession(sessionId, [
      {
        type: 'session.tool.started',
        sessionId,
        agentId: 'main',
        tool_call_id: toolCallId,
        tool_name: 'Read',
        arguments: { path: 'a' },
      } as Event,
      {
        type: 'session.turn.ended',
        sessionId,
        agentId: 'main',
        turn_id: 1,
        stop_reason: 'EndTurn',
        steps: 1,
      } as Event,
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
      toolCallId,
      title: 'Read',
      status: 'in_progress',
      rawInput: { path: 'a' },
    });
  });
});
