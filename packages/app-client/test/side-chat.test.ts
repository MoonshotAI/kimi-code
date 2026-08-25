import { describe, expect, it, vi } from 'vitest';
import { createInitialState, DaemonApiError } from '@moonshot-ai/app-core/api';
import type { KimiWebApi } from '@moonshot-ai/app-core/api';
import { useSideChat } from '../src/client/useSideChat';
import { joinDraftSegments } from '../src/lib/quoteSelection';
import type { ExtendedState } from '../src/client/types';

// The api is injected; stub the BTW endpoints.
const apiMock = {
  startBtw: vi.fn(),
  submitPrompt: vi.fn(),
  updateSession: vi.fn(),
  getSessionTranscript: vi.fn(),
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
    pendingPlanBySession: {},
    swarmModeBySession: {},
    pendingSwarmBySession: {},
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

  it('keeps the previous round\'s terminal routing identity when a resend fails provably-unsent', async () => {
    // The previous BTW round already ended (agentTurnEnded) but its final
    // taskCompleted is still in flight: a next send failing provably-unsent
    // must restore only the dock filter state, not delete the known identity
    // the late terminal output routes through.
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    apiMock.submitPrompt
      .mockResolvedValueOnce({ promptId: 'pr_btw', userMessageId: 'msg_srv_btw' })
      .mockRejectedValueOnce(new DaemonApiError({ code: 40900, msg: 'refused', requestId: 'r' }));

    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    await sideChat.openSideChatOn('sess_1', 'first question');
    sideChat.finishSideChatAgent('agent_btw_1', 'sess_1', 'partial');
    expect(sideChat.wasSideChatAgent('agent_btw_1')).toBe(true);

    const sent = await sideChat.sendSideChatPrompt('second question');
    expect(sent).toBe(false);

    // The dock filter is restored (terminated), but the routing identity
    // survives for the previous round's late final output.
    expect(sideChat.sideChatRunning.value).toBe(false);
    expect(sideChat.wasSideChatAgent('agent_btw_1')).toBe(true);
  });

  it('evicts agent-keyed buckets even when the panel was closed before the session died', async () => {
    // closeSideChat drops only the target; the session→agent attribution must
    // still let teardown find and clear every agent-keyed bucket, or they leak
    // for the app's lifetime.
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_btw', userMessageId: 'msg_srv_btw' });

    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    await sideChat.openSideChatOn('sess_1', 'what changed?');
    sideChat.appendSideChatAssistantText('agent_btw_1', 'sess_1', 'answer chunk');
    expect(state.sideChatMessagesByAgent.agent_btw_1?.length).toBeGreaterThan(0);

    sideChat.closeSideChat();
    expect(sideChat.sideChatTargetBySession.value.sess_1).toBeUndefined();

    sideChat.clearSideChatForSession('sess_1');

    expect(state.sideChatMessagesByAgent.agent_btw_1).toBeUndefined();
    expect(state.sideChatSendingByAgent.agent_btw_1).toBeUndefined();
    expect(state.sideChatUserMessageIdsBySession.sess_1).toBeUndefined();
    expect(sideChat.sideChatRunning.value).toBe(false);
  });

  it('cleans EVERY agent the session ever started after a panel reopen', async () => {
    // Reopening the panel starts a NEW agent over the old mapping: teardown
    // must clear both — the superseded agent's buckets and its routing
    // identity are just as dead as the current one's.
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.startBtw
      .mockResolvedValueOnce({ agentId: 'agent_btw_1' })
      .mockResolvedValueOnce({ agentId: 'agent_btw_2' });
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_btw', userMessageId: 'msg_srv_btw' });

    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    await sideChat.openSideChatOn('sess_1', 'first round');
    sideChat.appendSideChatAssistantText('agent_btw_1', 'sess_1', 'old answer');
    sideChat.closeSideChat();
    await sideChat.openSideChatOn('sess_1', 'second round');
    sideChat.appendSideChatAssistantText('agent_btw_2', 'sess_1', 'new answer');
    expect(sideChat.wasSideChatAgent('agent_btw_1')).toBe(true);
    expect(sideChat.wasSideChatAgent('agent_btw_2')).toBe(true);

    sideChat.clearSideChatForSession('sess_1');

    expect(state.sideChatMessagesByAgent.agent_btw_1).toBeUndefined();
    expect(state.sideChatSendingByAgent.agent_btw_1).toBeUndefined();
    expect(state.sideChatMessagesByAgent.agent_btw_2).toBeUndefined();
    expect(state.sideChatSendingByAgent.agent_btw_2).toBeUndefined();
    // The superseded agent's late terminal event must no longer route as a
    // side chat — it would recreate buckets no mapping can clean anymore.
    expect(sideChat.wasSideChatAgent('agent_btw_1')).toBe(false);
    expect(sideChat.wasSideChatAgent('agent_btw_2')).toBe(false);
  });

  it('drops a resync response that lands after the session was torn down', async () => {
    // The transcript GET is still in flight when clearSideChatForSession runs:
    // its late success must not rebuild the buckets as orphans no later
    // teardown can reach.
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.getSessionTranscript.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_btw', userMessageId: 'msg_srv_btw' });
    let resolveRead!: (value: unknown) => void;
    apiMock.getSessionTranscript.mockImplementationOnce(
      () => new Promise((resolve) => { resolveRead = resolve; }),
    );

    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    await sideChat.openSideChatOn('sess_1', 'what changed?');

    const resync = sideChat.resyncSideChat('sess_1');
    await vi.waitFor(() => expect(apiMock.getSessionTranscript).toHaveBeenCalledOnce());
    sideChat.clearSideChatForSession('sess_1');

    resolveRead({
      agentId: 'agent_btw_1',
      items: [],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      agents: [],
      pendingInteractions: [],
      meta: { activity: 'idle' },
      hasMoreOlder: false,
    });
    await resync;

    expect(state.sideChatMessagesByAgent.agent_btw_1).toBeUndefined();
    expect(state.sideChatSendingByAgent.agent_btw_1).toBeUndefined();
  });

  it('dedupes a resync-covered message by its TOP-LEVEL promptId', async () => {
    // The confirmed bubble's identity lives at message.promptId (top level) —
    // reading the metadata key would keep the bubble AND append the rebuilt
    // server copy, duplicating the message.
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.getSessionTranscript.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_btw', userMessageId: 'msg_srv_btw' });

    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    await sideChat.openSideChatOn('sess_1', 'what changed?');
    const stamped = (state.sideChatMessagesByAgent.agent_btw_1 ?? []).find(
      (msg) => msg.promptId === 'pr_btw',
    );
    expect(stamped).toBeDefined();

    await sideChat.resyncSideChat('sess_1', {
      agentId: 'agent_btw_1',
      items: [
        {
          kind: 'turn',
          turnId: 't-btw-1',
          ordinal: 1,
          state: 'running',
          origin: { kind: 'user' },
          prompt: 'what changed?',
          steps: [],
          startedAt: '2026-08-24T10:00:00.000Z',
        },
      ],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [
        {
          promptId: 'pr_btw',
          status: 'running',
          content: [{ type: 'text', text: 'what changed?' }],
          createdAt: '2026-08-24T10:00:00.000Z',
        },
      ],
      agents: [],
      pendingInteractions: [],
      meta: { activity: 'turn' },
      hasMoreOlder: false,
    } as never);

    const copies = (state.sideChatMessagesByAgent.agent_btw_1 ?? []).filter(
      (msg) =>
        msg.role === 'user' &&
        msg.content.some((part) => part.type === 'text' && part.text.includes('what changed?')),
    );
    expect(copies).toHaveLength(1);
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

  /** Multi-bubble tests need UNIQUE optimistic ids: confirmSideChatUserMessage
   *  matches by message id, so the shared constant stamps the FIRST bubble. */
  function makeUniqueIdDeps() {
    let optimisticId = 0;
    return { ...makeDeps(), nextOptimisticMsgId: () => `msg_opt_btw_${++optimisticId}` };
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

  it('ignores a PREVIOUS round’s straggler taskCompleted after a resend', async () => {
    // Round 1's turn ended (agent marked terminated), round 2 is in flight:
    // round 1's delayed taskCompleted must not clear round 2's sending state
    // or append its stale output after the new bubble.
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_btw', userMessageId: 'msg_srv_btw' });

    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    await sideChat.openSideChatOn('sess_1', 'round one');
    // Round 1's agentTurnEnded: agent terminated, sending cleared.
    sideChat.finishSideChatAgent('agent_btw_1', 'sess_1');
    expect(state.sideChatSendingByAgent.agent_btw_1).toBe(false);

    // Round 2 starts: sending re-arms, new user bubble lands.
    await sideChat.sendSideChatPrompt('round two');
    expect(state.sideChatSendingByAgent.agent_btw_1).toBe(true);

    // The straggler: round 1's taskCompleted arriving now is a no-op.
    sideChat.finishSideChatAgent('agent_btw_1', 'sess_1', 'stale old output', true);

    expect(state.sideChatSendingByAgent.agent_btw_1).toBe(true);
    expect(
      (state.sideChatMessagesByAgent.agent_btw_1 ?? []).some((msg) =>
        msg.content.some((part) => part.type === 'text' && part.text.includes('stale old output')),
      ),
    ).toBe(false);
  });

  it('settles a taskCompleted that lands while its own round is terminated', async () => {
    // The legit order per round: agentTurnEnded (terminated) THEN
    // taskCompleted — the terminal output still routes and settles.
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_btw', userMessageId: 'msg_srv_btw' });

    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    await sideChat.openSideChatOn('sess_1', 'round one');
    sideChat.finishSideChatAgent('agent_btw_1', 'sess_1');

    sideChat.finishSideChatAgent('agent_btw_1', 'sess_1', 'the final answer', true);

    expect(
      (state.sideChatMessagesByAgent.agent_btw_1 ?? []).some((msg) =>
        msg.content.some((part) => part.type === 'text' && part.text.includes('the final answer')),
      ),
    ).toBe(true);
  });

  it('accepts the current round’s taskCompleted when its turn-end was swallowed', async () => {
    // The client never saw this round's agentTurnEnded (a resync gap ate it):
    // the taskCompleted is the round's OWN terminal evidence. A one-shot
    // transcript read proves the current prompt is terminal — settle sending
    // and keep the output instead of dropping it as a straggler.
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.getSessionTranscript.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_btw', userMessageId: 'msg_srv_btw' });
    apiMock.getSessionTranscript.mockResolvedValue({
      agentId: 'agent_btw_1',
      items: [],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [
        {
          promptId: 'pr_btw',
          status: 'completed',
          createdAt: '2026-08-24T10:00:00.000Z',
          finishedAt: '2026-08-24T10:00:01.000Z',
        },
      ],
      agents: [],
      pendingInteractions: [],
      meta: { activity: 'idle' },
      hasMoreOlder: false,
    });

    const state = createState();
    const sideChat = useSideChat(state, makeUniqueIdDeps());
    await sideChat.openSideChatOn('sess_1', 'round one');
    expect(state.sideChatSendingByAgent.agent_btw_1).toBe(true);

    // No agentTurnEnded observed — the agent is NOT terminated.
    sideChat.finishSideChatAgent('agent_btw_1', 'sess_1', 'the final answer', true);

    await vi.waitFor(() => expect(state.sideChatSendingByAgent.agent_btw_1).toBe(false));
    expect(
      (state.sideChatMessagesByAgent.agent_btw_1 ?? []).some((msg) =>
        msg.content.some((part) => part.type === 'text' && part.text.includes('the final answer')),
      ),
    ).toBe(true);
  });

  it('still drops a straggler taskCompleted once the current round’s prompt reads live', async () => {
    // Same arbitration, opposite verdict: round 2's prompt is RUNNING in the
    // transcript — round 1's late taskCompleted must not clear round 2.
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.getSessionTranscript.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_btw', userMessageId: 'msg_srv_btw' });
    apiMock.getSessionTranscript.mockResolvedValue({
      agentId: 'agent_btw_1',
      items: [],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [{ promptId: 'pr_btw', status: 'running', createdAt: '2026-08-24T10:00:00.000Z' }],
      agents: [],
      pendingInteractions: [],
      meta: { activity: 'turn' },
      hasMoreOlder: false,
    });

    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    await sideChat.openSideChatOn('sess_1', 'round one');
    sideChat.finishSideChatAgent('agent_btw_1', 'sess_1');
    await sideChat.sendSideChatPrompt('round two');
    expect(state.sideChatSendingByAgent.agent_btw_1).toBe(true);

    sideChat.finishSideChatAgent('agent_btw_1', 'sess_1', 'stale old output', true);

    // Let the arbitration read complete, then assert the drop.
    await vi.waitFor(() => expect(apiMock.getSessionTranscript).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(state.sideChatSendingByAgent.agent_btw_1).toBe(true);
    expect(
      (state.sideChatMessagesByAgent.agent_btw_1 ?? []).some((msg) =>
        msg.content.some((part) => part.type === 'text' && part.text.includes('stale old output')),
      ),
    ).toBe(false);
  });

  it('parks a straggler taskCompleted while the current round’s POST is unanswered', async () => {
    // Round 2's POST is still out: the new bubble has no promptId yet, and a
    // pre-POST snapshot would call round 1's late taskCompleted the current
    // round's terminal. The arbitration must wait for the answer — then a
    // LIVE current prompt still drops the straggler.
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.getSessionTranscript.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    let answerSubmit!: (value: { promptId: string; userMessageId: string }) => void;
    apiMock.submitPrompt.mockImplementation(
      () =>
        new Promise<{ promptId: string; userMessageId: string }>((resolve) => {
          answerSubmit = resolve;
        }),
    );
    apiMock.getSessionTranscript.mockResolvedValue({
      agentId: 'agent_btw_1',
      items: [],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [{ promptId: 'pr_btw_2', status: 'running', createdAt: '2026-08-24T10:00:00.000Z' }],
      agents: [],
      pendingInteractions: [],
      meta: { activity: 'turn' },
      hasMoreOlder: false,
    });

    const state = createState();
    const sideChat = useSideChat(state, makeUniqueIdDeps());
    // Round 1 (its turn-end was swallowed — the agent is NOT terminated).
    apiMock.submitPrompt.mockResolvedValueOnce({ promptId: 'pr_btw_1', userMessageId: 'msg_1' });
    await sideChat.openSideChatOn('sess_1', 'round one');
    expect(state.sideChatSendingByAgent.agent_btw_1).toBe(true);

    // Round 2's POST is held; round 1's taskCompleted arrives in the window.
    const pendingRound2 = sideChat.sendSideChatPrompt('round two');
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledTimes(2));
    sideChat.finishSideChatAgent('agent_btw_1', 'sess_1', 'stale old output', true);

    // Parked: NO arbitration read yet, nothing settled, nothing appended.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(apiMock.getSessionTranscript).not.toHaveBeenCalled();
    expect(state.sideChatSendingByAgent.agent_btw_1).toBe(true);

    // The answer stamps round 2's identity — the arbitration now runs and
    // drops the straggler (round 2's prompt reads RUNNING).
    answerSubmit({ promptId: 'pr_btw_2', userMessageId: 'msg_2' });
    await pendingRound2;
    await vi.waitFor(() => expect(apiMock.getSessionTranscript).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(state.sideChatSendingByAgent.agent_btw_1).toBe(true);
    expect(
      (state.sideChatMessagesByAgent.agent_btw_1 ?? []).some((msg) =>
        msg.content.some((part) => part.type === 'text' && part.text.includes('stale old output')),
      ),
    ).toBe(false);
  });

  it('keeps the unanswered window until ALL concurrent submits settle', async () => {
    // Two concurrent sends share the agent: the FIRST answer must not close
    // the window while the second POST is still out — a straggler
    // taskCompleted stays parked until every outstanding identity is known.
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.getSessionTranscript.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    const answers: Array<(value: { promptId: string; userMessageId: string }) => void> = [];
    apiMock.submitPrompt
      .mockResolvedValueOnce({ promptId: 'pr_btw_1', userMessageId: 'msg_1' })
      .mockImplementation(
        () =>
          new Promise<{ promptId: string; userMessageId: string }>((resolve) => {
            answers.push(resolve);
          }),
      );
    apiMock.getSessionTranscript.mockResolvedValue({
      agentId: 'agent_btw_1',
      items: [],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [{ promptId: 'pr_btw_3', status: 'running', createdAt: '2026-08-24T10:00:00.000Z' }],
      agents: [],
      pendingInteractions: [],
      meta: { activity: 'turn' },
      hasMoreOlder: false,
    });

    const state = createState();
    const sideChat = useSideChat(state, makeUniqueIdDeps());
    // Round 1 (its turn-end was swallowed — the agent is NOT terminated).
    await sideChat.openSideChatOn('sess_1', 'round one');
    // Two CONCURRENT sends, both POSTs held.
    void sideChat.sendSideChatPrompt('round two');
    void sideChat.sendSideChatPrompt('round three');
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledTimes(3));

    // The straggler arrives: parked while the window is open.
    sideChat.finishSideChatAgent('agent_btw_1', 'sess_1', 'stale old output', true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(apiMock.getSessionTranscript).not.toHaveBeenCalled();

    // The FIRST answer lands — one POST is still out: STILL parked.
    answers[0]!({ promptId: 'pr_btw_2', userMessageId: 'msg_2' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(apiMock.getSessionTranscript).not.toHaveBeenCalled();
    expect(state.sideChatSendingByAgent.agent_btw_1).toBe(true);

    // The SECOND answer closes the window — the arbitration runs and drops
    // the straggler (the current round's prompt reads RUNNING).
    answers[1]!({ promptId: 'pr_btw_3', userMessageId: 'msg_3' });
    await vi.waitFor(() => expect(apiMock.getSessionTranscript).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(state.sideChatSendingByAgent.agent_btw_1).toBe(true);
    expect(
      (state.sideChatMessagesByAgent.agent_btw_1 ?? []).some((msg) =>
        msg.content.some((part) => part.type === 'text' && part.text.includes('stale old output')),
      ),
    ).toBe(false);
  });

  it('parks the arbitration while ANY submit is out, even once the newest bubble is stamped', async () => {
    // The LATER POST answers first and stamps the newest bubble while the
    // EARLIER POST is still out: a straggler arriving now must still park —
    // the stamped id's terminal read says nothing about the outstanding
    // round.
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.getSessionTranscript.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    const answers: Array<(value: { promptId: string; userMessageId: string }) => void> = [];
    apiMock.submitPrompt
      .mockResolvedValueOnce({ promptId: 'pr_btw_1', userMessageId: 'msg_1' })
      .mockImplementation(
        () =>
          new Promise<{ promptId: string; userMessageId: string }>((resolve) => {
            answers.push(resolve);
          }),
      );
    apiMock.getSessionTranscript.mockResolvedValue({
      agentId: 'agent_btw_1',
      items: [],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [
        { promptId: 'pr_btw_2', status: 'running', createdAt: '2026-08-24T10:00:00.000Z' },
        { promptId: 'pr_btw_3', status: 'completed', createdAt: '2026-08-24T10:00:01.000Z' },
      ],
      agents: [],
      pendingInteractions: [],
      meta: { activity: 'turn' },
      hasMoreOlder: false,
    });

    const state = createState();
    const sideChat = useSideChat(state, makeUniqueIdDeps());
    // Round 1 (its turn-end was swallowed — the agent is NOT terminated).
    await sideChat.openSideChatOn('sess_1', 'round one');
    // Two CONCURRENT sends, both POSTs held.
    void sideChat.sendSideChatPrompt('round two');
    void sideChat.sendSideChatPrompt('round three');
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledTimes(3));

    // The LATER POST answers first: the newest bubble is stamped, but round
    // two's POST is still out.
    answers[1]!({ promptId: 'pr_btw_3', userMessageId: 'msg_3' });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The straggler arrives: STILL parked (round two's identity unknown).
    sideChat.finishSideChatAgent('agent_btw_1', 'sess_1', 'stale old output', true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(apiMock.getSessionTranscript).not.toHaveBeenCalled();
    expect(state.sideChatSendingByAgent.agent_btw_1).toBe(true);

    // Round two's POST answers — the window closes; the arbitration runs and
    // drops the straggler (round two reads RUNNING even though round three
    // already completed).
    answers[0]!({ promptId: 'pr_btw_2', userMessageId: 'msg_2' });
    await vi.waitFor(() => expect(apiMock.getSessionTranscript).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(state.sideChatSendingByAgent.agent_btw_1).toBe(true);
    expect(
      (state.sideChatMessagesByAgent.agent_btw_1 ?? []).some((msg) =>
        msg.content.some((part) => part.type === 'text' && part.text.includes('stale old output')),
      ),
    ).toBe(false);
  });

  it('does not duplicate the terminal output when the reply text lives past content[0]', () => {
    // A rebuilt/continued assistant message can carry text at a non-zero part
    // index: the terminal dedup must find that trailing text part, or the
    // output gets appended AGAIN after the visible reply.
    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    state.sideChatMessagesByAgent = {
      agent_btw_1: [
        {
          id: 'm1',
          sessionId: 'sess_1',
          role: 'assistant',
          content: [
            { type: 'toolUse', toolCallId: 'c1', toolName: 'Bash', input: {} },
            { type: 'text', text: 'partial answer' },
          ],
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };

    sideChat.finishSideChatAgent('agent_btw_1', 'sess_1', 'partial answer tail');

    expect(state.sideChatMessagesByAgent.agent_btw_1!.at(-1)!.content).toEqual([
      { type: 'toolUse', toolCallId: 'c1', toolName: 'Bash', input: {} },
      { type: 'text', text: 'partial answer' },
    ]);
  });

  it('appends a resync-window text chunk without wiping rebuilt thinking/tool parts', () => {
    // The rebuilt baseline's last assistant message can carry thinking (or
    // tool) parts: a late text delta must continue the trailing text part or
    // start a new one — never replace the whole content.
    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    state.sideChatMessagesByAgent = {
      agent_btw_1: [
        {
          id: 'm_thinking',
          sessionId: 'sess_1',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'partial ans' },
          ],
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };

    // Tail is a text part: continue it, keeping the thinking part.
    sideChat.appendSideChatAssistantText('agent_btw_1', 'sess_1', 'wer');
    let last = state.sideChatMessagesByAgent.agent_btw_1!.at(-1)!;
    expect(last.content).toEqual([
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'partial answer' },
    ]);

    // Tail is NOT a text part: start a new text part after it.
    state.sideChatMessagesByAgent = {
      agent_btw_1: [
        {
          id: 'm_tool',
          sessionId: 'sess_1',
          role: 'assistant',
          content: [
            { type: 'toolUse', toolCallId: 'c1', toolName: 'Bash', input: {} },
          ],
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    sideChat.appendSideChatAssistantText('agent_btw_1', 'sess_1', 'fresh text');
    last = state.sideChatMessagesByAgent.agent_btw_1!.at(-1)!;
    expect(last.content).toEqual([
      { type: 'toolUse', toolCallId: 'c1', toolName: 'Bash', input: {} },
      { type: 'text', text: 'fresh text' },
    ]);
  });


  it('settles the sending state from a resync whose snapshot has the terminal prompt', async () => {
    // turn.ended was lost in the resync gap — the rebuilt snapshot's terminal
    // prompt entity is the only end signal this round will get.
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.getSessionTranscript.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_btw', userMessageId: 'msg_srv_btw' });
    apiMock.getSessionTranscript.mockImplementation(async () => ({
      agentId: 'agent_btw_1',
      items: [
        {
          kind: 'turn',
          turnId: 't-btw-1',
          ordinal: 1,
          state: 'completed',
          origin: { kind: 'user' },
          prompt: 'what changed?',
          steps: [],
          startedAt: '2026-08-24T10:00:00.000Z',
          endedAt: '2026-08-24T10:00:01.000Z',
        },
      ],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [
        {
          promptId: 'pr_btw',
          status: 'completed',
          content: [{ type: 'text', text: 'what changed?' }],
          createdAt: '2026-08-24T10:00:00.000Z',
        },
      ],
      agents: [],
      pendingInteractions: [],
      meta: { activity: 'idle' },
      hasMoreOlder: false,
    }));

    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    await sideChat.openSideChatOn('sess_1', 'what changed?');
    expect(state.sideChatSendingByAgent.agent_btw_1).toBe(true);

    await sideChat.resyncSideChat('sess_1');

    expect(state.sideChatSendingByAgent.agent_btw_1).toBe(false);
  });

  it('keeps the sending state when the resync snapshot still runs the prompt', async () => {
    // A snapshot that merely PREDATES the entity's terminal state is not an
    // end — the live round must keep its sending state.
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.getSessionTranscript.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_btw', userMessageId: 'msg_srv_btw' });
    apiMock.getSessionTranscript.mockImplementation(async () => ({
      agentId: 'agent_btw_1',
      items: [],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [
        {
          promptId: 'pr_btw',
          status: 'running',
          content: [{ type: 'text', text: 'what changed?' }],
          createdAt: '2026-08-24T10:00:00.000Z',
        },
      ],
      agents: [],
      pendingInteractions: [],
      meta: { activity: 'turn' },
      hasMoreOlder: false,
    }));

    const state = createState();
    const sideChat = useSideChat(state, makeDeps());
    await sideChat.openSideChatOn('sess_1', 'what changed?');
    expect(state.sideChatSendingByAgent.agent_btw_1).toBe(true);

    await sideChat.resyncSideChat('sess_1');

    expect(state.sideChatSendingByAgent.agent_btw_1).toBe(true);
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
