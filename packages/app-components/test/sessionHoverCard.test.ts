// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@moonshot-ai/app-core/client/types';
import { OpenSidebarBrowserUrlKey } from '@moonshot-ai/app-core/contracts';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';

const stores = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  fsHome: '/Users/me' as string | null,
  roots: [] as string[],
  workspaces: [] as Array<{ id: string; name: string }>,
  rows: [] as Array<Record<string, unknown>>,
  directoryRootsFor: vi.fn(),
  infoRows: vi.fn(),
  observe: vi.fn(),
  refresh: vi.fn(),
  refreshNow: vi.fn(),
}));

vi.mock('@moonshot-ai/app-client/stores', () => ({
  sessionsStore: () => ({ sessions: stores.sessions }),
  workspacesStore: () => ({
    fsHome: stores.fsHome,
    directoryRootsFor: stores.directoryRootsFor,
    mergedWorkspaces: stores.workspaces,
    workspaceIdForSession: (session: { workspaceId?: string }) => session.workspaceId ?? '',
  }),
  sessionInfoStore: () => ({
    rows: stores.infoRows,
    observe: stores.observe,
    refresh: stores.refresh,
    refreshNow: stores.refreshNow,
  }),
}));

import SessionHoverCard from '../src/worktree/SessionHoverCard.vue';

const WORKTREE = '/Users/me/.kimi-code/worktrees/cursor-worktree-entry-test';

let app: App | null = null;
let host: HTMLDivElement;

function row(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: 'Login redirect analysis',
    time: '1h',
    busy: false,
    workspaceId: 'w1',
    cwd: WORKTREE,
    ...overrides,
  } as Session;
}

function worktreeRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 's1',
    cwd: WORKTREE,
    worktree: {
      path: WORKTREE,
      branch: 'kimi/1104-b8b6',
      base: { ref: 'main', remote: false },
      setup: { status: 'ready' },
      ...overrides,
    },
  };
}

function ready(path: string, value: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path,
    primary: path === WORKTREE,
    state: {
      status: 'ready',
      value: {
        branch: 'kimi/1104-b8b6',
        detached: false,
        ahead: 0,
        behind: 0,
        entries: {},
        additions: 0,
        deletions: 0,
        pullRequest: null,
        ...value,
      },
    },
  };
}

function mountCard(session: Session, openInApp?: (url: string) => void): HTMLElement {
  app = createApp({ render: () => h(SessionHoverCard, { session }) });
  app.use(createKimiI18n({ locale: 'zh' }));
  app.provide(IconResolverKey, (name) => ({ render: () => h('svg', { 'data-icon': name }) }));
  if (openInApp !== undefined) app.provide(OpenSidebarBrowserUrlKey, () => openInApp);
  app.mount(host);
  return host.querySelector<HTMLElement>('[data-session-hover-card]')!;
}

function directory(el: HTMLElement, path: string): HTMLElement {
  return el.querySelector<HTMLElement>(`[data-directory="${path}"]`)!;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  stores.sessions = [];
  stores.fsHome = '/Users/me';
  stores.roots = [];
  stores.workspaces = [];
  stores.rows = [];
  stores.directoryRootsFor.mockReset().mockImplementation(() => stores.roots);
  stores.infoRows.mockReset().mockImplementation(() => stores.rows);
  stores.observe.mockReset();
  stores.refresh.mockReset();
  stores.refreshNow.mockReset();
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  vi.restoreAllMocks();
});

