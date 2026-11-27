// @vitest-environment jsdom
import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@moonshot-ai/app-core/client/types';
import { OpenSidebarBrowserUrlKey } from '@moonshot-ai/app-core/contracts';

const stores = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  fsHome: '/Users/me' as string | null,
  roots: [] as string[],
  workspaces: [] as Array<{ id: string; name: string }>,
  rows: [] as Array<Record<string, unknown>>,
  sessionPanelRoots: vi.fn(),
  infoRows: vi.fn(),
  observe: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('@moonshot-ai/app-client/stores', () => ({
  sessionsStore: () => ({ sessions: stores.sessions }),
  workspacesStore: () => ({
    fsHome: stores.fsHome,
    sessionPanelRoots: stores.sessionPanelRoots,
    mergedWorkspaces: stores.workspaces,
    workspaceIdForSession: (session: { workspaceId?: string }) => session.workspaceId ?? '',
  }),
  sessionInfoStore: () => ({
    rows: stores.infoRows,
    observe: stores.observe,
    refresh: stores.refresh,
  }),
}));

import SessionHoverCard from '../src/worktree/SessionHoverCard.vue';
import { cleanup, render, textOf, translator, within } from './helpers/dom';

const WORKTREE = '/Users/me/.kimi-code/worktrees/cursor-worktree-entry-test';
const zh = translator('zh');
const MAIN = zh('worktreeSession.mainDirectory');

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

async function mountCard(session: Session, openInApp?: (url: string) => void): Promise<HTMLElement> {
  const { host } = render(SessionHoverCard, { session }, {
    locale: 'zh',
    provide: openInApp === undefined ? [] : [[OpenSidebarBrowserUrlKey, () => openInApp]],
  });
  await nextTick();
  return within(host).getByRole('dialog', { name: session.title });
}

function directories(card: HTMLElement): HTMLElement[] {
  return [...card.querySelectorAll<HTMLElement>('[data-directory]')];
}

function directory(card: HTMLElement, path: string): HTMLElement {
  return card.querySelector<HTMLElement>(`[data-directory="${path}"]`)!;
}

