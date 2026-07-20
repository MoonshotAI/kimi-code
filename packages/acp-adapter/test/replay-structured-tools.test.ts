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
import type { Event, KimiHarness, Session } from '@moonshot-ai/kimi-code-sdk';

import { AcpServer } from '../src/server';
import { AUTHED_STATUS, makeModelsMap } from './_helpers/harness-stubs';

// Replay-side structured tools (fix/acp-replay-structured-tools): the three
// custom-tool families must reconstruct their live-path wire semantics on
// history replay instead of dumping raw envelopes into visible text.

class CapturingClient implements Client {
  readonly updates: SessionNotification[] = [];

  get historyUpdates(): readonly SessionNotification[] {
    return this.updates.filter(
      (n) =>
        (n.update as { sessionUpdate?: string }).sessionUpdate !==
        'available_commands_update',
    );
  }

  async requestPermission(_p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    throw new Error('CapturingClient.requestPermission should not be called in replay test');
  }
  async sessionUpdate(n: SessionNotification): Promise<void> {
    this.updates.push(n);
  }
  async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    throw new Error('CapturingClient.writeTextFile should not be called in replay test');
  }
  async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    throw new Error('CapturingClient.readTextFile should not be called in replay test');
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

function makeSessionWithHistory(sessionId: string, history: ReadonlyArray<unknown>): Session {
  return {
    id: sessionId,
    cancel: async () => undefined,
    prompt: async () => undefined,
    onEvent: (_fn: (event: Event) => void) => () => undefined,
    setApprovalHandler: () => undefined,
    getResumeState: () => ({
      agents: {
        main: {
          context: { history, tokenCount: 0 },
        },
      },
    }),
  } as unknown as Session;
}

function makeHarness(session: Session): KimiHarness {
  return {
    auth: {
      status: async () => AUTHED_STATUS,
    },
    resumeSession: async (_input: { id: string }) => session,
    getConfig: async () => ({
      providers: {},
      defaultModel: 'kimi-coder',
      models: makeModelsMap([{ id: 'kimi-coder', name: 'Kimi Coder', thinkingSupported: true }]),
    }),
  } as unknown as KimiHarness;
}

async function loadAndCapture(
  history: ReadonlyArray<unknown>,
): Promise<readonly SessionNotification[]> {
  const session = makeSessionWithHistory('sess-replay-structured', history);
  const harness = makeHarness(session);
  const { agentStream, clientStream } = makeInMemoryStreamPair();
  new AgentSideConnection((c) => new AcpServer(harness, c), agentStream);
  const client = new CapturingClient();
  const clientConn = new ClientSideConnection((_a) => client, clientStream);

  await clientConn.loadSession({
    sessionId: 'sess-replay-structured',
    cwd: '/tmp/x',
    mcpServers: [],
  });
  return client.historyUpdates;
}

function toolCall(id: string, name: string, args: unknown): Record<string, unknown> {
  return {
    type: 'function',
    id,
    name,
    arguments: JSON.stringify(args),
  };
}

