// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import type { AppWorktree, WorktreeInspection } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '@moonshot-ai/app-client/client';
import { resetWorktreeManageDialogs, useWorktreeManageDialogs } from '@moonshot-ai/app-client/composables';
import { worktreesStore, type WorktreeRemovalItem } from '@moonshot-ai/app-client/stores';
import { appWorktree, memoryStorage, worktreeRisk } from '@moonshot-ai/app-client/testing';
import WorktreesPanel from '../src/settings/WorktreesPanel.vue';

const i18n = createKimiI18n({ locale: 'en' });
const MB = 1024 * 1024;
const GB = 1024 * MB;

const api = {
  listWorktrees: vi.fn(),
  inspectWorktrees: vi.fn<(paths: string[]) => Promise<WorktreeInspection>>(),
  removeWorktree: vi.fn(),
};

const dialogs = useWorktreeManageDialogs();
let app: App | undefined;
let host: HTMLDivElement;
let openSession: ReturnType<typeof vi.fn>;

function session(id: string, title: string, extra: Partial<AppWorktree['sessions'][number]> = {}) {
  return { id, title, archived: false, busy: false, ...extra };
}

function worktree(name: string, overrides: Partial<AppWorktree> = {}): AppWorktree {
  return appWorktree(name, { workspaceName: 'kimi-code-app', sizeBytes: 60 * MB, ...overrides });
}

const fixture = (): AppWorktree[] => [
  worktree('demo', {
    workspaceId: 'ws-demo',
    workspaceName: 'kimi-worktree-demo',
    repoRoot: '/code/demo',
    sessions: [session('s-demo', 'Reply hello')],
  }),
  worktree('badge', { sizeBytes: 640 * MB, sessions: [session('s-badge', 'Sidebar badge', { busy: true })] }),
  worktree('login', {
    sizeBytes: 1.1 * GB,
    sessions: [session('s-login', 'Fix login redirect'), session('s-2', 'Two'), session('s-3', 'Three')],
  }),
  worktree('retry', { sizeBytes: 310 * MB, sessions: [session('s-retry', 'Retry requests', { archived: true })] }),
  worktree('task-3', { branch: 'tower/task-3-api-client', origin: 'external', sizeBytes: 260 * MB }),
];

function mount(options: { items?: AppWorktree[]; total?: number; loaded?: boolean; removals?: WorktreeRemovalItem[]; deleted?: Record<string, string> } = {}) {
  const store = worktreesStore();
  const items = options.items ?? fixture();
  store.items = items;
  store.totalSizeBytes = options.total;
  store.loaded = options.loaded ?? true;
  store.removals = options.removals ?? [];
  store.deletedSessionTitles = options.deleted ?? {};
  const load = vi.spyOn(store, 'load').mockResolvedValue(true);
  const ensureLoaded = vi.spyOn(store, 'ensureLoaded').mockResolvedValue(true);
  const refreshSizes = vi.spyOn(store, 'refreshSizes').mockResolvedValue(true);
  const markReminded = vi.spyOn(store, 'markDiskUsageReminded');
  app = createApp({ render: () => h(WorktreesPanel, { onOpenSession: openSession }) });
  app.use(i18n);
  app.provide(IconResolverKey, (name: string) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.mount(host);
  return { store, load, ensureLoaded, refreshSizes, markReminded };
}

function row(name: string): HTMLElement {
  return host.querySelector<HTMLElement>(`.manage-row[data-path="/wt/${name}"]`)!;
}

function failedRemoval(name: string, reason: 'in_use' | 'unknown', output: string): WorktreeRemovalItem {
  return { path: `/wt/${name}`, name, deleteBranch: false, state: 'failed', reason, output };
}

function deletingRemoval(name: string): WorktreeRemovalItem {
  return { path: `/wt/${name}`, name, deleteBranch: false, state: 'deleting' };
}

function text(el: Element | null | undefined): string {
  if (el === null || el === undefined) return '';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const part = node.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    if (part !== '') parts.push(part);
  }
  return parts.join(' ');
}

function cards(): string[] {
  return [...host.querySelectorAll('.wtp-card-toggle')].map((card) => text(card));
}

