import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionAdminBatchOutcome } from '@moonshot-ai/app-client/client';

const client = vi.hoisted(() => ({
  archiveSessions: vi.fn(),
  restoreSessions: vi.fn(),
  notify: vi.fn(),
  showActionToast: vi.fn(),
}));

vi.mock('@moonshot-ai/app-client/client', () => ({
  useKimiWebClient: () => client,
  planAdminBatchToast: (direction: 'archive' | 'restore', outcome: SessionAdminBatchOutcome) =>
    outcome.succeeded === 0
      ? null
      : { direction, ids: outcome.okIds, succeeded: outcome.succeeded, failed: outcome.failed },
}));

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => `${key}:${JSON.stringify(params ?? {})}`,
  }),
}));

import { useSessionAdminBatch } from '../src/admin/useSessionAdminBatch';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('useSessionAdminBatch', () => {
  beforeEach(() => {
    client.archiveSessions.mockReset();
    client.restoreSessions.mockReset();
    client.notify.mockReset();
    client.showActionToast.mockReset();
  });

  it('ignores a new batch while one is running', async () => {
    const pending = deferred<SessionAdminBatchOutcome>();
    client.archiveSessions.mockReturnValue(pending.promise);
    client.restoreSessions.mockResolvedValue({ okIds: ['c'], succeeded: 1, failed: 0 });
    const { sessionAdminBatchRunning, runSessionAdminBatch } = useSessionAdminBatch();

    const first = runSessionAdminBatch('archive', ['a', 'b']);
    expect(sessionAdminBatchRunning.value).toBe('archive');
    await runSessionAdminBatch('restore', ['c']);
    await runSessionAdminBatch('archive', ['d']);

    expect(client.archiveSessions).toHaveBeenCalledTimes(1);
    expect(client.archiveSessions).toHaveBeenCalledWith(['a', 'b']);
    expect(client.restoreSessions).not.toHaveBeenCalled();

    pending.resolve({ okIds: ['a', 'b'], succeeded: 2, failed: 0 });
    await first;

    expect(sessionAdminBatchRunning.value).toBeNull();
    expect(client.showActionToast).toHaveBeenCalledTimes(1);
    expect(client.showActionToast).toHaveBeenCalledWith({
      kind: 'adminBatch',
      plan: { direction: 'archive', ids: ['a', 'b'], succeeded: 2, failed: 0 },
    });
  });

  it('notifies instead of showing a toast when every session fails', async () => {
    client.restoreSessions.mockResolvedValue({ okIds: [], succeeded: 0, failed: 3 });
    const { sessionAdminBatchRunning, runSessionAdminBatch } = useSessionAdminBatch();

    await runSessionAdminBatch('restore', ['a', 'b', 'c']);

    expect(client.notify).toHaveBeenCalledTimes(1);
    expect(client.notify).toHaveBeenCalledWith({
      severity: 'error',
      title: 'admin.batchReopenFailedNotice:{"n":3}',
    });
    expect(client.showActionToast).not.toHaveBeenCalled();
    expect(sessionAdminBatchRunning.value).toBeNull();
  });
});
