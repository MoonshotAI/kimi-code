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
import {
  availableCommandsUpdateNotification,
  planFromDisplayBlock,
  todoListToSessionUpdate,
} from '../src/events-map';

/**
 * Phase 9.3 — end-to-end + helper-unit coverage for:
 *   - `available_commands_update` emitted ONCE on `session/new` and
 *     ONCE on `session/load` (empty list — the slash-command registry
 *     lives in `apps/kimi-code` and is intentionally out-of-scope for
 *     the adapter; see STATUS for the registry-gap note).
 *   - `plan` session_update derived from the kimi-code TodoList
 *     `display.kind === 'todo_list'` payload attached to a
 *     `tool.call.started` event.
 *
 * Status mapping is the kimi-code TodoStatus → ACP PlanEntryStatus
 * lift: `done` → `completed`, all other names pass through.
 */

class CollectingClient implements Client {
  readonly updates: SessionNotification[] = [];

  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error(
      'CollectingClient.requestPermission should not be called in plan-and-commands test',
    );
  }
  async sessionUpdate(n: SessionNotification): Promise<void> {
    this.updates.push(n);
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error(
      'CollectingClient.writeTextFile should not be called in plan-and-commands test',
    );
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error(
      'CollectingClient.readTextFile should not be called in plan-and-commands test',
    );
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
  await new Promise((resolve) => setTimeout(resolve, 25));
}

describe('Phase 9.3 unit · todoListToSessionUpdate', () => {
  it('maps a populated TodoList into a plan session_update with mapped statuses', () => {
    const note = todoListToSessionUpdate('sess-x', 7, [
      { title: 'plan thing', status: 'pending' },
      { title: 'doing thing', status: 'in_progress' },
      { title: 'finished thing', status: 'done' },
    ]);
    expect(note).not.toBeNull();
    expect(note?.sessionId).toBe('sess-x');
    expect(note?.update).toEqual({
      sessionUpdate: 'plan',
      entries: [
        { content: 'plan thing', priority: 'medium', status: 'pending' },
        { content: 'doing thing', priority: 'medium', status: 'in_progress' },
        { content: 'finished thing', priority: 'medium', status: 'completed' },
      ],
    });
  });

  it('returns null for an empty items array (no spurious empty plan)', () => {
    expect(todoListToSessionUpdate('sess-x', 1, [])).toBeNull();
  });

  it('defaults unknown statuses to pending (defensive)', () => {
    const note = todoListToSessionUpdate('sess-x', 1, [
      { title: 'odd', status: 'mysterious' },
    ]);
    expect(note?.update).toMatchObject({
      sessionUpdate: 'plan',
      entries: [{ content: 'odd', priority: 'medium', status: 'pending' }],
    });
  });

  it('also accepts ACP-style "completed" status verbatim', () => {
    const note = todoListToSessionUpdate('sess-x', 1, [
      { title: 'shipped', status: 'completed' },
    ]);
    expect(note?.update).toMatchObject({
      sessionUpdate: 'plan',
      entries: [{ content: 'shipped', priority: 'medium', status: 'completed' }],
    });
  });
});

describe('Phase 9.3 unit · planFromDisplayBlock', () => {
  it('translates a todo_list display block into a plan notification', () => {
    const note = planFromDisplayBlock('sess-y', 3, {
      kind: 'todo_list',
      items: [{ title: 'step 1', status: 'pending' }],
    });
    expect(note?.update).toEqual({
      sessionUpdate: 'plan',
      entries: [{ content: 'step 1', priority: 'medium', status: 'pending' }],
    });
  });

  it('returns null for non-todo_list display kinds', () => {
    expect(
      planFromDisplayBlock('sess-y', 3, { kind: 'command', command: 'ls' }),
    ).toBeNull();
    expect(
      planFromDisplayBlock('sess-y', 3, {
        kind: 'diff',
        path: 'x',
        before: 'a',
        after: 'b',
      }),
    ).toBeNull();
  });
});

describe('Phase 9.3 unit · availableCommandsUpdateNotification', () => {
  it('builds an available_commands_update with an empty list by default', () => {
    expect(availableCommandsUpdateNotification('sess-z')).toEqual({
      sessionId: 'sess-z',
      update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
    });
  });

  it('passes a caller-supplied command list through', () => {
    const cmds = [
      { name: 'help', description: 'Show help' },
      { name: 'clear', description: 'Clear the screen' },
    ];
    const note = availableCommandsUpdateNotification('sess-z', cmds);
    expect(note.update).toEqual({
      sessionUpdate: 'available_commands_update',
      availableCommands: cmds,
    });
  });
});

