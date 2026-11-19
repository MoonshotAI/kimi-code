import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppAgentState,
  AppEvent,
  AppSession,
  KimiEventConnection,
  KimiEventHandlers,
  KimiWebApi,
  PromptSubmission,
  PromptSubmitResult,
} from '@moonshot-ai/app-core/api';
import type {
  ConversationFrame,
  ConversationOutcome,
  ConversationTurn,
  ConversationTurnHeader,
  UserMessageItem,
} from '@moonshot-ai/app-core/conversation';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { agentState } from './agentFrames';
import { networkError } from './daemonErrors';

const clientApiMock: Record<string, unknown> = {};

const AT = '2026-01-01T00:00:00.000Z';

function opener(promptId: string, text: string): UserMessageItem {
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
  };
}

function endedTurn(ordinal: number, extra: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    turn_id: `t${ordinal}`,
    ordinal,
    turn_number: ordinal + 1,
    kind: 'agent',
    status: 'ended',
    outcome: 'completed',
    started_at: AT,
    steps: [],
    items: [opener(`u${ordinal}`, `turn ${ordinal}`)],
    ...extra,
  };
}

beforeEach(() => {
  setKimiClientDeps({ api: () => clientApiMock as unknown as KimiWebApi, t: (key) => key });
});

afterEach(() => {
  vi.useRealTimers();
  resetKimiClientDeps();
  vi.unstubAllGlobals();
});

function session(id: string): AppSession {
  return {
    id,
    title: id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    busy: false,
    mainTurnActive: false,
    pendingInteraction: 'none',
    archived: false,
    cwd: '/workspace',
    model: 'model-1',
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
    workspaceId: 'workspace-1',
  };
}

