import { computed, ref } from 'vue';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSession, AppWorkspace, KimiWebApi } from '@moonshot-ai/app-core/api';
import type { PanelTab } from '@moonshot-ai/app-client/composables';
import { resetKimiClientDeps, setKimiClientDeps } from '@moonshot-ai/app-client/client';
import { filesStore, sessionsStore, workspacesStore } from '@moonshot-ai/app-client/stores';
import { noopProductTracker, setProductTracker } from '@moonshot-ai/app-client/contracts';
import { panelTabProps, type PanelAdapterCtx } from '../../src/renderer/components/panel/panelAdapters';

interface TreeProps {
  roots: readonly string[];
  root: string;
  cwd: string;
  sessionId: string | null;
  onSelectRoot: (root: string) => void;
  onSelectFile: (path: string) => void;
}

function makeWorkspace(id: string, root: string, additionalDirs: string[]): AppWorkspace {
  return { id, root, name: id, kind: 'managed', additionalDirs, sessionCount: 0 };
}

function makeSession(id: string, workspaceId: string, cwd: string): AppSession {
  return { id, workspaceId, cwd } as AppSession;
}

function openSession(id: string): void {
  sessionsStore().setActiveSessionId(id);
  const session = sessionsStore().sessions.find((item) => item.id === id);
  if (session !== undefined) workspacesStore().selectWorkspace(workspacesStore().workspaceIdForSession(session));
}

function storeBackedClient() {
  return {
    activeSessionId: computed(() => sessionsStore().activeSessionId ?? null),
    activeWorkspaceId: computed(() => workspacesStore().activeWorkspaceId),
    status: computed(() => ({
      cwd: sessionsStore().sessions.find((item) => item.id === sessionsStore().activeSessionId)?.cwd ?? '',
    })),
  };
}

function makeCtx() {
  const tab = { id: 'file-1', type: 'file', payload: { path: '/a/file.ts' } } as PanelTab;
  const panel = {
    panelTabs: ref([tab]),
    closeTab: vi.fn(),
    activateTab: vi.fn(),
    updateTabPayload: vi.fn(),
    openFilePreview: vi.fn(),
  };
  const filePreview = {
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
    openPreviewInEditor: vi.fn(),
    revealPreviewFile: vi.fn(),
    refreshFilePreview: vi.fn(),
  };
  const client = storeBackedClient();
  const ctx = {
    panel,
    client,
    filePreview,
    previewStale: ref(false),
    diffStale: ref(false),
    onOpenMedia: vi.fn(),
    openFile: vi.fn(),
  } as unknown as PanelAdapterCtx;
  return { tab, panel, ctx };
}

function treeProps(tab: PanelTab, ctx: PanelAdapterCtx): TreeProps {
  return (panelTabProps(tab, ctx) as { tree: TreeProps }).tree;
}

function makeDiffCtx(): PanelAdapterCtx {
  return {
    panel: {
      detailDiffMode: ref('list'),
      detailDiffPath: ref(null),
      openDiffDetail: vi.fn(),
      selectDiffFile: vi.fn(),
      openFilePreview: vi.fn(),
    },
    client: {
      ...storeBackedClient(),
      changes: ref([]),
      gitInfo: ref(null),
      fileDiff: ref([]),
      fileDiffTexts: ref(null),
      fileDiffEmptyFile: ref(false),
      selectedDiffPath: ref(null),
      fileDiffLoading: ref(false),
      fileDiffLoadedSeq: ref(0),
      fileDiffLoadStartedSeq: ref(0),
      fileDiffRefreshing: ref(false),
      loadFileDiff: vi.fn(),
      clearFileDiff: vi.fn(),
    },
    filePreview: {},
    previewStale: ref(false),
    diffStale: ref(false),
    onOpenMedia: vi.fn(),
    openFile: vi.fn(),
  } as unknown as PanelAdapterCtx;
}

beforeAll(() => {
  vi.stubGlobal('WebSocket', undefined);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  setKimiClientDeps({
    api: () => ({ getWorkspaceTrust: async () => ({ trusted: true }) }) as unknown as KimiWebApi,
    t: (key) => key,
  });
  workspacesStore().workspaces = [
    makeWorkspace('wm_1', '/a', ['/b']),
    makeWorkspace('wm_2', '/x', ['/y']),
  ];
  workspacesStore().hiddenWorkspaceIds = [];
  workspacesStore().sessionsHasMoreByWorkspace = {};
  sessionsStore().setSessions([makeSession('s1', 'wm_1', '/a'), makeSession('s2', 'wm_2', '/x')]);
  openSession('s1');
  filesStore().fileTreeRootByWorkspace = {};
  setProductTracker(noopProductTracker);
});

afterEach(() => {
  resetKimiClientDeps();
  workspacesStore().workspaces = [];
  workspacesStore().hiddenWorkspaceIds = [];
  workspacesStore().storedActiveWorkspaceId = null;
  sessionsStore().setActiveSessionId(undefined);
  sessionsStore().setSessions([]);
  filesStore().fileTreeRootByWorkspace = {};
  setProductTracker(noopProductTracker);
});