describe('SessionHoverCard', () => {
  it('shows a worktree session: title, name, role, path, source, branch and sync state', async () => {
    stores.sessions = [worktreeRecord()];
    stores.roots = [WORKTREE];
    stores.rows = [ready(WORKTREE)];
    const el = mountCard(row());
    await nextTick();

    expect(el.querySelector('.shc-title')?.textContent).toBe('Login redirect analysis');
    const main = directory(el, WORKTREE);
    expect(main.querySelector('.shc-name')?.textContent).toBe('cursor-worktree-entry-test');
    expect(main.querySelector('.shc-role')?.textContent).toBe('主目录');
    expect(main.querySelector('.shc-path')?.textContent).toBe('~/.kimi-code/worktrees/cursor-worktree-entry-test');
    expect(main.querySelector('.shc-created')?.textContent).toBe('基于 main 创建');
    expect(main.querySelector('.shc-created [data-icon="git-fork"]')).not.toBeNull();
    expect(main.querySelector('.shc-branch')?.textContent).toBe('kimi/1104-b8b6');
    expect(main.querySelector('.shc-not-pushed')?.textContent?.trim()).toBe('未推送');
    expect([...main.children].map(node => node.classList[node.classList.length - 1])).toEqual([
      'shc-heading', 'shc-path', 'shc-created', 'shc-branch-line',
    ]);
  });

  it('titles the worktree directory with the project name', async () => {
    stores.sessions = [worktreeRecord()];
    stores.roots = [WORKTREE];
    stores.rows = [ready(WORKTREE)];
    stores.workspaces = [{ id: 'ws-demo', name: 'demo-project' }];
    const el = mountCard({ ...row(), workspaceId: 'ws-demo' });
    await nextTick();

    expect(el.querySelector('.shc-name')?.textContent).toBe('demo-project');
  });

  it('adds the cloud badge when the worktree was created from a remote', async () => {
    stores.sessions = [worktreeRecord({ base: { ref: 'origin/main', remote: true } })];
    stores.roots = [WORKTREE];
    const el = mountCard(row());
    await nextTick();

    expect(el.querySelector('.shc-created')?.textContent).toBe('基于 origin/main 创建');
    expect(el.querySelector('.shc-created [data-icon="git-fork-cloud"]')).not.toBeNull();
  });

  it('lists every directory and marks only the main one', async () => {
    stores.sessions = [worktreeRecord()];
    stores.roots = [WORKTREE, '/Users/other/extra', '/srv/plain'];
    stores.rows = [
      ready(WORKTREE, { upstream: 'origin/kimi/1104-b8b6' }),
      ready('/Users/other/extra', { branch: 'codex/conflict-safety', upstream: 'origin/codex/conflict-safety' }),
      { path: '/srv/plain', primary: false, state: { status: 'non-git' } },
    ];
    const el = mountCard(row());
    await nextTick();

    expect([...el.querySelectorAll('[data-directory]')].map(node => node.getAttribute('data-directory'))).toEqual(stores.roots);
    expect(el.querySelectorAll('.shc-role')).toHaveLength(1);
    expect(el.querySelectorAll('.shc-created')).toHaveLength(1);
    const extra = directory(el, '/Users/other/extra');
    expect(extra.querySelector('.shc-name')?.textContent).toBe('extra');
    expect(extra.querySelector('.shc-path')?.textContent).toBe('~/extra');
    expect(extra.querySelector('.shc-branch')?.textContent).toBe('codex/conflict-safety');
    expect(extra.querySelector('.shc-not-pushed')).toBeNull();
    const plain = directory(el, '/srv/plain');
    expect(plain.querySelector('.shc-path')?.textContent).toBe('/srv/plain');
    expect(plain.querySelector('.shc-branch-line')).toBeNull();
  });

  it('strikes the path and warns when the worktree directory is gone', async () => {
    stores.sessions = [worktreeRecord({ missing: true })];
    stores.roots = [WORKTREE];
    stores.rows = [{ path: WORKTREE, primary: true, state: { status: 'missing' } }];
    const el = mountCard(row({ pullRequest: { number: 7, state: 'open', url: 'https://example.test/pr/7' } }));
    await nextTick();

    expect(el.querySelector('.shc-path')?.classList.contains('missing')).toBe(true);
    expect(el.querySelector('.shc-missing')?.textContent).toBe('工作树目录不存在');
    expect(el.querySelector('.shc-created')).toBeNull();
    expect(el.querySelector('.shc-branch')?.textContent).toBe('kimi/1104-b8b6');
    expect(el.querySelector('.shc-pr')).toBeNull();
  });

  it('shows only the directory for a local session', async () => {
    stores.sessions = [{ id: 's1', cwd: '/Users/me/Desktop' }];
    stores.roots = ['/Users/me/Desktop'];
    const el = mountCard(row({ cwd: '/Users/me/Desktop' }));
    await nextTick();

    const main = directory(el, '/Users/me/Desktop');
    expect(main.querySelector('.shc-name')?.textContent).toBe('Desktop');
    expect(main.querySelector('.shc-role')?.textContent).toBe('主目录');
    expect(main.querySelector('.shc-path')?.textContent).toBe('~/Desktop');
    expect(main.children).toHaveLength(2);
  });

  it('falls back to the listed branch and pull request without cached status', async () => {
    stores.sessions = [{ ...worktreeRecord(), pullRequest: { number: 1312, state: 'merged', url: 'https://example.test/pr/1312' } }];
    stores.roots = [WORKTREE];
    const openInApp = vi.fn();
    const el = mountCard(row(), openInApp);
    await nextTick();

    expect(el.querySelector('.shc-branch')?.textContent).toBe('kimi/1104-b8b6');
    expect(el.querySelector('.shc-not-pushed')).toBeNull();
    expect(el.querySelector('.shc-pr-number')?.textContent).toBe('PR #1312');
    expect(el.querySelector('.shc-pr .spr-state')?.textContent).toBe('Merged');
    el.querySelector<HTMLButtonElement>('.shc-pr')!.click();
    expect(openInApp).toHaveBeenCalledExactlyOnceWith('https://example.test/pr/1312');
  });

  it('is read-only: no changes button, no refresh and no status request', async () => {
    stores.sessions = [worktreeRecord()];
    stores.roots = [WORKTREE];
    stores.rows = [ready(WORKTREE, { additions: 3, deletions: 1, entries: { 'a.ts': 'M' } })];
    const el = mountCard(row());
    await nextTick();

    expect(el.querySelectorAll('button')).toHaveLength(0);
    expect(el.textContent).not.toContain('+3');
    expect(stores.observe).not.toHaveBeenCalled();
    expect(stores.refresh).not.toHaveBeenCalled();
    expect(stores.refreshNow).not.toHaveBeenCalled();
  });

  it('uses the row directory when the session is not in the loaded list', async () => {
    const el = mountCard(row({ cwd: '/Users/me/elsewhere' }));
    await nextTick();

    expect(stores.directoryRootsFor).toHaveBeenCalledWith('s1', 'w1');
    expect(el.querySelector('.shc-path')?.textContent).toBe('~/elsewhere');
  });
});
