import { describe, expect, it, vi } from 'vitest';
import { createInitialState } from '@moonshot-ai/app-core/api';
import type { KimiWebApi } from '@moonshot-ai/app-core/api';
import { useSideChat } from '../src/client/useSideChat';
import { joinDraftSegments } from '../src/lib/quoteSelection';
import type { ExtendedState } from '../src/client/types';

// The api is injected; stub the BTW endpoints.
const apiMock = {
  startBtw: vi.fn(),
  submitPrompt: vi.fn(),
  updateSession: vi.fn(),
};
const api = apiMock as unknown as KimiWebApi;

function createState(): ExtendedState {
  return {
    ...createInitialState(),
    sessions: [
      {
        id: 'sess_1',
        title: 'Session',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        busy: false as const,
        archived: false,
        currentPromptId: null,
        cwd: '/workspace',
        model: 'kimi-code',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalCostUsd: 0,
          contextTokens: 0,
          contextLimit: 0,
          turnCount: 0,
        },
        messageCount: 0,
        lastSeq: 0,
      },
    ],
    activeSessionId: 'sess_1',
    permission: 'auto',
    thinking: 'high',
    pendingThinkingBySession: {},
    planModeBySession: { sess_1: true },
    planArmedBySession: {},
    swarmModeBySession: {},
    sideChatMessagesByAgent: {},
    sideChatSendingByAgent: {},
    sideChatUserMessageIdsBySession: {},
  } as unknown as ExtendedState;
}