beforeEach(() => {
  stores.sessions = [];
  stores.fsHome = '/Users/me';
  stores.roots = [];
  stores.workspaces = [];
  stores.rows = [];
  stores.sessionPanelRoots.mockReset().mockImplementation(() => ({ root: stores.roots[0] ?? '', roots: stores.roots }));
  stores.infoRows.mockReset().mockImplementation(() => stores.rows);
  stores.observe.mockReset();
  stores.refresh.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SessionHoverCard', () => {
  it('describes a worktree session: name, role, path, source, branch and sync state', async () => {
    stores.sessions = [worktreeRecord()];
    stores.roots = [WORKTREE];
    stores.rows = [ready(WORKTREE)];
    const card = await mountCard(row());

    const main = textOf(directory(card, WORKTREE));
    expect(main.startsWith(`cursor-worktree-entry-test ${MAIN}`)).toBe(true);
    expect(main).toContain('~/.kimi-code/worktrees/cursor-worktree-entry-test');
    expect(main).toContain(zh('worktreeSession.createdFrom', { ref: 'main' }));
    expect(main).toContain(`kimi/1104-b8b6 ${zh('worktreeSession.notPushed')}`);
    expect(directory(card, WORKTREE).querySelector('[data-worktree-icon="git-fork"]')).not.toBeNull();
  });

  it('titles the worktree directory with the project name', async () => {
    stores.sessions = [worktreeRecord()];
    stores.roots = [WORKTREE];
    stores.rows = [ready(WORKTREE)];
    stores.workspaces = [{ id: 'ws-demo', name: 'demo-project' }];
    const card = await mountCard({ ...row(), workspaceId: 'ws-demo' });

    expect(textOf(directory(card, WORKTREE)).startsWith(`demo-project ${MAIN}`)).toBe(true);
  });

  it('marks a worktree created from a remote with the cloud icon', async () => {
    stores.sessions = [worktreeRecord({ base: { ref: 'origin/main', remote: true } })];
    stores.roots = [WORKTREE];
    const card = await mountCard(row());

    expect(textOf(card)).toContain(zh('worktreeSession.createdFrom', { ref: 'origin/main' }));
    expect(card.querySelector('[data-worktree-icon="git-fork-cloud"]')).not.toBeNull();
    expect(within(card).getByLabel(zh('worktreeSession.remoteBase'))).toBeTruthy();
  });

  it('lists every directory in order and marks only the first as main', async () => {
    stores.sessions = [worktreeRecord()];
    stores.roots = [WORKTREE, '/Users/other/extra', '/srv/plain'];
    stores.rows = [
      ready(WORKTREE, { upstream: 'origin/kimi/1104-b8b6' }),
      ready('/Users/other/extra', { branch: 'codex/conflict-safety', upstream: 'origin/codex/conflict-safety' }),
      { path: '/srv/plain', primary: false, state: { status: 'non-git' } },
    ];
    const card = await mountCard(row());

    expect(directories(card).map((node) => node.getAttribute('data-directory'))).toEqual(stores.roots);
    expect(directories(card).map((node) => textOf(node).includes(MAIN))).toEqual([true, false, false]);
    expect(textOf(directory(card, '/Users/other/extra'))).toBe('extra ~/extra codex/conflict-safety');
    expect(textOf(directory(card, '/srv/plain'))).toBe('plain /srv/plain');
  });

  it('strikes the path, warns and hides the pull request when the worktree directory is gone', async () => {
    stores.sessions = [worktreeRecord({ missing: true })];
    stores.roots = [WORKTREE];
    stores.rows = [{ path: WORKTREE, primary: true, state: { status: 'missing' } }];
    const card = await mountCard(row({ pullRequest: { number: 7, state: 'open', url: 'https://example.test/pr/7' } }));

    const text = textOf(card);
    expect(text).toContain(zh('worktreeSession.worktreeMissing'));
    expect(text).not.toContain(zh('worktreeSession.createdFrom', { ref: 'main' }));
    expect(text).toContain('kimi/1104-b8b6');
    expect(within(card).getByText('~/.kimi-code/worktrees/cursor-worktree-entry-test').classList.contains('missing')).toBe(true);
    expect(within(card).queryByRole('button')).toBeNull();
  });

  it('shows only the directory for a local session', async () => {
    stores.sessions = [{ id: 's1', cwd: '/Users/me/Desktop' }];
    stores.roots = ['/Users/me/Desktop'];
    const card = await mountCard(row({ cwd: '/Users/me/Desktop' }));

    expect(textOf(directory(card, '/Users/me/Desktop'))).toBe(`Desktop ${MAIN} ~/Desktop`);
  });

  it('falls back to the listed branch and opens the listed pull request without cached status', async () => {
    stores.sessions = [{ ...worktreeRecord(), pullRequest: { number: 1312, state: 'merged', url: 'https://example.test/pr/1312' } }];
    stores.roots = [WORKTREE];
    const openInApp = vi.fn();
    const card = await mountCard(row(), openInApp);

    expect(textOf(card)).toContain('kimi/1104-b8b6');
    expect(textOf(card)).not.toContain(zh('worktreeSession.notPushed'));
    const pullRequest = within(card).getByRole('button', { name: zh('header.openPr') });
    expect(textOf(pullRequest)).toBe('PR #1312 Merged');
    pullRequest.click();
    expect(openInApp).toHaveBeenCalledExactlyOnceWith('https://example.test/pr/1312');
  });

  it('is read-only: no buttons, no change counts and no status request', async () => {
    stores.sessions = [worktreeRecord()];
    stores.roots = [WORKTREE];
    stores.rows = [ready(WORKTREE, { additions: 3, deletions: 1, entries: { 'a.ts': 'M' } })];
    const card = await mountCard(row());

    expect(within(card).queryAllByRole('button')).toEqual([]);
    expect(textOf(card)).not.toContain('+3');
    expect(stores.observe).not.toHaveBeenCalled();
    expect(stores.refresh).not.toHaveBeenCalled();
  });

  it('uses the row directory when the session is not in the loaded list', async () => {
    const card = await mountCard(row({ cwd: '/Users/me/elsewhere' }));

    expect(stores.sessionPanelRoots).not.toHaveBeenCalled();
    expect(textOf(card)).toContain('~/elsewhere');
  });
});
