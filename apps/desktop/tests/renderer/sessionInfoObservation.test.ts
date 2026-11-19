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
  return { sessionInfoStore };
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

    expect(getGitStatusBatch).toHaveBeenCalledExactlyOnceWith('s1', { roots: ['/repo/a'], includePullRequest: false }, undefined);
    response.resolve({ results: { '/repo/a': { branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null } }, errors: {} });

    await vi.waitFor(() => expect(sessionInfoStore().rows('s1')[0]?.state.status).toBe('ready'));
    expect(getGitStatusBatch).toHaveBeenCalledTimes(1);
    sessionsStore().updateSession('s1', session => ({ ...session, title: 'renamed', busy: true }));
    await nextTick();
    expect(getGitStatusBatch).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('main');
  });
});