describe('useSideChat — sendSideChatPromptOn', () => {
  it('carries model, thinking, permission and plan/swarm modes on the prompt', async () => {
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_btw', userMessageId: 'msg_opt_btw' });

    const state = createState();
    const pushOperationFailure = vi.fn();
    const sideChat = useSideChat(state, {
      api,
      pushOperationFailure,
      nextOptimisticMsgId: () => 'msg_opt_btw',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => null,
      refreshSessionStatus: vi.fn(),
      resolveThinkingForPrompt: async () => undefined,
    });

    await sideChat.openSideChatOn('sess_1', 'what changed?');

    expect(apiMock.startBtw).toHaveBeenCalledWith('sess_1');
    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({
        agentId: 'agent_btw_1',
        model: 'kimi-code',
        thinking: 'high',
        permissionMode: 'auto',
        planMode: true,
        swarmMode: false,
      }),
    );
    expect(pushOperationFailure).not.toHaveBeenCalled();
  });

  it('falls back to the active level when the parent model has left the catalog', async () => {
    // resolveThinkingForPrompt returns undefined for a model the catalog no
    // longer lists — the submit then keeps the active-session level (same
    // fallback as the normal prompt paths).
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_btw', userMessageId: 'msg_opt_btw' });

    const state = createState();
    state.thinking = 'max';
    const sideChat = useSideChat(state, {
      api,
      pushOperationFailure: vi.fn(),
      nextOptimisticMsgId: () => 'msg_opt_btw',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => null,
      refreshSessionStatus: vi.fn(),
      resolveThinkingForPrompt: async () => undefined,
    });

    await sideChat.openSideChatOn('sess_1', 'what changed?');

    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({ thinking: 'max' }),
    );
  });

  it('resolves thinking from the parent model, not the level of the session the user switched to', async () => {
    // startBtw spans an await during which the user can switch sessions; the
    // BTW prompt must still carry the PARENT model's level ('low'), never the
    // active view's ('max').
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_btw', userMessageId: 'msg_opt_btw' });

    const state = createState();
    state.thinking = 'max'; // the user is now viewing a max-only session elsewhere
    const sideChat = useSideChat(state, {
      api,
      pushOperationFailure: vi.fn(),
      nextOptimisticMsgId: () => 'msg_opt_btw',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => null,
      refreshSessionStatus: vi.fn(),
      resolveThinkingForPrompt: async (_sid, id) => (id === 'kimi-code' ? 'low' : undefined),
    });

    await sideChat.openSideChatOn('sess_1', 'what changed?');

    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({ model: 'kimi-code', thinking: 'low' }),
    );
  });

  it('reconciles a WS-first prompt inside the side chat by server identity', async () => {
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    let resolveSubmit!: (value: { promptId: string; userMessageId: string }) => void;
    apiMock.submitPrompt.mockImplementation(
      () =>
        new Promise<{ promptId: string; userMessageId: string }>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const state = createState();
    const sideChat = useSideChat(state, {
      api,
      pushOperationFailure: vi.fn(),
      nextOptimisticMsgId: () => 'msg_opt_btw',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => null,
      refreshSessionStatus: vi.fn(),
      resolveThinkingForPrompt: async () => 'high',
    });
    await sideChat.openSideChatOn('sess_1');

    const pending = sideChat.sendSideChatPrompt('repeat');
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());
    sideChat.reconcileSideChatUserMessage('agent_btw_1', {
      id: 'message_btw_1',
      sessionId: 'sess_1',
      role: 'user',
      content: [{ type: 'text', text: 'repeat' }],
      createdAt: '2026-01-01T00:00:00.000Z',
      promptId: 'prompt_btw_1',
    });

    expect(
      state.sideChatMessagesByAgent.agent_btw_1?.map((message) => message.id),
    ).toEqual(['msg_opt_btw', 'message_btw_1']);
    expect(state.sideChatUserMessageIdsBySession.sess_1).toEqual(['message_btw_1']);

    resolveSubmit({
      promptId: 'prompt_btw_1',
      userMessageId: 'message_btw_1',
    });
    await pending;
    expect(state.sideChatMessagesByAgent.agent_btw_1).toHaveLength(1);
    expect(state.sideChatMessagesByAgent.agent_btw_1?.[0]).toMatchObject({
      id: 'msg_opt_btw',
      promptId: 'prompt_btw_1',
      userMessageId: 'message_btw_1',
    });
  });

  it('keeps consecutive equal-text side-chat submissions separate', async () => {
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    apiMock.submitPrompt
      .mockResolvedValueOnce({
        promptId: 'prompt_btw_1',
        userMessageId: 'message_btw_1',
      })
      .mockResolvedValueOnce({
        promptId: 'prompt_btw_2',
        userMessageId: 'message_btw_2',
      });
    const state = createState();
    let optimisticId = 0;
    const sideChat = useSideChat(state, {
      api,
      pushOperationFailure: vi.fn(),
      nextOptimisticMsgId: () => `msg_opt_btw_${++optimisticId}`,
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => null,
      refreshSessionStatus: vi.fn(),
      resolveThinkingForPrompt: async () => 'high',
    });
    await sideChat.openSideChatOn('sess_1');

    await sideChat.sendSideChatPrompt('repeat');
    sideChat.reconcileSideChatUserMessage('agent_btw_1', {
      id: 'message_btw_1',
      sessionId: 'sess_1',
      role: 'user',
      content: [{ type: 'text', text: 'repeat' }],
      createdAt: '2026-01-01T00:00:00.000Z',
      promptId: 'prompt_btw_1',
    });
    await sideChat.sendSideChatPrompt('repeat');
    sideChat.reconcileSideChatUserMessage('agent_btw_1', {
      id: 'message_btw_2',
      sessionId: 'sess_1',
      role: 'user',
      content: [{ type: 'text', text: 'repeat' }],
      createdAt: '2026-01-01T00:00:01.000Z',
      promptId: 'prompt_btw_2',
    });

    expect(
      state.sideChatMessagesByAgent.agent_btw_1?.map((message) => message.userMessageId),
    ).toEqual(['message_btw_1', 'message_btw_2']);
  });

  it('cleans up the optimistic echo and sending flag when the send fails before the submit', async () => {
    // Regression: a failure thrown before the submit POST (here the thinking
    // resolve) must still run the catch's cleanup — an early return used to
    // skip it, so the side chat kept the optimistic message and stayed
    // "sending" forever (no terminal event ever arrives for an unsubmitted
    // prompt).
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    const state = createState();
    const sideChat = useSideChat(state, {
      api,
      pushOperationFailure: vi.fn(),
      nextOptimisticMsgId: () => 'msg_opt_btw',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => null,
      refreshSessionStatus: vi.fn(),
      resolveThinkingForPrompt: async () => {
        throw new TypeError('offline');
      },
    });
    await sideChat.openSideChatOn('sess_1');

    const sent = await sideChat.sendSideChatPrompt('repeat');

    expect(sent).toBe(false);
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(state.sideChatMessagesByAgent.agent_btw_1 ?? []).toHaveLength(0);
    expect(state.sideChatSendingByAgent.agent_btw_1).toBe(false);
  });
});

