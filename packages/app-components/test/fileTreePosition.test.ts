// @vitest-environment jsdom
import { createApp, h, nextTick, type App, type Component } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KimiWebApi } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '@moonshot-ai/app-client/client';
import { InsertPathMentionKey, RevealInFolderKey } from '@moonshot-ai/app-client/contracts';
import { clientPinia, workspacesStore } from '@moonshot-ai/app-client/stores';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import FileTree from '../src/FileTree.vue';
import FileTreePositionMenu from '../src/FileTreePositionMenu.vue';
import FileTreeRootSelect from '../src/FileTreeRootSelect.vue';
import FileTreeSidebar from '../src/FileTreeSidebar.vue';
import FileTreeSidebarFrame from '../src/FileTreeSidebarFrame.vue';
import {
  closeFileContextMenu,
  resolveFileMenuPath,
  useFileContextMenuState,
} from '../src/chat/fileContextMenu';
import { useFileTreePosition } from '../src/composables/useFileTreePosition';

const POSITION_KEY = 'kimi-web.file-tree-position';

let app: App | null = null;
let host: HTMLDivElement;
let insertPathMention: ReturnType<typeof vi.fn> | undefined;

function mount(component: Component, props?: Record<string, unknown>): HTMLElement {
  app = createApp({ render: () => h(component, props) });
  app.use(clientPinia);
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(IconResolverKey, (name: string) => ({
    render: () => h('svg', { 'data-icon': name }),
  }));
  if (insertPathMention !== undefined) app.provide(InsertPathMentionKey, insertPathMention);
  app.provide(RevealInFolderKey, async () => true);
  app.mount(host);
  return host;
}

beforeEach(() => {
  insertPathMention = undefined;
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  host = document.createElement('div');
  document.body.append(host);
  useFileTreePosition().setPosition('right');
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  window.localStorage.clear();
  resetKimiClientDeps();
  closeFileContextMenu();
  insertPathMention = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useFileTreePosition', () => {
  it('defaults to right and persists selection', () => {
    const { position, setPosition } = useFileTreePosition();
    expect(position.value).toBe('right');
    setPosition('left');
    expect(position.value).toBe('left');
    expect(window.localStorage.getItem(POSITION_KEY)).toBe('left');
    setPosition('right');
    expect(window.localStorage.getItem(POSITION_KEY)).toBe('right');
  });
});

describe('FileTreeRootSelect', () => {
  it('stays above the sidebar content and emits the picked root', async () => {
    const onSelect = vi.fn();
    const root = mount({
      render: () =>
        h(FileTreeSidebarFrame, { position: 'right' }, {
          default: () => [
            h(FileTreeRootSelect, {
              roots: ['/repo/frontend', '/archive/frontend'],
              root: '/repo/frontend',
              onSelect,
            }),
            h('div', { class: 'fts-head' }, 'Search'),
          ],
        }),
    });
    const body = root.querySelector<HTMLElement>('.fts-frame-body')!;
    expect(body.firstElementChild?.classList.contains('files-root-select-wrap')).toBe(true);
    expect(body.children[1]?.classList.contains('fts-head')).toBe(true);

    const trigger = body.querySelector<HTMLButtonElement>('button[aria-label="Switch file tree root"]')!;
    expect(trigger.querySelector('svg[data-icon="folder-closed"]')).not.toBeNull();
    trigger.click();
    await nextTick();
    await nextTick();
    const items = body.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    expect(items).toHaveLength(2);
    expect(items[0]?.getAttribute('title')).toBe('/repo/frontend');
    expect(items[1]?.getAttribute('title')).toBe('/archive/frontend');
    expect(items[0]?.querySelector('svg[data-icon="folder-closed"]')).not.toBeNull();
    items[1]!.click();
    await nextTick();

    expect(onSelect).toHaveBeenCalledWith('/archive/frontend');
  });
});

describe('FileTree symlink directories', () => {
  it('expands symlink directories and keeps plain symlinks as files', async () => {
    const onToggle = vi.fn();
    const root = mount(FileTree, {
      childrenOf: (path: string) => {
        if (path === '.') {
          return [
            {
              path: 'link',
              name: 'link',
              kind: 'symlink',
              isDirectory: true,
              modifiedAt: '',
            },
            {
              path: 'file-link',
              name: 'file-link',
              kind: 'symlink',
              modifiedAt: '',
            },
          ];
        }
        if (path === 'link') {
          return [
            {
              path: 'link/inside.txt',
              name: 'inside.txt',
              kind: 'file',
              modifiedAt: '',
            },
          ];
        }
        return undefined;
      },
      loadingOf: () => false,
      failedOf: () => false,
      expanded: { link: true },
      selectedPath: null,
      onToggle,
    });

    const link = root.querySelector<HTMLElement>('[data-file-path="link"]');
    expect(link?.dataset.fileKind).toBe('folder');
    expect(link?.hasAttribute('data-file-symlink')).toBe(true);
    expect(link?.classList.contains('is-folder')).toBe(true);
    expect(link?.querySelector('svg[data-icon="folder-symlink"]')).not.toBeNull();
    expect(root.querySelector('[data-file-path="link/inside.txt"]')).not.toBeNull();

    const fileLink = root.querySelector<HTMLElement>('[data-file-path="file-link"]');
    expect(fileLink?.dataset.fileKind).toBe('file');
    expect(fileLink?.hasAttribute('data-file-symlink')).toBe(true);
    expect(fileLink?.classList.contains('is-folder')).toBe(false);
    expect(fileLink?.querySelector('svg[data-icon="file-symlink"]')).not.toBeNull();

    link!.click();
    await nextTick();
    expect(onToggle).toHaveBeenCalledWith('link');
  });
});