describe('desktop file preview panel adapter workspace roots', () => {
  it('provides and shares roots without changing the file payload on root selection', () => {
    const { tab, panel, ctx } = makeCtx();
    let tree = treeProps(tab, ctx);
    expect(tree.roots).toEqual(['/a', '/b']);
    expect(tree.root).toBe('/a');
    expect(tree.cwd).toBe('/a');
    expect(tree.sessionId).toBe('s1');

    tree.onSelectRoot('/b');
    expect(treeProps(tab, ctx).root).toBe('/b');
    expect(panel.updateTabPayload).not.toHaveBeenCalled();

    openSession('s2');
    expect(treeProps(tab, ctx).root).toBe('/x');
    treeProps(tab, ctx).onSelectRoot('/y');
    openSession('s1');
    expect(treeProps(tab, ctx).root).toBe('/b');

    workspacesStore().workspaces[0]!.additionalDirs = [];
    expect(treeProps(tab, ctx).root).toBe('/a');

    treeProps(tab, ctx).onSelectFile('/a/next.ts');
    expect(panel.updateTabPayload).toHaveBeenCalledWith('file-1', { path: '/a/next.ts' });
  });

  it('falls back for a single root and no registered workspace', () => {
    workspacesStore().workspaces = [makeWorkspace('wm_single', '/single', [])];
    sessionsStore().setSessions([makeSession('s1', 'wm_single', '/single'), makeSession('s2', 'wm_gone', '/a')]);
    openSession('s1');
    const { tab, ctx } = makeCtx();
    expect(treeProps(tab, ctx).roots).toEqual(['/single']);
    expect(treeProps(tab, ctx).root).toBe('/single');

    workspacesStore().hiddenWorkspaceIds = ['wm_single', 'wm_gone'];
    openSession('s2');
    expect(workspacesStore().activeWorkspaceId).toBeNull();
    const tree = treeProps(tab, ctx);
    expect(tree.roots).toEqual(['/a']);
    expect(tree.root).toBe('/a');
  });

  it('roots the tree at a worktree session working directory instead of the project root', () => {
    workspacesStore().workspaces = [makeWorkspace('wd_repo', '/repo', ['/shared'])];
    sessionsStore().setSessions([makeSession('wt', 'wd_repo', '/repo-wt')]);
    openSession('wt');
    const { tab, ctx } = makeCtx();

    const tree = treeProps(tab, ctx);
    expect(tree.roots).toEqual(['/repo-wt', '/shared']);
    expect(tree.root).toBe('/repo-wt');
    expect(tree.cwd).toBe('/repo-wt');
  });
});

describe('diff panel adapter workspace roots', () => {
  it('uses the selected root for status, file diff, refresh and file preview', () => {
    const adapter = panelTabProps;
    const status = { branch: 'feature', ahead: 2, behind: 1, entries: { 'src/a.ts': 'modified' }, additions: 3, deletions: 1, pullRequest: null };
    filesStore().gitStatusBySessionRoot = { s1: { '/b': status } };
    const tab = { id: 'diff-1', type: 'diff', payload: { root: '/b' } } as PanelTab;
    const panel = {
      detailDiffMode: ref('list'),
      detailDiffPath: ref(null),
      openDiffDetail: vi.fn(),
      selectDiffFile: vi.fn(),
      openFilePreview: vi.fn(),
    };
    const client = {
      ...storeBackedClient(),
      changes: ref([]),
      gitInfo: ref(null),
      fileDiff: ref([]),
      fileDiffTexts: ref(null),
      fileDiffEmptyFile: ref(false),
      selectedDiffPath: ref('src/a.ts'),
      fileDiffLoading: ref(false),
      fileDiffLoadedSeq: ref(0),
      fileDiffLoadStartedSeq: ref(0),
      fileDiffRefreshing: ref(false),
      loadFileDiff: vi.fn(),
      clearFileDiff: vi.fn(),
    };
    const ctx = {
      panel,
      client,
      filePreview: {},
      previewStale: ref(false),
      diffStale: ref(false),
      onOpenMedia: vi.fn(),
      openFile: vi.fn(),
    } as unknown as PanelAdapterCtx;

    const props = adapter(tab, ctx) as {
      roots: string[];
      cwd: string;
      changes: { path: string; status: string }[];
      gitInfo: { branch: string };
      onSelectRoot: (root: string) => void;
      onOpen: (path: string) => void;
      onRefresh: () => void;
      onOpenFile: (path: string) => void;
    };
    expect(props.roots).toEqual(['/a', '/b']);
    expect(props.cwd).toBe('/b');
    expect(props.gitInfo.branch).toBe('feature');
    expect(props.changes).toEqual([{ path: 'src/a.ts', status: 'modified' }]);

    props.onSelectRoot('/a');
    props.onOpen('src/a.ts');
    props.onRefresh();
    props.onOpenFile('src/a.ts');
    expect(panel.openDiffDetail).toHaveBeenCalledExactlyOnceWith('/a');
    expect(panel.selectDiffFile).toHaveBeenCalledExactlyOnceWith('src/a.ts', '/b');
    expect(client.loadFileDiff).toHaveBeenCalledExactlyOnceWith('src/a.ts', { preserveCurrent: true, root: '/b' });
    expect(panel.openFilePreview).toHaveBeenCalledExactlyOnceWith({ path: '/b/src/a.ts' });
  });

  it('offers the working directory of a worktree session first instead of the project root', () => {
    workspacesStore().workspaces = [makeWorkspace('wd_repo', '/repo', ['/shared'])];
    sessionsStore().setSessions([makeSession('wt', 'wd_repo', '/repo-wt')]);
    openSession('wt');
    const tab = { id: 'diff-1', type: 'diff', payload: {} } as PanelTab;

    const props = panelTabProps(tab, makeDiffCtx()) as { roots: string[]; cwd: string };

    expect(props.roots).toEqual(['/repo-wt', '/shared']);
    expect(props.cwd).toBe('/repo-wt');
  });
});
