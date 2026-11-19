import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialState } from '@moonshot-ai/app-core/api';
import type { KimiEventConnection, KimiWebApi, PromptSubmission, PromptSubmitResult } from '@moonshot-ai/app-core/api';
import type { ConversationItem, ConversationTurn, ToolCallItem, UserMessageItem } from '@moonshot-ai/app-core/conversation';
import { useSideChat, type UseSideChatDeps } from '../src/client/useSideChat';
import { createConversationPool } from '../src/composables/useConversations';
import { sideChatDrafts } from '../src/client/sideChatDrafts';
import { modelsStore } from '../src/stores/models';
import { permissionsStore } from '../src/stores/permissions';
import { agentStatesStore } from '../src/stores/agentStates';
import type { ExtendedState } from '../src/client/types';
import { networkError } from './daemonErrors';

const apiMock = {
  getFileUrl: (id: string) => `/files/${id}`,
  getSessionMediaUrl: (sessionId: string, id: string) => `/sessions/${sessionId}/media/${id}`,
  startBtw: vi.fn(),
  submitPrompt: vi.fn(),
  updateSession: vi.fn(),
};
const api = apiMock as unknown as KimiWebApi;

function echoSubmit(input: PromptSubmission): PromptSubmitResult {
  return { promptId: input.promptId!, userMessageId: input.promptId! };
}

function sentPromptId(index: number): string {
  return (apiMock.submitPrompt.mock.calls[index]![1] as PromptSubmission).promptId!;
}

function deferSubmits(): () => void {
  let release!: () => void;
  apiMock.submitPrompt.mockImplementation((_sid: string, input: PromptSubmission) =>
    new Promise((resolve) => {
      release = () => resolve(echoSubmit(input));
    }));
  return () => release();
}

const AT = '2026-01-01T00:00:01.000Z';

function userItem(promptId: string, text: string, extra: Partial<UserMessageItem> = {}): ConversationItem {
  return {
    type: 'user_message',
    item_id: promptId,
    status: 'ended',
    outcome: 'completed',
    created_at: AT,
    placement: 'opener',
    prompt_ids: [promptId],
    origin: { kind: 'user' },
    text,
    attachments: [],
    skills: [],
    ...extra,
  };
}

function toolItem(id: string, extra: Partial<ToolCallItem> = {}): ConversationItem {
  return {
    type: 'tool_call',
    item_id: id,
    status: 'ended',
    outcome: 'completed',
    step_index: 1,
    created_at: AT,
    started_at: AT,
    name: 'Read',
    ...extra,
  };
}

function sideTurn(
  ordinal: number,
  promptId: string,
  text: string,
  extra: Partial<ConversationTurn> = {},
  items: ConversationItem[] = [],
): ConversationTurn {
  return {
    turn_id: `t${ordinal}`,
    ordinal,
    turn_number: ordinal + 1,
    kind: 'agent',
    status: 'ended',
    outcome: 'completed',
    started_at: AT,
    steps: [],
    ...extra,
    items: [userItem(promptId, text), ...items],
  };
}

const running = { status: 'running', outcome: undefined } as const;

function seedCatalog() {
  modelsStore().setModels([
    { id: 'kimi-code', provider: 'managed:kimi-code', model: 'kimi-code', maxContextSize: 0 },
  ]);
}

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
      },
    ],
    activeSessionId: 'sess_1',
    thinking: 'high',
    pendingThinkingBySession: {},
    planModeBySession: { sess_1: true },
    planArmedBySession: {},
    pendingPlanBySession: {},
    swarmModeBySession: {},
    pendingSwarmBySession: {},
  } as unknown as ExtendedState;
}

function createSideChat(
  state: ExtendedState = createState(),
  overrides: Partial<UseSideChatDeps> = {},
) {
  const connection = { subscribeConversation: vi.fn(), unsubscribeConversation: vi.fn() };
  const conversations = createConversationPool({
    api: () => api,
    connection: () => connection as unknown as KimiEventConnection,
    maxParked: 6,
    listener: {
      onChange: (entry) => sideChat.pruneEchoedMessages(entry.sessionId, entry.agentId),
    },
  });
  let optimisticId = 0;
  const pushOperationFailure = vi.fn();
  const sideChat = useSideChat(state, {
    api,
    conversations,
    pushOperationFailure,
    nextOptimisticMsgId: () => `msg_opt_${++optimisticId}`,
    resolveThinkingForPrompt: () => state.thinking,
    ...overrides,
  });
  function deliver(agentId: string, turns: ConversationTurn[], options: { running?: boolean; sessionId?: string } = {}): void {
    const sessionId = options.sessionId ?? 'sess_1';
    conversations.handleFrame(sessionId, agentId, { type: 'turns', turns, has_more: false });
    agentStatesStore().setState(sessionId, agentId, {
      status: options.running === true ? 'running' : 'idle',
      planMode: false,
      swarmMode: false,
      towerMode: false,
    });
  }
  function loaded(agentId: string, sessionId = 'sess_1'): void {
    if (conversations.getEntry(sessionId, agentId)?.loaded !== true) deliver(agentId, [], { sessionId });
  }
  return { state, sideChat, conversations, connection, pushOperationFailure, loaded, deliver };
}

function userTexts(turns: ReturnType<ReturnType<typeof useSideChat>['sideChatTurnsOf']>) {
  return turns.filter((turn) => turn.role === 'user').map((turn) => turn.text);
}

beforeEach(() => {
  agentStatesStore().resetAgentStates();
  apiMock.startBtw.mockReset();
  apiMock.submitPrompt.mockReset();
  apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_1' });
  apiMock.submitPrompt.mockImplementation(async (_sid: string, input: PromptSubmission) => echoSubmit(input));
  seedCatalog();
  permissionsStore().$reset();
});