describe('useSideChat — clearSideChatForSession eviction (memory)', () => {
  function makeDeps() {
    return {
      api,
      pushOperationFailure: vi.fn(),
      nextOptimisticMsgId: () => 'msg_opt_btw',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => null,
      refreshSessionStatus: vi.fn(),
      resolveThinkingForPrompt: async () => undefined,
    };
  }

  it('evicts target, messages, sending flag and user-message ids of the dead session', async () => {
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_btw', userMessageId: 'msg_srv_btw' });

    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    await sideChat.openSideChatOn('sess_1', 'what changed?');
    // A completed send leaves every bucket populated: target, optimistic +
    // assistant messages, the still-true sending flag, and the user-id set.
    sideChat.appendSideChatAssistantText('agent_btw_1', 'sess_1', 'answer chunk');
    expect(state.sideChatMessagesByAgent.agent_btw_1?.length).toBeGreaterThan(0);
    expect(state.sideChatSendingByAgent.agent_btw_1).toBe(true);
    expect(state.sideChatUserMessageIdsBySession.sess_1).toEqual(['msg_srv_btw']);
    expect(sideChat.sideChatVisible.value).toBe(true);

    sideChat.clearSideChatForSession('sess_1');

    expect(sideChat.sideChatTargetBySession.value.sess_1).toBeUndefined();
    expect(state.sideChatMessagesByAgent.agent_btw_1).toBeUndefined();
    expect(state.sideChatSendingByAgent.agent_btw_1).toBeUndefined();
    expect(state.sideChatUserMessageIdsBySession.sess_1).toBeUndefined();
    expect(sideChat.sideChatVisible.value).toBe(false);
    expect(sideChat.sideChatTurns.value).toEqual([]);
  });

  it('keeps other sessions’ side-chat state intact', async () => {
    apiMock.startBtw.mockReset();
    apiMock.startBtw.mockImplementation(async (parent: string) => ({
      agentId: parent === 'sess_1' ? 'agent_btw_1' : 'agent_btw_2',
    }));

    const state = createState();
    state.sessions.push({
      ...state.sessions[0]!,
      id: 'sess_2',
    });
    const sideChat = useSideChat(state, makeDeps());
    await sideChat.openSideChatOn('sess_1');
    await sideChat.openSideChatOn('sess_2');
    sideChat.appendSideChatAssistantText('agent_btw_2', 'sess_2', 'keep me');

    sideChat.clearSideChatForSession('sess_1');

    expect(state.sideChatMessagesByAgent.agent_btw_1).toBeUndefined();
    expect(sideChat.sideChatTargetBySession.value.sess_2).toEqual({ agentId: 'agent_btw_2' });
    expect(state.sideChatMessagesByAgent.agent_btw_2).toHaveLength(1);
  });

  it('is a no-op for a session without a side chat target', () => {
    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    sideChat.clearSideChatForSession('sess_1');
    expect(state.sideChatMessagesByAgent).toEqual({});
    expect(sideChat.sideChatTargetBySession.value).toEqual({});
  });
});