async function boot(opts: { deferPages?: boolean; sessionIds?: string[] } = {}) {
  vi.stubGlobal('WebSocket', class {});
  vi.resetModules();
  const sessions = (opts.sessionIds ?? ['s1']).map(session);
  let handlers: KimiEventHandlers | undefined;
  const connection: KimiEventConnection = {
    subscribeConversation: vi.fn((sid: string, agentId: string) => {
      queueMicrotask(() => {
        if (opts.deferPages !== true) handlers?.onConversation?.(sid, agentId, { type: 'turns', turns: [], has_more: false });
      });
    }),
    unsubscribeConversation: vi.fn(),
    watchTaskOutput: vi.fn(),
    unwatchTaskOutput: vi.fn(),
    stopTask: vi.fn(),
    backgroundTask: vi.fn(),
    health: () => ({ connected: true, open: true, stale: false }),
    reconnect: vi.fn(),
    close: vi.fn(),
  };
  const submitPrompt = vi.fn<(sid: string, input: PromptSubmission) => Promise<PromptSubmitResult>>(
    async (_sid, input) => ({ promptId: input.promptId!, userMessageId: input.promptId!, status: 'running' }),
  );
  const getGitStatus = vi.fn(async () => ({ branch: '', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null }));
  const getSessionWarnings = vi.fn(async () => []);
  const listSkills = vi.fn(async () => []);
  const generateSessionTitle = vi.fn(async () => null);
  const api: Partial<KimiWebApi> = {
    getAuth: vi.fn(async () => ({ modelsReady: true, providersCount: 1, managedProvider: null })),
    getHealth: vi.fn(async () => ({ status: 'ok', uptimeSec: 1 })),
    getMeta: vi.fn(async () => ({
      serverVersion: '0.0.0',
      serverId: 'server-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      capabilities: {},
      openInApps: [],
      dangerousBypassAuth: false,
      backend: 'v2' as const,
    })),
    getConfig: vi.fn(async () => ({ providers: {}, defaultModel: 'model-1' })),
    listModels: vi.fn(async () => []),
    listProviders: vi.fn(async () => []),
    listWorkspaces: vi.fn(async () => [{ id: 'workspace-1', root: '/workspace', name: 'Workspace', sessionCount: sessions.length }]),
    getWorkspaceTrust: vi.fn(async () => ({ trusted: true })),
    getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
    listSessions: vi.fn(async () => ({ items: sessions, hasMore: false, nextPageToken: null, total: sessions.length })),
    listSessionGroups: vi.fn(async () => ({
      groups: [{
        workspaceId: 'workspace-1',
        sessions: sessions.map((value) => ({
          ...value,
          lastPrompt: value.lastPrompt ?? 'prompt',
        })),
        total: sessions.length,
      }],
      hasMore: false,
      nextPageToken: null,
      total: sessions.length,
    })),
    getSession: vi.fn(async (id: string) => ({ ...session(id) })),
    submitPrompt,
    getSessionGoal: vi.fn(async () => null),
    getSessionWarnings,
    getGitStatus,
    listSkills,
    listSkillsForWorkspace: vi.fn(async () => []),
    generateSessionTitle,
    getFileUrl: (fileId: string) => `file:${fileId}`,
    connectEvents: vi.fn((next: KimiEventHandlers) => {
      handlers = next;
      return connection;
    }),
  };
  for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
  Object.assign(clientApiMock, api);

  const { useKimiWebClient } = await import('../src/client/useKimiWebClient');
  const { warningsStore } = await import('../src/stores/warnings');
  const client = useKimiWebClient();
  await client.load();
  await client.selectSession('s1');
  if (opts.deferPages !== true) await vi.waitFor(() => expect(client.sessionLoading.value).toBe(false));

  const frame = (sid: string, next: ConversationFrame) => handlers!.onConversation?.(sid, 'main', next);
  const agentStatus = (sid: string, status: AppAgentState['status'] | 'compacting') =>
    handlers!.onAgentState?.(sid, 'main', status === 'compacting' ? agentState('idle', { compacting: true }) : agentState(status));
  const header = (ordinal: number, outcome?: ConversationOutcome): ConversationTurnHeader => ({
    turn_id: `t${ordinal}`,
    ordinal,
    turn_number: ordinal + 1,
    kind: 'agent',
    status: outcome === undefined ? 'running' : 'ended',
    outcome,
    started_at: AT,
    steps: [],
  });
  const startTurn = (sid: string, ordinal: number, promptId: string, text: string) => {
    agentStatus(sid, 'running');
    frame(sid, { type: 'turn.started', turn: header(ordinal) });
    frame(sid, { type: 'item.ended', turn_id: `t${ordinal}`, item: opener(promptId, text) });
  };
  const endTurn = (sid: string, ordinal: number, outcome: ConversationOutcome = 'completed') => {
    frame(sid, { type: 'turn.ended', turn: header(ordinal, outcome) });
    agentStatus(sid, 'idle');
  };
  const sentPromptId = (index: number) => submitPrompt.mock.calls[index]![1].promptId!;

  const turnEndReads = { getGitStatus, getSessionWarnings, listSkills, generateSessionTitle };
  const event = (sid: string, appEvent: AppEvent) => handlers!.onEvent(appEvent, { sessionId: sid });

  return { client, submitPrompt, frame, startTurn, endTurn, agentStatus, event, sentPromptId, warningsStore, turnEndReads };
}

