// @vitest-environment jsdom
import { computed, createApp, h, nextTick, ref, type App, type ComponentPublicInstance } from 'vue';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { useSidebarTabs } from '@moonshot-ai/app-core/composables';
import { ModelDisplayKey, noopProductTracker, setProductTracker, SubagentEffortKey } from '@moonshot-ai/app-client/contracts';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import { AgentPanel, DiffView, FilePreview } from '@moonshot-ai/app-components';
import { saveDiffViewMode } from '@moonshot-ai/app-core/lib';
import type { FileData } from '@moonshot-ai/app-core/client/types';
import ConversationPane from '../../src/renderer/components/chat/ConversationPane.vue';
import appSource from '../../src/renderer/App.vue?raw';
import filePreviewSource from '../../../../packages/app-components/src/FilePreview.vue?raw';
import sideChatPanelSource from '../../../../packages/app-components/src/chat/SideChatPanel.vue?raw';
import agentDetailPanelSource from '../../../../packages/app-components/src/chat/AgentDetailPanel.vue?raw';
import compactionPanelSource from '../../../../packages/app-components/src/chat/CompactionPanel.vue?raw';
import turnDiffPanelSource from '../../../../packages/app-components/src/chat/TurnDiffPanel.vue?raw';
import diffViewSource from '../../../../packages/app-components/src/chat/DiffView.vue?raw';
import chatPaneSource from '../../../../packages/app-components/src/chat/ChatPane.vue?raw';
import workingIndicatorSource from '../../../../packages/app-components/src/chat/WorkingIndicator.vue?raw';

const mocks = vi.hoisted(() => ({
  client: null as unknown,
}));

let apple = false;

function setApplePlatform(value: boolean): void {
  apple = value;
  Object.defineProperty(window.navigator, 'platform', {
    value: value ? 'MacIntel' : 'Linux x86_64',
    configurable: true,
  });
}

vi.mock('@moonshot-ai/app-client/client', () => ({
  sessionObservationOptions: () => ({}),
  turnFileChangesFetcher: () => async () => [],
  useKimiWebClient: () => mocks.client,
}));

vi.mock('../../src/renderer/lib/browserOverlayMenu', () => ({
  registerBrowserOverlayMenu: () => ({ available: false, open: ref(false), close() {}, refresh() {}, toggle() {} }),
}));

vi.mock('../../src/renderer/composables/useNativeTerminal', () => ({
  useNativeTerminal: () => ({ available: false, open: ref(false), toggle: vi.fn() }),
}));

vi.mock('../../src/renderer/components/chat/ChatDock.vue', () => ({
  default: { render: () => h('div', { class: 'chat-dock' }) },
}));

vi.mock('@moonshot-ai/app-markdown', () => ({
  Markdown: { template: '<div />' },
}));

vi.mock('@moonshot-ai/app-components', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@moonshot-ai/app-components')>()),
  ChatPane: {
    render: () => h('div', { class: 'chat' }, [h('p', { class: 'msg' }, 'CHAT_TRANSCRIPT_SENTINEL')]),
  },
  Composer: { render: () => null },
  ConversationToc: { render: () => null },
  KimiMascotPeek: { render: () => null },
  WorkspaceRecentSessions: { render: () => null },
  WorkspaceTrustDialog: { render: () => null },
}));

vi.mock('@moonshot-ai/app-client/composables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@moonshot-ai/app-client/composables')>()),
  useComposerAutoFocus: vi.fn(),
  useEscInterrupt: () => ({ armed: ref(false), reset: vi.fn() }),
  useWorkspaceTrust: () => ({
    trustDenied: ref(false),
    trustReadPending: ref(false),
    trustRejected: ref(false),
    trustGateOpen: ref(false),
    busy: ref(false),
    trustWorkspace: vi.fn(),
    rejectTrust: vi.fn(),
    gateSubmitForTrust: () => true,
  }),
}));

interface ConversationPaneExposed {
  selectAllRegion: (target: EventTarget | null) => Promise<void>;
}

const FILE_LINES = ['export const alpha = 1;', 'export const beta = 2;', 'export const gamma = 3;'];