describe('useSideChat — sendSideChatPromptOn', () => {
  it('carries model, thinking, permission and plan/swarm modes on the prompt', async () => {
    permissionsStore().pickInSession('sess_1', 'auto');
    const { sideChat, pushOperationFailure } = createSideChat();

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

  it('resolves thinking from the parent model, not the level of the session the user switched to', async () => {
    const state = createState();
    state.thinking = 'max';
    const { sideChat } = createSideChat(state, {
      resolveThinkingForPrompt: (_sid, id) => (id === 'kimi-code' ? 'low' : undefined),
    });

    await sideChat.openSideChatOn('sess_1', 'what changed?');

    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({ model: 'kimi-code', thinking: 'low' }),
    );
  });

  it('sends a rich initial prompt with its media and keeps the recoverable snapshot on the echo', async () => {
    apiMock.startBtw.mockResolvedValue({ agentId: 'rich-side' });
    const { sideChat } = createSideChat();
    const snapshot = { version: 1 as const, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Inspect image' }] }] }, attachments: [], attachmentOrder: [] };

    const outcome = await sideChat.openSideChatOn('sess_1', { text: 'Inspect image', snapshot, attachments: [{ kind: 'image', fileId: 'image-file', name: 'shot.png' }] });

    expect(outcome.sent).toBe(true);
    expect(apiMock.submitPrompt).toHaveBeenCalledWith('sess_1', expect.objectContaining({
      content: [{ type: 'text', text: 'Inspect image' }, { type: 'image', source: { kind: 'file', fileId: 'image-file' }, name: 'shot.png' }],
      metadata: expect.objectContaining({ kimi_code_composer: snapshot }),
    }));
    expect(userTexts(sideChat.sideChatTurnsOf('rich-side'))).toEqual(['Inspect image']);
  });

  it('cleans up the optimistic echo and sending flag when the send fails before the submit', async () => {
    const { sideChat } = createSideChat(createState(), {
      resolveThinkingForPrompt: () => {
        throw new TypeError('offline');
      },
    });
    await sideChat.openSideChatOn('sess_1');

    const sent = await sideChat.sendSideChatPrompt('repeat');

    expect(sent).toBe(false);
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(sideChat.sideChatTurnsOf('agent_btw_1')).toEqual([]);
    expect(sideChat.sideChatSendingOf('agent_btw_1')).toBe(false);
    expect(sideChat.sideChatRunningOf('agent_btw_1')).toBe(false);
  });

  it('reports not-sent on a network-ambiguous failure so the caller restores the draft', async () => {
    apiMock.submitPrompt.mockRejectedValueOnce(new TypeError('fetch failed'));
    const { sideChat } = createSideChat();
    await sideChat.openSideChatOn('sess_1');

    expect(await sideChat.sendSideChatPrompt('question')).toBe(false);
    expect(sideChat.sideChatTurnsOf('agent_btw_1')).toEqual([]);
  });

  it('resends a prompt that failed on the network with the same prompt id and keeps its echo', async () => {
    const { sideChat, pushOperationFailure } = createSideChat();
    await sideChat.openSideChatOn('sess_1');
    vi.useFakeTimers();
    try {
      apiMock.submitPrompt.mockRejectedValueOnce(networkError());

      const sent = sideChat.sendSideChatPrompt('question');
      await vi.advanceTimersByTimeAsync(2_000);

      expect(await sent).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(apiMock.submitPrompt).toHaveBeenCalledTimes(2);
    expect(sentPromptId(1)).toBe(sentPromptId(0));
    expect(userTexts(sideChat.sideChatTurnsOf('agent_btw_1'))).toEqual(['question']);
    expect(pushOperationFailure).not.toHaveBeenCalled();
  });

  it('drops the pending message and reports not-sent when the server fails the prompt before its turn', async () => {
    apiMock.submitPrompt.mockImplementationOnce(async (_sid: string, input: PromptSubmission) => ({
      ...echoSubmit(input),
      status: 'failed',
    }));
    const { sideChat, pushOperationFailure } = createSideChat();
    await sideChat.openSideChatOn('sess_1');

    expect(await sideChat.sendSideChatPrompt('question')).toBe(false);
    expect(sideChat.sideChatTurnsOf('agent_btw_1')).toEqual([]);
    expect(sideChat.sideChatRunningOf('agent_btw_1')).toBe(false);
    expect(pushOperationFailure).toHaveBeenCalledWith(
      'sendSideChatPrompt',
      expect.any(Error),
      expect.objectContaining({ sessionId: 'sess_1', message: 'warnings.promptFailedMessage' }),
    );
  });

  it('blocks the send before the optimistic echo when the gate rejects', async () => {
    const { sideChat } = createSideChat(createState(), {
      ensureSideChatReady: vi.fn(async () => 'pick-model' as const),
    });
    await sideChat.openSideChatOn('sess_1');

    const sent = await sideChat.sendSideChatPrompt('repeat');

    expect(sent).toBe(false);
    expect(apiMock.submitPrompt).not.toHaveBeenCalled();
    expect(sideChat.sideChatTurnsOf('agent_btw_1')).toEqual([]);
    expect(sideChat.sideChatSendingOf('agent_btw_1')).toBe(false);
  });

  it('submits the first prompt without waiting for the first conversation page', async () => {
    const { sideChat, conversations } = createSideChat();

    const opened = await sideChat.openSideChatOn('sess_1', 'first question');

    expect(opened.sent).toBe(true);
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(conversations.getEntry('sess_1', 'agent_btw_1')?.loaded).toBe(false);
  });
});

describe('useSideChat — transcript rendering', () => {
  it('shows the optimistic echo until the turn its prompt triggered lands in the transcript', async () => {
    const resolveSubmit = deferSubmits();
    const { sideChat, loaded, deliver } = createSideChat();
    await sideChat.openSideChatOn('sess_1');
    loaded('agent_btw_1');

    const sending = sideChat.sendSideChatPrompt('what changed?');
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());
    expect(sideChat.sideChatSendingOf('agent_btw_1')).toBe(true);
    expect(sideChat.sideChatRunningOf('agent_btw_1')).toBe(true);
    expect(userTexts(sideChat.sideChatTurnsOf('agent_btw_1'))).toEqual(['what changed?']);

    resolveSubmit();
    await sending;
    expect(sideChat.sideChatSendingOf('agent_btw_1')).toBe(false);
    expect(sideChat.sideChatRunningOf('agent_btw_1')).toBe(true);

    const promptId = sentPromptId(0);
    deliver('agent_btw_1', [sideTurn(0, promptId, 'what changed?', running)], { running: true });
    expect(userTexts(sideChat.sideChatTurnsOf('agent_btw_1'))).toEqual(['what changed?']);
    expect(sideChat.sideChatRunningOf('agent_btw_1')).toBe(true);

    deliver('agent_btw_1', [
      sideTurn(0, promptId, 'what changed?', {}, [
        { type: 'assistant_message', item_id: 's1:0', status: 'ended', outcome: 'completed', step_index: 1, created_at: AT, text: 'Nothing much.' },
      ]),
    ]);
    const turns = sideChat.sideChatTurnsOf('agent_btw_1');
    expect(userTexts(turns)).toEqual(['what changed?']);
    expect(turns.find((turn) => turn.role === 'assistant')?.text).toBe('Nothing much.');
    expect(sideChat.sideChatRunningOf('agent_btw_1')).toBe(false);

    deliver('agent_btw_1', [sideTurn(1, 'pr_later', 'later question')]);
    expect(userTexts(sideChat.sideChatTurnsOf('agent_btw_1'))).toEqual(['later question']);
    expect(sideChat.sideChatRunningOf('agent_btw_1')).toBe(false);
  });

  it('keeps consecutive equal-text submissions separate', async () => {
    const { sideChat, loaded, deliver } = createSideChat();
    await sideChat.openSideChatOn('sess_1');
    loaded('agent_btw_1');

    await sideChat.sendSideChatPrompt('repeat');
    await sideChat.sendSideChatPrompt('repeat');
    expect(userTexts(sideChat.sideChatTurnsOf('agent_btw_1'))).toEqual(['repeat', 'repeat']);

    deliver('agent_btw_1', [sideTurn(0, sentPromptId(0), 'repeat', running)], { running: true });
    expect(userTexts(sideChat.sideChatTurnsOf('agent_btw_1'))).toEqual(['repeat', 'repeat']);

    deliver('agent_btw_1', [sideTurn(0, sentPromptId(0), 'repeat'), sideTurn(1, sentPromptId(1), 'repeat')]);
    expect(userTexts(sideChat.sideChatTurnsOf('agent_btw_1'))).toEqual(['repeat', 'repeat']);
    expect(sideChat.sideChatRunningOf('agent_btw_1')).toBe(false);
  });

  it('reads the turn error from a failed transcript turn and hides it while a new prompt runs', async () => {
    const { sideChat, loaded, deliver } = createSideChat();
    await sideChat.openSideChatOn('sess_1');
    loaded('agent_btw_1');

    deliver('agent_btw_1', [
      sideTurn(0, 'pr_0', 'q', {
        outcome: 'failed',
        error: { code: 'quota_exhausted', message: 'exceeded your current quota', status_code: 429, request_id: 'req-1' },
      }),
    ]);
    expect(sideChat.sideChatTurnErrorOf('agent_btw_1')).toEqual(
      expect.objectContaining({ code: 'quota_exhausted', message: 'exceeded your current quota', statusCode: 429, requestId: 'req-1' }),
    );

    await sideChat.sendSideChatPrompt('again');
    expect(sideChat.sideChatTurnErrorOf('agent_btw_1')).toBeNull();
  });

  it('keeps a steer echo until its user frame is projected into the running turn', async () => {
    const { sideChat, loaded, deliver } = createSideChat();
    await sideChat.openSideChatOn('sess_1');
    loaded('agent_btw_1');
    const first = sideTurn(0, 'pr_0', 'first', running);
    deliver('agent_btw_1', [first], { running: true });

    await sideChat.sendSideChatPrompt('steer this');
    deliver('agent_btw_1', [first], { running: true });
    expect(userTexts(sideChat.sideChatTurnsOf('agent_btw_1'))).toEqual(['first', 'steer this']);

    deliver('agent_btw_1', [{
      ...first,
      items: [...first.items, userItem(sentPromptId(0), 'steer this', { placement: 'steer' })],
    }], { running: true });
    expect(userTexts(sideChat.sideChatTurnsOf('agent_btw_1'))).toEqual(['first', 'steer this']);
  });

  it('renders tool calls from the transcript frames', async () => {
    const { sideChat, loaded, deliver } = createSideChat();
    await sideChat.openSideChatOn('sess_1');
    loaded('agent_btw_1');

    deliver('agent_btw_1', [
      sideTurn(0, 'pr_1', 'q?', {}, [
        toolItem('tc_1', { input: { path: 'src/a.ts' }, output: 'file body' }),
        toolItem('tc_2', { name: 'Bash', input: { command: 'false' }, outcome: 'failed', error: 'exit 1' }),
      ]),
    ]);

    const assistant = sideChat.sideChatTurnsOf('agent_btw_1').find((turn) => turn.role === 'assistant');
    expect(assistant?.tools?.map((tool) => [tool.id, tool.status])).toEqual([
      ['tc_1', 'ok'],
      ['tc_2', 'error'],
    ]);
  });

  it('preserves rich user metadata from the transcript', async () => {
    const clientMetadata = { display_text: 'Save button', kimi_code_composer: { version: 1, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Save button' }] }] }, attachments: [], attachmentOrder: [] } };
    apiMock.startBtw.mockResolvedValue({ agentId: 'restored-side' });
    const { sideChat, deliver } = createSideChat();
    await sideChat.openSideChatOn('sess_1');
    deliver('restored-side', [{
      ...sideTurn(0, 'pr_1', ''),
      items: [userItem('pr_1', 'Captured page evidence', { metadata: clientMetadata })],
    }]);

    expect(sideChat.sideChatTurnsOf('restored-side').find((turn) => turn.role === 'user')?.clientMetadata).toEqual([clientMetadata]);
  });

  it('resolves session-scoped image and video URLs from the transcript', async () => {
    apiMock.startBtw.mockResolvedValue({ agentId: 'media-side' });
    const { sideChat, deliver } = createSideChat();
    await sideChat.openSideChatOn('sess_1');
    deliver('media-side', [{
      ...sideTurn(0, 'pr_1', ''),
      items: [userItem('pr_1', 'Inspect media', {
        attachments: [
          { kind: 'image', file_id: 'image-file', name: 'capture.png', ordinal: 1 },
          { kind: 'video', file_id: 'video-file', name: 'clip.mp4', ordinal: 2 },
        ],
      })],
    }]);

    const turn = sideChat.sideChatTurnsOf('media-side').find((item) => item.role === 'user');
    expect(turn?.attachments?.map((attachment) => attachment.url)).toEqual(['/sessions/sess_1/media/image-file', '/sessions/sess_1/media/video-file']);
  });
});

describe('useSideChat — fork boundary', () => {
  const forkBoundary: ConversationTurn = {
    turn_id: 't_fork',
    ordinal: 0,
    kind: 'system',
    status: 'ended',
    outcome: 'completed',
    started_at: AT,
    steps: [],
    items: [{
      type: 'system',
      kind: 'fork_boundary',
      item_id: 't_fork#0',
      status: 'ended',
      outcome: 'completed',
      created_at: AT,
      source: 'btw',
      forked_from: { agent_id: 'main' },
    }],
  };

  it('shows every turn after the boundary and nothing for the boundary itself', async () => {
    const { sideChat, deliver } = createSideChat();
    await sideChat.openSideChatOn('sess_1');
    deliver('agent_btw_1', [
      forkBoundary,
      sideTurn(1, 'pr_1', 'side question', {}, [
        { type: 'assistant_message', item_id: 'a1', status: 'ended', outcome: 'completed', step_index: 1, created_at: AT, text: 'side answer' },
      ]),
      sideTurn(2, 'pr_2', 'follow-up'),
    ]);

    expect(sideChat.sideChatTurnsOf('agent_btw_1').map((turn) => [turn.role, turn.text])).toEqual([
      ['user', 'side question'],
      ['assistant', 'side answer'],
      ['user', 'follow-up'],
    ]);
  });
});

describe('useSideChat — transcript subscription', () => {
  it('subscribes each fork to its own agent transcript and releases it on close', async () => {
    apiMock.startBtw
      .mockResolvedValueOnce({ agentId: 'agent_btw_1' })
      .mockResolvedValueOnce({ agentId: 'agent_btw_2' });
    const { sideChat, conversations, connection } = createSideChat();
    await sideChat.openSideChatOn('sess_1');
    await sideChat.openSideChatOn('sess_1');

    expect(connection.subscribeConversation).toHaveBeenCalledWith('sess_1', 'agent_btw_1');
    expect(connection.subscribeConversation).toHaveBeenCalledWith('sess_1', 'agent_btw_2');
    expect(conversations.entriesOf('sess_1').map((entry) => entry.agentId)).toEqual(['agent_btw_1', 'agent_btw_2']);

    sideChat.closeSideChat('agent_btw_1');

    expect(connection.unsubscribeConversation).toHaveBeenCalledWith('sess_1', ['agent_btw_1']);
    expect(conversations.entriesOf('sess_1').map((entry) => entry.agentId)).toEqual(['agent_btw_2']);
  });

  it('releases a closed fork at once even while its turn runs and an interaction is pending', async () => {
    const onSideChatClosed = vi.fn();
    const { sideChat, conversations, connection, deliver } = createSideChat(
      undefined,
      { onSideChatClosed },
    );
    await sideChat.openSideChatOn('sess_1', 'q?');
    deliver('agent_btw_1', [
      sideTurn(0, 'pr_1', 'q?', running, [toolItem('tc_1', {
        status: 'running',
        outcome: undefined,
        name: 'Bash',
        input: { command: 'rm -rf build' },
        stage: 'awaiting_approval',
        interaction_id: 'ix_1',
      })]),
    ], { running: true });

    sideChat.closeSideChat('agent_btw_1');

    expect(connection.unsubscribeConversation).toHaveBeenCalledWith('sess_1', ['agent_btw_1']);
    expect(conversations.getEntry('sess_1', 'agent_btw_1')).toBeUndefined();
    expect(onSideChatClosed).toHaveBeenCalledWith('sess_1', 'agent_btw_1');
  });

  it('restoring a target subscribes its conversation once', async () => {
    const { sideChat, connection } = createSideChat();

    sideChat.restoreSideChatTarget('sess_1', { agentId: 'restored', seq: 1 });
    sideChat.restoreSideChatTarget('sess_1', { agentId: 'restored', seq: 1 });

    expect(connection.subscribeConversation).toHaveBeenCalledOnce();
    expect(connection.subscribeConversation).toHaveBeenCalledWith('sess_1', 'restored');
    expect(sideChat.sideChatTargetsOfSession('sess_1')).toEqual([{ agentId: 'restored', seq: 1 }]);
  });

  it('late transcript frames for a closed fork cannot resurrect it', async () => {
    const { sideChat, conversations, deliver } = createSideChat();
    await sideChat.openSideChatOn('sess_1', 'q?');
    expect(sideChat.sideChatTurnsOf('agent_btw_1')).toHaveLength(1);

    sideChat.closeSideChat('agent_btw_1');
    deliver('agent_btw_1', [sideTurn(0, 'pr_1', 'q?')]);

    expect(conversations.getEntry('sess_1', 'agent_btw_1')).toBeUndefined();
    expect(sideChat.sideChatTurnsOf('agent_btw_1')).toEqual([]);
    expect(sideChat.sideChatRunningOf('agent_btw_1')).toBe(false);
  });
});

describe('useSideChat — multiple targets per session', () => {
  it('every open forks a fresh target with a monotonic seq; closing the middle one never renumbers', async () => {
    apiMock.startBtw
      .mockResolvedValueOnce({ agentId: 'agent_btw_1' })
      .mockResolvedValueOnce({ agentId: 'agent_btw_2' })
      .mockResolvedValueOnce({ agentId: 'agent_btw_3' })
      .mockResolvedValueOnce({ agentId: 'agent_btw_4' });
    const { sideChat } = createSideChat();

    await sideChat.openSideChatOn('sess_1');
    await sideChat.openSideChatOn('sess_1');
    await sideChat.openSideChatOn('sess_1');
    expect(sideChat.sideChatTargetsOfSession('sess_1')).toEqual([
      { agentId: 'agent_btw_1', seq: 1 },
      { agentId: 'agent_btw_2', seq: 2 },
      { agentId: 'agent_btw_3', seq: 3 },
    ]);
    expect(apiMock.startBtw).toHaveBeenCalledTimes(3);

    sideChat.closeSideChat('agent_btw_2');
    expect(sideChat.sideChatTargetsOfSession('sess_1')).toEqual([
      { agentId: 'agent_btw_1', seq: 1 },
      { agentId: 'agent_btw_3', seq: 3 },
    ]);

    await sideChat.openSideChatOn('sess_1');
    expect(sideChat.sideChatTargetsOfSession('sess_1').at(-1)).toEqual({
      agentId: 'agent_btw_4',
      seq: 4,
    });
  });

  it('COMPAT openSideChat reuses the live fork instead of piling up new ones', async () => {
    const { sideChat } = createSideChat();

    expect(await sideChat.openSideChat()).toBe(true);
    expect(apiMock.startBtw).toHaveBeenCalledTimes(1);

    expect(await sideChat.openSideChat()).toBe(true);
    expect(apiMock.startBtw).toHaveBeenCalledTimes(1);
    expect(sideChat.sideChatTargetsOfSession('sess_1')).toHaveLength(1);

    expect(await sideChat.openSideChat('follow-up')).toBe(true);
    expect(apiMock.startBtw).toHaveBeenCalledTimes(1);
    expect(apiMock.submitPrompt).toHaveBeenCalledWith(
      'sess_1',
      expect.objectContaining({ agentId: 'agent_btw_1' }),
    );
  });

  it('parameterized reads resolve per fork agent id', async () => {
    apiMock.startBtw
      .mockResolvedValueOnce({ agentId: 'agent_btw_1' })
      .mockResolvedValueOnce({ agentId: 'agent_btw_2' });
    const { sideChat, loaded, deliver } = createSideChat();
    await sideChat.openSideChatOn('sess_1');
    await sideChat.openSideChatOn('sess_1');
    loaded('agent_btw_1');
    loaded('agent_btw_2');

    deliver('agent_btw_1', [sideTurn(0, 'pr_a', 'question one')]);
    deliver('agent_btw_2', [sideTurn(0, 'pr_b', 'question two', running)], { running: true });

    expect(userTexts(sideChat.sideChatTurnsOf('agent_btw_1'))).toEqual(['question one']);
    expect(userTexts(sideChat.sideChatTurnsOf('agent_btw_2'))).toEqual(['question two']);
    expect(sideChat.sideChatRunningOf('agent_btw_1')).toBe(false);
    expect(sideChat.sideChatRunningOf('agent_btw_2')).toBe(true);
  });

  it('clearSideChatForSession drops the whole list and rewinds the seq counter', async () => {
    apiMock.startBtw
      .mockResolvedValueOnce({ agentId: 'agent_btw_1' })
      .mockResolvedValueOnce({ agentId: 'agent_btw_2' })
      .mockResolvedValueOnce({ agentId: 'agent_btw_3' });
    const { sideChat, conversations } = createSideChat();
    await sideChat.openSideChatOn('sess_1');
    await sideChat.openSideChatOn('sess_1');

    sideChat.clearSideChatForSession('sess_1');
    expect(sideChat.sideChatTargetsOfSession('sess_1')).toEqual([]);
    expect(conversations.entriesOf('sess_1')).toEqual([]);

    await sideChat.openSideChatOn('sess_1');
    expect(sideChat.sideChatTargetsOfSession('sess_1')).toEqual([
      { agentId: 'agent_btw_3', seq: 1 },
    ]);
  });

  it('closing a fork drops its unsent draft; closing the session drops them all', async () => {
    apiMock.startBtw
      .mockResolvedValueOnce({ agentId: 'agent_btw_1' })
      .mockResolvedValueOnce({ agentId: 'agent_btw_2' });
    const { sideChat } = createSideChat();
    await sideChat.openSideChatOn('sess_1');
    await sideChat.openSideChatOn('sess_1');
    sideChatDrafts.set('agent_btw_1', 'unsent one');
    sideChatDrafts.set('agent_btw_2', 'unsent two');

    sideChat.closeSideChat('agent_btw_1');
    expect(sideChatDrafts.has('agent_btw_1')).toBe(false);
    expect(sideChatDrafts.get('agent_btw_2')).toBe('unsent two');

    sideChat.clearSideChatForSession('sess_1');
    expect(sideChatDrafts.has('agent_btw_2')).toBe(false);
  });

  it('rewinds the seq counter on clear even when the forks were closed first', async () => {
    apiMock.startBtw
      .mockResolvedValueOnce({ agentId: 'agent_btw_1' })
      .mockResolvedValueOnce({ agentId: 'agent_btw_2' });
    const { sideChat } = createSideChat();
    await sideChat.openSideChatOn('sess_1');
    sideChat.closeSideChat('agent_btw_1');
    expect(sideChat.sideChatTargetsOfSession('sess_1')).toEqual([]);

    sideChat.clearSideChatForSession('sess_1');

    await sideChat.openSideChatOn('sess_1');
    expect(sideChat.sideChatTargetsOfSession('sess_1')).toEqual([
      { agentId: 'agent_btw_2', seq: 1 },
    ]);
  });

  it('COMPAT exports track the most recent fork and the no-arg close clears the session', async () => {
    apiMock.startBtw
      .mockResolvedValueOnce({ agentId: 'agent_btw_1' })
      .mockResolvedValueOnce({ agentId: 'agent_btw_2' });
    const { sideChat, conversations, loaded, deliver } = createSideChat();

    expect(sideChat.sideChatVisible.value).toBe(false);
    await sideChat.openSideChatOn('sess_1');
    await sideChat.openSideChatOn('sess_1');
    loaded('agent_btw_2');
    expect(sideChat.sideChatVisible.value).toBe(true);

    deliver('agent_btw_2', [sideTurn(0, 'pr_1', 'new fork')]);
    expect(userTexts(sideChat.sideChatTurns.value)).toEqual(['new fork']);

    sideChat.closeSideChat();
    expect(sideChat.sideChatTargetsOfSession('sess_1')).toEqual([]);
    expect(sideChat.sideChatVisible.value).toBe(false);
    expect(conversations.entriesOf('sess_1')).toEqual([]);
  });

  it('marks closed forks so their task rows stay hidden until the session is cleared', async () => {
    const { sideChat } = createSideChat();
    await sideChat.openSideChatOn('sess_1');

    sideChat.closeSideChat('agent_btw_1');
    expect(sideChat.isClosedSideChatAgent('sess_1', 'agent_btw_1')).toBe(true);

    sideChat.clearSideChatForSession('sess_1');
    expect(sideChat.isClosedSideChatAgent('sess_1', 'agent_btw_1')).toBe(false);
  });
});

describe('useSideChat — session teardown', () => {
  it('evicts the targets, echoes and transcripts of the dead session', async () => {
    const { sideChat, conversations } = createSideChat();
    await sideChat.openSideChatOn('sess_1', 'what changed?');
    expect(sideChat.sideChatTurns.value).toHaveLength(1);

    sideChat.clearSideChatForSession('sess_1');

    expect(sideChat.sideChatTargetBySession.value.sess_1).toBeUndefined();
    expect(conversations.getEntry('sess_1', 'agent_btw_1')).toBeUndefined();
    expect(sideChat.sideChatVisible.value).toBe(false);
    expect(sideChat.sideChatTurns.value).toEqual([]);
    expect(sideChat.sideChatRunningOf('agent_btw_1')).toBe(false);
  });

  it('keeps other sessions’ side-chat state intact', async () => {
    apiMock.startBtw.mockImplementation(async (parent: string) => ({
      agentId: parent === 'sess_1' ? 'agent_btw_1' : 'agent_btw_2',
    }));
    const state = createState();
    state.sessions.push({ ...state.sessions[0]!, id: 'sess_2' });
    const { sideChat, conversations } = createSideChat(state);
    await sideChat.openSideChatOn('sess_1');
    await sideChat.openSideChatOn('sess_2', 'keep me');

    sideChat.clearSideChatForSession('sess_1');

    expect(conversations.getEntry('sess_1', 'agent_btw_1')).toBeUndefined();
    expect(sideChat.sideChatTargetsOfSession('sess_2')).toEqual([
      { agentId: 'agent_btw_2', seq: 1 },
    ]);
    expect(userTexts(sideChat.sideChatTurnsOf('agent_btw_2'))).toEqual(['keep me']);
  });

  it('isolates same-numbered side agents by the active session', async () => {
    const state = createState();
    state.sessions.push({ ...state.sessions[0]!, id: 'sess_2' });
    state.activeSessionId = 'sess_2';
    const { sideChat, loaded, deliver } = createSideChat(state);
    await sideChat.openSideChatOn('sess_1');
    loaded('agent_btw_1', 'sess_1');
    await sideChat.openSideChatOn('sess_2');
    loaded('agent_btw_1', 'sess_2');

    deliver('agent_btw_1', [
      sideTurn(0, 'pr_1', 'second session question', {}, [
        { type: 'assistant_message', item_id: 's1:0', status: 'ended', outcome: 'completed', step_index: 1, created_at: AT, text: 'second session answer' },
      ]),
    ], { sessionId: 'sess_2' });

    expect(sideChat.sideChatTurnsOf('agent_btw_1').map((turn) => [turn.role, turn.text])).toEqual([
      ['user', 'second session question'],
      ['assistant', 'second session answer'],
    ]);

    state.activeSessionId = 'sess_1';
    deliver('agent_btw_1', [
      sideTurn(0, 'pr_1', 'first session question', {}, [
        { type: 'assistant_message', item_id: 's1:0', status: 'ended', outcome: 'completed', step_index: 1, created_at: AT, text: 'first session answer' },
      ]),
    ], { sessionId: 'sess_1' });

    expect(sideChat.sideChatTurnsOf('agent_btw_1').map((turn) => [turn.role, turn.text])).toEqual([
      ['user', 'first session question'],
      ['assistant', 'first session answer'],
    ]);
  });

  it('keeps a late submit success scoped to its parent session', async () => {
    const resolveSubmit = deferSubmits();
    const state = createState();
    state.sessions.push({ ...state.sessions[0]!, id: 'sess_2' });
    const { sideChat, loaded, deliver } = createSideChat(state);
    const opening = sideChat.openSideChatOn('sess_1', 'pending in first session');
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());
    expect(sideChat.sideChatSendingOf('agent_btw_1')).toBe(true);

    state.activeSessionId = 'sess_2';
    await sideChat.openSideChatOn('sess_2');
    loaded('agent_btw_1', 'sess_2');
    expect(sideChat.sideChatSendingOf('agent_btw_1')).toBe(false);
    expect(sideChat.sideChatTurnsOf('agent_btw_1')).toEqual([]);

    resolveSubmit();
    await opening;
    expect(sideChat.sideChatTurnsOf('agent_btw_1')).toEqual([]);

    state.activeSessionId = 'sess_1';
    deliver('agent_btw_1', [sideTurn(0, sentPromptId(0), 'pending in first session')]);
    await vi.waitFor(() => expect(sideChat.sideChatRunningOf('agent_btw_1')).toBe(false));
    expect(userTexts(sideChat.sideChatTurnsOf('agent_btw_1'))).toEqual(['pending in first session']);
  });

  it('removes a late submit failure from its original session only', async () => {
    let rejectSubmit!: (err: unknown) => void;
    apiMock.submitPrompt.mockImplementation(
      () => new Promise<never>((_resolve, reject) => { rejectSubmit = reject; }),
    );
    const state = createState();
    state.sessions.push({ ...state.sessions[0]!, id: 'sess_2' });
    const { sideChat, loaded } = createSideChat(state);
    const opening = sideChat.openSideChatOn('sess_1', 'pending in first session');
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());

    state.activeSessionId = 'sess_2';
    await sideChat.openSideChatOn('sess_2');
    loaded('agent_btw_1', 'sess_2');
    rejectSubmit(new TypeError('offline'));
    await expect(opening).resolves.toEqual({ target: { agentId: 'agent_btw_1', seq: 1 }, sent: false });
    expect(sideChat.sideChatTurnsOf('agent_btw_1')).toEqual([]);

    state.activeSessionId = 'sess_1';
    expect(sideChat.sideChatTurnsOf('agent_btw_1')).toEqual([]);
    expect(sideChat.sideChatSendingOf('agent_btw_1')).toBe(false);
  });

  it('is a no-op for a session without a side chat target', () => {
    const { sideChat } = createSideChat();
    sideChat.clearSideChatForSession('sess_1');
    expect(sideChat.sideChatTargetBySession.value).toEqual({});
  });

  it('returns a null target when the session dies mid-first-prompt', async () => {
    const resolveSubmit = deferSubmits();
    const { sideChat } = createSideChat();

    const opening = sideChat.openSideChatOn('sess_1', 'first question');
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());
    sideChat.clearSideChatForSession('sess_1');
    resolveSubmit();

    const result = await opening;
    expect(result.target).toBeNull();
    expect(result.sent).toBe(true);
    expect(sideChat.sideChatTargetsOfSession('sess_1')).toEqual([]);
  });

  it('does not resurrect the echo when the submit succeeds after the session died', async () => {
    const resolveSubmit = deferSubmits();
    const { sideChat } = createSideChat();
    await sideChat.openSideChatOn('sess_1');
    const pending = sideChat.sendSideChatPrompt('q');
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());

    sideChat.clearSideChatForSession('sess_1');
    resolveSubmit();
    await pending;

    sideChat.restoreSideChatTarget('sess_1', { agentId: 'agent_btw_1', seq: 1 });
    expect(sideChat.sideChatTurnsOf('agent_btw_1')).toEqual([]);
    expect(sideChat.sideChatSendingOf('agent_btw_1')).toBe(false);
  });

  it('does not resurrect the echo when the submit fails after the session died', async () => {
    let rejectSubmit!: (err: unknown) => void;
    apiMock.submitPrompt.mockImplementation(
      () => new Promise<never>((_resolve, reject) => { rejectSubmit = reject; }),
    );
    const { sideChat } = createSideChat();
    await sideChat.openSideChatOn('sess_1');
    const pending = sideChat.sendSideChatPrompt('q');
    await vi.waitFor(() => expect(apiMock.submitPrompt).toHaveBeenCalledOnce());

    sideChat.clearSideChatForSession('sess_1');
    rejectSubmit(new TypeError('offline'));
    await pending;

    sideChat.restoreSideChatTarget('sess_1', { agentId: 'agent_btw_1', seq: 1 });
    expect(sideChat.sideChatTurnsOf('agent_btw_1')).toEqual([]);
    expect(sideChat.sideChatSendingOf('agent_btw_1')).toBe(false);
  });
});

