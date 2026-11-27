// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, ref, type App, type Ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';

const fakes = vi.hoisted(() => ({
  client: null as unknown as {
    activeSessionId: Ref<string | null>;
    activeWorkspaceId: Ref<string | null>;
    status: Ref<{ cwd: string }>;
    turns: Ref<unknown[]>;
    [key: string]: unknown;
  },
  files: null as unknown as {
    filePreviewTargetOf: ReturnType<typeof vi.fn>;
    setFilePreviewTarget: ReturnType<typeof vi.fn>;
    resolveFileTreeRoot: ReturnType<typeof vi.fn>;
    selectFileTreeRoot: ReturnType<typeof vi.fn>;
  },
  workspaces: null as unknown as {
    workspaces: Array<{ id: string; root: string; name: string; additionalDirs: string[] }>;
    mergedWorkspaces: Array<{ id: string; root: string; name: string; additionalDirs: string[] }>;
    activePanelRoots: { root: string; roots: string[] };
  },
  preview: null as unknown as Record<string, unknown> & {
    openFilePreview: ReturnType<typeof vi.fn>;
    closeFilePreview: ReturnType<typeof vi.fn>;
  },
  staleness: null as unknown as Record<string, unknown>,
}));

vi.mock('@moonshot-ai/app-client/client', () => ({
  useKimiWebClient: () => fakes.client,
}));

vi.mock('@moonshot-ai/app-client/stores', () => ({
  filesStore: () => fakes.files,
  workspacesStore: () => fakes.workspaces,
}));

vi.mock('@moonshot-ai/app-client/contracts', () => ({ track: vi.fn() }));
vi.mock('@moonshot-ai/app-client/composables', () => ({
  useFilePreview: () => fakes.preview,
}));
vi.mock('@moonshot-ai/app-ui', () => ({
  EmptyState: { render: () => null },
  Icon: { render: () => null },
  IconButton: { render: () => null },
  PanelHeader: { render: () => null },
}));
vi.mock('../src/FilePreview.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/FileTreePositionMenu.vue', () => ({ default: { render: () => null } }));
vi.mock('../src/FileTreeRootSelect.vue', () => ({
  default: {
    render(this: { $emit: (event: string, root: string) => void }) {
      return h('button', { class: 'root-select', onClick: () => this.$emit('select', '/extra-a') });
    },
  },
}));
vi.mock('../src/FileTreeSidebar.vue', () => ({
  default: {
    props: ['sessionId', 'workspaceId', 'cwd', 'root', 'selectedPath'],
    render(this: { workspaceId?: string; cwd: string; root?: string }) {
      return h('div', {
        class: 'tree-sidebar',
        'data-workspace-id': this.workspaceId,
        'data-cwd': this.cwd,
        'data-root': this.root,
      });
    },
  },
}));
vi.mock('../src/FileTreeSidebarFrame.vue', () => ({
  default: {
    render(this: { $slots: { default?: () => ReturnType<typeof h>[] } }) {
      return h('div', this.$slots.default?.());
    },
  },
}));
vi.mock('../src/composables/useFileTreePosition', () => ({
  useFileTreePosition: () => ({ position: ref('right') }),
}));
vi.mock('../src/composables/useFileStaleness', () => ({
  useFileStaleness: () => fakes.staleness,
}));

import FilesPanel from '../src/FilesPanel.vue';

let app: App | null = null;
let host: HTMLDivElement;
let previews: Map<string, { path: string }>;
let selectedRoots: Record<string, string>;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  previews = new Map([
    ['workspace:w1', { path: '/extra-a/a.txt' }],
    ['workspace:w2', { path: '/extra-b/b.txt' }],
  ]);
  selectedRoots = reactive({});
  fakes.client = {
    activeSessionId: ref(null),
    activeWorkspaceId: ref('w1'),
    status: ref({ cwd: '/repo' }),
    turns: ref([]),
    getFileDownloadUrl: vi.fn(),
    readHostFileContent: vi.fn(),
    readFileContent: vi.fn(),
    readWorkspaceFileBlob: vi.fn(),
    openWorkspaceFile: vi.fn(),
    revealWorkspaceFile: vi.fn(),
  };
  fakes.files = {
    filePreviewTargetOf: vi.fn((key: string) => previews.get(key) ?? null),
    setFilePreviewTarget: vi.fn(),
    resolveFileTreeRoot: vi.fn((id: string | null, roots: readonly string[], cwd: string) => {
      const remembered = id === null ? undefined : selectedRoots[id];
      return remembered !== undefined && roots.includes(remembered) ? remembered : (roots[0] ?? cwd);
    }),
    selectFileTreeRoot: vi.fn((id: string | null, roots: readonly string[], root: string) => {
      if (id !== null && roots.includes(root)) selectedRoots[id] = root;
    }),
  };
  const items = reactive([
    { id: 'w1', root: '/repo', name: 'A', additionalDirs: ['/extra-a'] },
    { id: 'w2', root: '/repo', name: 'B', additionalDirs: ['/extra-b'] },
  ]);
  fakes.workspaces = reactive({
    workspaces: items,
    mergedWorkspaces: items,
    activePanelRoots: { root: '/repo', roots: ['/repo', '/extra-a'] },
  });
  fakes.preview = {
    previewTarget: ref(null),
    previewFile: ref(null),
    previewLoading: ref(false),
    previewError: ref(null),
    previewRefreshing: ref(false),
    previewDownloadUrl: ref(null),
    previewExternalActions: ref(false),
    previewAbsolutePath: ref(null),
    previewNormalizedPath: ref(null),
    previewLoadedSeq: ref(0),
    previewLoadStartedSeq: ref(0),
    previewMediaUrl: ref(null),
    openFilePreview: vi.fn(),
    closeFilePreview: vi.fn(),
    refreshFilePreview: vi.fn(),
    openPreviewInEditor: vi.fn(),
    revealPreviewFile: vi.fn(),
  };
  fakes.staleness = {
    markers: ref(new Map()),
    createTracker: () => ({ stale: ref(false), markLoaded: vi.fn() }),
  };
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  window.localStorage.clear();
});

