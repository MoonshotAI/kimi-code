import { ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppWorkspace, KimiWebApi } from '@moonshot-ai/app-core/api';
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

function makeCtx(workspaceId: string | null = 'wm_1') {
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
  const client = {
    activeSessionId: ref('s1'),
    activeWorkspaceId: ref(workspaceId),
    status: ref({ cwd: '/a' }),
  };
  const ctx = {
    panel,
    client,
    filePreview,
    previewStale: ref(false),
    diffStale: ref(false),
    onOpenMedia: vi.fn(),
    openFile: vi.fn(),
  } as unknown as PanelAdapterCtx;
  return { tab, panel, client, ctx };
}

function treeProps(tab: PanelTab, ctx: PanelAdapterCtx): TreeProps {
  return (panelTabProps(tab, ctx) as { tree: TreeProps }).tree;
}

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
  sessionsStore().setSessions([]);
  filesStore().fileTreeRootByWorkspace = {};
  setProductTracker(noopProductTracker);
});

afterEach(() => {
  resetKimiClientDeps();
  workspacesStore().workspaces = [];
  sessionsStore().setSessions([]);
  filesStore().fileTreeRootByWorkspace = {};
  setProductTracker(noopProductTracker);
});

describe('web file preview panel adapter workspace roots', () => {
  it('provides and shares roots without changing the file payload on root selection', () => {
    const { tab, panel, client, ctx } = makeCtx();
    let tree = treeProps(tab, ctx);
    expect(tree.roots).toEqual(['/a', '/b']);
    expect(tree.root).toBe('/a');
    expect(tree.cwd).toBe('/a');
    expect(tree.sessionId).toBe('s1');

    tree.onSelectRoot('/b');
    expect(treeProps(tab, ctx).root).toBe('/b');
    expect(panel.updateTabPayload).not.toHaveBeenCalled();

    client.activeWorkspaceId.value = 'wm_2';
    client.status.value = { cwd: '/x' };
    expect(treeProps(tab, ctx).root).toBe('/x');
    treeProps(tab, ctx).onSelectRoot('/y');
    client.activeWorkspaceId.value = 'wm_1';
    client.status.value = { cwd: '/a' };
    expect(treeProps(tab, ctx).root).toBe('/b');

    workspacesStore().workspaces[0]!.additionalDirs = [];
    expect(treeProps(tab, ctx).root).toBe('/a');

    treeProps(tab, ctx).onSelectFile('/a/next.ts');
    expect(panel.updateTabPayload).toHaveBeenCalledWith('file-1', { path: '/a/next.ts' });
  });

  it('falls back for a single root and no registered workspace', () => {
    workspacesStore().workspaces = [makeWorkspace('wm_single', '/single', [])];
    const { tab, client, ctx } = makeCtx('wm_single');
    client.status.value = { cwd: '/single' };
    expect(treeProps(tab, ctx).roots).toEqual(['/single']);
    expect(treeProps(tab, ctx).root).toBe('/single');

    client.activeWorkspaceId.value = null;
    client.status.value = { cwd: '/a' };
    const tree = treeProps(tab, ctx);
    expect(tree.roots).toEqual([]);
    expect(tree.root).toBe('/a');
  });
});
