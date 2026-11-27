// @vitest-environment jsdom
import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppWorktree } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '@moonshot-ai/app-client/client';
import { resetWorktreeManageDialogs, useWorktreeManageDialogs } from '@moonshot-ai/app-client/composables';
import { worktreesStore, type WorktreeRemovalItem } from '@moonshot-ai/app-client/stores';
import { appWorktree, memoryStorage, sessionRef, worktreeManageApi, worktreeRisk } from '@moonshot-ai/app-client/testing';
import WorktreesPanel from '../src/settings/WorktreesPanel.vue';
import { cleanup, msg, render, screen, settle, textOf, within, type Rendered } from './helpers/dom';

const MB = 1024 * 1024;
const GB = 1024 * MB;

const api = worktreeManageApi();
const dialogs = useWorktreeManageDialogs();
let rendered: Rendered;
let openSession: ReturnType<typeof vi.fn>;

function worktree(name: string, overrides: Partial<AppWorktree> = {}): AppWorktree {
  return appWorktree(name, { workspaceName: 'kimi-code-app', sizeBytes: 60 * MB, ...overrides });
}

const fixture = (): AppWorktree[] => [
  worktree('demo', {
    workspaceId: 'ws-demo',
    workspaceName: 'kimi-worktree-demo',
    repoRoot: '/code/demo',
    sessions: [sessionRef('s-demo', 'Reply hello')],
  }),
  worktree('badge', { sizeBytes: 640 * MB, sessions: [sessionRef('s-badge', 'Sidebar badge', { busy: true })] }),
  worktree('login', {
    sizeBytes: 1.1 * GB,
    sessions: [
      sessionRef('s-old', 'Old attempt', { archived: true }),
      sessionRef('s-login', 'Fix login redirect'),
      sessionRef('s-2', 'Two'),
      sessionRef('s-3', 'Three'),
    ],
  }),
  worktree('retry', { sizeBytes: 310 * MB, sessions: [sessionRef('s-retry', 'Retry requests', { archived: true })] }),
  worktree('task-3', { branch: 'tower/task-3-api-client', origin: 'external', sizeBytes: 260 * MB }),
];

function mount(options: { items?: AppWorktree[]; total?: number; loaded?: boolean; removals?: WorktreeRemovalItem[]; deleted?: Record<string, string> } = {}) {
  const store = worktreesStore();
  store.items = options.items ?? fixture();
  store.totalSizeBytes = options.total;
  store.loaded = options.loaded ?? true;
  store.removals = options.removals ?? [];
  store.deletedSessionTitles = options.deleted ?? {};
  const load = vi.spyOn(store, 'load').mockResolvedValue(true);
  const ensureLoaded = vi.spyOn(store, 'ensureLoaded').mockResolvedValue(true);
  const refreshSizes = vi.spyOn(store, 'refreshSizes').mockResolvedValue(true);
  const markReminded = vi.spyOn(store, 'markDiskUsageReminded');
  rendered = render(WorktreesPanel, { onOpenSession: openSession });
  return { store, load, ensureLoaded, refreshSizes, markReminded };
}

const view = () => within(rendered.host);

function row(name: string): HTMLElement {
  return rendered.host.querySelector<HTMLElement>(`[data-path="/wt/${name}"]`)!;
}

const rowPaths = () => [...rendered.host.querySelectorAll('[data-path]')].map((el) => el.getAttribute('data-path'));

function rowButton(name: string, label: string): HTMLButtonElement | null {
  return within(row(name)).queryByRole('button', { name: label }) as HTMLButtonElement | null;
}

function projectToggle(project: string): HTMLElement {
  return view().getByRole('button', { name: new RegExp(`^${project} `) });
}

function batchButton(): HTMLButtonElement {
  return view().getByRole('button', { name: msg('worktreeManage.batchDelete') }) as HTMLButtonElement;
}

function deleteSelectedButton(): HTMLButtonElement | null {
  return view().queryByRole('button', { name: msg('worktreeManage.deleteSelected') }) as HTMLButtonElement | null;
}

function rowCheckbox(title: string): HTMLInputElement {
  return view().getByRole('checkbox', { name: msg('worktreeManage.selectWorktree', { name: title }) }) as HTMLInputElement;
}

function projectCheckbox(project: string): HTMLInputElement {
  return view().getByRole('checkbox', { name: msg('worktreeManage.selectProject', { project }) }) as HTMLInputElement;
}

const selectedCount = (n: number) => msg('worktreeManage.selectedCount', { n });

