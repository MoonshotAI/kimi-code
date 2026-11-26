// @vitest-environment jsdom
import { computed, createApp, h, nextTick, ref, type App } from 'vue';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { useSidebarTabs } from '@moonshot-ai/app-core';
import type { AppSession, AppWorkspace } from '@moonshot-ai/app-core/api';
import type { ConversationStatus } from '@moonshot-ai/app-core/client/types';
import type { PanelTab } from '@moonshot-ai/app-client/composables';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import { ModelDisplayKey, noopProductTracker, setProductTracker, SubagentEffortKey } from '@moonshot-ai/app-client/contracts';
import { filesStore, sessionsStore, workspacesStore } from '@moonshot-ai/app-client/stores';
import ChatHeader from '../../src/renderer/components/chat/ChatHeader.vue';
import ConversationPane from '../../src/renderer/components/chat/ConversationPane.vue';
import { panelTabProps, type PanelAdapterCtx } from '../../src/renderer/components/panel/panelAdapters';

const mocks = vi.hoisted(() => ({
  client: null as unknown,
  terminalToggle: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('@moonshot-ai/app-client/client', () => ({
  sessionObservationOptions: () => ({}),
  turnFileChangesFetcher: () => async () => [],
  useKimiWebClient: () => mocks.client,
}));
vi.mock('../../src/renderer/lib/browserOverlayMenu', () => ({
  registerBrowserOverlayMenu: () => ({ available: false, open: ref(false), close() {}, refresh() {}, toggle() {} }),
}));
vi.mock('../../src/renderer/composables/useNativeTerminal', () => ({
  useNativeTerminal: () => ({ available: true, open: ref(false), toggle: mocks.terminalToggle }),
}));
vi.mock('@moonshot-ai/app-components', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@moonshot-ai/app-components')>()),
  ChatPane: { render: () => null },
  Composer: { render: () => null },
  ConversationToc: { render: () => null },
  KimiMascotPeek: { render: () => null },
  OpenInMenu: {
    props: ['workDir'],
    render(this: { workDir: string }) {
      return h('div', { class: 'open-in', 'data-work-dir': this.workDir });
    },
  },
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
vi.mock('@moonshot-ai/app-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@moonshot-ai/app-ui')>()),
  Icon: { render: () => null },
  IconButton: {
    render(this: { $slots: { default?: () => ReturnType<typeof h>[] } }) {
      return h('button', this.$slots.default?.());
    },
  },
  Menu: { render: () => null },
  MenuItem: { render: () => null },
  Tooltip: {
    render(this: { $slots: { default?: () => ReturnType<typeof h>[] } }) {
      return h('span', this.$slots.default?.());
    },
  },
}));

interface RootsSeen {
  fileTree: { root: string; cwd: string; roots: readonly string[] };
  diffPicker: { cwd: string; roots: readonly string[] };
  terminal: unknown;
  openIn: string | null | undefined;
}

const repo: AppWorkspace = {
  id: 'wd_repo',
  root: '/repo',
  name: 'repo',
  kind: 'implicit',
  additionalDirs: ['/shared'],
  sessionCount: 2,
};

function session(id: string, cwd: string): AppSession {
  return { id, title: id, workspaceId: repo.id, cwd, createdAt: '', updatedAt: '' } as AppSession;
}

let app: App | null = null;
let host: HTMLDivElement;