describe('useSideChat — concurrent first opens (multi-fork)', () => {
  it('two opens landing before the first startBtw returns fork TWO fresh agents', async () => {
    const resolveStarts: Array<(value: { agentId: string }) => void> = [];
    apiMock.startBtw.mockImplementation(
      () => new Promise<{ agentId: string }>((resolve) => { resolveStarts.push(resolve); }),
    );
    const { sideChat } = createSideChat();

    const first = sideChat.openSideChatOn('sess_1');
    const second = sideChat.openSideChatOn('sess_1');
    expect(apiMock.startBtw).toHaveBeenCalledTimes(2);
    resolveStarts[0]!({ agentId: 'agent_btw_1' });
    resolveStarts[1]!({ agentId: 'agent_btw_2' });
    await expect(first).resolves.toEqual({ target: { agentId: 'agent_btw_1', seq: 1 }, sent: true });
    await expect(second).resolves.toEqual({ target: { agentId: 'agent_btw_2', seq: 2 }, sent: true });

    expect(sideChat.sideChatTargetsOfSession('sess_1')).toEqual([
      { agentId: 'agent_btw_1', seq: 1 },
      { agentId: 'agent_btw_2', seq: 2 },
    ]);
  });

  it('each open sends its own initial prompt on its own fork', async () => {
    apiMock.startBtw
      .mockResolvedValueOnce({ agentId: 'agent_btw_1' })
      .mockResolvedValueOnce({ agentId: 'agent_btw_2' });
    const { sideChat } = createSideChat();

    const first = sideChat.openSideChatOn('sess_1', 'q1');
    const second = sideChat.openSideChatOn('sess_1', 'q2');
    await expect(first).resolves.toEqual({ target: { agentId: 'agent_btw_1', seq: 1 }, sent: true });
    await expect(second).resolves.toEqual({ target: { agentId: 'agent_btw_2', seq: 2 }, sent: true });

    expect(apiMock.submitPrompt).toHaveBeenCalledTimes(2);
    expect(apiMock.submitPrompt).toHaveBeenCalledWith('sess_1', expect.objectContaining({ agentId: 'agent_btw_1' }));
    expect(apiMock.submitPrompt).toHaveBeenCalledWith('sess_1', expect.objectContaining({ agentId: 'agent_btw_2' }));
  });

  it('a failed first send does not eat a concurrent caller’s own prompt', async () => {
    apiMock.startBtw
      .mockResolvedValueOnce({ agentId: 'agent_btw_1' })
      .mockResolvedValueOnce({ agentId: 'agent_btw_2' });
    const resolveThinkingForPrompt = vi
      .fn<() => undefined>()
      .mockImplementationOnce(() => {
        throw new TypeError('offline');
      })
      .mockReturnValue(undefined);
    const { sideChat } = createSideChat(createState(), { resolveThinkingForPrompt });

    const first = sideChat.openSideChatOn('sess_1', 'q1');
    const second = sideChat.openSideChatOn('sess_1', 'q2');

    await expect(first).resolves.toEqual({ target: { agentId: 'agent_btw_1', seq: 1 }, sent: false });
    await expect(second).resolves.toEqual({ target: { agentId: 'agent_btw_2', seq: 2 }, sent: true });
    expect(apiMock.submitPrompt).toHaveBeenCalledOnce();
    expect(apiMock.submitPrompt).toHaveBeenCalledWith('sess_1', expect.objectContaining({ agentId: 'agent_btw_2' }));
  });
});