async function frames(): Promise<void> {
  for (let index = 0; index < 3; index++) await new Promise((resolve) => requestAnimationFrame(resolve));
  await nextTick();
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index++) await nextTick();
}

function check(input: HTMLInputElement): void {
  input.checked = !input.checked;
  input.dispatchEvent(new Event('change'));
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  host = document.createElement('div');
  document.body.append(host);
  openSession = vi.fn();
  for (const mock of Object.values(api)) mock.mockReset();
  api.inspectWorktrees.mockImplementation(async (paths) => ({
    items: paths.map((path) => worktreeRisk(path.split('/').at(-1)!)),
    errors: {},
  }));
  setKimiClientDeps({
    api: () => api as never,
    t: (key, params) => (params === undefined ? i18n.global.t(key) : i18n.global.t(key, params)),
  });
  worktreesStore().reset();
  resetWorktreeManageDialogs();
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  vi.restoreAllMocks();
  resetWorktreeManageDialogs();
  worktreesStore().reset();
  resetKimiClientDeps();
  host.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('Worktrees settings page', () => {
  it('loads the list and counts opening the page as a disk reminder', async () => {
    const { ensureLoaded, load, markReminded } = mount({ loaded: false, items: [] });
    await flush();

    expect(ensureLoaded).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
    expect(markReminded).toHaveBeenCalled();
    expect(text(host.querySelector('.wtp-state'))).toBe('Loading Worktrees…');
  });

  it('refreshes an already loaded list when the page opens again', async () => {
    const { ensureLoaded, load } = mount();
    await flush();

    expect(load).toHaveBeenCalledOnce();
    expect(ensureLoaded).not.toHaveBeenCalled();
  });

  it('groups worktrees by project with a count and disk usage', () => {
    mount({ total: 2.3 * GB });

    expect(text(host.querySelector('.wtp-title'))).toBe('Created Worktrees');
    expect(cards()).toEqual(['kimi-worktree-demo 1 Worktree · 60 MB', 'kimi-code-app 4 Worktrees · 2.3 GB']);
    expect(text(host.querySelector('.wtp-total'))).toBe('Total: 2.3 GB.');
    expect(host.querySelector('.wtp-total [data-icon]')).toBeNull();
  });

  it('recommends freeing space above the reminder threshold', () => {
    mount({ total: 5.3 * GB });

    expect(text(host.querySelector('.wtp-total'))).toBe(
      'Total: 5.3 GB. Consider deleting Worktrees you no longer need to free up space.',
    );
    expect(host.querySelector('.wtp-total [data-icon="alert-triangle"]')).not.toBeNull();
  });

  it('renders each kind of row', () => {
    mount({
      items: [...fixture(), worktree('hello')],
      removals: [failedRemoval('hello', 'in_use', 'busy'), deletingRemoval('badge')],
      deleted: { '/wt/hello': 'Hello' },
    });

    expect(text(row('demo').querySelector('.manage-row__title'))).toBe('Reply hello');
    expect(text(row('demo').querySelector('.manage-row__meta'))).toBe('kimi/demo · 60 MB');
    expect(row('demo').querySelector('.manage-row__open')).not.toBeNull();

    expect(text(row('login').querySelector('.manage-row__title'))).toBe('Fix login redirect');
    expect(text(row('login').querySelector('.manage-row__meta'))).toBe('kimi/login · 1.1 GB · 3 sessions in use');

    expect(text(row('retry').querySelector('.manage-row__title'))).toBe('Retry requests Archived');
    expect(row('retry').querySelector('.manage-row__open')).toBeNull();
    expect(row('retry').querySelector('.manage-row__delete')).not.toBeNull();

    expect(text(row('task-3').querySelector('.manage-row__title'))).toBe('task-3');
    expect(row('task-3').querySelector('.manage-row__name')!.classList.contains('is-directory')).toBe(true);
    expect(text(row('task-3').querySelector('.manage-row__meta'))).toBe(
      'tower/task-3-api-client · 260 MB · No associated session',
    );
    expect(row('task-3').querySelector('.manage-row__open')).toBeNull();

    expect(text(row('hello').querySelector('.manage-row__title'))).toBe('Hello Deleted');
    expect(text(row('badge').querySelector('.manage-row__actions'))).toBe('Deleting…');
  });

  it('opens the associated session', () => {
    mount();

    row('demo').querySelector<HTMLButtonElement>('.manage-row__open')!.click();

    expect(openSession).toHaveBeenCalledWith('s-demo');
  });

  it('collapses and expands a project card', async () => {
    mount();
    const toggle = host.querySelectorAll<HTMLButtonElement>('.wtp-card-toggle')[1]!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    toggle.click();
    await nextTick();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await frames();
    expect(host.querySelectorAll('.manage-row')).toHaveLength(1);

    toggle.click();
    await nextTick();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelectorAll('.manage-row')).toHaveLength(5);
  });

  it('recomputes sizes from the refresh button', () => {
    const { refreshSizes } = mount();

    host.querySelector<HTMLButtonElement>('.wtp-refresh')!.click();

    expect(refreshSizes).toHaveBeenCalledOnce();
  });

  it('refuses to delete while the associated session is running', async () => {
    mount();
    const button = row('badge').querySelector<HTMLButtonElement>('.manage-row__delete')!;

    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.classList.contains('is-unavailable')).toBe(true);
    button.click();
    await flush();

    expect(api.inspectWorktrees).not.toHaveBeenCalled();
    expect(dialogs.deleteDialog.value).toBeNull();
  });

  it('asks for confirmation after refreshing the status of the clicked worktree', async () => {
    mount();

    row('login').querySelector<HTMLButtonElement>('.manage-row__delete')!.click();
    await flush();

    expect(api.inspectWorktrees).toHaveBeenCalledWith(['/wt/login']);
    expect(dialogs.deleteDialog.value).toMatchObject({ kind: 'worktrees', phase: 'confirm' });
  });

  it('shows the failure reason with expandable raw output', async () => {
    mount({
      removals: [
        failedRemoval('demo', 'in_use', 'Directory not empty'),
        failedRemoval('retry', 'unknown', 'fatal: boom'),
      ],
    });

    expect(text(row('demo').querySelector('.manage-row__failure'))).toBe(
      'Deletion failed: directory in use View Raw Output',
    );
    expect(text(row('retry').querySelector('.manage-row__failure'))).toBe('Deletion failed View Raw Output');
    expect(row('demo').querySelector('.manage-row__output')).toBeNull();

    row('demo').querySelector<HTMLButtonElement>('.manage-row__link')!.click();
    await nextTick();
    expect(text(row('demo').querySelector('.manage-row__output'))).toBe('Directory not empty');
    expect(text(row('demo').querySelector('.manage-row__link'))).toBe('Collapse');

    row('demo').querySelector<HTMLButtonElement>('.manage-row__link')!.click();
    await nextTick();
    expect(row('demo').querySelector('.manage-row__output')).toBeNull();
  });

  it('clears the failures the user has seen when the page closes', () => {
    const { store } = mount({
      removals: [failedRemoval('demo', 'in_use', 'busy'), failedRemoval('gone', 'in_use', 'busy'), deletingRemoval('login')],
    });

    app?.unmount();
    app = undefined;

    expect(store.removals.map((entry) => entry.path)).toEqual(['/wt/gone', '/wt/login']);
  });

  it('states when there is nothing to manage and when loading failed', async () => {
    const empty = mount({ items: [] });
    expect(text(host.querySelector('.wtp-state'))).toBe('No Worktrees yet.');
    expect(host.querySelector<HTMLButtonElement>('.wtp-batch')!.disabled).toBe(true);

    empty.store.loaded = false;
    empty.store.loadError = 'offline';
    await nextTick();
    expect(text(host.querySelector('.wtp-state'))).toBe('Couldn’t load Worktrees. Retry');
    host.querySelector<HTMLButtonElement>('.wtp-state .ui-button')!.click();
    expect(empty.load).toHaveBeenCalled();
  });
});

