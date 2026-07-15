// apps/kimi-web/test/side-chat.test.ts
/**
 * Scenario: a Web side chat creates and prompts a BTW agent under its parent session.
 * Responsibilities: carry prompt controls and register session-scoped event routing.
 * Wiring: real useSideChat composable; daemon API and event connection are external stubs.
 * Run: pnpm --filter @moonshot-ai/kimi-web test -- side-chat.test.ts
 */

import { describe, expect, it, vi } from 'vitest';
import { nextTick, reactive } from 'vue';
import { createInitialState } from '../src/api/daemon/eventReducer';
import { useSideChat } from '../src/composables/client/useSideChat';
import type { AppModel, KimiEventConnection } from '../src/api/types';
import type { ExtendedState } from '../src/composables/useKimiWebClient';

const apiMock = vi.hoisted(() => ({
  startBtw: vi.fn(),
  submitPrompt: vi.fn(),
}));

vi.mock('../src/api', () => ({
  getKimiWebApi: () => apiMock,
}));

function createState(): ExtendedState {
  return {
    ...createInitialState(),
    sessions: [
      {
        id: 'sess_1',
        title: 'Session',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        status: 'idle' as const,
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
    planModeBySession: { sess_1: true },
    swarmModeBySession: {},
    sideChatMessagesByAgent: {},
    sideChatSendingByAgent: {},
    sideChatUserMessageIdsBySession: {},
  } as unknown as ExtendedState;
}

describe('useSideChat — sendSideChatPromptOn', () => {
  it('registers a new BTW agent under its parent session', async () => {
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    const markSideChannelAgent = vi.fn();

    const sideChat = useSideChat(createState(), {
      pushOperationFailure: vi.fn(),
      nextOptimisticMsgId: () => 'msg_opt_btw',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => ({ markSideChannelAgent }) as unknown as KimiEventConnection,
      models: () => [],
    });

    await sideChat.openSideChatOn('sess_1');

    expect(markSideChannelAgent).toHaveBeenCalledWith('agent_btw_1', 'sess_1');
  });

  it('registers an existing BTW agent again when its parent session becomes active', async () => {
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    const markSideChannelAgent = vi.fn();
    const state = reactive(createState()) as ExtendedState;
    const sideChat = useSideChat(state, {
      pushOperationFailure: vi.fn(),
      nextOptimisticMsgId: () => 'msg_opt_btw',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => ({ markSideChannelAgent }) as unknown as KimiEventConnection,
      models: () => [],
    });
    await sideChat.openSideChatOn('sess_1');
    markSideChannelAgent.mockClear();

    state.activeSessionId = undefined;
    await nextTick();
    state.activeSessionId = 'sess_1';
    await nextTick();

    expect(markSideChannelAgent).toHaveBeenCalledWith('agent_btw_1', 'sess_1');
  });

  it('carries model, thinking, permission and plan/swarm modes on the prompt', async () => {
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_btw', userMessageId: 'msg_opt_btw' });

    const state = createState();
    const pushOperationFailure = vi.fn();
    const sideChat = useSideChat(state, {
      pushOperationFailure,
      nextOptimisticMsgId: () => 'msg_opt_btw',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => null,
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

  it('submits the stored thinking level verbatim, even when the parent model does not declare it', async () => {
    // Thinking levels are never coerced onto the prompt's model (same as
    // normal prompts and the TUI): a stale effort like 'max' is sent as-is.
    apiMock.startBtw.mockReset();
    apiMock.submitPrompt.mockReset();
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
    apiMock.submitPrompt.mockResolvedValue({ promptId: 'pr_btw', userMessageId: 'msg_opt_btw' });

    const state = createState();
    state.thinking = 'max';
    const sideChat = useSideChat(state, {
      pushOperationFailure: vi.fn(),
      nextOptimisticMsgId: () => 'msg_opt_btw',
      connectEventsIfNeeded: vi.fn(),
      getEventConn: () => null,
    });

    await sideChat.openSideChatOn('sess_1', 'what changed?');

    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({ thinking: 'max' }),
    );
  });
});