async function mountPanel(): Promise<void> {
  app = createApp({ render: () => h(FilesPanel) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
  await nextTick();
}

describe('FilesPanel draft preview scope', () => {
  it('closes and restores previews by workspace ID when switching between same-root projects', async () => {
    await mountPanel();
    expect(fakes.preview.openFilePreview).toHaveBeenCalledWith({ path: '/extra-a/a.txt' });
    fakes.preview.openFilePreview.mockClear();

    fakes.client.activeWorkspaceId.value = 'w2';
    fakes.workspaces.activePanelRoots = { root: '/repo', roots: ['/repo', '/extra-b'] };
    await nextTick();

    expect(fakes.preview.closeFilePreview).toHaveBeenCalledOnce();
    expect(fakes.preview.openFilePreview).toHaveBeenCalledWith({ path: '/extra-b/b.txt' });
    expect(fakes.preview.openFilePreview).not.toHaveBeenCalledWith({ path: '/extra-a/a.txt' });
    expect(fakes.files.filePreviewTargetOf).toHaveBeenCalledWith('workspace:w2');
  });

  it('retains the cwd preview key when no workspace ID is available', async () => {
    fakes.client.activeWorkspaceId.value = null;
    fakes.workspaces.activePanelRoots = { root: '/repo', roots: ['/repo'] };
    previews.set('workspace:/repo', { path: 'legacy.txt' });

    await mountPanel();

    expect(fakes.preview.openFilePreview).toHaveBeenCalledWith({ path: 'legacy.txt' });
  });

  it('closes the current preview when switching the file tree root', async () => {
    await mountPanel();
    fakes.preview.closeFilePreview.mockClear();

    host.querySelector<HTMLButtonElement>('.root-select')!.click();
    await nextTick();

    expect(fakes.preview.closeFilePreview).toHaveBeenCalledOnce();
  });

  it('closes the current preview when its root is removed from the project', async () => {
    await mountPanel();
    host.querySelector<HTMLButtonElement>('.root-select')!.click();
    await nextTick();
    fakes.preview.closeFilePreview.mockClear();

    fakes.workspaces.activePanelRoots = { root: '/repo', roots: ['/repo'] };
    await nextTick();

    expect(fakes.preview.closeFilePreview).toHaveBeenCalledOnce();
  });

  it('passes the registered workspace ID and selected root to the sidebar', async () => {
    await mountPanel();
    const sidebar = host.querySelector<HTMLElement>('.tree-sidebar')!;
    expect(sidebar.getAttribute('data-workspace-id')).toBe('w1');
    expect(sidebar.getAttribute('data-root')).toBe('/repo');

    host.querySelector<HTMLButtonElement>('.root-select')!.click();
    await nextTick();

    expect(sidebar.getAttribute('data-workspace-id')).toBe('w1');
    expect(sidebar.getAttribute('data-root')).toBe('/extra-a');
  });

  it('does not treat a derived workspace ID as registered', async () => {
    fakes.workspaces.workspaces = [];
    await mountPanel();

    expect(host.querySelector<HTMLElement>('.tree-sidebar')!.getAttribute('data-workspace-id')).toBeNull();
  });
});

describe('FilesPanel session roots', () => {
  it('roots the tree at a worktree session working directory instead of the project root', async () => {
    fakes.client.activeSessionId.value = 's1';
    fakes.workspaces.activePanelRoots = { root: '/repo-wt', roots: ['/repo-wt', '/extra-a'] };

    await mountPanel();

    const sidebar = host.querySelector<HTMLElement>('.tree-sidebar')!;
    expect(sidebar.getAttribute('data-cwd')).toBe('/repo-wt');
    expect(sidebar.getAttribute('data-root')).toBe('/repo-wt');
    expect(fakes.files.resolveFileTreeRoot).toHaveBeenLastCalledWith('w1', ['/repo-wt', '/extra-a'], '/repo-wt');
  });
});