function mountHeader(): void {
  mocks.client = {
    activeSessionId: computed(() => sessionsStore().activeSessionId ?? ''),
    activeSessionArchived: ref(false),
    activeSessionEnvironment: ref('local'),
    visibleWorkspace: computed(() => workspacesStore().visibleWorkspace),
  };
  app = createApp({ render: () => h(ChatHeader) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(panelApiKey, undefined);
  app.mount(host);
}

function mountEmptyConversation(): void {
  const status = computed(() => ({
    cwd: sessionsStore().sessions.find((item) => item.id === sessionsStore().activeSessionId)?.cwd ?? '',
  }) as ConversationStatus);
  mocks.client = {
    onboarded: ref(true),
    dangerousBypassAuth: ref(false),
    turns: ref([]),
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
    historyWindowState: ref({ startIndex: 0, totalCount: 0 }),
    sessionPlans: ref([]),
    workspacesView: computed(() => workspacesStore().workspacesView),
    activeWorkspaceId: computed(() => workspacesStore().activeWorkspaceId),
    draftEntry: ref('workspace'),
    draftEntryNonce: ref(0),
    visibleWorkspace: computed(() => workspacesStore().visibleWorkspace),
    status,
    activeTurnError: ref(null),
    activeTurnRetry: ref(null),
    activeTurnEnd: ref(null),
    recentSessionsForWorkspace: () => [],
    activeSessionId: computed(() => sessionsStore().activeSessionId ?? ''),
    sessionById: () => undefined,
    loadOlderMessages: vi.fn(),
    reorderQueuedPrompts: vi.fn(),
    editQueuedPrompt: vi.fn(),
    forkFromTurn: vi.fn(),
  };
  app = createApp({ render: () => h(ConversationPane, { status: status.value, supportsReplyFeedback: false }) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(panelApiKey, undefined);
  app.provide(ModelDisplayKey, (alias: string | undefined) => alias);
  app.provide(SubagentEffortKey, () => undefined);
  app.mount(host);
}

interface EmptyConversationSeen {
  paths: (string | null)[];
  terminal: unknown;
  openIn: string | null | undefined;
}

function emptyConversationSeen(): EmptyConversationSeen {
  mocks.terminalToggle.mockClear();
  host.querySelector<HTMLButtonElement>('.ws-home-action')!.click();
  return {
    paths: [...host.querySelectorAll('.ws-home-path')].map((path) => path.textContent),
    terminal: mocks.terminalToggle.mock.lastCall?.[0],
    openIn: host.querySelector('.ws-home .open-in')?.getAttribute('data-work-dir'),
  };
}

function panelCtx(): PanelAdapterCtx {
  return {
    panel: {
      panelTabs: ref([]),
      detailDiffMode: ref('list'),
      detailDiffPath: ref(null),
    },
    client: {
      activeSessionId: computed(() => sessionsStore().activeSessionId ?? null),
      activeWorkspaceId: computed(() => workspacesStore().activeWorkspaceId),
      status: computed(() => ({
        cwd: sessionsStore().sessions.find((item) => item.id === sessionsStore().activeSessionId)?.cwd ?? '',
      })),
      changes: ref([]),
      gitInfo: ref(null),
      fileDiff: ref([]),
      fileDiffTexts: ref(null),
      fileDiffEmptyFile: ref(false),
      selectedDiffPath: ref(null),
      fileDiffLoading: ref(false),
      fileDiffRefreshing: ref(false),
    },
    filePreview: {
      previewFile: ref(null),
      previewLoading: ref(false),
      previewError: ref(null),
      previewDownloadUrl: ref(null),
      previewMediaUrl: ref(null),
      previewAbsolutePath: ref(null),
      previewTarget: ref(null),
      previewExternalActions: ref(false),
      previewNormalizedPath: ref(null),
      previewRefreshing: ref(false),
    },
    previewStale: ref(false),
    diffStale: ref(false),
    onOpenMedia: vi.fn(),
    openFile: vi.fn(),
  } as unknown as PanelAdapterCtx;
}

function rootsSeen(): RootsSeen {
  const ctx = panelCtx();
  const fileTab = { id: 'file-1', type: 'file', payload: { path: 'README.md' } } as PanelTab;
  const diffTab = { id: 'diff-1', type: 'diff', payload: {} } as PanelTab;
  const { tree } = panelTabProps(fileTab, ctx) as { tree: RootsSeen['fileTree'] };
  const diff = panelTabProps(diffTab, ctx) as RootsSeen['diffPicker'];
  mocks.terminalToggle.mockClear();
  host.querySelector<HTMLButtonElement>('.ch-terminal')!.click();
  return {
    fileTree: { root: tree.root, cwd: tree.cwd, roots: tree.roots },
    diffPicker: { cwd: diff.cwd, roots: diff.roots },
    terminal: mocks.terminalToggle.mock.lastCall?.[0],
    openIn: host.querySelector('.open-in')?.getAttribute('data-work-dir'),
  };
}

function sameRootEverywhere(root: string, roots: readonly string[]): RootsSeen {
  return {
    fileTree: { root, cwd: root, roots },
    diffPicker: { cwd: root, roots },
    terminal: root,
    openIn: root,
  };
}

beforeAll(() => {
  vi.stubGlobal('WebSocket', undefined);
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  useSidebarTabs().setSidebarTabs(true);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  setProductTracker(noopProductTracker);
  mocks.terminalToggle = vi.fn();
  host = document.createElement('div');
  document.body.append(host);
  workspacesStore().workspaces = [repo];
  workspacesStore().hiddenWorkspaceIds = [];
  workspacesStore().sessionsHasMoreByWorkspace = {};
  sessionsStore().setSessions([session('wt', '/repo-wt'), session('main', '/repo')]);
  workspacesStore().selectWorkspace(repo.id);
  filesStore().fileTreeRootByWorkspace = {};
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  sessionsStore().setActiveSessionId(undefined);
  sessionsStore().setSessions([]);
  workspacesStore().workspaces = [];
  workspacesStore().storedActiveWorkspaceId = null;
  filesStore().fileTreeRootByWorkspace = {};
});

describe('session panel roots', () => {
  it('gives the file tree, diff picker, terminal and Open In the same root for each session', async () => {
    sessionsStore().setActiveSessionId('wt');
    mountHeader();
    await nextTick();
    expect(rootsSeen()).toEqual(sameRootEverywhere('/repo-wt', ['/repo-wt', '/shared']));

    sessionsStore().setActiveSessionId('main');
    await nextTick();
    expect(rootsSeen()).toEqual(sameRootEverywhere('/repo', ['/repo', '/shared']));
  });

  it('shows the same root on the page of a session without turns', async () => {
    sessionsStore().setActiveSessionId('wt');
    mountEmptyConversation();
    await nextTick();
    expect(emptyConversationSeen()).toEqual({ paths: ['/repo-wt', '/shared'], terminal: '/repo-wt', openIn: '/repo-wt' });

    sessionsStore().setActiveSessionId('main');
    await nextTick();
    expect(emptyConversationSeen()).toEqual({ paths: ['/repo', '/shared'], terminal: '/repo', openIn: '/repo' });

    sessionsStore().setActiveSessionId(undefined);
    await nextTick();
    expect(emptyConversationSeen()).toEqual({ paths: ['/repo', '/shared'], terminal: '/repo', openIn: '/repo' });
  });

  it('gives every panel the project primary directory on the draft page', async () => {
    mountHeader();
    await nextTick();
    expect(rootsSeen()).toEqual(sameRootEverywhere('/repo', ['/repo', '/shared']));
  });
});
