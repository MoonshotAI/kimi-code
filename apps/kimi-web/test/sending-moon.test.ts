import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSession, KimiEventHandlers, KimiWebApi } from '../src/api/types';

const now = '2026-06-11T00:00:00.000Z';

function session(id: string): AppSession {
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
    abort: vi.fn(),
    close: vi.fn(),
  };
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
    submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_real' })),
    listTasks: vi.fn(async () => []),
    getGitStatus: vi.fn(async () => ({ branch: 'main', ahead: 0, behind: 0, entries: {} })),
    getSessionStatus: vi.fn(async () => ({
      model: 'kimi-test',
      thinkingLevel: 'high',
      permission: 'manual',
      planMode: false,
      contextTokens: 0,
      maxContextTokens: 128_000,
      contextUsage: 0,
    })),
    connectEvents: vi.fn((next: KimiEventHandlers) => {
      handlers = next;
      return eventConn;
    }),
    getFileUrl: vi.fn((fileId: string) => `/files/${fileId}`),
  } as unknown as KimiWebApi;

  vi.doMock('../src/api', () => ({ getKimiWebApi: () => api }));
  const { useKimiWebClient } = await import('../src/composables/useKimiWebClient');
  return {
    client: useKimiWebClient(),
    getHandlers: () => {
      if (!handlers) throw new Error('connectEvents not called');
      return handlers;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

describe('sending moon placeholder', () => {
  it('clears on the first streamed token instead of lingering until turn end', async () => {
    const { client, getHandlers } = await setup();
    await client.createSession('/repo');
    await client.sendPrompt('hello');
    expect(client.isSending.value).toBe(true);

    // First token of the reply arrives.
    getHandlers().onEvent(
      {
        type: 'assistantDelta',
        sessionId: 'sess_1',
        messageId: 'm1',
        contentIndex: 0,
        delta: { text: 'Hi' },
      },
      { sessionId: 'sess_1', seq: 5 },
    );

    expect(client.isSending.value).toBe(false);
  });
});
