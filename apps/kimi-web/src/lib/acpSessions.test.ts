// apps/kimi-web/src/lib/acpSessions.test.ts
import { describe, expect, it } from 'vitest';

import type { AppSession } from '../api/types';
import { acpOnlyWorkspaceRoots, isAcpSession } from './acpSessions';
import { workspaceRootKey } from './rootKey';

function makeSession(overrides: Partial<AppSession>): AppSession {
  return {
    id: 'session_1',
    title: 't',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    busy: false,
    archived: false,
    cwd: '/repo',
    model: 'kimi',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextLimit: 0,
      turnCount: 0,
    },
    messageCount: 0,
    lastSeq: 0,
    ...overrides,
  };
}

describe('isAcpSession', () => {
  it('matches exactly the acp source tag', () => {
    expect(isAcpSession(makeSession({ source: 'acp' }))).toBe(true);
    expect(isAcpSession(makeSession({ source: 'vscode' }))).toBe(false);
    expect(isAcpSession(makeSession({}))).toBe(false);
  });
});

describe('acpOnlyWorkspaceRoots', () => {
  it('reports roots whose sessions are all ACP-created', () => {
    const roots = acpOnlyWorkspaceRoots([
      makeSession({ id: 'a', cwd: '/agent/s_1', source: 'acp' }),
      makeSession({ id: 'b', cwd: '/agent/s_1', source: 'acp' }),
      makeSession({ id: 'c', cwd: '/repo', source: undefined }),
    ]);
    expect(roots).toEqual([workspaceRootKey('/agent/s_1')]);
  });

  it('hides nothing when a workspace has any non-ACP session', () => {
    const roots = acpOnlyWorkspaceRoots([
      makeSession({ id: 'a', cwd: '/mixed', source: 'acp' }),
      makeSession({ id: 'b', cwd: '/mixed' }),
    ]);
    expect(roots).toEqual([]);
  });

  it('never reports a root with no ACP session (no vacuous truth on empty/ACP-free sets)', () => {
    expect(acpOnlyWorkspaceRoots([])).toEqual([]);
    expect(acpOnlyWorkspaceRoots([makeSession({ id: 'a', cwd: '/repo' })])).toEqual([]);
  });

  it('skips sessions without a cwd', () => {
    const roots = acpOnlyWorkspaceRoots([makeSession({ id: 'a', cwd: '', source: 'acp' })]);
    expect(roots).toEqual([]);
  });
});
