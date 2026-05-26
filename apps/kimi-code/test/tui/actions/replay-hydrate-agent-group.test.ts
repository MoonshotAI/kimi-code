
import { Text } from '@earendil-works/pi-tui';
import type { Session } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { hydrateProjectedEntries, hydrateTranscriptFromReplay } from '#/tui/actions/replay-ops';
import { AgentGroupComponent } from '#/tui/components/messages/agent-group';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import { createTUIState, type KimiTUIOptions, type TUIState } from '#/tui/kimi-tui';
import type { AppState, ToolCallBlockData, TranscriptEntry } from '#/tui/types';

function makeAppState(): AppState {
  return {
    model: 'k2',
    workDir: '/tmp/proj-a',
    sessionId: 'sess-1',
    yolo: false,
    permissionMode: 'manual',
    planMode: false,
    thinking: false,
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 100,
    isStreaming: false,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: 'dark',
    version: '0.0.0-test',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    availableModels: {},
    availableProviders: {},
    sessionTitle: null,
  };
}

function makeTuiState(): TUIState {
  const options: KimiTUIOptions = {
    initialAppState: makeAppState(),
    startup: {
      continueLast: false,
      yolo: false,
      plan: false,
    },
    resolvedTheme: 'dark',
  };
  const state = createTUIState(options);
  vi.spyOn(state.ui, 'requestRender').mockImplementation(() => {});
  return state;
}

function appendEntry(state: TUIState, entry: TranscriptEntry): void {
  state.transcriptEntries.push(entry);
  if (entry.toolCallData !== undefined) {
    const tc = new ToolCallComponent(
      entry.toolCallData,
      entry.toolCallData.result,
      state.theme.colors,
      state.ui,
      state.theme.markdownTheme,
    );
    state.pendingToolComponents.set(entry.toolCallData.id, tc);
    state.transcriptContainer.addChild(tc);
    return;
  }
  state.transcriptContainer.addChild(new Text(entry.content, 0, 0));
}

function hydrate(state: TUIState, entries: readonly TranscriptEntry[]): void {
  hydrateProjectedEntries(state, entries, (entry) => {
    appendEntry(state, entry);
  });
}

function setTodoList(
  state: TUIState,
  todos: Parameters<TUIState['todoPanel']['setTodos']>[0],
): void {
  state.todoPanel.setTodos(todos);
  state.todoPanelContainer.clear();
  if (!state.todoPanel.isEmpty()) {
    state.todoPanelContainer.addChild(state.todoPanel);
  }
}

function sessionWithToolStore(toolStore: Record<string, unknown>): Session {
  return {
    getResumeState: () => ({
      sessionMetadata: {},
      agents: {
        main: {
          type: 'main',
          config: {
            modelAlias: 'k2',
            provider: undefined,
            modelCapabilities: { max_context_tokens: 100 },
          },
          context: { history: [], tokenCount: 0 },
          replay: [],
          permission: { mode: 'manual' },
          plan: null,
          usage: {},
          tools: [],
          toolStore,
          background: [],
        },
      },
    }),
  } as unknown as Session;
}

let entryIdSeq = 0;
function makeAgentEntry(
  id: string,
  step: number,
  turnId: string,
  result?: { is_error?: boolean },
): TranscriptEntry {
  entryIdSeq += 1;
  const tc: ToolCallBlockData = {
    id,
    name: 'Agent',
    args: { description: id },
    step,
    turnId,
    ...(result !== undefined
      ? { result: { tool_call_id: id, output: 'done', is_error: result.is_error ?? false } }
      : {}),
  };
  return {
    id: `e${String(entryIdSeq)}`,
    kind: 'tool_call',
    turnId,
    renderMode: 'plain',
    content: '',
    toolCallData: tc,
  };
}

function makeBashEntry(id: string, step: number, turnId: string): TranscriptEntry {
  entryIdSeq += 1;
  const tc: ToolCallBlockData = {
    id,
    name: 'Bash',
    args: { command: 'pwd' },
    step,
    turnId,
  };
  return {
    id: `e${String(entryIdSeq)}`,
    kind: 'tool_call',
    turnId,
    renderMode: 'plain',
    content: '',
    toolCallData: tc,
  };
}

