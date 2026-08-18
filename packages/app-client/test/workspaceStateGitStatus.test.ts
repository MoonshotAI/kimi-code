// packages/app-client/test/workspaceStateGitStatus.test.ts
// loadGitStatus lives in the files store (P12); the pullRequest mirror writes
// the sessions store's pool. Both stores are resolved through the package-held
// pinia instance, so the tests seed and assert the stores directly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { filesStore } from '../src/stores/files';
import { sessionsStore } from '../src/stores/sessions';
import type { AppSession } from '@moonshot-ai/app-core/api';

const getKimiWebApiMock = vi.fn();

interface GitStatusResult {
  branch: string;
  ahead: number;
  behind: number;
  entries: Record<string, string>;
  additions: number;
  deletions: number;
  pullRequest: { number: number; state: string; url: string } | null;
}

function gitStatus(pullRequest: GitStatusResult['pullRequest']): GitStatusResult {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    entries: {},
    additions: 0,
    deletions: 0,
    pullRequest,
  };
}

const OPEN_PR = { number: 12, state: 'open', url: 'https://github.com/o/r/pull/12' };

function seedSessions(sessions: Array<Pick<AppSession, 'id'> & Partial<AppSession>>) {
  sessionsStore().setSessions(sessions as AppSession[]);
}

describe('loadGitStatus — pullRequest mirror into the sessions pool', () => {
  beforeEach(() => {
    getKimiWebApiMock.mockReset();
    setKimiClientDeps({ api: () => getKimiWebApiMock(), t: (key) => key });
    sessionsStore().setSessions([]);
    filesStore().clearSessionGitStatus('s1');
    filesStore().clearSessionGitStatus('archived-away');
  });

  afterEach(() => {
    resetKimiClientDeps();
  });

  it('mirrors a fresh PR onto the pooled session so the sidebar chip updates', async () => {
    getKimiWebApiMock.mockReturnValue({ getGitStatus: vi.fn().mockResolvedValue(gitStatus(OPEN_PR)) });
    seedSessions([{ id: 's1', pullRequest: null }]);

    await filesStore().loadGitStatus('s1');

    expect(filesStore().gitStatusBySession['s1']?.pullRequest).toEqual(OPEN_PR);
    expect(sessionsStore().sessions[0]!.pullRequest).toEqual({
      number: 12,
      state: 'open',
      url: 'https://github.com/o/r/pull/12',
    });
  });

  it('clears the pooled PR when the branch no longer has one', async () => {
    getKimiWebApiMock.mockReturnValue({ getGitStatus: vi.fn().mockResolvedValue(gitStatus(null)) });
    seedSessions([
      { id: 's1', pullRequest: { number: 12, state: 'open', url: 'https://github.com/o/r/pull/12' } },
    ]);

    await filesStore().loadGitStatus('s1');

    expect(sessionsStore().sessions[0]!.pullRequest).toBeNull();
  });

  it('keeps the session object identity when the PR is unchanged (no pool churn)', async () => {
    getKimiWebApiMock.mockReturnValue({ getGitStatus: vi.fn().mockResolvedValue(gitStatus(OPEN_PR)) });
    const pooled = {
      id: 's1',
      pullRequest: { number: 12, state: 'open', url: 'https://github.com/o/r/pull/12' } as const,
    };
    seedSessions([pooled]);

    const before = sessionsStore().sessions[0];
    await filesStore().loadGitStatus('s1');

    // Unchanged PR → updateSession's mapper returns the same object, so the
    // pooled entry keeps its identity (the sidebar row is not dirtied).
    expect(sessionsStore().sessions[0]).toBe(before);
  });

  it('narrows an unrecognized PR state to null instead of guessing', async () => {
    getKimiWebApiMock.mockReturnValue({
      getGitStatus: vi.fn().mockResolvedValue(gitStatus({ number: 3, state: 'draft', url: 'https://github.com/o/r/pull/3' })),
    });
    seedSessions([{ id: 's1', pullRequest: null }]);

    await filesStore().loadGitStatus('s1');

    expect(sessionsStore().sessions[0]!.pullRequest).toBeNull();
  });

  it('leaves the pool untouched when the request fails', async () => {
    getKimiWebApiMock.mockReturnValue({ getGitStatus: vi.fn().mockRejectedValue(new Error('404')) });
    seedSessions([{ id: 's1', pullRequest: null }]);

    await filesStore().loadGitStatus('s1');

    expect(filesStore().gitStatusBySession['s1']).toBeUndefined();
    expect(sessionsStore().sessions[0]!.pullRequest).toBeNull();
  });

  it('is a no-op for a session that is no longer pooled', async () => {
    getKimiWebApiMock.mockReturnValue({ getGitStatus: vi.fn().mockResolvedValue(gitStatus(OPEN_PR)) });
    seedSessions([{ id: 's1' }]);

    await filesStore().loadGitStatus('archived-away');

    expect(sessionsStore().sessions).toHaveLength(1);
    expect(sessionsStore().sessions[0]!.id).toBe('s1');
  });
});