describe('conversation events in the client', () => {
  it('settles a local turn whose terminal frames beat the POST response', async () => {
    const h = await boot();
    const { notificationsStore } = await import('../src/stores/notifications');
    const { sessionRatingStore } = await import('../src/stores/sessionRating');
    const notifyCompletion = vi.spyOn(notificationsStore(), 'maybeNotifyCompletion');
    const noteTurnEnded = vi.spyOn(sessionRatingStore(), 'noteMainTurnEnded');
    let answer!: () => void;
    h.submitPrompt.mockImplementationOnce((_sid, input) => new Promise((resolve) => {
      answer = () => resolve({ promptId: input.promptId!, userMessageId: input.promptId!, status: 'running' });
    }));
    void h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'quick work' }));
    await vi.waitFor(() => expect(h.submitPrompt).toHaveBeenCalledTimes(1));
    void h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'behind it' }));

    const promptId = h.sentPromptId(0);
    expect(promptId).toMatch(/^msg_/);
    for (const read of Object.values(h.turnEndReads)) read.mockClear();
    h.startTurn('s1', 0, promptId, 'quick work');
    h.endTurn('s1', 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.submitPrompt).toHaveBeenCalledTimes(1);
    expect(h.client.activity.value).toBe('running');
    expect(notifyCompletion).toHaveBeenCalledWith('s1', expect.objectContaining({ promptId }));
    expect(noteTurnEnded).toHaveBeenCalledWith('s1', 't0', expect.any(Function));
    expect(h.turnEndReads.generateSessionTitle).toHaveBeenCalledWith('s1', { source: 'first_turn' });
    expect(h.turnEndReads.getGitStatus).toHaveBeenCalled();
    expect(h.turnEndReads.getSessionWarnings).toHaveBeenCalled();
    expect(h.turnEndReads.listSkills).toHaveBeenCalled();

    answer();
    await vi.waitFor(() => expect(h.submitPrompt).toHaveBeenCalledTimes(2));
    expect(h.submitPrompt.mock.calls[1]![1].content).toEqual([{ type: 'text', text: 'behind it' }]);
  });

  it('runs the turn-end effects of a local prompt whose turn already ended on the first page', async () => {
    const h = await boot({ deferPages: true });
    const { sessionRatingStore } = await import('../src/stores/sessionRating');
    const noteTurnEnded = vi.spyOn(sessionRatingStore(), 'noteMainTurnEnded');
    void h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'quick work' }));
    await vi.waitFor(() => expect(h.submitPrompt).toHaveBeenCalledTimes(1));
    const promptId = h.sentPromptId(0);
    for (const read of Object.values(h.turnEndReads)) read.mockClear();

    h.frame('s1', { type: 'turns', turns: [endedTurn(0, { items: [opener(promptId, 'quick work')] })], has_more: false });

    await vi.waitFor(() => expect(noteTurnEnded).toHaveBeenCalledWith('s1', 't0', expect.any(Function)));
    expect(h.turnEndReads.generateSessionTitle).toHaveBeenCalledWith('s1', { source: 'first_turn' });
    expect(h.turnEndReads.getGitStatus).toHaveBeenCalled();
    expect(h.turnEndReads.getSessionWarnings).toHaveBeenCalled();
    expect(h.turnEndReads.listSkills).toHaveBeenCalled();
  });

  it('drops a sent prompt the server lost while disconnected and sends the next queued one', async () => {
    const h = await boot();
    await h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'lost' }));
    await h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'next' }));
    expect(h.submitPrompt).toHaveBeenCalledTimes(1);
    expect(h.client.activity.value).toBe('running');

    h.agentStatus('s1', 'idle');
    expect(h.submitPrompt).toHaveBeenCalledTimes(1);
    h.frame('s1', { type: 'turns', turns: [], has_more: false });

    await vi.waitFor(() => expect(h.submitPrompt).toHaveBeenCalledTimes(2));
    expect(h.submitPrompt.mock.calls[1]![1].content).toEqual([{ type: 'text', text: 'next' }]);
  });

  it('sends a message queued while the session row showed a running turn once the agent frame says idle', async () => {
    const h = await boot({ deferPages: true });
    h.event('s1', { type: 'sessionWorkChanged', sessionId: 's1', busy: true, mainTurnActive: true });
    await h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'after the reload' }));
    expect(h.submitPrompt).not.toHaveBeenCalled();

    h.frame('s1', { type: 'turns', turns: [endedTurn(0)], has_more: false });
    h.agentStatus('s1', 'idle');
    await vi.waitFor(() => expect(h.submitPrompt).toHaveBeenCalledTimes(1));
    expect(h.submitPrompt.mock.calls[0]![1].content).toEqual([{ type: 'text', text: 'after the reload' }]);
  });

  it('rolls back a prompt only after every resend failed on the network, and the queue still drains', async () => {
    const h = await boot();
    vi.useFakeTimers();
    h.submitPrompt
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError());
    const sent = h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'lost' }));
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(sent).resolves.toBe('rejected');
    vi.useRealTimers();
    expect(h.submitPrompt).toHaveBeenCalledTimes(3);
    expect([h.sentPromptId(1), h.sentPromptId(2)]).toEqual([h.sentPromptId(0), h.sentPromptId(0)]);
    expect(h.client.turns.value).toEqual([]);
    expect(h.client.inFlight.value).toBe(false);

    h.startTurn('s1', 0, 'msg_from_another_client', 'theirs');
    await expect(h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'after theirs' }))).resolves.toBe('queued');
    h.endTurn('s1', 0);
    await vi.waitFor(() => expect(h.submitPrompt).toHaveBeenCalledTimes(4));
    expect(h.submitPrompt.mock.calls[3]![1].content).toEqual([{ type: 'text', text: 'after theirs' }]);
  });

  it('rolls back a prompt the server failed before it started a turn', async () => {
    const h = await boot();
    h.submitPrompt.mockImplementationOnce(async (_sid, input) => ({
      promptId: input.promptId!,
      userMessageId: input.promptId!,
      status: 'failed',
    }));
    await expect(h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'gated' }))).resolves.toBe('rejected');
    expect(h.client.turns.value).toEqual([]);
    expect(h.client.inFlight.value).toBe(false);
    expect(h.warningsStore().warnings).toContainEqual(expect.objectContaining({
      severity: 'error',
      title: 'warnings.sendFailedTitle',
      message: 'warnings.promptFailedMessage',
    }));

    await expect(h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'next' }))).resolves.toBe('ok');
    expect(h.submitPrompt).toHaveBeenCalledTimes(2);
  });

  it('replaces the optimistic bubble with the echoed user message', async () => {
    const h = await boot();
    await h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'hello there' }));
    const userTexts = () => h.client.turns.value.filter((turn) => turn.role === 'user').map((turn) => turn.text);
    await vi.waitFor(() => expect(userTexts()).toEqual(['hello there']));

    h.startTurn('s1', 0, h.sentPromptId(0), 'hello there');
    await vi.waitFor(() => expect(h.client.turns.value[0]?.id).toBe(h.sentPromptId(0)));
    expect(userTexts()).toEqual(['hello there']);
  });

  it('reads the main turn as running from the agent frame, and from the session row only before any frame', async () => {
    const h = await boot();
    h.event('s1', { type: 'sessionWorkChanged', sessionId: 's1', busy: true, mainTurnActive: true });
    expect(h.client.turnActive.value).toBe(true);
    expect(h.client.activity.value).toBe('running');

    h.agentStatus('s1', 'idle');
    expect(h.client.turnActive.value).toBe(false);
    expect(h.client.activity.value).toBe('idle');

    h.agentStatus('s1', 'running');
    expect(h.client.working.value).toBe(true);
  });

  it('stops the running turn by its opener prompt, else falls back to session cancel', async () => {
    const h = await boot();
    const abortPrompt = vi.fn(async () => ({ aborted: true }));
    const cancelSession = vi.fn(async () => ({ cancelled: true }));
    clientApiMock['abortPrompt'] = abortPrompt;
    clientApiMock['cancelSession'] = cancelSession;
    await h.client.sendPrompt(h.client.createPromptEnvelope({ text: 'mine' }));
    h.agentStatus('s1', 'running');
    await h.client.abortCurrentPrompt();
    expect(abortPrompt).toHaveBeenLastCalledWith('s1', h.sentPromptId(0));

    h.startTurn('s1', 0, 'msg_opener', 'theirs');
    await h.client.abortCurrentPrompt();
    expect(abortPrompt).toHaveBeenLastCalledWith('s1', 'msg_opener');
  });

  it('reads how the last main turn ended from the conversation, so undoing a stopped turn clears it', async () => {
    const h = await boot();
    h.frame('s1', {
      type: 'turns',
      turns: [endedTurn(0), endedTurn(1, { outcome: 'interrupted', end_reason: 'user_cancelled' })],
      has_more: false,
    });
    await vi.waitFor(() =>
      expect(h.client.activeTurnEnd.value).toMatchObject({ outcome: 'interrupted', end_reason: 'user_cancelled' }),
    );

    h.frame('s1', { type: 'turns.removed', turn_ids: [endedTurn(1).turn_id] });
    await vi.waitFor(() => expect(h.client.activeTurnEnd.value).toMatchObject({ outcome: 'completed' }));

    h.startTurn('s1', 1, 'msg_next', 'next');
    await vi.waitFor(() => expect(h.client.activeTurnEnd.value).toBeUndefined());
  });

  it('settles a compaction from its item or the cancel notice, never from the agent frame', async () => {
    const h = await boot();
    const { modelSwitchConfirmStore } = await import('../src/stores/modelSwitchConfirm');
    const { promptStore } = await import('../src/stores/prompt');
    const compaction = { type: 'system', kind: 'compaction', item_id: 'c0', status: 'ended', outcome: 'completed', created_at: AT, trigger: 'auto' } as const;
    h.agentStatus('s1', 'compacting');
    const completed = modelSwitchConfirmStore().waitCompactionSettled('s1', 60_000);
    h.agentStatus('s1', 'idle');
    expect(promptStore().hasUnsettledCompaction('s1')).toBe(true);
    h.frame('s1', { type: 'turn.started', turn: { turn_id: 't0', ordinal: 0, kind: 'system', status: 'running', started_at: AT, steps: [] } });
    h.frame('s1', { type: 'item.ended', turn_id: 't0', item: compaction });
    await expect(completed).resolves.toBe('completed');
    expect(promptStore().hasUnsettledCompaction('s1')).toBe(false);

    h.agentStatus('s1', 'compacting');
    const cancelled = modelSwitchConfirmStore().waitCompactionSettled('s1', 60_000);
    h.frame('s1', { type: 'notice', level: 'warning', title: 'Context compaction did not finish', code: 'compaction.cancelled' });
    await expect(cancelled).resolves.toBe('cancelled');
    expect(promptStore().hasUnsettledCompaction('s1')).toBe(false);
  });

  it('settles a compaction that ended while disconnected from the page after reconnect', async () => {
    const h = await boot();
    const { modelSwitchConfirmStore } = await import('../src/stores/modelSwitchConfirm');
    const system = (turnId: string, ordinal: number, itemId: string) => endedTurn(ordinal, {
      turn_id: turnId,
      kind: 'system',
      items: [{ type: 'system', kind: 'compaction', item_id: itemId, status: 'ended', outcome: 'completed', created_at: AT, trigger: 'auto' }],
    });
    h.frame('s1', { type: 'turns', turns: [system('t0', 0, 'c0')], has_more: false });

    h.agentStatus('s1', 'compacting');
    const completed = modelSwitchConfirmStore().waitCompactionSettled('s1', 60_000);
    h.agentStatus('s1', 'idle');
    h.frame('s1', { type: 'turns', turns: [system('t0', 0, 'c0'), system('t1', 1, 'c1')], has_more: false });
    await expect(completed).resolves.toBe('completed');

    h.agentStatus('s1', 'compacting');
    const cancelled = modelSwitchConfirmStore().waitCompactionSettled('s1', 60_000);
    h.agentStatus('s1', 'idle');
    h.frame('s1', { type: 'turns', turns: [system('t0', 0, 'c0'), system('t1', 1, 'c1')], has_more: false });
    await expect(cancelled).resolves.toBe('cancelled');
  });

  it('commits the first page before clearing sessionLoading so the pane never sees an empty non-loading frame', async () => {
    const { watchEffect } = await import('vue');
    const h = await boot({ deferPages: true, sessionIds: ['s1', 's2'] });
    h.frame('s1', { type: 'turns', turns: [], has_more: false });
    await h.client.selectSession('s2');
    expect(h.client.sessionLoading.value).toBe(true);

    const states: Array<{ loading: boolean; count: number }> = [];
    const stop = watchEffect(
      () => {
        states.push({ loading: h.client.sessionLoading.value, count: h.client.turns.value.length });
      },
      { flush: 'sync' },
    );

    h.frame('s2', { type: 'turns', turns: [endedTurn(0)], has_more: false });
    await Promise.resolve();
    stop();

    expect(h.client.sessionLoading.value).toBe(false);
    expect(h.client.turns.value.map((turn) => turn.id)).toEqual(['u0']);
    expect(states.some((state) => !state.loading && state.count === 0)).toBe(false);
  });

  it('commits prepended older turns before loadOlderMessages resolves and flags a stalled older page', async () => {
    const h = await boot({ deferPages: true });
    h.frame('s1', { type: 'turns', turns: [endedTurn(2)], has_more: true });
    expect(h.client.turns.value.map((turn) => turn.id)).toEqual(['u2']);

    clientApiMock['getAgentTurns'] = vi
      .fn()
      .mockResolvedValueOnce({ turns: [endedTurn(1)], has_more: true })
      .mockResolvedValueOnce({ turns: [], has_more: true });

    await h.client.loadOlderMessages('s1');
    expect(h.client.loadingMoreMessages.value).toBe(false);
    expect(h.client.loadMoreMessagesError.value).toBe(false);
    expect(h.client.turns.value.map((turn) => turn.id)).toEqual(['u1', 'u2']);

    await h.client.loadOlderMessages('s1');
    expect(h.client.loadingMoreMessages.value).toBe(false);
    expect(h.client.loadMoreMessagesError.value).toBe(true);
  });
});

