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
import { toolResultToAcpContent } from '../src/convert';

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
    throw new Error('CollectingClient.requestPermission should not be called in tool-result test');
  }
  async sessionUpdate(n: SessionNotification): Promise<void> {
    this.updates.push(n);
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('CollectingClient.writeTextFile should not be called in tool-result test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('CollectingClient.readTextFile should not be called in tool-result test');
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

function makeScriptedSession(sessionId: string, script: readonly Event[]): Session {
  const listeners = new Set<(event: Event) => void>();
  return {
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
}

const textBlock = (text: string): ContentBlock => ({ type: 'text', text });

async function flushNdjson(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe('toolResultToAcpContent (unit)', () => {
  it('returns a text content entry for a non-empty string content', () => {
    const content = toolResultToAcpContent('hello world');
    expect(content).toEqual([
      { type: 'content', content: { type: 'text', text: 'hello world' } },
    ]);
  });

  it('passes JSON-encoded content through as a single text entry', () => {
    const content = toolResultToAcpContent('{"count":3}');
    expect(content).toEqual([
      { type: 'content', content: { type: 'text', text: '{"count":3}' } },
    ]);
  });

  it('returns an empty array for empty content', () => {
    expect(toolResultToAcpContent('')).toEqual([]);
  });
});

describe('AcpServer session.tool.settled → tool_call_update', () => {
  it('emits status=completed with text content for non-error string output', async () => {
    const sessionId = 'sess-tr-1';
    const toolCallId = 'tc-1';
    const session = makeScriptedSession(sessionId, [
      {
        type: 'session.tool.started',
        sessionId,
        agentId: 'main',
        tool_call_id: toolCallId,
        tool_name: 'Bash',
        arguments: { cmd: 'echo hi' },
      } as Event,
      {
        type: 'session.tool.settled',
        sessionId,
        agentId: 'main',
        tool_call_id: toolCallId,
        tool_name: 'Bash',
        content: 'hello world',
        is_error: false,
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

    // 1 start + 1 settled = 2 updates.
    expect(collecting.promptUpdates).toHaveLength(2);
    expect(collecting.promptUpdates[1]?.update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'hello world' } },
      ],
      rawOutput: 'hello world',
    });
  });

  it('emits status=failed when is_error is true', async () => {
    const sessionId = 'sess-tr-err';
    const toolCallId = 'tc-err';
    const session = makeScriptedSession(sessionId, [
      {
        type: 'session.tool.started',
        sessionId,
        agentId: 'main',
        tool_call_id: toolCallId,
        tool_name: 'Bash',
        arguments: { cmd: 'false' },
      } as Event,
      {
        type: 'session.tool.settled',
        sessionId,
        agentId: 'main',
        tool_call_id: toolCallId,
        tool_name: 'Bash',
        content: 'oops',
        is_error: true,
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

    const toolUpdates = collecting.updates.filter(
      (u) => (u.update as { sessionUpdate?: string }).sessionUpdate !==
        'available_commands_update',
    );
    const last = toolUpdates.at(-1)?.update as { sessionUpdate: string; status: string };
    expect(last.sessionUpdate).toBe('tool_call_update');
    expect(last.status).toBe('failed');
  });

  it('emits status=completed with empty content array for empty content', async () => {
    const sessionId = 'sess-tr-empty';
    const toolCallId = 'tc-empty';
    const session = makeScriptedSession(sessionId, [
      {
        type: 'session.tool.started',
        sessionId,
        agentId: 'main',
        tool_call_id: toolCallId,
        tool_name: 'Bash',
        arguments: { cmd: 'true' },
      } as Event,
      {
        type: 'session.tool.settled',
        sessionId,
        agentId: 'main',
        tool_call_id: toolCallId,
        tool_name: 'Bash',
        content: '',
        is_error: false,
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

    const toolUpdates = collecting.updates.filter(
      (u) => (u.update as { sessionUpdate?: string }).sessionUpdate !==
        'available_commands_update',
    );
    const last = toolUpdates.at(-1)?.update as {
      sessionUpdate: string;
      status: string;
      content: unknown[];
    };
    expect(last.sessionUpdate).toBe('tool_call_update');
    expect(last.status).toBe('completed');
    expect(last.content).toEqual([]);
  });
});