function failedRemoval(name: string, reason: 'in_use' | 'unknown', output: string): WorktreeRemovalItem {
  return { path: `/wt/${name}`, name, deleteBranch: false, state: 'failed', reason, output };
}

function deletingRemoval(name: string, state: 'waiting' | 'deleting' = 'deleting'): WorktreeRemovalItem {
  return { path: `/wt/${name}`, name, deleteBranch: false, state };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  openSession = vi.fn();
  for (const mock of Object.values(api)) mock.mockReset();
  api.inspectWorktrees.mockImplementation(async (paths) => ({
    items: paths.map((path) => worktreeRisk(path.split('/').at(-1)!)),
    errors: {},
  }));
  setKimiClientDeps({ api: () => api as never, t: (key, params) => msg(key, params) });
  worktreesStore().reset();
  resetWorktreeManageDialogs();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetWorktreeManageDialogs();
  worktreesStore().reset();
  resetKimiClientDeps();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('Worktrees settings page', () => {
  it('loads the list on first open and counts opening the page as a disk reminder', async () => {
    const { ensureLoaded, load, markReminded } = mount({ loaded: false, items: [] });
    await settle();

    expect(ensureLoaded).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
    expect(markReminded).toHaveBeenCalled();
    expect(view().getByText(msg('worktreeManage.loading'))).toBeTruthy();
  });

  it('refreshes an already loaded list when the page opens again', async () => {
    const { ensureLoaded, load } = mount();
    await settle();

    expect(load).toHaveBeenCalledOnce();
    expect(ensureLoaded).not.toHaveBeenCalled();
  });

  it('groups worktrees by project with a count and disk usage', () => {
    mount({ total: 2.3 * GB });

    expect(view().getByRole('heading', { name: msg('worktreeManage.title') })).toBeTruthy();
    expect(textOf(projectToggle('kimi-worktree-demo'))).toBe(
      `kimi-worktree-demo ${msg('worktreeManage.projectSummary', { n: 1 })} · 60 MB`,
    );
    expect(textOf(projectToggle('kimi-code-app'))).toBe(`kimi-code-app ${msg('worktreeManage.projectSummary', { n: 4 })} · 2.3 GB`);
    const card = projectToggle('kimi-code-app').closest('section')!;
    expect(['demo', 'badge', 'login', 'retry', 'task-3'].map((name) => card.contains(row(name)))).toEqual([false, true, true, true, true]);
    const total = view().getByText(msg('worktreeManage.total', { size: '2.3 GB' }));
    expect(total.parentElement!.querySelector('[data-icon="alert-triangle"]')).toBeNull();
  });

  it('recommends freeing space above the reminder threshold', () => {
    mount({ total: 5.3 * GB });

    const total = view().getByText(msg('worktreeManage.totalReminder', { size: '5.3 GB' }));
    expect(total.parentElement!.querySelector('[data-icon="alert-triangle"]')).not.toBeNull();
  });

  it.each<[string, { title: string; label?: string; notes: string[]; open: boolean; deletable: boolean }]>([
    ['demo', { title: 'Reply hello', notes: ['kimi/demo', '60 MB'], open: true, deletable: true }],
    [
      'login',
      { title: 'Fix login redirect', notes: ['kimi/login', '1.1 GB', msg('worktreeManage.sessionsInUse', { n: 4 })], open: true, deletable: true },
    ],
    ['retry', { title: 'Retry requests', label: 'worktreeManage.labelArchived', notes: ['kimi/retry'], open: false, deletable: true }],
    [
      'task-3',
      { title: 'task-3', notes: ['tower/task-3-api-client', '260 MB', msg('worktreeManage.noSession')], open: false, deletable: true },
    ],
    ['hello', { title: 'Hello', label: 'worktreeManage.labelDeleted', notes: ['kimi/hello', '60 MB'], open: false, deletable: true }],
    ['badge', { title: 'Sidebar badge', notes: [msg('worktreeManage.deleting')], open: false, deletable: false }],
    ['queued', { title: 'queued', notes: [msg('worktreeManage.deleting')], open: false, deletable: false }],
  ])('describes the %s worktree row and offers only the actions it allows', (name, expected) => {
    mount({
      items: [...fixture(), worktree('hello'), worktree('queued')],
      removals: [failedRemoval('hello', 'in_use', 'busy'), deletingRemoval('badge'), deletingRemoval('queued', 'waiting')],
      deleted: { '/wt/hello': 'Hello' },
    });

    const text = textOf(row(name));
    expect(text.startsWith(expected.label === undefined ? expected.title : `${expected.title} ${msg(expected.label)}`)).toBe(true);
    for (const note of expected.notes) expect(text).toContain(note);
    expect(rowButton(name, msg('worktreeManage.openSession')) !== null).toBe(expected.open);
    expect(rowButton(name, msg('worktreeManage.delete')) !== null).toBe(expected.deletable);
  });

  it('sets a directory title apart from a session title', () => {
    mount();

    expect(within(row('task-3')).getByText('task-3').classList.contains('is-directory')).toBe(true);
    expect(within(row('demo')).getByText('Reply hello').classList.contains('is-directory')).toBe(false);
  });

  it('opens the first active associated session', () => {
    mount();

    rowButton('login', msg('worktreeManage.openSession'))!.click();

    expect(openSession).toHaveBeenCalledExactlyOnceWith('s-login');
  });

  it('collapses and expands a project card', async () => {
    mount();
    const toggle = projectToggle('kimi-code-app');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    toggle.click();
    await nextTick();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await vi.waitFor(() => expect(rowPaths()).toEqual(['/wt/demo']), { interval: 1 });

    toggle.click();
    await nextTick();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(rowPaths()).toHaveLength(5);
  });

  it('recomputes sizes from the refresh button', () => {
    const { refreshSizes } = mount();

    view().getByRole('button', { name: msg('worktreeManage.refresh') }).click();

    expect(refreshSizes).toHaveBeenCalledOnce();
  });

  it('refuses to delete while the associated session is running', async () => {
    mount();
    const button = rowButton('badge', msg('worktreeManage.delete'))!;

    expect(button.getAttribute('aria-disabled')).toBe('true');
    button.click();
    await settle();

    expect(api.inspectWorktrees).not.toHaveBeenCalled();
    expect(dialogs.deleteDialog.value).toBeNull();
  });

  it('asks for confirmation after refreshing the status of the clicked worktree', async () => {
    mount();

    rowButton('login', msg('worktreeManage.delete'))!.click();
    await settle();

    expect(api.inspectWorktrees).toHaveBeenCalledExactlyOnceWith(['/wt/login']);
    expect(dialogs.deleteDialog.value).toMatchObject({ kind: 'worktrees', phase: 'confirm' });
  });

  it.each<[string, 'in_use' | 'unknown', string]>([
    ['the directory is in use', 'in_use', 'worktreeManage.failedInUse'],
    ['the cause is unknown', 'unknown', 'worktreeManage.failedGeneric'],
  ])('explains a failed deletion when %s', (_label, reason, key) => {
    mount({ removals: [failedRemoval('demo', reason, 'fatal: boom')] });

    expect(textOf(row('demo'))).toContain(msg(key));
  });

  it('expands and collapses the raw output of a failed deletion', async () => {
    mount({ removals: [failedRemoval('demo', 'in_use', 'Directory not empty')] });
    const show = rowButton('demo', msg('worktreeManage.viewOutput'))!;
    expect(show.getAttribute('aria-expanded')).toBe('false');
    expect(within(row('demo')).queryByText('Directory not empty')).toBeNull();

    show.click();
    await nextTick();
    const hide = rowButton('demo', msg('worktreeManage.hideOutput'))!;
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    expect(within(row('demo')).getByText('Directory not empty')).toBeTruthy();

    hide.click();
    await nextTick();
    expect(within(row('demo')).queryByText('Directory not empty')).toBeNull();
  });

  it('clears the failures the user has seen when the page closes', () => {
    const { store } = mount({
      removals: [failedRemoval('demo', 'in_use', 'busy'), failedRemoval('gone', 'in_use', 'busy'), deletingRemoval('login')],
    });

    rendered.unmount();

    expect(store.removals.map((entry) => entry.path)).toEqual(['/wt/gone', '/wt/login']);
  });

  it('states when there is nothing to manage and retries a failed load', async () => {
    const empty = mount({ items: [] });
    expect(view().getByText(msg('worktreeManage.empty'))).toBeTruthy();
    expect(batchButton().disabled).toBe(true);

    empty.store.loaded = false;
    empty.store.loadError = 'offline';
    await nextTick();
    expect(view().getByText(msg('worktreeManage.loadFailed'))).toBeTruthy();
    empty.load.mockClear();
    view().getByRole('button', { name: msg('worktreeManage.retryLoad') }).click();
    expect(empty.load).toHaveBeenCalledOnce();
  });
});

describe('batch mode', () => {
  async function enterBatch(): Promise<void> {
    batchButton().click();
    await nextTick();
  }

  async function hoverBatch(): Promise<string> {
    await nextTick();
    vi.useFakeTimers();
    try {
      const button = batchButton();
      document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 10, clientY: 10 }));
      button.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 24, clientY: 18 }));
      vi.advanceTimersByTime(1000);
      await nextTick();
      return textOf(screen.getByRole('tooltip'));
    } finally {
      vi.useRealTimers();
    }
  }

  it('styles Batch Delete as destructive and explains how many worktrees it can delete', async () => {
    mount();

    expect(batchButton().classList.contains('ui-button--danger')).toBe(true);
    expect(await hoverBatch()).toBe(msg('worktreeManage.batchDeleteTip', { n: 4 }));
  });

  it('swaps the header and row actions for checkboxes', async () => {
    mount();
    await enterBatch();

    expect(view().getByText(selectedCount(0))).toBeTruthy();
    expect(view().getByRole('button', { name: msg('worktreeManage.cancelBatch') })).toBeTruthy();
    expect(deleteSelectedButton()!.disabled).toBe(true);
    expect(view().queryByRole('button', { name: msg('worktreeManage.batchDelete') })).toBeNull();
    const rowBoxes = ['Reply hello', 'Sidebar badge', 'Fix login redirect', 'Retry requests', 'task-3'].map(rowCheckbox);
    const projectBoxes = ['kimi-worktree-demo', 'kimi-code-app'].map(projectCheckbox);
    expect(view().getAllByRole('checkbox')).toEqual([projectBoxes[0], rowBoxes[0], projectBoxes[1], ...rowBoxes.slice(1)]);
    expect(view().queryAllByRole('button', { name: msg('worktreeManage.delete') })).toEqual([]);
    expect(view().queryAllByRole('button', { name: msg('worktreeManage.openSession') })).toEqual([]);
    expect(rowCheckbox('Sidebar badge').disabled).toBe(true);
  });

  it('selects every deletable worktree of a project from the card header', async () => {
    mount();
    await enterBatch();

    projectCheckbox('kimi-code-app').click();
    await nextTick();

    expect(view().getByText(selectedCount(3))).toBeTruthy();
    expect(
      ['Fix login redirect', 'Retry requests', 'task-3', 'Sidebar badge', 'Reply hello'].map((title) => rowCheckbox(title).checked),
    ).toEqual([true, true, true, false, false]);
    expect(projectCheckbox('kimi-code-app').checked).toBe(true);

    rowCheckbox('Retry requests').click();
    await nextTick();
    expect(view().getByText(selectedCount(2))).toBeTruthy();
    expect(projectCheckbox('kimi-code-app').checked).toBe(false);

    projectCheckbox('kimi-code-app').click();
    await nextTick();
    projectCheckbox('kimi-code-app').click();
    await nextTick();
    expect(view().getByText(selectedCount(0))).toBeTruthy();
  });

  it('ignores a click on a worktree whose session is running', async () => {
    mount();
    await enterBatch();

    rowCheckbox('Sidebar badge').click();
    await nextTick();

    expect(rowCheckbox('Sidebar badge').checked).toBe(false);
    expect(view().getByText(selectedCount(0))).toBeTruthy();
  });

  it('confirms the selection and leaves batch mode once deletion starts', async () => {
    api.removeWorktree.mockReturnValue(new Promise(() => undefined));
    mount();
    await enterBatch();
    rowCheckbox('Fix login redirect').click();
    rowCheckbox('Reply hello').click();
    await nextTick();

    deleteSelectedButton()!.click();
    await settle(6);

    expect(api.inspectWorktrees).toHaveBeenCalledExactlyOnceWith(['/wt/login', '/wt/demo']);
    expect(dialogs.deleteDialog.value).toMatchObject({ kind: 'worktrees', phase: 'confirm' });
    expect(deleteSelectedButton()).not.toBeNull();

    dialogs.confirmDeletion();
    await settle(6);

    expect(deleteSelectedButton()).toBeNull();
    expect(batchButton()).toBeTruthy();
    expect(textOf(row('login'))).toContain(msg('worktreeManage.deleting'));
  });

  it('leaves batch mode on Cancel and forgets the selection', async () => {
    mount();
    await enterBatch();
    rowCheckbox('Fix login redirect').click();
    await nextTick();

    view().getByRole('button', { name: msg('worktreeManage.cancelBatch') }).click();
    await nextTick();
    expect(view().queryAllByRole('checkbox')).toEqual([]);

    await enterBatch();
    expect(view().getByText(selectedCount(0))).toBeTruthy();
    expect(rowCheckbox('Fix login redirect').checked).toBe(false);
  });
});