describe('batch mode', () => {
  async function enterBatch(): Promise<void> {
    host.querySelector<HTMLButtonElement>('.wtp-batch')!.click();
    await nextTick();
  }

  async function hoverBatch(): Promise<string> {
    await nextTick();
    vi.useFakeTimers();
    try {
      const button = host.querySelector<HTMLButtonElement>('.wtp-batch')!;
      document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }));
      button.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 24, clientY: 18 }));
      vi.advanceTimersByTime(1000);
      await nextTick();
      return text(document.body.querySelector('[role="tooltip"]'));
    } finally {
      vi.useRealTimers();
    }
  }

  it('styles Batch Delete as destructive and explains what it deletes', async () => {
    mount();
    expect(host.querySelector('.wtp-batch')!.classList.contains('ui-button--danger')).toBe(true);
    expect(await hoverBatch()).toBe(
      'Select Worktrees to delete (4 can be deleted). Deleting removes the Worktree directory, and uncommitted changes in it are lost.',
    );
  });

  function rowCheckbox(name: string): HTMLInputElement {
    return row(name).querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  }

  function cardCheckbox(index: number): HTMLInputElement {
    return host.querySelectorAll<HTMLInputElement>('.wtp-card-check input')[index]!;
  }

  it('swaps the header and row actions for checkboxes', async () => {
    mount();
    await enterBatch();

    expect(text(host.querySelector('.wtp-actions'))).toBe('0 selected Cancel Delete Selected');
    expect(host.querySelector<HTMLButtonElement>('.wtp-batch-delete')!.disabled).toBe(true);
    expect(host.querySelectorAll('.manage-row input[type="checkbox"]')).toHaveLength(5);
    expect(host.querySelectorAll('.wtp-card-check input')).toHaveLength(2);
    expect(host.querySelector('.manage-row__delete')).toBeNull();
    expect(host.querySelector('.manage-row__open')).toBeNull();
    expect(rowCheckbox('badge').disabled).toBe(true);
  });

  it('selects every deletable worktree of a project from the card header', async () => {
    mount();
    await enterBatch();

    check(cardCheckbox(1));
    await nextTick();

    expect(text(host.querySelector('.wtp-selected'))).toBe('3 selected');
    expect(rowCheckbox('login').checked).toBe(true);
    expect(rowCheckbox('retry').checked).toBe(true);
    expect(rowCheckbox('task-3').checked).toBe(true);
    expect(rowCheckbox('badge').checked).toBe(false);
    expect(rowCheckbox('demo').checked).toBe(false);
    expect(cardCheckbox(1).checked).toBe(true);

    check(rowCheckbox('retry'));
    await nextTick();
    expect(text(host.querySelector('.wtp-selected'))).toBe('2 selected');
    expect(cardCheckbox(1).checked).toBe(false);

    check(cardCheckbox(1));
    await nextTick();
    check(cardCheckbox(1));
    await nextTick();
    expect(text(host.querySelector('.wtp-selected'))).toBe('0 selected');
  });

  it('confirms the selection and leaves batch mode once deletion starts', async () => {
    api.removeWorktree.mockReturnValue(new Promise(() => undefined));
    mount();
    await enterBatch();
    check(rowCheckbox('login'));
    check(rowCheckbox('demo'));
    await nextTick();

    host.querySelector<HTMLButtonElement>('.wtp-batch-delete')!.click();
    await flush();

    expect(api.inspectWorktrees).toHaveBeenCalledWith(['/wt/login', '/wt/demo']);
    expect(dialogs.deleteDialog.value).toMatchObject({ kind: 'worktrees', phase: 'confirm' });
    expect(host.querySelector('.wtp-batch-delete')).not.toBeNull();

    dialogs.confirmDeletion();
    await flush();

    expect(host.querySelector('.wtp-batch-delete')).toBeNull();
    expect(host.querySelector('.wtp-batch')).not.toBeNull();
    expect(text(row('login').querySelector('.manage-row__actions'))).toBe('Deleting…');
  });

  it('leaves batch mode on Cancel and forgets the selection', async () => {
    mount();
    await enterBatch();
    check(rowCheckbox('login'));
    await nextTick();

    host.querySelector<HTMLButtonElement>('.wtp-batch-cancel')!.click();
    await nextTick();
    expect(host.querySelector('.manage-row input[type="checkbox"]')).toBeNull();

    await enterBatch();
    expect(text(host.querySelector('.wtp-selected'))).toBe('0 selected');
  });
});
