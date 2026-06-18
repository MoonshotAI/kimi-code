// apps/kimi-web/test/side-chat.test.ts
//
// Side chat ("BTW"): openSideChat starts a TUI-style forked agent, sends the
// question to the parent session with agentId, echoes it into the side-chat
// transcript, and never creates a sidebar session.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSession, KimiEventHandlers, KimiWebApi } from '../src/api/types';

const now = '2026-06-11T00:00:00.000Z';

function session(id: string, extra: Partial<AppSession> = {}): AppSession {
  return {
    id,
    title: id,
    createdAt: now,
    updatedAt: now,
    status: 'idle',
    cwd: '/repo',
    model: 'kimi-test',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextLimit: 128_000,
      turnCount: 0,
    },
    messageCount: 0,
    lastSeq: 0,
    ...extra,
  };
}

async function setup() {
  vi.resetModules();
  vi.stubGlobal('WebSocket', class WebSocket {});

  let handlers: KimiEventHandlers | undefined;
  const eventConn = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    bindNextPromptId: vi.fn(),
    seedSnapshot: vi.fn(),
    markSideChannelAgent: vi.fn(),
    abort: vi.fn(),
    close: vi.fn(),
  };
  let promptN = 0;
  const created = session('sess_1');
  const api = {
    createSession: vi.fn(async () => created),
    getSessionSnapshot: vi.fn(async () => ({
      asOfSeq: 0,
      epoch: 'ep_test',
      session: created,
      messages: [],
      hasMoreMessages: false,
      inFlightTurn: null,
      pendingApprovals: [],
      pendingQuestions: [],
    })),
    submitPrompt: vi.fn(async () => {
      promptN += 1;
      return { promptId: `pr_${promptN}`, userMessageId: `msg_real_${promptN}`, status: 'running' };
    }),
    listTasks: vi.fn(async () => []),
    getGitStatus: vi.fn(async () => ({ branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0 })),
    getSessionStatus: vi.fn(async () => ({
      model: 'kimi-test',
      thinkingLevel: 'high',
      permission: 'manual',
      planMode: false,
      swarmMode: false,
      contextTokens: 0,
      maxContextTokens: 128_000,
      contextUsage: 0,
    })),
    connectEvents: vi.fn((nextHandlers: KimiEventHandlers) => {
      handlers = nextHandlers;
      return eventConn;
    }),
    getFileUrl: vi.fn((fileId: string) => `/files/${fileId}`),
    startBtw: vi.fn(async () => ({ agentId: 'agent_btw' })),
  } as unknown as KimiWebApi;

  vi.doMock('../src/api', () => ({ getKimiWebApi: () => api }));
  const { useKimiWebClient } = await import('../src/composables/useKimiWebClient');

  return {
    api,
    client: useKimiWebClient(),
    eventConn,
    getHandlers: () => {
      if (!handlers) throw new Error('connectEvents was not called');
      return handlers;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

describe('side chat (BTW)', () => {
  it('opens a side-channel agent, sends the question, and echoes it', async () => {
    const { api, client, eventConn, getHandlers } = await setup();
    await client.createSession('/repo');

    await client.openSideChat('what does this do?');

    // A BTW agent is started under the active session and marked as side-channel
    // so its streamed text deltas are not dropped like background subagents.
    expect(api.startBtw).toHaveBeenCalledWith('sess_1');
    expect(eventConn.markSideChannelAgent).toHaveBeenCalledWith('agent_btw');
    // The question goes to the SAME session, scoped to the BTW agent.
    const call = (api.submitPrompt as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe('sess_1');
    expect(call[1]).toMatchObject({
      agentId: 'agent_btw',
      content: [
        { type: 'text', text: 'what does this do?' },
      ],
    });

    // The side-chat panel is open and shows the question.
    expect(client.sideChatVisible.value).toBe(true);
    const userTurns = client.sideChatTurns.value.filter((t) => t.role === 'user');
    expect(userTurns.map((t) => t.text)).toEqual(['what does this do?']);

    getHandlers().onEvent(
      {
        type: 'taskProgress',
        sessionId: 'sess_1',
        taskId: 'agent_btw',
        outputChunk: 'It checks the diff.',
        stream: 'stdout',
      },
      { sessionId: 'sess_1', seq: 2 },
    );

    const assistantTurns = client.sideChatTurns.value.filter((t) => t.role === 'assistant');
    expect(assistantTurns.map((t) => t.text)).toEqual(['It checks the diff.']);
  });

  it('keeps BTW user messages out of the main conversation transcript', async () => {
    const { api, client, getHandlers } = await setup();
    await client.createSession('/repo');

    await client.openSideChat('what does this do?');

    const submitResult = await (api.submitPrompt as ReturnType<typeof vi.fn>).mock.results[0]!.value;
    getHandlers().onEvent(
      {
        type: 'messageCreated',
        message: {
          id: submitResult.userMessageId,
          sessionId: 'sess_1',
          role: 'user',
          content: [{ type: 'text', text: 'what does this do?' }],
          createdAt: now,
          promptId: submitResult.promptId,
        },
      },
      { sessionId: 'sess_1', seq: 2 },
    );

    // The side chat still shows the user question.
    expect(client.sideChatTurns.value.filter((t) => t.role === 'user').map((t) => t.text)).toEqual([
      'what does this do?',
    ]);
    // But it must not leak into the main session transcript.
    expect(client.turns.value.filter((t) => t.role === 'user').map((t) => t.text)).toEqual([]);
  });

  it('renders side-channel agent text deltas as the assistant response', async () => {
    const { client, getHandlers } = await setup();
    await client.createSession('/repo');

    await client.openSideChat('what does this do?');

    getHandlers().onEvent(
      {
        type: 'agentDelta',
        sessionId: 'sess_1',
        agentId: 'agent_btw',
        delta: { text: 'It checks ' },
      },
      { sessionId: 'sess_1', seq: 2 },
    );
    getHandlers().onEvent(
      {
        type: 'agentDelta',
        sessionId: 'sess_1',
        agentId: 'agent_btw',
        delta: { text: 'the diff.' },
      },
      { sessionId: 'sess_1', seq: 3 },
    );

    const assistantTurns = client.sideChatTurns.value.filter((t) => t.role === 'assistant');
    expect(assistantTurns.map((t) => t.text)).toEqual(['It checks the diff.']);
    expect(client.sideChatRunning.value).toBe(true);

    getHandlers().onEvent(
      {
        type: 'agentTurnEnded',
        sessionId: 'sess_1',
        agentId: 'agent_btw',
      },
      { sessionId: 'sess_1', seq: 4 },
    );

    expect(client.sideChatRunning.value).toBe(false);
  });

  it('does not create a child session for the sidebar', async () => {
    const { api, client } = await setup();
    await client.createSession('/repo');

    await client.openSideChat();

    expect(api.startBtw).toHaveBeenCalledWith('sess_1');
    expect(api.createChildSession).toBeUndefined();
    const ids = client.sessionsForView.value.map((s) => s.id);
    expect(ids).toEqual(['sess_1']);
  });

  it('keeps the question in the panel when task progress is not available yet', async () => {
    const { api, client } = await setup();
    await client.createSession('/repo');

    await client.openSideChat('what does this do?');

    expect(api.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({
        agentId: 'agent_btw',
        content: [
          { type: 'text', text: 'what does this do?' },
        ],
      }),
    );
    expect(client.sideChatTurns.value.filter((t) => t.role === 'user').map((t) => t.text)).toEqual([
      'what does this do?',
    ]);
  });

  it('does not make the main session look busy while the BTW agent is sending', async () => {
    const { client } = await setup();
    await client.createSession('/repo');
    // Simulate the daemon reporting the parent session as running before the
    // task list has been refreshed to show the BTW agent.
    client.sessions.value[0]!.status = 'running';

    await client.openSideChat('what does this do?');

    expect(client.activity.value).toBe('idle');
  });
});