describe('useSideChat — persisted whole draft (per-session)', () => {
  it('saves and loads a draft per session, isolated across sessions', () => {
    const { sideChat } = createSideChat();
    sideChat.saveSideChatDraft('sess_1', '> 引用\n\n评论');
    sideChat.saveSideChatDraft('sess_2', '其他草稿');

    expect(sideChat.sideChatDraft('sess_1')).toBe('> 引用\n\n评论');
    expect(sideChat.sideChatDraft('sess_2')).toBe('其他草稿');
    expect(sideChat.sideChatDraft('sess_unknown')).toBe('');
  });

  it('re-saving overwrites; an empty draft evicts the key', () => {
    const { sideChat } = createSideChat();
    sideChat.saveSideChatDraft('sess_1', 'v1');
    sideChat.saveSideChatDraft('sess_1', 'v2');
    expect(sideChat.sideChatDraft('sess_1')).toBe('v2');

    sideChat.saveSideChatDraft('sess_1', '');
    expect(sideChat.sideChatDraft('sess_1')).toBe('');
    sideChat.saveSideChatDraft('sess_1', '');
    expect(sideChat.sideChatDraft('sess_1')).toBe('');
  });

  it('clearSideChatForSession evicts the persisted draft (target or not)', () => {
    const { sideChat } = createSideChat();
    sideChat.saveSideChatDraft('sess_1', '> 引用\n\n');
    sideChat.saveSideChatDraft('sess_2', '其他草稿');

    sideChat.clearSideChatForSession('sess_1');

    expect(sideChat.sideChatDraft('sess_1')).toBe('');
    expect(sideChat.sideChatDraft('sess_2')).toBe('其他草稿');
  });

  it('clearSideChatDraftIfUnchanged clears only an unchanged draft (post-send cleanup)', () => {
    const { sideChat } = createSideChat();
    sideChat.saveSideChatDraft('sess_1', '> 引用\n\n评论');
    sideChat.saveSideChatDraft('sess_1', '> 引用\n\n评论 + 新内容');
    sideChat.clearSideChatDraftIfUnchanged('sess_1', '> 引用\n\n评论');
    expect(sideChat.sideChatDraft('sess_1')).toBe('> 引用\n\n评论 + 新内容');
    sideChat.clearSideChatDraftIfUnchanged('sess_1', '> 引用\n\n评论 + 新内容');
    expect(sideChat.sideChatDraft('sess_1')).toBe('');
  });

  it('clearSideChatDraftIfUnchanged never touches another session with identical text', () => {
    const { sideChat } = createSideChat();
    sideChat.saveSideChatDraft('sess_1', 'same');
    sideChat.saveSideChatDraft('sess_2', 'same');
    sideChat.clearSideChatDraftIfUnchanged('sess_1', 'same');
    expect(sideChat.sideChatDraft('sess_1')).toBe('');
    expect(sideChat.sideChatDraft('sess_2')).toBe('same');
  });
});