describe('useSideChat — clearSideChatForSession after the tab was closed', () => {
  it('still cleans the session-keyed id bucket when no target remains', async () => {
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_btw', userMessageId: 'msg_srv_btw' });

    const state = createState();
    const sideChat = useSideChat(state, {
      api,
      pushOperationFailure: vi.fn(),
      nextOptimisticMsgId: () => 'msg_opt_btw',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => null,
      refreshSessionStatus: vi.fn(),
      resolveThinkingForPrompt: async () => undefined,
    });
    await sideChat.openSideChatOn('sess_1', 'q?');
    expect(state.sideChatUserMessageIdsBySession.sess_1).toEqual(['msg_srv_btw']);

    // The user closes the BTW tab (target gone), then the session is archived.
    sideChat.closeSideChat();
    sideChat.clearSideChatForSession('sess_1');

    expect(state.sideChatUserMessageIdsBySession.sess_1).toBeUndefined();
  });
});

describe('useSideChat — session dies mid-submit', () => {
  function makeDeps() {
    return {
      api,
      pushOperationFailure: vi.fn(),
      nextOptimisticMsgId: () => 'msg_opt_btw',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => null,
      refreshSessionStatus: vi.fn(),
      resolveThinkingForPrompt: async () => undefined,
    };
  }

  it('does not resurrect buckets when the submit succeeds after the session died', async () => {
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    let resolveSubmit!: (value: { promptId: string; userMessageId: string }) => void;
    apiMock.submitPrompt.mockImplementation(
      () =>
        new Promise<{ promptId: string; userMessageId: string }>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    await sideChat.openSideChatOn('sess_1');
    const pending = sideChat.sendSideChatPrompt('q');
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());

    // The parent session is archived while the submit is in flight.
    sideChat.clearSideChatForSession('sess_1');
    resolveSubmit({ promptId: 'pr_btw', userMessageId: 'msg_srv_btw' });
    await pending;

    expect(state.sideChatMessagesByAgent.agent_btw_1).toBeUndefined();
    expect(state.sideChatUserMessageIdsBySession.sess_1).toBeUndefined();
  });

  it('does not resurrect buckets when the submit fails after the session died', async () => {
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    let rejectSubmit!: (err: unknown) => void;
    apiMock.submitPrompt.mockImplementation(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectSubmit = reject;
        }),
    );
    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    await sideChat.openSideChatOn('sess_1');
    const pending = sideChat.sendSideChatPrompt('q');
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());

    sideChat.clearSideChatForSession('sess_1');
    rejectSubmit(new TypeError('offline'));
    await pending;

    expect(state.sideChatMessagesByAgent.agent_btw_1).toBeUndefined();
    expect(state.sideChatSendingByAgent.agent_btw_1).toBeUndefined();
  });
});

describe('useSideChat — concurrent first opens share one in-flight startBtw', () => {
  function makeDeps() {
    return {
      api,
      pushOperationFailure: vi.fn(),
      nextOptimisticMsgId: () => 'msg_opt_btw',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => null,
      refreshSessionStatus: vi.fn(),
      resolveThinkingForPrompt: async () => undefined,
    };
  }

  it('two opens landing before the first startBtw returns spawn only ONE agent', async () => {
    apiMock.startBtw.mockReset();
    let resolveStart!: (value: { agentId: string }) => void;
    apiMock.startBtw.mockImplementation(
      () =>
        new Promise<{ agentId: string }>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const state = createState();
    const sideChat = useSideChat(state, makeDeps());

    const first = sideChat.openSideChatOn('sess_1');
    const second = sideChat.openSideChatOn('sess_1');
    // Both calls are in flight before the create resolves — the second must
    // piggyback on the first instead of taking the create branch again.
    resolveStart({ agentId: 'agent_btw_1' });
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);

    expect(apiMock.startBtw).toHaveBeenCalledOnce();
    expect(apiMock.startBtw).toHaveBeenCalledWith('sess_1');
  });

  it('a piggybacked open still sends its own initial prompt after the shared open lands', async () => {
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    let resolveStart!: (value: { agentId: string }) => void;
    apiMock.startBtw.mockImplementation(
      () =>
        new Promise<{ agentId: string }>((resolve) => {
          resolveStart = resolve;
        }),
    );
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_btw', userMessageId: 'msg_opt_btw' });
    const state = createState();
    const sideChat = useSideChat(state, makeDeps());

    const first = sideChat.openSideChatOn('sess_1');
    const second = sideChat.openSideChatOn('sess_1', 'queued question');
    resolveStart({ agentId: 'agent_btw_1' });
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);

    expect(apiMock.startBtw).toHaveBeenCalledOnce();
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({ agentId: 'agent_btw_1' }),
    );
  });

  it('a failed first send does not eat a concurrent caller’s own prompt', async () => {
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    let resolveStart!: (value: { agentId: string }) => void;
    apiMock.startBtw.mockImplementation(
      () =>
        new Promise<{ agentId: string }>((resolve) => {
          resolveStart = resolve;
        }),
    );
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_btw', userMessageId: 'msg_opt_btw' });
    const state = createState();
    // The FIRST send fails before the submit POST (a provably-unsent failure
    // → false); the second must still go out on its own.
    const resolveThinkingForPrompt = vi
      .fn<() => Promise<undefined>>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValue(undefined);
    const sideChat = useSideChat(state, { ...makeDeps(), resolveThinkingForPrompt });

    const first = sideChat.openSideChatOn('sess_1', 'q1');
    const second = sideChat.openSideChatOn('sess_1', 'q2');
    resolveStart({ agentId: 'agent_btw_1' });

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(apiMock.startBtw).toHaveBeenCalledOnce();
    // Only the second caller's prompt reached the daemon — independently of
    // the first's failure.
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
  });
});

