// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { AppSession, GitStatusBatchResult } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../../../../packages/app-client/src/client/deps';
import { sessionInfoStore } from '../../../../packages/app-client/src/stores/sessionInfo';
import { sessionsStore } from '../../../../packages/app-client/src/stores/sessions';

vi.mock('@moonshot-ai/app-client/stores', async () => {
  const { sessionInfoStore } = await import('../../../../packages/app-client/src/stores/sessionInfo');
  const { sessionsStore } = await import('../../../../packages/app-client/src/stores/sessions');
  const { workspacesStore } = await import('../../../../packages/app-client/src/stores/workspaces');
  return { sessionInfoStore, sessionsStore, workspacesStore };
});

import SessionInfoPanel from '../../src/renderer/components/chat/SessionInfoPanel.vue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res });
  return { promise, resolve };
}

let app: App | undefined;
let host: HTMLDivElement | undefined;

beforeEach(() => {
  sessionsStore().setSessions([{ id: 's1', cwd: '/repo/a' } as AppSession]);
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  sessionInfoStore().unobserve('s1');
  sessionsStore().setSessions([]);
  resetKimiClientDeps();
  app = undefined;
  host = undefined;
});

describe('SessionInfoPanel observation', () => {
  it('keeps loaded folder state after a reactive observation settles', async () => {
    const response = deferred<GitStatusBatchResult>();
    const getGitStatusBatch = vi.fn().mockReturnValue(response.promise);
    const getPullRequestBatch = vi.fn().mockResolvedValue({ results: {}, errors: {} });
    setKimiClientDeps({ api: () => ({ getGitStatusBatch, getPullRequestBatch }) as never, t: (key) => key });

    host = document.createElement('div');
    document.body.append(host);
    app = createApp(SessionInfoPanel, { sessionId: 's1', mode: 'floating' });
    app.use(createKimiI18n({ locale: 'zh' }));
    app.mount(host);
    await nextTick();

    expect(getGitStatusBatch).toHaveBeenCalledExactlyOnceWith('s1', { roots: ['/repo/a'], includePullRequest: false, includeUntracked: true }, undefined);
    response.resolve({ results: { '/repo/a': { branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null } }, errors: {} });

    await vi.waitFor(() => expect(sessionInfoStore().rows('s1')[0]?.state.status).toBe('ready'));
    expect(getGitStatusBatch).toHaveBeenCalledTimes(1);
    sessionsStore().updateSession('s1', session => ({ ...session, title: 'renamed', busy: true }));
    await nextTick();
    expect(getGitStatusBatch).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('main');
  });

  it('reloads for the worktree directory once the session moves into it', async () => {
    const status = { branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null };
    const getGitStatusBatch = vi.fn(async (_sessionId: string, query: { roots: string[] }) => ({
      results: Object.fromEntries(query.roots.map(root => [root, { ...status, branch: root === '/worktrees/s1' ? 'kimi/s1' : 'main' }])),
      errors: {},
    }));
    const getPullRequestBatch = vi.fn().mockResolvedValue({ results: {}, errors: {}, statuses: {} });
    setKimiClientDeps({ api: () => ({ getGitStatusBatch, getPullRequestBatch }) as never, t: (key) => key });
    sessionsStore().updateSession('s1', session => ({
      ...session,
      worktree: { setup: { status: 'running' } } as AppSession['worktree'],
    }));

    host = document.createElement('div');
    document.body.append(host);
    app = createApp(SessionInfoPanel, { sessionId: 's1', mode: 'floating' });
    app.use(createKimiI18n({ locale: 'zh' }));
    app.mount(host);
    await vi.waitFor(() => expect(host!.querySelector('.sif-branch')?.textContent).toBe('main'));
    expect(host.querySelector('.sif-created')).toBeNull();

    sessionsStore().updateSession('s1', session => ({
      ...session,
      cwd: '/worktrees/s1',
      worktree: {
        path: '/worktrees/s1',
        branch: 'kimi/s1',
        base: { ref: 'main', remote: false },
        setup: { status: 'ready' },
      } as AppSession['worktree'],
    }));
    await vi.waitFor(() => expect(host!.querySelector('.sif-branch')?.textContent).toBe('kimi/s1'));

    expect(getGitStatusBatch.mock.calls.at(-1)?.slice(0, 2)).toEqual(['s1', { roots: ['/worktrees/s1'], includePullRequest: false, includeUntracked: true }]);
    expect(host.querySelector('.sif-path')?.textContent).toBe('/worktrees/s1');
    expect(host.querySelector('.sif-created')?.textContent).toBe('基于 main 创建');
  });
});