describe('Phase 9.3 e2e · newSession emits available_commands_update once', () => {
  it('newSession returns and the client sees exactly one available_commands_update', async () => {
    const sessionId = 'sess-cmds-new';
    const session = makeScriptedSession(sessionId, []);
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      createSession: async () => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    const response = await client.newSession({ cwd: '/tmp/x', mcpServers: [] });
    expect(response.sessionId).toBe(sessionId);
    await flushNdjson();

    const cmdUpdates = collecting.updates.filter(
      (n) =>
        (n.update as { sessionUpdate: string }).sessionUpdate ===
        'available_commands_update',
    );
    expect(cmdUpdates).toHaveLength(1);
    expect(cmdUpdates[0]?.sessionId).toBe(sessionId);
    expect(cmdUpdates[0]?.update).toMatchObject({
      sessionUpdate: 'available_commands_update',
      availableCommands: [],
    });
  });
});

describe('Phase 9.3 e2e · loadSession emits available_commands_update once', () => {
  it('loadSession returns and the client sees exactly one available_commands_update (not duplicated during replay)', async () => {
    const sessionId = 'sess-cmds-load';
    const session = {
      id: sessionId,
      cancel: async () => undefined,
      prompt: async () => undefined,
      onEvent: (_fn: (event: Event) => void) => () => undefined,
      setApprovalHandler: () => undefined,
      getResumeState: () => ({
        agents: {
          main: {
            context: {
              history: [
                {
                  role: 'user',
                  content: [{ type: 'text', text: 'hi' }],
                  toolCalls: [],
                },
              ],
            },
          },
        },
      }),
    } as unknown as Session;
    const harness = {
      auth: { status: async () => AUTHED_STATUS },
      resumeSession: async (_opts: { id: string }) => session,
    } as unknown as KimiHarness;

    const { agentStream, clientStream } = makeInMemoryStreamPair();
    new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
    const collecting = new CollectingClient();
    const client = new ClientSideConnection(() => collecting, clientStream);

    await client.loadSession({ sessionId, cwd: '/tmp/x', mcpServers: [] });
    await flushNdjson();

    const cmdUpdates = collecting.updates.filter(
      (n) =>
        (n.update as { sessionUpdate: string }).sessionUpdate ===
        'available_commands_update',
    );
    expect(cmdUpdates).toHaveLength(1);
  });
});

describe('Phase 9.3 e2e · todo_list display block becomes a plan session_update', () => {
  it('emits a plan session_update alongside tool_call when a tool.call.started carries display.kind=todo_list', async () => {
    const sessionId = 'sess-plan';
    const turnId = 1;
    const toolCallId = 'tc-todo';
    const session = makeScriptedSession(sessionId, [
      {
        type: 'tool.call.started',
        sessionId,
        agentId: 'main',
        turnId,
        toolCallId,
        name: 'TodoList',
        args: { todos: [{ title: 'a', status: 'pending' }] },
        display: {
          kind: 'todo_list',
          items: [
            { title: 'a', status: 'pending' },
            { title: 'b', status: 'in_progress' },
            { title: 'c', status: 'done' },
          ],
        },
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
    const response = await client.prompt({ sessionId, prompt: [textBlock('plan it')] });
    expect(response.stopReason).toBe('end_turn');
    await flushNdjson();

    const planUpdates = collecting.updates.filter(
      (n) => (n.update as { sessionUpdate: string }).sessionUpdate === 'plan',
    );
    expect(planUpdates).toHaveLength(1);
    expect(planUpdates[0]?.update).toEqual({
      sessionUpdate: 'plan',
      entries: [
        { content: 'a', priority: 'medium', status: 'pending' },
        { content: 'b', priority: 'medium', status: 'in_progress' },
        { content: 'c', priority: 'medium', status: 'completed' },
      ],
    });
  });

  it('does NOT emit plan when no todo_list display is attached', async () => {
    const sessionId = 'sess-no-plan';
    const turnId = 1;
    const toolCallId = 'tc-read';
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
    await client.prompt({ sessionId, prompt: [textBlock('read')] });
    await flushNdjson();

    const planUpdates = collecting.updates.filter(
      (n) => (n.update as { sessionUpdate: string }).sessionUpdate === 'plan',
    );
    expect(planUpdates).toHaveLength(0);
  });
});