describe('useSideChat — pending side-chat draft (guarded-open fallback)', () => {
  function makeDeps() {
    return {
      api,
      pushOperationFailure: vi.fn(),
      nextOptimisticMsgId: () => 'msg_opt_btw',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => null,
      refreshSessionStatus: vi.fn(),
      resolveThinkingForPrompt: async () => undefined,
    };
  }

  it('stores a draft per session and take returns it exactly once', () => {
    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    sideChat.setSideChatPendingDraft('sess_1', '> 引用\n\n');
    sideChat.setSideChatPendingDraft('sess_2', '> other\n\n');

    // Session isolation.
    expect(sideChat.takeSideChatPendingDraft('sess_1')).toBe('> 引用\n\n');
    // Taken means cleared — a second take finds nothing.
    expect(sideChat.takeSideChatPendingDraft('sess_1')).toBeNull();
    // The other session's draft is untouched.
    expect(sideChat.takeSideChatPendingDraft('sess_2')).toBe('> other\n\n');
    expect(sideChat.takeSideChatPendingDraft('sess_2')).toBeNull();
  });

  it('take on an unknown session resolves null', () => {
    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    expect(sideChat.takeSideChatPendingDraft('sess_unknown')).toBeNull();
  });
});

describe('useSideChat — pending draft joining and eviction', () => {
  function makeDeps() {
    return {
      api,
      pushOperationFailure: vi.fn(),
      nextOptimisticMsgId: () => 'msg_opt_btw',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => null,
      refreshSessionStatus: vi.fn(),
      resolveThinkingForPrompt: async () => undefined,
    };
  }

  it('repeat stashes in one session join as ONE normalized draft (never last-write-wins)', () => {
    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    sideChat.setSideChatPendingDraft('sess_1', '> q1\n\n');
    sideChat.setSideChatPendingDraft('sess_1', '> q2\n\n');
    // joinDraftSegments semantics: exactly one blank line between the two
    // quote blocks (never four consecutive newlines).
    expect(sideChat.takeSideChatPendingDraft('sess_1')).toBe('> q1\n\n> q2\n\n');
  });

  it('clearSideChatForSession evicts the pending draft (target or not)', () => {
    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    sideChat.setSideChatPendingDraft('sess_1', '> 引用\n\n');
    sideChat.setSideChatPendingDraft('sess_2', '> other\n\n');

    sideChat.clearSideChatForSession('sess_1');

    expect(sideChat.takeSideChatPendingDraft('sess_1')).toBeNull();
    // Other sessions are untouched.
    expect(sideChat.takeSideChatPendingDraft('sess_2')).toBe('> other\n\n');
  });
});