function codeFile(): FileData {
  return {
    path: '/workspace/src/example.ts',
    content: `${FILE_LINES.join('\n')}\n`,
    encoding: 'utf-8',
    mime: 'text/plain',
    languageId: 'typescript',
    isBinary: false,
    size: 80,
  };
}

let app: App | null = null;
let host: HTMLDivElement;
let pane: ConversationPaneExposed;

function mountWorkspace(renderPanel?: () => ReturnType<typeof h>): void {
  const status = computed(() => ({ cwd: '/workspace' }));
  mocks.client = {
    onboarded: ref(true),
    dangerousBypassAuth: ref(false),
    turns: ref([{ id: 'turn-1' }]),
    pendingApprovals: ref([]),
    tasks: ref([]),
    todos: ref([]),
    goal: ref(null),
    questions: ref([]),
    turnActive: ref(false),
    isStartingFirstPrompt: ref(false),
    compaction: ref({ state: 'idle' }),
    sessionLoading: ref(false),
    hasMoreMessages: ref(false),
    loadingMoreMessages: ref(false),
    historyWindowState: ref({ startIndex: 0, totalCount: 1 }),
    sessionPlans: ref([]),
    workspacesView: ref([]),
    activeWorkspaceId: ref('ws-1'),
    draftEntry: ref('workspace'),
    draftEntryNonce: ref(0),
    visibleWorkspace: ref(null),
    status,
    activeTurnError: ref(null),
    activeTurnRetry: ref(null),
    activeTurnEnd: ref(null),
    recentSessionsForWorkspace: () => [],
    activeSessionId: ref('session-1'),
    sessionById: () => undefined,
    loadOlderMessages: vi.fn(),
    reorderQueuedPrompts: vi.fn(),
    editQueuedPrompt: vi.fn(),
    forkFromTurn: vi.fn(),
  };
  const paneRef = ref<ComponentPublicInstance | null>(null);
  app = createApp({
    render: () => h('div', [
      h(ConversationPane, {
        ref: paneRef,
        sessionId: 'session-1',
        status: status.value as never,
        supportsReplyFeedback: false,
      }),
      h('aside', { class: 'global-preview open' }, [
        h('div', { class: 'panel-tab-bar' }, [
          h('button', { class: 'ptb-tab-main', type: 'button' }, 'PANEL_TAB_SENTINEL'),
        ]),
        h('div', { class: 'pt-body' }, [
          renderPanel
            ? renderPanel()
            : h(FilePreview, {
                file: codeFile(),
                loading: false,
                displayPath: '/workspace/src/example.ts',
                treeAvailable: true,
                treeOpen: true,
              }, {
                sidebar: () => h('div', { class: 'tree-list' }, 'FILE_TREE_SENTINEL'),
              }),
        ]),
      ]),
    ]),
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(panelApiKey, undefined);
  app.provide(ModelDisplayKey, (alias: string | undefined) => alias);
  app.provide(SubagentEffortKey, () => undefined);
  app.mount(host);
  pane = paneRef.value as unknown as ConversationPaneExposed;
}

function pointerDown(target: Element): void {
  target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
}

function pressSelectAll(target: EventTarget): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'a',
    code: 'KeyA',
    metaKey: apple,
    ctrlKey: !apple,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  useSidebarTabs().setSidebarTabs(true);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  setProductTracker(noopProductTracker);
  setApplePlatform(false);
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  window.getSelection()?.removeAllRanges();
});

