import {
  DaemonApiError,
  WORKTREE_REMOVE_FAILED_CODE,
  type AppSession,
  type AppSessionWorktree,
  type AppWorkspace,
  type AppWorktree,
  type AppWorktreeHeldPrompt,
  type AppWorktreeRisk,
  type AppWorktreeSetup,
  type WorkspaceGitBranches,
} from '@moonshot-ai/app-core/api';

export function worktreeSetup(overrides: Partial<AppWorktreeSetup> = {}): AppWorktreeSetup {
  return {
    status: 'ready',
    purpose: 'create',
    request: { sourceBranch: 'main' },
    steps: [],
    commandsRan: 0,
    startedAt: '2026-11-18T00:00:00.000Z',
    ...overrides,
  };
}

export function sessionWorktree(
  status: AppWorktreeSetup['status'],
  overrides: Partial<AppSessionWorktree> = {},
  setup: Partial<AppWorktreeSetup> = {},
): AppSessionWorktree {
  return { ...overrides, setup: worktreeSetup({ status, ...setup }) };
}

export function heldPromptFixture(overrides: Partial<AppWorktreeHeldPrompt> = {}): AppWorktreeHeldPrompt {
  return {
    promptId: 'held-1',
    kind: 'prompt',
    createdAt: '2026-11-18T00:00:00.000Z',
    content: [{ type: 'text', text: 'hello' }],
    ...overrides,
  };
}

export function workspaceGitBranches(overrides: Partial<WorkspaceGitBranches> = {}): WorkspaceGitBranches {
  return {
    isRepo: true,
    remotes: ['origin'],
    headBranch: 'main',
    dirty: false,
    branches: [
      { name: 'topic', committedAt: '2026-11-18T00:00:00.000Z' },
      { name: 'main', committedAt: '2026-11-17T00:00:00.000Z', remoteRef: 'origin/main' },
    ],
    ...overrides,
  };
}

export function appWorkspace(id: string, overrides: Partial<AppWorkspace> = {}): AppWorkspace {
  return { id, root: `/${id}`, name: id, kind: 'managed', additionalDirs: [], sessionCount: 0, ...overrides };
}

export function appSession(overrides: Partial<AppSession> = {}): AppSession {
  return {
    id: 's1',
    title: 's1',
    createdAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-18T00:00:00.000Z',
    busy: false,
    archived: false,
    cwd: '/workspace',
    model: 'kimi-k3',
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
    workspaceId: 'workspace',
    ...overrides,
  };
}

export function appWorktree(name: string, overrides: Partial<AppWorktree> = {}): AppWorktree {
  return {
    path: `/wt/${name}`,
    name,
    repoRoot: '/repo',
    workspaceId: 'ws-1',
    workspaceName: 'Repo',
    branch: `kimi/${name}`,
    origin: 'product',
    sessions: [],
    ...overrides,
  };
}

export function worktreeRisk(name: string, overrides: Partial<AppWorktreeRisk> = {}): AppWorktreeRisk {
  return {
    path: `/wt/${name}`,
    branch: `kimi/${name}`,
    uncommittedFiles: 0,
    unpushedCommits: 0,
    sessions: [],
    ...overrides,
  };
}

export function worktreeRemoveFailed(reason: string, output: string): DaemonApiError {
  return new DaemonApiError({
    code: WORKTREE_REMOVE_FAILED_CODE,
    msg: 'remove failed',
    requestId: 'r1',
    details: { reason, output },
  });
}

export function memoryStorage(
  data: Map<string, string> = new Map(),
): Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'clear'> {
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
    clear: () => {
      data.clear();
    },
  };
}
