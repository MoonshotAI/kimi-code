// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, ref, type App } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/FilePreview.vue', () => ({
  default: {
    props: ['treeAvailable', 'treeOpen'],
    render(this: {
      treeAvailable: boolean;
      treeOpen: boolean;
      $slots: { sidebar?: () => ReturnType<typeof h>[] };
    }) {
      return h('div', {
        'data-tree-available': String(this.treeAvailable),
        'data-tree-open': String(this.treeOpen),
      }, this.$slots.sidebar?.());
    },
  },
}));

vi.mock('../src/FileTreeRootSelect.vue', () => ({
  default: {
    props: ['roots', 'root'],
    render(this: { root: string; $emit: (event: string, root: string) => void }) {
      return h('button', {
        class: 'root-select',
        'data-root': this.root,
        onClick: () => this.$emit('select', '/b'),
      });
    },
  },
}));

vi.mock('../src/FileTreeSidebar.vue', () => ({
  default: {
    props: ['sessionId', 'cwd', 'root', 'selectedPath'],
    render(this: { root?: string; $emit: (event: string, path: string) => void }) {
      return h('button', {
        class: 'tree-sidebar',
        'data-root': this.root,
        onClick: () => this.$emit('select', '/b/file.ts'),
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

import FilePreviewPanel from '../src/FilePreviewPanel.vue';

interface TestTree {
  available: boolean;
  sessionId: string | null;
  roots: string[];
  root: string;
  cwd: string;
  selectedPath: string | null;
  onSelectRoot: ReturnType<typeof vi.fn>;
  onSelectFile: ReturnType<typeof vi.fn>;
}

let app: App | null = null;
let host: HTMLDivElement;

function mountPanel(overrides: Partial<TestTree> = {}) {
  host = document.createElement('div');
  document.body.append(host);
  const tree = reactive<TestTree>({
    available: true,
    sessionId: 's1',
    roots: ['/a', '/b'],
    root: '/a',
    cwd: '/a',
    selectedPath: null,
    onSelectRoot: vi.fn((root: string) => {
      tree.root = root;
    }),
    onSelectFile: vi.fn(),
  });
  Object.assign(tree, overrides);
  const preview = { file: null, loading: false, onClose: vi.fn() };
  app = createApp({ render: () => h(FilePreviewPanel, { preview, tree }) });
  app.mount(host);
  return { tree, preview };
}

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  window.localStorage.clear();
});

describe('FilePreviewPanel workspace roots', () => {
  it('shows the root selector for multiple roots and switches only the tree', async () => {
    const { tree, preview } = mountPanel();
    const selector = host.querySelector<HTMLButtonElement>('.root-select')!;
    expect(selector).not.toBeNull();
    expect(selector.getAttribute('data-root')).toBe('/a');
    expect(host.querySelector<HTMLElement>('.tree-sidebar')!.getAttribute('data-root')).toBe('/a');

    selector.click();
    await nextTick();

    expect(tree.onSelectRoot).toHaveBeenCalledWith('/b');
    expect(tree.root).toBe('/b');
    expect(host.querySelector<HTMLElement>('.tree-sidebar')!.getAttribute('data-root')).toBe('/b');
    expect(preview.onClose).not.toHaveBeenCalled();
    expect(tree.onSelectFile).not.toHaveBeenCalled();

    host.querySelector<HTMLButtonElement>('.tree-sidebar')!.click();
    expect(tree.onSelectFile).toHaveBeenCalledWith('/b/file.ts');
  });

  it('hides the root selector for a single root', () => {
    mountPanel({ roots: ['/a'], root: '/a' });

    expect(host.querySelector('.root-select')).toBeNull();
    expect(host.querySelector<HTMLElement>('.tree-sidebar')!.getAttribute('data-root')).toBeNull();
  });

  it('keeps the tree unavailable without a session', () => {
    mountPanel({ sessionId: null });

    expect(host.querySelector<HTMLElement>('[data-tree-available]')!.getAttribute('data-tree-available')).toBe('false');
    expect(host.querySelector<HTMLElement>('[data-tree-open]')!.getAttribute('data-tree-open')).toBe('false');
    expect(host.querySelector('.tree-sidebar')).toBeNull();
  });
});
