// apps/kimi-web/test/steer.test.ts
//
// steerPrompt (TUI ctrl+s parity): while a turn is running, the composer text
// plus any locally queued prompts merge into ONE message that is submitted
// (daemon parks it) and then steered into the active turn. When the session is
// idle it degrades to a normal send.

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

async function setup(opts?: { submitStatuses?: ('running' | 'queued')[] }) {
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
  const statuses = [...(opts?.submitStatuses ?? [])];
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
      return {
        promptId: `pr_${promptN}`,
        userMessageId: `msg_real_${promptN}`,
        status: statuses.shift() ?? 'running',
      };
    }),
    steerPrompts: vi.fn(async (_sid: string, ids: string[]) => ({ steered: true, promptIds: ids })),
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
  } as unknown as KimiWebApi;

  vi.doMock('../src/api', () => ({ getKimiWebApi: () => api }));
  const { useKimiWebClient } = await import('../src/composables/useKimiWebClient');

  return {
    api,
    client: useKimiWebClient(),
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

describe('steerPrompt', () => {
  it('submits then steers the parked prompt while a turn is running', async () => {
    const { api, client } = await setup({ submitStatuses: ['running', 'queued'] });
    await client.createSession('/repo');
    await client.sendPrompt('first');            // turn in flight
    await client.steerPrompt('change of plan');  // steer into it

    expect(api.submitPrompt).toHaveBeenCalledTimes(2);
    expect(api.steerPrompts).toHaveBeenCalledWith('sess_1', ['pr_2']);
    // The steered text shows up in the transcript like any user message.
    const userTurns = client.turns.value.filter((t) => t.role === 'user');
    expect(userTurns.map((t) => t.text)).toEqual(['first', 'change of plan']);
  });

  it('carries an image attachment into the steered prompt and the transcript echo', async () => {
    const { api, client } = await setup({ submitStatuses: ['running', 'queued'] });
    await client.createSession('/repo');
    await client.sendPrompt('first');                 // turn in flight
    await client.steerPrompt('look at this', [{ fileId: 'file_1', kind: 'image' }]);

    // The image rides the steered prompt's content alongside the text.
    const steered = (api.submitPrompt as ReturnType<typeof vi.fn>).mock.calls[1]![1] as {
      content: { type: string; text?: string; source?: { kind: string; fileId: string } }[];
    };
    expect(steered.content).toEqual([
      { type: 'text', text: 'look at this' },
      { type: 'image', source: { kind: 'file', fileId: 'file_1' } },
    ]);

    // The optimistic transcript echo shows the image too.
    const lastUser = client.turns.value.filter((t) => t.role === 'user').at(-1)!;
    expect(lastUser.images).toEqual([{ url: '/files/file_1', alt: undefined, kind: 'image' }]);
  });

  it('carries a video attachment as a video content block and a video echo', async () => {
    const { api, client } = await setup({ submitStatuses: ['running', 'queued'] });
    await client.createSession('/repo');
    await client.sendPrompt('first');
    await client.steerPrompt('watch this', [{ fileId: 'clip_1', kind: 'video' }]);

    // A video attachment serializes to a `video` content block (not `image`).
    const steered = (api.submitPrompt as ReturnType<typeof vi.fn>).mock.calls[1]![1] as {
      content: { type: string; text?: string; source?: { kind: string; fileId: string } }[];
    };
    expect(steered.content).toEqual([
      { type: 'text', text: 'watch this' },
      { type: 'video', source: { kind: 'file', fileId: 'clip_1' } },
    ]);

    // The transcript echo carries the video kind so the bubble renders <video>.
    const lastUser = client.turns.value.filter((t) => t.role === 'user').at(-1)!;
    expect(lastUser.images).toEqual([{ url: '/files/clip_1', alt: undefined, kind: 'video' }]);
  });

  it('merges the daemon echo of an image steer into the optimistic message (no duplicate)', async () => {
    const { client, getHandlers } = await setup({ submitStatuses: ['running', 'queued'] });
    await client.createSession('/repo');
    await client.sendPrompt('first');
    await client.steerPrompt('look at this', [{ fileId: 'file_1', kind: 'image' }]);

    // The daemon echoes the steered user message with the SAME prompt_id but a
    // different image serialization (a resolved URL rather than our file ref).
    // Content-equality alone can't match it; the prompt_id must.
    getHandlers().onEvent(
      {
        type: 'messageCreated',
        message: {
          id: 'msg_real_2',
          sessionId: 'sess_1',
          role: 'user',
          promptId: 'pr_2',
          content: [
            { type: 'text', text: 'look at this' },
            { type: 'image', source: { kind: 'url', url: 'https://daemon/img.png' } },
          ],
          createdAt: now,
        },
      },
      { sessionId: 'sess_1', seq: 6 },
    );

    // Exactly one user turn for the steered message — the echo merged in.
    const userTurns = client.turns.value.filter((t) => t.role === 'user');
    expect(userTurns.map((t) => t.text)).toEqual(['first', 'look at this']);
  });

  it('merges an image-steer echo even when it carries no matching prompt_id (race)', async () => {
    const { client, getHandlers } = await setup({ submitStatuses: ['running', 'queued'] });
    await client.createSession('/repo');
    await client.sendPrompt('first');
    await client.steerPrompt('look at this', [{ fileId: 'file_1' }]);

    // The echo arrives WITHOUT a prompt_id (the WS event can land before the
    // submit response stamps it onto the optimistic copy) AND with a different
    // image serialization. Neither prompt_id nor exact-content matches, so only
    // the loose (text + image-count) fallback can reconcile it.
    getHandlers().onEvent(
      {
        type: 'messageCreated',
        message: {
          id: 'msg_real_x',
          sessionId: 'sess_1',
          role: 'user',
          content: [
            { type: 'text', text: 'look at this' },
            { type: 'image', source: { kind: 'url', url: 'https://daemon/img.png' } },
          ],
          createdAt: now,
        },
      },
      { sessionId: 'sess_1', seq: 7 },
    );

    const userTurns = client.turns.value.filter((t) => t.role === 'user');
    expect(userTurns.map((t) => t.text)).toEqual(['first', 'look at this']);
  });

  it('merges queued prompts + live text into one steered message and clears the queue', async () => {
    const { api, client } = await setup({ submitStatuses: ['running', 'queued'] });
    await client.createSession('/repo');
    await client.sendPrompt('first');
    await client.sendPrompt('queued idea');      // running → goes to the local queue
    expect(client.queued.value).toHaveLength(1);

    await client.steerPrompt('and do this now');

    expect(client.queued.value).toHaveLength(0);
    const submitted = (api.submitPrompt as ReturnType<typeof vi.fn>).mock.calls[1]![1] as {
      content: { type: string; text?: string }[];
    };
    expect(submitted.content).toEqual([{ type: 'text', text: 'queued idea\n\nand do this now' }]);
    expect(api.steerPrompts).toHaveBeenCalledTimes(1);
  });

  it('degrades to a normal send when the session is idle', async () => {
    const { api, client, getHandlers } = await setup({ submitStatuses: ['running', 'running'] });
    await client.createSession('/repo');
    await client.sendPrompt('first');
    // Turn ends → session back to idle.
    getHandlers().onEvent(
      { type: 'sessionStatusChanged', sessionId: 'sess_1', status: 'idle', previousStatus: 'running' },
      { sessionId: 'sess_1', seq: 5 },
    );

    await client.steerPrompt('just send it');

    expect(api.steerPrompts).not.toHaveBeenCalled();
    expect(api.submitPrompt).toHaveBeenCalledTimes(2);
  });

  it('treats a steer race (turn ended between submit and steer) as success', async () => {
    const { api, client } = await setup({ submitStatuses: ['running', 'queued'] });
    (api.steerPrompts as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('PROMPT_NOT_FOUND'));
    await client.createSession('/repo');
    await client.sendPrompt('first');

    await client.steerPrompt('late message');

    // No warning, no transcript rollback — the parked prompt runs as its own turn.
    expect(client.warnings.value).toHaveLength(0);
    const userTurns = client.turns.value.filter((t) => t.role === 'user');
    expect(userTurns.map((t) => t.text)).toEqual(['first', 'late message']);
  });
});