describe.each([
  ['Ctrl+A on Windows/Linux', false],
  ['Cmd+A on macOS', true],
])('right panel file preview select-all (%s)', (_label, isApple) => {
  beforeEach(async () => {
    setApplePlatform(isApple);
    mountWorkspace();
    await nextTick();
  });

  it('selects only the file content after clicking inside the file preview', async () => {
    const codeText = host.querySelector('.fp-body .hl-text')!;
    pointerDown(codeText);

    const event = pressSelectAll(document.body);
    await nextTick();

    expect(event.defaultPrevented).toBe(true);
    const selection = window.getSelection()!;
    expect(selection.isCollapsed).toBe(false);
    for (const line of FILE_LINES) expect(selection.toString()).toContain(line);
    expect(selection.toString()).not.toContain('example.ts');
    expect(selection.toString()).not.toContain('PANEL_TAB_SENTINEL');
    expect(selection.toString()).not.toContain('FILE_TREE_SENTINEL');
    expect(selection.toString()).not.toContain('CHAT_TRANSCRIPT_SENTINEL');
    expect(host.querySelector('.fp-body')!.contains(selection.getRangeAt(0).commonAncestorContainer)).toBe(true);
  });

  it('selects only the file content from the menu path when a panel tab has focus', async () => {
    const tab = host.querySelector<HTMLButtonElement>('.ptb-tab-main')!;
    tab.focus();
    pointerDown(tab);

    await pane.selectAllRegion(document.activeElement);

    const selection = window.getSelection()!;
    expect(selection.isCollapsed).toBe(false);
    for (const line of FILE_LINES) expect(selection.toString()).toContain(line);
    expect(selection.toString()).not.toContain('example.ts');
    expect(selection.toString()).not.toContain('PANEL_TAB_SENTINEL');
    expect(selection.toString()).not.toContain('FILE_TREE_SENTINEL');
    expect(selection.toString()).not.toContain('CHAT_TRANSCRIPT_SENTINEL');
  });

  it('leaves native input select-all inside the right panel untouched', async () => {
    const input = document.createElement('input');
    input.value = 'search text';
    host.querySelector('.global-preview')!.append(input);
    input.focus();
    pointerDown(input);

    const event = pressSelectAll(input);
    await nextTick();

    expect(event.defaultPrevented).toBe(false);
    expect(window.getSelection()?.toString() ?? '').not.toContain(FILE_LINES[0]!);
  });

  it('still selects the chat transcript when attending to the main conversation', async () => {
    pointerDown(host.querySelector('.chat .msg')!);

    const event = pressSelectAll(document.body);
    await nextTick();

    expect(event.defaultPrevented).toBe(true);
    const text = window.getSelection()!.toString();
    expect(text).toContain('CHAT_TRANSCRIPT_SENTINEL');
    expect(text).not.toContain(FILE_LINES[0]!);
  });
});