function makeUserEntry(turnId: string, content: string): TranscriptEntry {
  entryIdSeq += 1;
  return {
    id: `e${String(entryIdSeq)}`,
    kind: 'user',
    turnId,
    renderMode: 'plain',
    content,
  };
}

describe('hydrateProjectedEntries', () => {
  it('hydrates the visible todo panel from resumed tool store state', async () => {
    const state = makeTuiState();
    const errors: string[] = [];

    const ok = await hydrateTranscriptFromReplay(
      state,
      {
        setAppState: (patch) => {
          state.appState = { ...state.appState, ...patch };
        },
        appendEntry: (entry) => {
          appendEntry(state, entry);
        },
        setTodoList: (todos) => {
          setTodoList(state, todos);
        },
        emitError: (message) => {
          errors.push(message);
        },
      },
      sessionWithToolStore({
        todo: [
          { title: 'Review resume snapshot', status: 'done' },
          { title: 'Render todo panel', status: 'in_progress' },
          { title: '', status: 'pending' },
        ],
      }),
    );

    expect(ok).toBe(true);
    expect(errors).toEqual([]);
    expect(state.todoPanel.getTodos()).toEqual([
      { title: 'Review resume snapshot', status: 'done' },
      { title: 'Render todo panel', status: 'in_progress' },
    ]);
    expect(state.todoPanelContainer.children).toContain(state.todoPanel);
  });

  it('clears the todo panel when resumed state has no todo store entry', async () => {
    const state = makeTuiState();
    setTodoList(state, [{ title: 'stale todo', status: 'pending' }]);

    const ok = await hydrateTranscriptFromReplay(
      state,
      {
        setAppState: (patch) => {
          state.appState = { ...state.appState, ...patch };
        },
        appendEntry: (entry) => {
          appendEntry(state, entry);
        },
        setTodoList: (todos) => {
          setTodoList(state, todos);
        },
        emitError: () => {},
      },
      sessionWithToolStore({}),
    );

    expect(ok).toBe(true);
    expect(state.todoPanel.getTodos()).toEqual([]);
    expect(state.todoPanelContainer.children).not.toContain(state.todoPanel);
  });

  it('groups 2 adjacent same-step Agents into a single AgentGroupComponent', () => {
    const state = makeTuiState();
    const entries: TranscriptEntry[] = [
      makeAgentEntry('a1', 1, 't1', { is_error: false }),
      makeAgentEntry('a2', 1, 't1', { is_error: false }),
    ];

    hydrate(state, entries);

    const children = state.transcriptContainer.children;
    expect(children.length).toBe(1);
    expect(children[0]).toBeInstanceOf(AgentGroupComponent);
    expect((children[0] as AgentGroupComponent).size()).toBe(2);
    // ToolCallComponent still registers in pendingToolComponents because
    // later wire event routing depends on this mapping.
    expect(state.pendingToolComponents.has('a1')).toBe(true);
    expect(state.pendingToolComponents.has('a2')).toBe(true);
  });

  it('keeps cross-step Agents independent', () => {
    const state = makeTuiState();
    const entries: TranscriptEntry[] = [
      makeAgentEntry('a1', 1, 't1'),
      makeAgentEntry('a2', 2, 't1'),
    ];

    hydrate(state, entries);
    const children = state.transcriptContainer.children;
    expect(children.length).toBe(2);
    expect(children[0]).toBeInstanceOf(ToolCallComponent);
    expect(children[1]).toBeInstanceOf(ToolCallComponent);
  });

  it('does not group when a non-Agent tool sits between Agents', () => {
    const state = makeTuiState();
    const entries: TranscriptEntry[] = [
      makeAgentEntry('a1', 1, 't1'),
      makeBashEntry('b1', 1, 't1'),
      makeAgentEntry('a2', 1, 't1'),
    ];

    hydrate(state, entries);
    const children = state.transcriptContainer.children;
    expect(children.length).toBe(3);
    for (const child of children) expect(child).toBeInstanceOf(ToolCallComponent);
  });

  it('a single Agent is left as a standalone ToolCallComponent', () => {
    const state = makeTuiState();
    hydrate(state, [makeAgentEntry('a1', 1, 't1')]);
    const children = state.transcriptContainer.children;
    expect(children.length).toBe(1);
    expect(children[0]).toBeInstanceOf(ToolCallComponent);
  });

  it('user message between Agents prevents grouping', () => {
    const state = makeTuiState();
    const entries: TranscriptEntry[] = [
      makeAgentEntry('a1', 1, 't1'),
      makeUserEntry('t1', 'hello'),
      makeAgentEntry('a2', 1, 't1'),
    ];

    hydrate(state, entries);
    const children = state.transcriptContainer.children;
    expect(children.length).toBe(3);
    expect(children[0]).toBeInstanceOf(ToolCallComponent);
    expect(children[2]).toBeInstanceOf(ToolCallComponent);
  });

  it('replay does not write pendingAgentGroup (it stays null after hydration)', () => {
    const state = makeTuiState();
    hydrate(state, [makeAgentEntry('a1', 1, 't1'), makeAgentEntry('a2', 1, 't1')]);
    expect(state.pendingAgentGroup).toBeNull();
  });

  it('background Agent replay hydrates only background status rows, not AgentGroupComponent', () => {
    const state = makeTuiState();
    hydrate(state, [
      {
        id: 'e-background-started',
        kind: 'status',
        renderMode: 'plain',
        content: 'explore agent started in background',
      },
      {
        id: 'e-background-completed',
        kind: 'status',
        renderMode: 'plain',
        content: 'explore agent completed in background',
      },
    ]);

    expect(
      state.transcriptContainer.children.some((child) => child instanceof AgentGroupComponent),
    ).toBe(false);
    expect(
      state.transcriptContainer.children.some((child) => child instanceof ToolCallComponent),
    ).toBe(false);
  });

  it('group with mixed completed/failed children renders correct phase tails', () => {
    const state = makeTuiState();
    hydrate(state, [
      makeAgentEntry('a1', 1, 't1', { is_error: false }),
      makeAgentEntry('a2', 1, 't1', { is_error: true }),
    ]);
    const group = state.transcriptContainer.children[0] as AgentGroupComponent;
    const out = group
      .render(120)
      .join('\n')
      .replaceAll(/\[[0-9;]*m/g, '');
    expect(out).toContain('✓ Completed');
    expect(out).toContain('✗ Failed');
  });
});

describe('hydrateTodoPanelFromResume', () => {
  function makeHooks(state: TUIState) {
    return {
      setAppState: vi.fn(),
      appendEntry: vi.fn(),
      setTodoList: (todos: Parameters<typeof setTodoList>[1]) => setTodoList(state, todos),
      emitError: vi.fn(),
    };
  }

  it('clears the panel when all resumed todos are done', async () => {
    const state = makeTuiState();
    const session = sessionWithToolStore({
      todo: [
        { title: 'A', status: 'done' },
        { title: 'B', status: 'done' },
      ],
    });
    await hydrateTranscriptFromReplay(state, makeHooks(state), session);
    expect(state.todoPanel.isEmpty()).toBe(true);
    expect(state.todoPanelContainer.children.length).toBe(0);
  });

  it('restores pending and in-progress todos', async () => {
    const state = makeTuiState();
    const session = sessionWithToolStore({
      todo: [
        { title: 'A', status: 'done' },
        { title: 'B', status: 'in_progress' },
      ],
    });
    await hydrateTranscriptFromReplay(state, makeHooks(state), session);
    expect(state.todoPanel.getTodos()).toEqual([
      { title: 'A', status: 'done' },
      { title: 'B', status: 'in_progress' },
    ]);
    expect(state.todoPanelContainer.children.length).toBe(1);
  });

  it('clears the panel when the tool store has no todo key', async () => {
    const state = makeTuiState();
    const session = sessionWithToolStore({});
    await hydrateTranscriptFromReplay(state, makeHooks(state), session);
    expect(state.todoPanel.isEmpty()).toBe(true);
    expect(state.todoPanelContainer.children.length).toBe(0);
  });

  it('filters out malformed todo items', async () => {
    const state = makeTuiState();
    const session = sessionWithToolStore({
      todo: [
        { title: 'Valid', status: 'pending' },
        { title: '', status: 'done' },
        { status: 'in_progress' },
        'not-an-object',
      ],
    });
    await hydrateTranscriptFromReplay(state, makeHooks(state), session);
    expect(state.todoPanel.getTodos()).toEqual([{ title: 'Valid', status: 'pending' }]);
    expect(state.todoPanelContainer.children.length).toBe(1);
  });
});