describe('replay of structured tool families', () => {
  it('TodoList replays as an ACP plan update — never a tool_call text dump', async () => {
    const updates = await loadAndCapture([
      { role: 'user', content: [{ type: 'text', text: 'plan it' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'tracking work' }],
        toolCalls: [
          toolCall('tc-todo', 'TodoList', {
            todos: [
              { title: 'first thing', status: 'done' },
              { title: 'second thing', status: 'in_progress' },
              { title: 'third thing', status: 'pending' },
            ],
          }),
        ],
      },
      {
        role: 'tool',
        toolCallId: 'tc-todo',
        content: [{ type: 'text', text: 'Todo list updated successfully. Use it to track progress.' }],
        toolCalls: [],
      },
    ]);

    const plans = updates.filter(
      (n) => (n.update as { sessionUpdate?: string }).sessionUpdate === 'plan',
    );
    expect(plans.length).toBe(1);
    expect(plans[0]!.update).toMatchObject({
      sessionUpdate: 'plan',
      entries: [
        { content: 'first thing', status: 'completed' },
        { content: 'second thing', status: 'in_progress' },
        { content: 'third thing', status: 'pending' },
      ],
    });

    // No tool_call / tool_call_update for the TodoList id at all — the
    // 'Todo list updated…' text must not leak as visible content.
    const toolWires = updates.filter((n) => {
      const update = n.update as { toolCallId?: string };
      return update.toolCallId !== undefined && update.toolCallId.endsWith(':tc-todo');
    });
    expect(toolWires).toEqual([]);
  });

  it('AskUserQuestion replays with a clean tool_call + one-line summary + rawOutput (no JSON dump)', async () => {
    const resultJson = JSON.stringify({
      answers: { q1: { option_id: 'safe path' } },
    });
    const updates = await loadAndCapture([
      { role: 'user', content: [{ type: 'text', text: 'choose' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'asking' }],
        toolCalls: [
          toolCall('tc-ask', 'AskUserQuestion', {
            questions: [
              {
                question: 'Which approach?',
                header: 'Approach',
                options: [
                  { label: 'safe path' },
                  { label: 'fast path' },
                ],
              },
            ],
          }),
        ],
      },
      {
        role: 'tool',
        toolCallId: 'tc-ask',
        content: [{ type: 'text', text: resultJson }],
        toolCalls: [],
      },
    ]);

    const call = updates.find(
      (n) => (n.update as { sessionUpdate?: string }).sessionUpdate === 'tool_call',
    );
    expect(call!.update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: '1:tc-ask',
      title: 'AskUserQuestion',
      status: 'in_progress',
    });
    expect((call!.update as { rawInput?: unknown }).rawInput).toMatchObject({
      questions: [{ question: 'Which approach?' }],
    });

    const result = updates.find(
      (n) => (n.update as { sessionUpdate?: string }).sessionUpdate === 'tool_call_update',
    );
    expect(result!.update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: '1:tc-ask',
      status: 'completed',
      rawOutput: resultJson,
      content: [{ type: 'content', content: { type: 'text', text: 'Answered: safe path' } }],
    });
    // The JSON envelope must not appear in the visible content text.
    const contentText = JSON.stringify((result!.update as { content?: unknown }).content);
    expect(contentText).not.toContain('"answers"');
    expect(contentText).not.toContain('option_id');
  });

  it('AskUserQuestion dismissal replays as the dismiss note, not the empty-answers JSON', async () => {
    const updates = await loadAndCapture([
      { role: 'user', content: [{ type: 'text', text: 'choose' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'asking' }],
        toolCalls: [
          toolCall('tc-ask2', 'AskUserQuestion', {
            questions: [{ question: 'Continue?', options: [{ label: 'yes' }] }],
          }),
        ],
      },
      {
        role: 'tool',
        toolCallId: 'tc-ask2',
        content: [
          { type: 'text', text: '{"answers":{},"note":"User dismissed the question without answering."}' },
        ],
        toolCalls: [],
      },
    ]);
    const result = updates.find(
      (n) => (n.update as { sessionUpdate?: string }).sessionUpdate === 'tool_call_update',
    );
    expect(result!.update).toMatchObject({
      content: [
        {
          type: 'content',
          content: { type: 'text', text: 'User dismissed the question without answering.' },
        },
      ],
    });
  });

  it('Agent replays with a clean title and summary-only content (no envelope prelude)', async () => {
    const envelope = [
      'agent_id: agent-0',
      'actual_subagent_type: coder',
      'status: completed',
      '',
      '[summary]',
      'The refactor is complete and all tests pass.',
    ].join('\n');
    const updates = await loadAndCapture([
      { role: 'user', content: [{ type: 'text', text: 'delegate this' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'spawning a subagent' }],
        toolCalls: [
          toolCall('tc-agent', 'Agent', {
            subagent_type: 'coder',
            description: 'refactor the parser',
            prompt: 'Refactor the parser module end to end.',
          }),
        ],
      },
      {
        role: 'tool',
        toolCallId: 'tc-agent',
        content: [{ type: 'text', text: envelope }],
        toolCalls: [],
      },
    ]);

    const call = updates.find(
      (n) => (n.update as { sessionUpdate?: string }).sessionUpdate === 'tool_call',
    );
    expect(call!.update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: '1:tc-agent',
      title: 'Agent (coder): refactor the parser',
      status: 'in_progress',
    });
    expect((call!.update as { rawInput?: unknown }).rawInput).toMatchObject({
      subagent_type: 'coder',
      description: 'refactor the parser',
    });

    const result = updates.find(
      (n) => (n.update as { sessionUpdate?: string }).sessionUpdate === 'tool_call_update',
    );
    expect(result!.update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: '1:tc-agent',
      status: 'completed',
      rawOutput: envelope,
      content: [
        {
          type: 'content',
          content: { type: 'text', text: 'The refactor is complete and all tests pass.' },
        },
      ],
    });
    const contentText = JSON.stringify((result!.update as { content?: unknown }).content);
    expect(contentText).not.toContain('agent_id');
    expect(contentText).not.toContain('actual_subagent_type');
  });

  it('generic tools (Bash) replay exactly as before — call + raw result dump', async () => {
    const updates = await loadAndCapture([
      { role: 'user', content: [{ type: 'text', text: 'ls' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'running ls' }],
        toolCalls: [toolCall('tc-bash', 'Bash', { command: 'ls' })],
      },
      {
        role: 'tool',
        toolCallId: 'tc-bash',
        content: [{ type: 'text', text: 'file1\nfile2' }],
        toolCalls: [],
      },
    ]);
    expect(updates[2]!.update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: '1:tc-bash',
      title: 'Bash',
      kind: 'execute',
      status: 'in_progress',
    });
    expect(updates[3]!.update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: '1:tc-bash',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'file1\nfile2' } }],
    });
  });

  it('malformed family args fall back to the generic tool_call dump', async () => {
    const updates = await loadAndCapture([
      { role: 'user', content: [{ type: 'text', text: 'todo?' }], toolCalls: [] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'todo' }],
        toolCalls: [toolCall('tc-bad-todo', 'TodoList', { notTodos: true })],
      },
      {
        role: 'tool',
        toolCallId: 'tc-bad-todo',
        content: [{ type: 'text', text: 'Todo list updated successfully.' }],
        toolCalls: [],
      },
    ]);
    const kinds = updates.map((n) => (n.update as { sessionUpdate?: string }).sessionUpdate);
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('tool_call_update');
    expect(kinds).not.toContain('plan');
  });
});
