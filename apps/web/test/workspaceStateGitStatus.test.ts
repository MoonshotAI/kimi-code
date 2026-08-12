// apps/kimi-web/test/workspaceStateGitStatus.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getKimiWebApiMock } = vi.hoisted(() => ({
  getKimiWebApiMock: vi.fn(),
}));

vi.mock('../src/api', () => ({ getKimiWebApi: getKimiWebApiMock }));

import { useWorkspaceState } from '../src/composables/client/useWorkspaceState';
import type { AppSession } from '../src/api/types';

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

function createState(sessions: Array<Pick<AppSession, 'id'> & Partial<AppSession>>) {
  const rawState = {
    sessions,
    gitStatusBySession: {} as Record<string, GitStatusResult>,
  };
  const deps = {
    updateSession: (id: string, update: (s: AppSession) => AppSession) => {
      rawState.sessions = rawState.sessions.map((s) => (s.id === id ? update(s as AppSession) : s));
    },
    pushOperationFailure: vi.fn(),
  };
  return { rawState, ws: useWorkspaceState(rawState as never, deps as never) };
}

describe('loadGitStatus — pullRequest mirror into the sessions pool', () => {
  beforeEach(() => {
    getKimiWebApiMock.mockReset();
  });

  it('mirrors a fresh PR onto the pooled session so the sidebar chip updates', async () => {
    getKimiWebApiMock.mockReturnValue({ getGitStatus: vi.fn().mockResolvedValue(gitStatus(OPEN_PR)) });
    const { rawState, ws } = createState([{ id: 's1', pullRequest: null }]);

    await ws.loadGitStatus('s1');

    expect(rawState.gitStatusBySession['s1']?.pullRequest).toEqual(OPEN_PR);
    expect(rawState.sessions[0]!.pullRequest).toEqual({
      number: 12,
      state: 'open',
      url: 'https://github.com/o/r/pull/12',
    });
  });

  it('clears the pooled PR when the branch no longer has one', async () => {
    getKimiWebApiMock.mockReturnValue({ getGitStatus: vi.fn().mockResolvedValue(gitStatus(null)) });
    const { rawState, ws } = createState([
      { id: 's1', pullRequest: { number: 12, state: 'open', url: 'https://github.com/o/r/pull/12' } },
    ]);

    await ws.loadGitStatus('s1');

    expect(rawState.sessions[0]!.pullRequest).toBeNull();
  });

  it('keeps the session object identity when the PR is unchanged (no pool churn)', async () => {
    getKimiWebApiMock.mockReturnValue({ getGitStatus: vi.fn().mockResolvedValue(gitStatus(OPEN_PR)) });
    const pooled = {
      id: 's1',
      pullRequest: { number: 12, state: 'open', url: 'https://github.com/o/r/pull/12' } as const,
    };
    const { rawState, ws } = createState([pooled]);

    await ws.loadGitStatus('s1');

    expect(rawState.sessions[0]).toBe(pooled);
  });

  it('narrows an unrecognized PR state to null instead of guessing', async () => {
    getKimiWebApiMock.mockReturnValue({
      getGitStatus: vi.fn().mockResolvedValue(gitStatus({ number: 3, state: 'draft', url: 'https://github.com/o/r/pull/3' })),
    });
    const { rawState, ws } = createState([{ id: 's1', pullRequest: null }]);

    await ws.loadGitStatus('s1');

    expect(rawState.sessions[0]!.pullRequest).toBeNull();
  });

  it('leaves the pool untouched when the request fails', async () => {
    getKimiWebApiMock.mockReturnValue({ getGitStatus: vi.fn().mockRejectedValue(new Error('404')) });
    const { rawState, ws } = createState([{ id: 's1', pullRequest: null }]);

    await ws.loadGitStatus('s1');

    expect(rawState.gitStatusBySession['s1']).toBeUndefined();
    expect(rawState.sessions[0]!.pullRequest).toBeNull();
  });

  it('is a no-op for a session that is no longer pooled', async () => {
    getKimiWebApiMock.mockReturnValue({ getGitStatus: vi.fn().mockResolvedValue(gitStatus(OPEN_PR)) });
    const { rawState, ws } = createState([{ id: 's1' }]);

    await ws.loadGitStatus('archived-away');

    expect(rawState.sessions).toHaveLength(1);
    expect(rawState.sessions[0]!.id).toBe('s1');
  });
});