describe('useSideChat — persisted whole draft (per-session)', () => {
  function makeDeps() {
    return {
      api,
      pushOperationFailure: vi.fn(),
      nextOptimisticMsgId: () => 'msg_opt_btw',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => null,
      refreshSessionStatus: vi.fn(),
      resolveThinkingForPrompt: async () => undefined,
    };
  }

  it('saves and loads a draft per session, isolated across sessions', () => {
    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    sideChat.saveSideChatDraft('sess_1', '> 引用\n\n评论');
    sideChat.saveSideChatDraft('sess_2', '其他草稿');

    expect(sideChat.sideChatDraft('sess_1')).toBe('> 引用\n\n评论');
    expect(sideChat.sideChatDraft('sess_2')).toBe('其他草稿');
    expect(sideChat.sideChatDraft('sess_unknown')).toBe('');
  });

  it('re-saving overwrites; an empty draft evicts the key', () => {
    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    sideChat.saveSideChatDraft('sess_1', 'v1');
    sideChat.saveSideChatDraft('sess_1', 'v2');
    expect(sideChat.sideChatDraft('sess_1')).toBe('v2');

    sideChat.saveSideChatDraft('sess_1', '');
    expect(sideChat.sideChatDraft('sess_1')).toBe('');
    // Evicting an unknown key is a no-op.
    sideChat.saveSideChatDraft('sess_1', '');
    expect(sideChat.sideChatDraft('sess_1')).toBe('');
  });

  it('clearSideChatForSession evicts the persisted draft (target or not)', () => {
    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    sideChat.saveSideChatDraft('sess_1', '> 引用\n\n');
    sideChat.saveSideChatDraft('sess_2', '其他草稿');

    sideChat.clearSideChatForSession('sess_1');

    expect(sideChat.sideChatDraft('sess_1')).toBe('');
    expect(sideChat.sideChatDraft('sess_2')).toBe('其他草稿');
  });

  it('clearSideChatDraftIfUnchanged clears only an unchanged draft (post-send cleanup)', () => {
    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    sideChat.saveSideChatDraft('sess_1', '> 引用\n\n评论');
    // The draft moved on mid-flight — the stale snapshot must NOT clear the
    // user's new content.
    sideChat.saveSideChatDraft('sess_1', '> 引用\n\n评论 + 新内容');
    sideChat.clearSideChatDraftIfUnchanged('sess_1', '> 引用\n\n评论');
    expect(sideChat.sideChatDraft('sess_1')).toBe('> 引用\n\n评论 + 新内容');
    // Unchanged — the send consumed it.
    sideChat.clearSideChatDraftIfUnchanged('sess_1', '> 引用\n\n评论 + 新内容');
    expect(sideChat.sideChatDraft('sess_1')).toBe('');
  });

  it('clearSideChatDraftIfUnchanged never touches another session with identical text', () => {
    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    // Two sessions holding the SAME draft text: clearing the source session's
    // post-send draft must not evict the other's (the panel instance is
    // reused across sessions, so the key — not the text — decides).
    sideChat.saveSideChatDraft('sess_1', 'same');
    sideChat.saveSideChatDraft('sess_2', 'same');
    sideChat.clearSideChatDraftIfUnchanged('sess_1', 'same');
    expect(sideChat.sideChatDraft('sess_1')).toBe('');
    expect(sideChat.sideChatDraft('sess_2')).toBe('same');
  });

  it('load + pending merge: a reused panel picks up both, the stash once-only', () => {
    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    sideChat.saveSideChatDraft('sess_2', '已有草稿');
    sideChat.setSideChatPendingDraft('sess_2', '> 引用\n\n');
    // SideChatPanel's parentSessionId watcher on an instance-reusing A→B
    // switch: the persisted draft and the pending stash join as ONE draft
    // (joinDraftSegments semantics — exactly one blank line between), and the
    // take clears the stash so a later remount finds nothing.
    const loaded = sideChat.sideChatDraft('sess_2');
    const pending = sideChat.takeSideChatPendingDraft('sess_2');
    expect(pending).toBe('> 引用\n\n');
    expect(joinDraftSegments(loaded, pending!)).toBe('已有草稿\n\n> 引用\n\n');
    expect(sideChat.takeSideChatPendingDraft('sess_2')).toBeNull();
    // An empty persisted side passes the stash through unchanged.
    expect(joinDraftSegments(sideChat.sideChatDraft('sess_1'), '> q\n\n')).toBe('> q\n\n');
  });
});