describe('model turn error notices', () => {
  it('keeps model errors in their session instead of toasting another session', async () => {
    const h = await boot({ sessionIds: ['s1', 's2'] });
    await h.client.selectSession('s2');
    await h.client.selectSession('s1');
    h.warningsStore().resetWarnings();

    h.frame('s2', { type: 'notice', level: 'error', title: 'bad request', code: 'provider.api_error' });
    h.frame('s2', { type: 'notice', level: 'error', title: 'too large', code: 'context.overflow' });
    h.frame('s1', { type: 'notice', level: 'error', title: 'bad request', code: 'provider.api_error' });

    expect(h.warningsStore().warnings).toEqual([]);
  });

  it('still toasts background errors that are not model turn errors', async () => {
    const h = await boot({ sessionIds: ['s1', 's2'] });
    await h.client.selectSession('s2');
    await h.client.selectSession('s1');
    h.warningsStore().resetWarnings();

    h.frame('s2', { type: 'notice', level: 'error', title: 'boom', code: 'internal' });

    expect(h.warningsStore().warnings).toEqual([
      expect.objectContaining({
        severity: 'error',
        title: 'warnings.agentError.title',
        message: 'boom',
      }),
    ]);
  });
});

describe('echoed steer prompt pruning', () => {
  it('prunes optimistic steer bubbles immediately when user_message items arrive mid-turn', async () => {
    const h = await boot();
    const { promptStore } = await import('../src/stores/prompt');
    const steerPrompt = vi.fn<(sid: string, input: PromptSubmission) => Promise<PromptSubmitResult>>(
      async (_sid, input) => ({ promptId: input.promptId!, userMessageId: input.promptId!, status: 'running' }),
    );
    clientApiMock['steerPrompt'] = steerPrompt;

    h.agentStatus('s1', 'running');
    h.frame('s1', {
      type: 'turn.started',
      turn: { turn_id: 't0', ordinal: 0, turn_number: 1, kind: 'agent', status: 'running', started_at: AT, steps: [] },
    });
    h.frame('s1', { type: 'item.ended', turn_id: 't0', item: opener('u0', 'initial prompt') });

    await expect(h.client.steerPromptDirect(h.client.createPromptEnvelope({ text: 'first steer' }))).resolves.toBe('ok');
    const firstPromptId = steerPrompt.mock.calls[0]![1].promptId!;
    expect(promptStore().optimisticMessagesBySession['s1']).toHaveLength(1);

    h.frame('s1', {
      type: 'item.ended',
      turn_id: 't0',
      item: { ...opener(firstPromptId, 'first steer'), placement: 'steer' },
    });
    expect(promptStore().optimisticMessagesBySession['s1']).toBeUndefined();

    await expect(h.client.steerPromptDirect(h.client.createPromptEnvelope({ text: 'second steer' }))).resolves.toBe('ok');
    const secondPromptId = steerPrompt.mock.calls[1]![1].promptId!;
    expect(promptStore().optimisticMessagesBySession['s1']).toHaveLength(1);

    h.frame('s1', {
      type: 'item.ended',
      turn_id: 't0',
      item: { ...opener(secondPromptId, 'second steer'), placement: 'steer' },
    });
    expect(promptStore().optimisticMessagesBySession['s1']).toBeUndefined();
  });
});
