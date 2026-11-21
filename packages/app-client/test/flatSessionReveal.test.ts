import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const memStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memStorage.get(key) ?? null,
  setItem: (key: string, value: string) => void memStorage.set(key, value),
  removeItem: (key: string) => void memStorage.delete(key),
  clear: () => memStorage.clear(),
});

import type { AppSession } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { useKimiWebClient } from '../src/client/useKimiWebClient';
import { sessionsStore } from '../src/stores/sessions';
import { sessionViewsStore } from '../src/stores/sessionViews';
import { workspacesStore } from '../src/stores/workspaces';

const BASE_TIME = Date.UTC(2026, 0, 1);

function session(id: string, updatedAt: number): AppSession {
  return {
    id,
    title: id,
    createdAt: new Date(BASE_TIME).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    busy: false,
    mainTurnActive: false,
    pendingInteraction: 'none',
    archived: false,
    cwd: '/repo/a',
    model: 'model-1',
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
    workspaceId: 'ws-a',
  };
}

beforeEach(() => {
  memStorage.clear();
  setKimiClientDeps({
    api: () => ({ getWorkspaceTrust: vi.fn(async () => ({ trusted: true })) }) as never,
    t: (key) => key,
  });
  workspacesStore().workspaces = [{ id: 'ws-a', root: '/repo/a', name: 'Alpha', sessionCount: 0 }];
  workspacesStore().hiddenWorkspaceIds = [];
  workspacesStore().pinnedWorkspaceIds = [];
  sessionsStore().setSessions([]);
  sessionsStore().unpinSessions([...sessionsStore().pinnedSessionIds]);
  sessionViewsStore().setFlatSessionsFrontier(null);
});

afterEach(() => {
  sessionViewsStore().stopSessionTimeClock();
  resetKimiClientDeps();
});

describe('revealFlatSession', () => {
  it('extends both flat windows and the frontier to include the selected search result', () => {
    const rows = Array.from({ length: 60 }, (_, index) => session(`s-${index}`, BASE_TIME - index * 1000));
    sessionsStore().setSessions(rows);
    sessionViewsStore().setFlatSessionsFrontier(BASE_TIME - 55 * 1000);
    const client = useKimiWebClient();

    expect(client.flatSessions.value).toHaveLength(50);
    expect(client.sidebarFlatSessions.value).toHaveLength(50);
    expect(client.flatSessions.value.some((s) => s.id === 's-59')).toBe(false);
    expect(client.sidebarFlatSessions.value.some((s) => s.id === 's-59')).toBe(false);

    client.revealFlatSession('s-59');

    expect(sessionViewsStore().flatSessionsFrontier).toBe(BASE_TIME - 59 * 1000);
    expect(client.flatSessions.value).toHaveLength(60);
    expect(client.sidebarFlatSessions.value).toHaveLength(60);
    expect(client.flatSessions.value[59]?.id).toBe('s-59');
    expect(client.sidebarFlatSessions.value[59]?.id).toBe('s-59');
  });

  it('keeps the frontier when a status session is already included', () => {
    const rows = Array.from({ length: 60 }, (_, index) => session(`s-${index}`, BASE_TIME - index * 1000));
    rows[59]!.mainTurnActive = true;
    sessionsStore().setSessions(rows);
    sessionViewsStore().setFlatSessionsFrontier(BASE_TIME - 55 * 1000);
    const client = useKimiWebClient();

    expect(client.flatSessions.value.some((s) => s.id === 's-59')).toBe(true);
    expect(client.sidebarFlatSessions.value.some((s) => s.id === 's-59')).toBe(true);

    client.revealFlatSession('s-59');

    expect(sessionViewsStore().flatSessionsFrontier).toBe(BASE_TIME - 55 * 1000);
  });
});
