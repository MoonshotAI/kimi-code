import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { sessionsStore } from '../src/stores/sessions';
import { sessionListStore, setSessionListHooks } from '../src/stores/sessionList';
import { workspacesStore } from '../src/stores/workspaces';

const getKimiWebApiMock = vi.fn();

const BASE = 1_700_000_000_000;

function makeSession(id: string, index: number) {
  return {
    id,
    title: `title-${id}`,
    workspaceId: 'ws1',
    cwd: '/repo/ws1',
    updatedAt: new Date(BASE - index * 1000).toISOString(),
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
  };
}

function ids(sessions: { id: string }[]): string[] {
  return sessions.map((s) => s.id);
}

beforeEach(() => {
  getKimiWebApiMock.mockReset();
  setKimiClientDeps({ api: () => getKimiWebApiMock(), t: (key) => key });
  sessionsStore().setSessions([]);
  sessionsStore().setActiveSessionId(undefined);
  sessionListStore().resetSessionList();
  setSessionListHooks(null);
  const ws = workspacesStore();
  ws.sessionsCursorByWorkspace = {};
  ws.sessionsHasMoreByWorkspace = {};
});

afterEach(() => {
  resetKimiClientDeps();
  setSessionListHooks(null);
});

describe('sessionList.deleteSession', () => {
  it('removes the row, tombstones the id, and calls the API on success', async () => {
    const deleteSessionMock = vi.fn().mockResolvedValue({ deleted: true });
    getKimiWebApiMock.mockReturnValue({ deleteSession: deleteSessionMock });
    sessionsStore().setSessions([makeSession('s1', 0), makeSession('s2', 1), makeSession('s3', 2)] as never);

    const deleted = await sessionListStore().deleteSession('s2');

    expect(deleted).toBe(true);
    expect(deleteSessionMock).toHaveBeenCalledTimes(1);
    expect(deleteSessionMock).toHaveBeenCalledWith('s2');
    expect(ids(sessionsStore().sessions)).toEqual(['s1', 's3']);
    expect(sessionListStore().hasDeletedTombstone('s2')).toBe(true);
  });

  it('removes the row from doneSessions too', async () => {
    const deleteSessionMock = vi.fn().mockResolvedValue({ deleted: true });
    getKimiWebApiMock.mockReturnValue({ deleteSession: deleteSessionMock });
    sessionListStore().doneSessions = [
      { ...makeSession('s4', 3), archived: true },
      { ...makeSession('s5', 4), archived: true },
    ] as never;

    const deleted = await sessionListStore().deleteSession('s4');

    expect(deleted).toBe(true);
    expect(ids(sessionListStore().doneSessions)).toEqual(['s5']);
    expect(sessionListStore().hasDeletedTombstone('s4')).toBe(true);
  });

  it('invokes onSessionDeletedLocally after the row is already gone', async () => {
    const deleteSessionMock = vi.fn().mockResolvedValue({ deleted: true });
    getKimiWebApiMock.mockReturnValue({ deleteSession: deleteSessionMock });
    sessionsStore().setSessions([makeSession('s1', 0), makeSession('s2', 1)] as never);
    sessionsStore().setActiveSessionId('s2');
    const onSessionDeletedLocally = vi.fn().mockImplementation(async (id: string) => {
      expect(sessionsStore().sessions.some((s) => s.id === id)).toBe(false);
      if (sessionsStore().activeSessionId === id) {
        sessionsStore().setActiveSessionId(sessionsStore().sessions[0]?.id);
      }
    });
    setSessionListHooks({ pushOperationFailure: vi.fn(), onSessionDeletedLocally });

    const deleted = await sessionListStore().deleteSession('s2');

    expect(deleted).toBe(true);
    expect(onSessionDeletedLocally).toHaveBeenCalledTimes(1);
    expect(onSessionDeletedLocally).toHaveBeenCalledWith('s2');
    expect(sessionsStore().activeSessionId).toBe('s1');
  });

  it('keeps the row and reports the failure when the API rejects', async () => {
    const failure = new Error('network down');
    const deleteSessionMock = vi.fn().mockRejectedValue(failure);
    getKimiWebApiMock.mockReturnValue({ deleteSession: deleteSessionMock });
    sessionsStore().setSessions([makeSession('s1', 0), makeSession('s2', 1)] as never);
    const pushOperationFailure = vi.fn();
    const onSessionDeletedLocally = vi.fn();
    setSessionListHooks({ pushOperationFailure, onSessionDeletedLocally });

    const deleted = await sessionListStore().deleteSession('s2');

    expect(deleted).toBe(false);
    expect(pushOperationFailure).toHaveBeenCalledTimes(1);
    expect(pushOperationFailure).toHaveBeenCalledWith('deleteSession', failure, { sessionId: 's2' });
    expect(onSessionDeletedLocally).not.toHaveBeenCalled();
    expect(ids(sessionsStore().sessions)).toEqual(['s1', 's2']);
    expect(sessionListStore().hasDeletedTombstone('s2')).toBe(false);
  });

  it('treats the request as successful when the deletion event already tombstoned the id', async () => {
    const deleteSessionMock = vi.fn().mockRejectedValue(new Error('response lost'));
    getKimiWebApiMock.mockReturnValue({ deleteSession: deleteSessionMock });
    sessionsStore().setSessions([makeSession('s1', 0)] as never);
    sessionListStore().doneSessions = [
      { ...makeSession('s1', 0), archived: true },
      { ...makeSession('s2', 1), archived: true },
    ] as never;
    sessionListStore().noteSessionDeleted('s1');
    const pushOperationFailure = vi.fn();
    const onSessionDeletedLocally = vi.fn();
    setSessionListHooks({ pushOperationFailure, onSessionDeletedLocally });

    const deleted = await sessionListStore().deleteSession('s1');

    expect(deleted).toBe(true);
    expect(onSessionDeletedLocally).toHaveBeenCalledWith('s1');
    expect(pushOperationFailure).not.toHaveBeenCalled();
    expect(sessionsStore().sessions.some((s) => s.id === 's1')).toBe(false);
    expect(ids(sessionListStore().doneSessions)).toEqual(['s2']);
  });

  it('drops a restore response that resolves after the session was deleted', async () => {
    const restoreSessionMock = vi.fn().mockResolvedValue(makeSession('s1', 0));
    getKimiWebApiMock.mockReturnValue({ restoreSession: restoreSessionMock });
    sessionListStore().noteSessionDeleted('s1');

    const restored = await sessionListStore().restoreSession('s1');

    expect(restored).toBe(false);
    expect(sessionsStore().sessions.some((s) => s.id === 's1')).toBe(false);
  });

  it('filters tombstoned ids out of the done list first page', async () => {
    const doneItem = (id: string) => ({
      ...makeSession(id, 0),
      lastPrompt: `prompt-${id}`,
      archived: true,
      archivedAt: new Date(3000).toISOString(),
    });
    const listSessions = vi.fn().mockResolvedValue({
      items: [doneItem('s4'), doneItem('s5')],
      hasMore: false,
      nextPageToken: null,
      total: 2,
    });
    getKimiWebApiMock.mockReturnValue({ listSessions });
    sessionListStore().noteSessionDeleted('s4');
    sessionListStore().doneSessionsHasMore = true;

    await sessionListStore().loadMoreDoneSessions();

    expect(ids(sessionListStore().doneSessions)).toEqual(['s5']);
  });

  it('re-anchors the workspace cursor when the deleted row was the cursor', async () => {
    const deleteSessionMock = vi.fn().mockResolvedValue({ deleted: true });
    const listSessionsMock = vi
      .fn()
      .mockResolvedValue({ items: [], hasMore: false, nextPageToken: null });
    getKimiWebApiMock.mockReturnValue({
      deleteSession: deleteSessionMock,
      listSessions: listSessionsMock,
    });
    sessionsStore().setSessions([makeSession('s1', 0), makeSession('s2', 1), makeSession('s3', 2)] as never);
    const ws = workspacesStore();
    ws.sessionsCursorByWorkspace = { ws1: 's3' };
    ws.sessionsHasMoreByWorkspace = { ws1: true };

    const deleted = await sessionListStore().deleteSession('s3');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deleted).toBe(true);
    expect(ws.sessionsCursorByWorkspace.ws1).not.toBe('s3');
  });

  it('re-anchors the workspace cursor on the remote-event convergence path too', async () => {
    const listSessionsMock = vi
      .fn()
      .mockResolvedValue({ items: [], hasMore: false, nextPageToken: null });
    getKimiWebApiMock.mockReturnValue({ listSessions: listSessionsMock });
    sessionsStore().setSessions([makeSession('s1', 0), makeSession('s2', 1), makeSession('s3', 2)] as never);
    const ws = workspacesStore();
    ws.sessionsCursorByWorkspace = { ws1: 's3' };
    ws.sessionsHasMoreByWorkspace = { ws1: true };

    await sessionListStore().applySessionDeletedLocally('s3');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ws.sessionsCursorByWorkspace.ws1).not.toBe('s3');
    expect(ids(sessionsStore().sessions)).toEqual(['s1', 's2']);
  });
});