describe('right panel select-all scope across panel states', () => {
  it('scopes select-all to the error message in file preview error state', async () => {
    mountWorkspace(() => h(FilePreview, {
      file: null,
      loading: false,
      error: 'FILE_ERROR_SENTINEL',
      closable: true,
      displayPath: '/workspace/src/missing-file.ts',
      treeAvailable: true,
      treeOpen: true,
    }, {
      sidebar: () => h('div', { class: 'tree-list' }, 'FILE_TREE_SENTINEL'),
    }));
    await nextTick();

    pointerDown(host.querySelector('.fp-error span')!);
    pressSelectAll(document.body);
    await nextTick();

    const text = window.getSelection()!.toString();
    expect(text).toContain('FILE_ERROR_SENTINEL');
    expect(text).not.toContain('missing-file.ts');
    expect(text).not.toContain('PANEL_TAB_SENTINEL');
    expect(text).not.toContain('FILE_TREE_SENTINEL');
  });

  it('scopes select-all to the loading indicator in file preview loading state', async () => {
    mountWorkspace(() => h(FilePreview, {
      file: null,
      loading: true,
      displayPath: '/workspace/src/loading-file.ts',
    }));
    await nextTick();

    pointerDown(host.querySelector('.fp-loading')!);
    pressSelectAll(document.body);
    await nextTick();

    const text = window.getSelection()!.toString();
    expect(text).not.toContain('loading-file.ts');
    expect(text).not.toContain('PANEL_TAB_SENTINEL');
  });

  it('selects only the side chat transcript without the side chat composer', async () => {
    mountWorkspace(() => h('div', { class: 'sc' }, [
      h('div', { class: 'sc-body', 'data-panel-content': '' }, [
        h('div', { class: 'chat' }, [
          h('p', 'SIDE_QUESTION_SENTINEL'),
          h('p', 'SIDE_CHAT_REPLY_SENTINEL'),
        ]),
      ]),
      h('div', { class: 'sc-composer' }, [
        h('div', { class: 'composer-placeholder' }, 'SIDE_COMPOSER_PLACEHOLDER_SENTINEL'),
      ]),
    ]));
    await nextTick();

    pointerDown(host.querySelector('.sc-body .chat p')!.parentElement!);
    pressSelectAll(document.body);
    await nextTick();

    const text = window.getSelection()!.toString();
    expect(text).toContain('SIDE_CHAT_REPLY_SENTINEL');
    expect(text).not.toContain('SIDE_COMPOSER_PLACEHOLDER_SENTINEL');
    expect(text).not.toContain('PANEL_TAB_SENTINEL');
  });

  it('scopes select-all to the changed-file list in Diff list state', async () => {
    saveDiffViewMode('list');
    mountWorkspace(() => h(DiffView, {
      mode: 'list',
      changes: [{ path: 'src/diff-list-sentinel.ts', status: 'modified' }],
      gitInfo: { branch: 'header-branch-sentinel', ahead: 0, behind: 0 },
    }));
    await nextTick();

    pointerDown(host.querySelector('.ch-list .fpath')!);
    pressSelectAll(document.body);
    await nextTick();

    const text = window.getSelection()!.toString();
    expect(text).toContain('diff-list-sentinel.ts');
    expect(text).not.toContain('header-branch-sentinel');
    expect(text).not.toContain('PANEL_TAB_SENTINEL');
    expect(text).not.toContain('CHAT_TRANSCRIPT_SENTINEL');
  });

  it('scopes select-all to the changed-file tree in Diff tree state', async () => {
    saveDiffViewMode('tree');
    mountWorkspace(() => h(DiffView, {
      mode: 'list',
      changes: [{ path: 'src/diff-tree-sentinel.ts', status: 'added' }],
      gitInfo: { branch: 'header-branch-sentinel', ahead: 0, behind: 0 },
    }));
    await nextTick();

    pointerDown(host.querySelector('.ch-tree .tree-file .tree-name')!);
    pressSelectAll(document.body);
    await nextTick();

    const text = window.getSelection()!.toString();
    expect(text).toContain('diff-tree-sentinel.ts');
    expect(text).not.toContain('header-branch-sentinel');
    expect(text).not.toContain('PANEL_TAB_SENTINEL');
    expect(text).not.toContain('CHAT_TRANSCRIPT_SENTINEL');
  });

  it('scopes select-all to the empty state in Diff clean state', async () => {
    saveDiffViewMode('list');
    mountWorkspace(() => h(DiffView, {
      mode: 'list',
      changes: [],
      gitInfo: { branch: 'header-branch-sentinel', ahead: 0, behind: 0 },
    }));
    await nextTick();

    pointerDown(host.querySelector('.changes-pane > .empty-state')!);
    pressSelectAll(document.body);
    await nextTick();

    const text = window.getSelection()!.toString();
    expect(text).not.toContain('header-branch-sentinel');
    expect(text).not.toContain('PANEL_TAB_SENTINEL');
    expect(text).not.toContain('CHAT_TRANSCRIPT_SENTINEL');
  });

  it('scopes select-all to command and output in Bash sub-agent panels', async () => {
    mountWorkspace(() => h(AgentPanel, {
      member: {
        id: 'bash-1',
        name: 'Bash helper',
        kind: 'bash',
        phase: 'completed',
        status: 'completed',
        prompt: 'echo BASH_COMMAND_SENTINEL',
        outputLines: ['BASH_OUTPUT_SENTINEL'],
      },
      turns: [],
      running: false,
      loading: false,
      loadError: false,
      hasMore: false,
      loadingMore: false,
      loadMoreError: false,
    }));
    await nextTick();

    pointerDown(host.querySelector('.bp-output-inner')!);
    pressSelectAll(document.body);
    await nextTick();

    const text = window.getSelection()!.toString();
    expect(text).toContain('BASH_COMMAND_SENTINEL');
    expect(text).toContain('BASH_OUTPUT_SENTINEL');
    expect(text).not.toContain('PANEL_TAB_SENTINEL');
    expect(text).not.toContain('CHAT_TRANSCRIPT_SENTINEL');
  });

  it('falls back to selecting the panel for tabs without a marked content region', async () => {
    mountWorkspace(() => h('div', { class: 'unmarked-panel' }, 'UNMARKED_PANEL_SENTINEL'));
    await nextTick();

    pointerDown(host.querySelector('.unmarked-panel')!);
    pressSelectAll(document.body);
    await nextTick();

    expect(window.getSelection()!.toString()).toContain('UNMARKED_PANEL_SENTINEL');
  });
});