describe('useSideChat — session dies mid-create (generation tombstone)', () => {
  it('an in-flight startBtw writes NOTHING back after the session was cleared', async () => {
    let resolveStart!: (value: { agentId: string }) => void;
    apiMock.startBtw.mockImplementation(
      () => new Promise<{ agentId: string }>((resolve) => { resolveStart = resolve; }),
    );
    const { sideChat, conversations } = createSideChat();

    const pending = sideChat.openSideChatOn('sess_1');
    sideChat.clearSideChatForSession('sess_1');
    resolveStart({ agentId: 'agent_btw_1' });

    await expect(pending).resolves.toEqual({ target: null, sent: false });
    expect(sideChat.sideChatTargetBySession.value['sess_1']).toBeUndefined();
    expect(conversations.getEntry('sess_1', 'agent_btw_1')).toBeUndefined();
  });

  it('a FRESH open after the clear (e.g. restored session) captures the bumped generation and works', async () => {
    apiMock.startBtw.mockResolvedValue({ agentId: 'agent_btw_2' });
    const { sideChat } = createSideChat();

    sideChat.clearSideChatForSession('sess_1');
    await expect(sideChat.openSideChatOn('sess_1')).resolves.toEqual({
      target: { agentId: 'agent_btw_2', seq: 1 },
      sent: true,
    });

    expect(sideChat.sideChatTargetBySession.value['sess_1']).toEqual([{ agentId: 'agent_btw_2', seq: 1 }]);
  });

  it('the stale in-flight open never blocks the fresh one (fresh slot after clear)', async () => {
    let resolveFirst!: (value: { agentId: string }) => void;
    apiMock.startBtw
      .mockImplementationOnce(
        () => new Promise<{ agentId: string }>((resolve) => { resolveFirst = resolve; }),
      )
      .mockResolvedValueOnce({ agentId: 'agent_btw_2' });
    const { sideChat, conversations } = createSideChat();

    const first = sideChat.openSideChatOn('sess_1');
    sideChat.clearSideChatForSession('sess_1');
    const second = sideChat.openSideChatOn('sess_1');
    resolveFirst({ agentId: 'agent_btw_1' });

    await expect(first).resolves.toEqual({ target: null, sent: false });
    await expect(second).resolves.toEqual({ target: { agentId: 'agent_btw_2', seq: 1 }, sent: true });
    expect(apiMock.startBtw).toHaveBeenCalledTimes(2);
    expect(sideChat.sideChatTargetBySession.value['sess_1']).toEqual([{ agentId: 'agent_btw_2', seq: 1 }]);
    expect(conversations.getEntry('sess_1', 'agent_btw_1')).toBeUndefined();
  });
});
