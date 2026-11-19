import { computed, nextTick, reactive, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';

import { usePanelTabs } from '../src/composables';
import type { ConversationEntry } from '../src/composables/useConversations';
import type { AgentTabPayload } from '../src/panel/panelRegistry';
import type { TaskOutputState } from '../src/client/useTaskOutputStream';
import type { AppTask } from '@moonshot-ai/app-core/api';
import type { ChatTurn } from '@moonshot-ai/app-core/client';
import type { ConversationAttachment, ConversationItem, ConversationTurn } from '@moonshot-ai/app-core/conversation';

const t = (key: string) => key;

function conversationEntry(agentId: string, turns: ConversationTurn[] = [], extra: Partial<ConversationEntry> = {}): ConversationEntry {
  return {
    sessionId: 'session-1',
    agentId,
    version: ref(0),
    view: { turns, hasMore: false },
    latestPages: 1,
    loaded: true,
    loadingOlder: false,
    loadOlderError: false,
    holders: 1,
    lastTouched: 0,
    ...extra,
  };
}

const AT = '2026-08-26T00:00:00.000Z';

function opener(id: string, text: string, attachments: ConversationAttachment[] = []): ConversationItem {
  return {
    type: 'user_message',
    item_id: id,
    status: 'ended',
    outcome: 'completed',
    created_at: AT,
    placement: 'opener',
    prompt_ids: [],
    origin: { kind: 'system' },
    text,
    attachments,
    skills: [],
  };
}

function conversationTurn(ordinal: number, items: ConversationItem[]): ConversationTurn {
  return {
    turn_id: `t${ordinal}`,
    ordinal,
    turn_number: ordinal + 1,
    kind: 'agent',
    status: 'ended',
    outcome: 'completed',
    started_at: AT,
    steps: [],
    items,
  };
}

function promptTurn(ordinal: number, text: string): ConversationTurn {
  return conversationTurn(ordinal, [opener(`p${ordinal}`, text)]);
}

function conversations(entry: (sessionId: string, agentId: string) => ConversationEntry | undefined) {
  return {
    getEntry: vi.fn(entry),
    activate: vi.fn(),
    deactivate: vi.fn(),
    loadOlder: vi.fn(async () => {}),
  };
}

function panelClient(extra: Record<string, unknown>) {
  return {
    activeSessionId: ref<string | null>('session-1'),
    activeWorkspaceId: ref<string | null>(null),
    findBashCommandForTask: () => undefined,
    getFileUrl: (id: string) => `file://${id}`,
    getSessionMediaUrl: (sid: string, id: string) => `media://${sid}/${id}`,
    loadGitStatus: vi.fn(async () => {}),
    loadFileDiff: vi.fn(async () => {}),
    clearFileDiff: vi.fn(),
    startSessionAndOpenSideChat: vi.fn(async () => null),
    openSideChatOn: vi.fn(async () => ({ target: null, sent: false })),
    closeSideChat: vi.fn(),
    sideChatTargetsOfSession: vi.fn(() => []),
    ...extra,
  };
}

describe('usePanelTabs agent conversation state', () => {
  it('updates loading state and member metadata when the conversation version changes', async () => {
    const entry = conversationEntry('agent-30', [], { loaded: false });
    const findSubagentPromptForTask = vi.fn(() => undefined as string | undefined);
    const client = panelClient({
      findSubagentPromptForTask,
      activeAppTasks: ref([
        {
          id: 'agent-99',
          kind: 'subagent',
          description: 'Unrelated live agent',
        },
        {
          id: 'background-task-30',
          agentId: 'agent-30',
          kind: 'subagent',
          description: 'Inspect files',
          status: 'running',
          sessionId: 'session-1',
          createdAt: '2026-07-28T00:00:00.000Z',
          subagentType: 'explore',
          thinkingEffort: 'low',
        },
      ] as unknown as AppTask[]),
      turns: ref([{
        id: 'turn-1',
        role: 'assistant',
        no: 1,
        text: '',
        tools: [{
          id: 'tool-1',
          name: 'Agent',
          arg: JSON.stringify({
            description: 'Inspect files',
            subagent_type: 'explore',
            prompt: 'Read every file in src and report the architecture.',
            model: 'k2-thinking',
            thinking: 'high',
          }),
          status: 'ok',
          agentId: 'agent-30',
          output: ['saved result'],
        }],
      }] as unknown as ChatTurn[]),
      auxiliaryConversations: conversations(() => entry),
    });
    const panel = usePanelTabs({ client: client as never, sideWidth: ref(280), t });

    panel.openAgentPanel('agent-30');
    expect(client.auxiliaryConversations.activate).toHaveBeenCalledWith('session-1', 'agent-30');
    const payload = panel.activeTab.value!.payload as AgentTabPayload;
    expect(panel.agentPanelLoadingOf(payload)).toBe(true);
    expect(panel.agentPanelMemberOf(payload)).toMatchObject({
      id: 'agent-30',
      kind: 'subagent',
      name: 'Inspect files',
      subagentType: 'explore',
      model: 'k2-thinking',
      thinkingEffort: 'low',
      prompt: 'Read every file in src and report the architecture.',
      phase: 'working',
    });
    expect(findSubagentPromptForTask).not.toHaveBeenCalled();

    client.activeAppTasks.value = [client.activeAppTasks.value[0]!];
    entry.loaded = true;
    entry.version.value += 1;
    await nextTick();

    expect(panel.agentPanelLoadingOf(payload)).toBe(false);
    const turns = panel.agentPanelTurnsOf(payload);
    expect(panel.agentPanelTurnsOf(payload)).toBe(turns);
    entry.view = { turns: [promptTurn(0, 'Read every file in src and report the architecture.')], hasMore: false };
    entry.version.value += 1;
    expect(panel.agentPanelTurnsOf(payload)).not.toBe(turns);
    expect(panel.agentPanelMemberOf(payload)).toMatchObject({
      id: 'agent-30',
      kind: 'subagent',
      name: 'Inspect files',
      subagentType: 'explore',
      model: 'k2-thinking',
      thinkingEffort: 'high',
      prompt: 'Read every file in src and report the architecture.',
      phase: 'completed',
      outputLines: ['saved result'],
    });

    client.turns.value[0]!.tools![0]!.status = 'error';
    await nextTick();
    expect(panel.agentPanelMemberOf(payload)).toMatchObject({
      phase: 'failed',
      status: 'failed',
      outputLines: ['saved result'],
    });

    panel.openTab('file', { path: '/repo/a.ts' });
    expect(client.auxiliaryConversations.deactivate).toHaveBeenCalledWith('session-1', 'agent-30');
    panel.activateTab(panel.panelTabs.value.find((tab) => tab.type === 'agent')!.id);
    expect(panel.activeTab.value?.type).toBe('agent');
    expect(client.auxiliaryConversations.activate).toHaveBeenLastCalledWith('session-1', 'agent-30');
  });

  it('deactivates an optimistic subscription once the task row re-classifies the id', async () => {
    const entry = conversationEntry('task-bash-1');
    const client = panelClient({
      activeAppTasks: ref([] as unknown as AppTask[]),
      turns: ref([] as unknown as ChatTurn[]),
      auxiliaryConversations: conversations(() => entry),
    });
    const panel = usePanelTabs({ client: client as never, sideWidth: ref(280), t });

    panel.openAgentPanel('task-bash-1');
    expect(client.auxiliaryConversations.activate).toHaveBeenCalledWith('session-1', 'task-bash-1');

    client.activeAppTasks.value = [
      {
        id: 'task-bash-1',
        kind: 'bash',
        description: 'npm test',
        status: 'running',
        sessionId: 'session-1',
        createdAt: '2026-08-25T00:00:00.000Z',
      } as unknown as AppTask,
    ];
    await nextTick();
    expect(client.auxiliaryConversations.deactivate).toHaveBeenCalledWith('session-1', 'task-bash-1');
    expect(client.auxiliaryConversations.activate).toHaveBeenCalledTimes(1);
  });
});

describe('usePanelTabs agentPanelMemberOf prompt resolution', () => {
  function setup(options: {
    turns?: ConversationTurn[];
    hasMore?: boolean;
    tasks?: AppTask[];
    toolPrompt?: string;
  }) {
    const entry = conversationEntry('agent-1', options.turns ?? []);
    entry.view = { turns: options.turns ?? [], hasMore: options.hasMore ?? false };
    const tasks = ref(
      (options.tasks ?? [{
        id: 'task-1',
        agentId: 'agent-1',
        kind: 'subagent',
        description: 'Inspect files',
        status: 'completed',
        sessionId: 'session-1',
        createdAt: '2026-08-26T00:00:00.000Z',
      }]) as unknown as AppTask[],
    );
    const turns = ref(
      (options.toolPrompt === undefined
        ? []
        : [{
            id: 'turn-1',
            role: 'assistant',
            no: 1,
            text: '',
            tools: [{
              id: 'tool-1',
              name: 'Agent',
              arg: JSON.stringify({ description: 'Inspect files', prompt: options.toolPrompt }),
              status: 'ok',
              agentId: 'agent-1',
            }],
          }]) as unknown as ChatTurn[],
    );
    const client = panelClient({
      activeAppTasks: tasks,
      turns,
      auxiliaryConversations: conversations((sessionId, agentId) =>
        sessionId === 'session-1' && agentId === 'agent-1' ? entry : undefined),
    });
    const panel = usePanelTabs({ client: client as never, sideWidth: ref(280), t });
    const payload: AgentTabPayload = { sessionId: 'session-1', subagentId: 'agent-1' };
    return { panel, entry, client, turns, payload };
  }

  it('takes P1 from the earliest turn of a complete history, not a later P2', () => {
    const { panel, payload } = setup({
      turns: [promptTurn(0, 'P1: scan the repo'), promptTurn(1, 'P2: now the styles')],
      toolPrompt: 'ORCHESTRATOR-P1',
    });

    expect(panel.agentPanelMemberOf(payload)?.prompt).toBe('P1: scan the repo');
  });

  it('falls back to the tool-call prompt while history is incomplete, never to the window', () => {
    const { panel, turns, payload } = setup({
      turns: [promptTurn(1, 'P2: now the styles')],
      hasMore: true,
      toolPrompt: 'ORCHESTRATOR-P1',
    });

    expect(panel.agentPanelMemberOf(payload)?.prompt).toBe('ORCHESTRATOR-P1');
    turns.value = [];
    expect(panel.agentPanelMemberOf(payload)?.prompt).toBeUndefined();
  });

  it('does not skip a promptless earliest turn — falls back instead of showing P2', () => {
    const { panel, turns, payload } = setup({
      turns: [conversationTurn(0, []), promptTurn(1, 'P2: now the styles')],
      toolPrompt: 'ORCHESTRATOR-P1',
    });

    expect(panel.agentPanelMemberOf(payload)?.prompt).toBe('ORCHESTRATOR-P1');
    turns.value = [];
    expect(panel.agentPanelMemberOf(payload)?.prompt).toBeUndefined();
  });

  it('falls back the same way for an empty complete history', () => {
    const { panel, turns, payload } = setup({ turns: [], toolPrompt: 'ORCHESTRATOR-P1' });

    expect(panel.agentPanelMemberOf(payload)?.prompt).toBe('ORCHESTRATOR-P1');
    turns.value = [];
    expect(panel.agentPanelMemberOf(payload)?.prompt).toBeUndefined();
  });

  it('keeps P2 out of the top bubble when the earliest turn is attachment-only', () => {
    const { panel, turns, payload } = setup({
      turns: [
        conversationTurn(0, [opener('p0', '', [{ kind: 'image', file_id: 'f_1', name: 'f_1.png', ordinal: 1 }])]),
        promptTurn(1, 'P2: now the styles'),
      ],
      toolPrompt: 'ORCHESTRATOR-P1',
    });

    expect(panel.agentPanelMemberOf(payload)?.prompt).toBe('ORCHESTRATOR-P1');
    turns.value = [];
    expect(panel.agentPanelMemberOf(payload)?.prompt).toBeUndefined();

    const chatTurns = panel.agentPanelTurnsOf(payload);
    expect(chatTurns[0]).toMatchObject({ id: 'p0', role: 'user', text: '' });
    expect(chatTurns[0]?.attachments).toHaveLength(1);
    expect(chatTurns[1]).toMatchObject({ id: 'p1', role: 'user', text: 'P2: now the styles' });
  });

  it('re-derives the prompt when a late page bumps the conversation version', async () => {
    const { panel, entry, payload } = setup({ turns: [], toolPrompt: 'ORCHESTRATOR-P1' });
    const member = computed(() => panel.agentPanelMemberOf(payload));
    expect(member.value?.prompt).toBe('ORCHESTRATOR-P1');

    entry.view = { turns: [promptTurn(0, 'P1: scan the repo')], hasMore: false };
    entry.version.value += 1;
    await nextTick();

    expect(member.value?.prompt).toBe('P1: scan the repo');
  });

  it('normalizes task-store ids to the agent id before reading the conversation', () => {
    const { panel, client } = setup({
      turns: [promptTurn(0, 'P1: scan the repo')],
      tasks: [
        {
          id: 'task-1',
          agentId: 'agent-1',
          kind: 'subagent',
          description: 'Inspect files',
          status: 'completed',
          sessionId: 'session-1',
          createdAt: '2026-08-26T00:00:00.000Z',
        },
        {
          id: 'task-2',
          kind: 'subagent',
          description: 'Other agent',
          status: 'running',
          sessionId: 'session-1',
          createdAt: '2026-08-26T00:00:00.000Z',
        },
      ] as unknown as AppTask[],
      toolPrompt: 'ORCHESTRATOR-P1',
    });

    expect(panel.agentPanelMemberOf({ sessionId: 'session-1', subagentId: 'task-1' })?.prompt).toBe('P1: scan the repo');
    expect(client.auxiliaryConversations.getEntry).toHaveBeenCalledWith('session-1', 'agent-1');

    expect(panel.agentPanelMemberOf({ sessionId: 'session-1', subagentId: 'task-2' })?.prompt).toBeUndefined();
    panel.openAgentPanel('task-2');
    expect(client.auxiliaryConversations.activate).not.toHaveBeenCalled();
  });
});

describe('usePanelTabs streamed task output', () => {
  function setup(task: AppTask, opts: { sessionId?: string } = {}) {
    const outputs = reactive<Record<string, TaskOutputState>>({});
    const watchTaskOutput = vi.fn();
    const unwatchTaskOutput = vi.fn();
    const tasks = ref([task]);
    const client = panelClient({
      activeSessionId: ref<string | null>(opts.sessionId ?? 'session-1'),
      activeAppTasks: tasks,
      turns: ref([]),
      auxiliaryConversations: conversations(() => undefined),
      watchTaskOutput,
      unwatchTaskOutput,
      taskOutputOf: (sessionId: string, agentId: string, taskId: string) =>
        outputs[`${sessionId}/${agentId}/${taskId}`],
    });
    const panel = usePanelTabs({ client: client as never, sideWidth: ref(280), t });
    return { panel, client, tasks, outputs, watchTaskOutput, unwatchTaskOutput };
  }

  function bashTask(overrides: Partial<AppTask> = {}): AppTask {
    return {
      id: 'bash-1',
      kind: 'bash',
      description: 'Run tests',
      status: 'running',
      sessionId: 'session-1',
      createdAt: '2026-08-26T00:00:00.000Z',
      ...overrides,
    } as unknown as AppTask;
  }

  const target = { sessionId: 'session-1', subagentId: 'bash-1' };

  it('watches the main agent task while the panel shows it and unwatches when it hides', async () => {
    const { panel, outputs, watchTaskOutput, unwatchTaskOutput } = setup(bashTask());
    panel.openAgentPanel('bash-1');
    await nextTick();
    expect(watchTaskOutput).toHaveBeenCalledExactlyOnceWith('session-1', 'main', 'bash-1');

    expect(panel.agentPanelMemberOf(target)?.outputLines).toBeUndefined();
    outputs['session-1/main/bash-1'] = { status: 'ready', text: 'line 1\nline 2' };
    expect(panel.agentPanelMemberOf(target)?.outputLines).toEqual(['line 1', 'line 2']);

    panel.hidePanel();
    await nextTick();
    expect(unwatchTaskOutput).toHaveBeenCalledExactlyOnceWith('session-1', 'main', 'bash-1');
  });

  it('also watches ended bash tasks', async () => {
    const { panel, watchTaskOutput } = setup(bashTask({ status: 'completed' }));
    panel.openAgentPanel('bash-1');
    await nextTick();
    expect(watchTaskOutput).toHaveBeenCalledExactlyOnceWith('session-1', 'main', 'bash-1');
  });

  it('shows the output as loading until the first chunk and as unavailable when the watch fails', async () => {
    const { panel, outputs } = setup(bashTask({ status: 'completed' }));
    panel.openAgentPanel('bash-1');
    await nextTick();

    outputs['session-1/main/bash-1'] = { status: 'loading' };
    expect(panel.agentPanelMemberOf(target)).toMatchObject({ outputLoading: true, outputUnavailable: false });

    outputs['session-1/main/bash-1'] = { status: 'failed' };
    expect(panel.agentPanelMemberOf(target)).toMatchObject({ outputLoading: false, outputUnavailable: true });
    expect(panel.agentPanelMemberOf(target)?.outputLines).toBeUndefined();
  });

  it('does not watch subagent tasks', async () => {
    const subagent = setup(bashTask({ id: 'agent-1', agentId: 'agent-1', kind: 'subagent' }));
    subagent.panel.openAgentPanel('agent-1');
    await nextTick();
    expect(subagent.watchTaskOutput).not.toHaveBeenCalled();
  });

  it('keeps watching after the task ends until the panel hides', async () => {
    const { panel, tasks, outputs, watchTaskOutput, unwatchTaskOutput } = setup(bashTask());
    panel.openAgentPanel('bash-1');
    await nextTick();
    outputs['session-1/main/bash-1'] = { status: 'ready', text: 'streamed' };

    tasks.value = [bashTask({ status: 'completed' })];
    await nextTick();
    expect(watchTaskOutput).toHaveBeenCalledExactlyOnceWith('session-1', 'main', 'bash-1');
    expect(unwatchTaskOutput).not.toHaveBeenCalled();
    expect(panel.agentPanelMemberOf(target)?.outputLines).toEqual(['streamed']);

    panel.hidePanel();
    await nextTick();
    expect(unwatchTaskOutput).toHaveBeenCalledExactlyOnceWith('session-1', 'main', 'bash-1');
  });

  it('passes session ids containing slashes through intact', async () => {
    const { panel, watchTaskOutput } = setup(
      bashTask({ sessionId: 'sess/1', status: 'completed' }),
      { sessionId: 'sess/1' },
    );
    panel.openAgentPanel('bash-1');
    await nextTick();
    expect(watchTaskOutput).toHaveBeenCalledWith('sess/1', 'main', 'bash-1');
  });

  it('keeps a shell tab working once its task left the list, as after a relaunch', async () => {
    const { panel, client, tasks, outputs, watchTaskOutput, unwatchTaskOutput } = setup(
      bashTask({ status: 'completed' }),
    );
    panel.openAgentPanel('bash-1');
    await nextTick();
    expect(panel.activeTab.value?.payload).toMatchObject({ subagentId: 'bash-1', shellTask: true });
    panel.hidePanel();
    await nextTick();
    expect(unwatchTaskOutput).toHaveBeenCalledOnce();

    tasks.value = [];
    panel.showPanel();
    await nextTick();
    expect(watchTaskOutput).toHaveBeenCalledTimes(2);
    expect(watchTaskOutput).toHaveBeenLastCalledWith('session-1', 'main', 'bash-1');
    expect(client.auxiliaryConversations.activate).not.toHaveBeenCalled();
    expect(panel.agentPanelMemberOf({ ...target, shellTask: true })).toMatchObject({
      kind: 'bash',
      outputLoading: true,
      outputUnavailable: false,
    });
    outputs['session-1/main/bash-1'] = { status: 'failed' };
    expect(panel.agentPanelMemberOf({ ...target, shellTask: true })).toMatchObject({
      kind: 'bash',
      outputLoading: false,
      outputUnavailable: true,
    });

    tasks.value = [bashTask({ status: 'completed' })];
    expect(panel.agentPanelMemberOf({ ...target, shellTask: true })).toMatchObject({
      kind: 'bash',
      status: 'completed',
    });
  });
});