describe('select-all scope contracts', () => {
  it('marks primary content regions in right panel components', () => {
    expect(filePreviewSource).toMatch(/class="fp-empty fp-error"[^>]*data-panel-content/);
    expect(filePreviewSource).toMatch(/class="fp-empty"[^>]*data-panel-content/);
    expect(filePreviewSource).toMatch(/class="fp-loading"[^>]*data-panel-content/);
    expect(filePreviewSource).toMatch(/class="fp-body"[^>]*data-panel-content/);
    expect(filePreviewSource).toMatch(/class="fp-body fp-code"[^>]*data-panel-content/);
    expect(filePreviewSource).toMatch(/class="fp-body fp-pdf-wrap"[^>]*data-panel-content/);
    expect(filePreviewSource).toMatch(/class="fp-body fp-table-wrap"[^>]*data-panel-content/);
    expect(filePreviewSource).toMatch(/class="fp-body fp-image-wrap"[^>]*data-panel-content/);
    expect(filePreviewSource).toMatch(/class="fp-body fp-binary-wrap"[^>]*data-panel-content/);
    expect(sideChatPanelSource).toMatch(/class="sc-body"[^>]*data-panel-content/);
    expect(agentDetailPanelSource).toMatch(/class="agent-transcript"[^>]*data-panel-content/);
    expect(compactionPanelSource).toMatch(/class="cp-scroll"[^>]*data-panel-content/);
    expect(compactionPanelSource).toMatch(/class="cp-empty"[^>]*data-panel-content/);
    expect(turnDiffPanelSource).toMatch(/class="td-body"[^>]*data-panel-content/);
    expect(diffViewSource).toMatch(/class="dv-detail-body"[^>]*data-panel-content/);
  });

  it('keeps UI metadata and error action buttons out of text selections', () => {
    expect(chatPaneSource).toMatch(/\.u-meta\s*\{[^}]*user-select: none;/);
    expect(chatPaneSource).toMatch(/\.a-msg-ft\s*\{[^}]*user-select: none;/);
    expect(filePreviewSource).toMatch(/\.fp-error\s*:deep\(\.ui-button\)\s*\{[^}]*user-select: none;/);
  });

  it('keeps transient indicators, dividers, and queue controls out of chat selections', () => {
    expect(workingIndicatorSource).toMatch(/\.working-indicator\s*\{[^}]*user-select: none;/);
    expect(chatPaneSource).toMatch(/\.sending-placeholder\s*\{[^}]*user-select: none;/);
    expect(chatPaneSource).toMatch(/\.compact-divider\s*\{[^}]*user-select: none;/);
    expect(chatPaneSource).toMatch(/\.turn-failed\s*:deep\(\.ui-button\)\s*\{[^}]*user-select: none;/);
    expect(chatPaneSource).toMatch(/\.q-head\s*\{[^}]*user-select: none;/);
    expect(chatPaneSource).toMatch(/\.q-send\s*\{[^}]*user-select: none;/);
    expect(chatPaneSource).toMatch(/\.q-grip\s*\{[^}]*user-select: none;/);
  });

  it('routes terminal menu select-all to the terminal buffer before textarea selection', () => {
    const fnStart = appSource.indexOf('function selectAllFromMenu()');
    const fnEnd = appSource.indexOf('function undoRedoFromMenu', fnStart);
    const body = appSource.slice(fnStart, fnEnd);
    expect(body.indexOf('selectAllTerminalIn')).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('selectAllTerminalIn')).toBeLessThan(body.indexOf('HTMLTextAreaElement'));
  });
});