describe('useSideChat — session dies mid-create (generation tombstone)', () => {
  function makeDeps() {
    return {
      api,
      pushOperationFailure: vi.fn(),
      nextOptimisticMsgId: () => 'msg_opt_btw',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => null,
      refreshSessionStatus: vi.fn(),
      resolveThinkingForPrompt: async () => undefined,
    };
  }

  it('an in-flight startBtw writes NOTHING back after the session was cleared', async () => {
    apiMock.startBtw.mockReset();
    let resolveStart!: (value: { agentId: string }) => void;
    apiMock.startBtw.mockImplementation(
      () =>
        new Promise<{ agentId: string }>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const state = createState();
    const sideChat = useSideChat(state, makeDeps());

    const pending = sideChat.openSideChatOn('sess_1');
    sideChat.clearSideChatForSession('sess_1');
    resolveStart({ agentId: 'agent_btw_1' });

    await expect(pending).resolves.toBe(false);
    // No target, no message bucket, no pending draft possible.
    expect(sideChat.sideChatTargetBySession.value['sess_1']).toBeUndefined();
    expect(state.sideChatMessagesByAgent['agent_btw_1']).toBeUndefined();
    sideChat.setSideChatPendingDraft('sess_1', '> 引用\n\n');
    expect(sideChat.takeSideChatPendingDraft('sess_1')).toBeNull();
  });

  it('a FRESH open after the clear (e.g. restored session) captures the bumped generation and works', async () => {
    apiMock.startBtw.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_2' });
    const state = createState();
    const sideChat = useSideChat(state, makeDeps());

    sideChat.clearSideChatForSession('sess_1');
    await expect(sideChat.openSideChatOn('sess_1')).resolves.toBe(true);

    expect(sideChat.sideChatTargetBySession.value['sess_1']).toEqual({ agentId: 'agent_btw_2' });
    // And the tombstone no longer blocks drafts for the re-opened session.
    sideChat.setSideChatPendingDraft('sess_1', '> 引用\n\n');
    expect(sideChat.takeSideChatPendingDraft('sess_1')).toBe('> 引用\n\n');
  });
});

describe('useSideChat — archive mid-flight, restore and re-open before the stale create lands', () => {
  function makeDeps() {
    return {
      api,
      pushOperationFailure: vi.fn(),
      nextOptimisticMsgId: () => 'msg_opt_btw',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => null,
      refreshSessionStatus: vi.fn(),
      resolveThinkingForPrompt: async () => undefined,
    };
  }

  it('the stale in-flight open never blocks the fresh one (fresh slot after clear)', async () => {
    apiMock.startBtw.mockReset();
    let resolveFirst!: (value: { agentId: string }) => void;
    apiMock.startBtw
      .mockImplementationOnce(
        () =>
          new Promise<{ agentId: string }>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ agentId: 'agent_btw_2' });
    const state = createState();
    const sideChat = useSideChat(state, makeDeps());

    const first = sideChat.openSideChatOn('sess_1');
    // Archived mid-flight…
    sideChat.clearSideChatForSession('sess_1');
    // …restored and re-opened BEFORE the first startBtw lands.
    const second = sideChat.openSideChatOn('sess_1');
    resolveFirst({ agentId: 'agent_btw_1' });

    // The stale create resolves false and writes nothing; the fresh one
    // (new slot, new generation) succeeds and registers its agent.
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(apiMock.startBtw).toHaveBeenCalledTimes(2);
    expect(sideChat.sideChatTargetBySession.value['sess_1']).toEqual({ agentId: 'agent_btw_2' });
    expect(state.sideChatMessagesByAgent['agent_btw_1']).toBeUndefined();
  });
});