describe('FileTree row actions', () => {
  it('adds a file from an additional root to chat by its absolute path', async () => {
    insertPathMention = vi.fn();
    const root = mount(FileTree, {
      childrenOf: (path: string) => path === '/repo/B'
        ? [{ path: 'src/a.ts', name: 'a.ts', kind: 'file', modifiedAt: '' }]
        : undefined,
      loadingOf: () => false,
      failedOf: () => false,
      expanded: {},
      selectedPath: null,
      cwd: '/repo/B',
      rootPath: '/repo/B',
    });

    root.querySelector<HTMLButtonElement>('.tree-more')!.click();
    await nextTick();
    await nextTick();
    const add = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.includes('Add to chat'),
    );
    expect(add).not.toBeUndefined();
    add!.click();

    expect(insertPathMention).toHaveBeenCalledWith('/repo/B/src/a.ts', 'file');
  });

  it.each([
    { hostId: undefined, visible: true },
    { hostId: 'devbox', visible: false },
  ])('offers reveal in folder only for local files ($hostId)', async ({ hostId, visible }) => {
    const store = workspacesStore();
    store.workspaces = [{
      id: 'project',
      root: '/repo/B',
      hostId,
      name: 'B',
      kind: 'managed',
      sessionCount: 0,
      additionalDirs: [],
    }];
    store.storedActiveWorkspaceId = 'project';
    try {
      const root = mount(FileTree, {
        childrenOf: (path: string) => path === '/repo/B'
          ? [{ path: 'src/a.ts', name: 'a.ts', kind: 'file', modifiedAt: '' }]
          : undefined,
        loadingOf: () => false,
        failedOf: () => false,
        expanded: {},
        selectedPath: null,
        cwd: '/repo/B',
        rootPath: '/repo/B',
      });

      root.querySelector<HTMLButtonElement>('.tree-more')!.click();
      await nextTick();
      await nextTick();
      const items = [...document.body.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent ?? '');
      expect(items.some((item) => item.includes('Copy'))).toBe(true);
      expect(items).toHaveLength(visible ? 2 : 1);
    } finally {
      store.workspaces = [];
      store.storedActiveWorkspaceId = null;
    }
  });
});

describe('FileTreePositionMenu', () => {
  it('opens on gear click, marks the active position, and picking updates shared state', async () => {
    const root = mount(FileTreePositionMenu);
    const trigger = root.querySelector<HTMLButtonElement>('button[aria-label="File tree settings"]');
    expect(trigger).not.toBeNull();
    expect(root.querySelector('.ftpm-menu')).toBeNull();

    trigger!.click();
    await nextTick();
    await nextTick();

    const menu = root.querySelector('.ftpm-menu');
    expect(menu).not.toBeNull();
    expect(menu!.textContent).toContain('File tree position');
    const items = menu!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain('Left');
    expect(items[1].textContent).toContain('Right');
    expect(items[0].querySelector('svg[data-icon="check"]')).toBeNull();
    expect(items[1].querySelector('svg[data-icon="check"]')).not.toBeNull();

    items[0].click();
    await nextTick();
    expect(useFileTreePosition().position.value).toBe('left');
    expect(window.localStorage.getItem(POSITION_KEY)).toBe('left');
  });
});

describe('FileTreeSidebar search', () => {
  it('opens a search result within the selected root', async () => {
    vi.useFakeTimers();
    const listDirectory = vi.fn().mockResolvedValue({ items: [], truncated: false });
    const suggestFilesAtRoots = vi.fn().mockResolvedValue({
      items: [
        {
          path: 'src/shared.ts',
          name: 'shared.ts',
          kind: 'file',
          score: 1,
          matchPositions: [0],
        },
      ],
      truncated: false,
    });
    setKimiClientDeps({
      api: () => ({ listDirectory, suggestFilesAtRoots }) as unknown as KimiWebApi,
    });
    const onSelect = vi.fn();
    const root = mount(FileTreeSidebar, {
      sessionId: 's1',
      cwd: '/repo/A',
      root: '/repo/B',
      selectedPath: null,
      onSelect,
    });
    const input = root.querySelector<HTMLInputElement>('input')!;
    input.value = 'shared';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(300);
    await nextTick();

    const result = root.querySelector<HTMLElement>('[data-file-path="src/shared.ts"]');
    expect(result).not.toBeNull();
    result!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const menuState = useFileContextMenuState();
    expect(menuState.cwd).toBe('/repo/B');
    expect(resolveFileMenuPath(menuState.path, menuState.cwd)).toBe('/repo/B/src/shared.ts');
    closeFileContextMenu();
    result!.click();
    await nextTick();

    expect(suggestFilesAtRoots).toHaveBeenCalledWith(
      ['/repo/B'],
      { query: 'shared', limit: 20 },
      { signal: undefined },
    );
    expect(onSelect).toHaveBeenCalledWith('/repo/B/src/shared.ts');
  });
});
