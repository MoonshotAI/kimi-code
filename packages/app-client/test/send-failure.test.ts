import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DaemonApiError, type KimiWebApi } from '@moonshot-ai/app-core/api';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { createSendFailureNotifier } from '../src/client/sendFailure';
import { confirmSessionOccupied, retryWhileOccupied } from '../src/client/sessionOccupancy';
import { submitWithNetworkRetry } from '../src/client/submitRetry';
import { useConfirmDialog } from '../src/composables/useConfirmDialog';
import { noopProductTracker, setProductTracker } from '../src/contracts';
import { sessionsStore } from '../src/stores/sessions';
import { warningsStore } from '../src/stores/warnings';
import { networkError, promptIdConflict } from './daemonErrors';

function occupiedError(identity?: string, displayName?: string): DaemonApiError {
  return new DaemonApiError({
    code: 40931,
    msg: 'session occupied',
    requestId: 'req-1',
    details: { holder: { pid: 1234, clientIdentity: identity, clientDisplayName: displayName } },
  });
}

function staleError(): DaemonApiError {
  return new DaemonApiError({ code: 40932, msg: 'session stale', requestId: 'req-2' });
}

function translateWithClient(key: string, params?: Record<string, unknown>): string {
  const client = params?.['client'];
  return typeof client === 'string' ? `${key}:${client}` : key;
}

describe('session occupancy notices', () => {
  const pushOperationFailure = vi.fn();
  let trackSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pushOperationFailure.mockClear();
    trackSpy = vi.fn();
    setProductTracker({ track: trackSpy });
    useConfirmDialog().settle(false);
    sessionsStore().setActiveSessionId('s1');
    warningsStore().resetWarnings();
    setKimiClientDeps({ api: () => ({}) as unknown as KimiWebApi, t: (key) => key });
  });

  afterEach(() => {
    setProductTracker(noopProductTracker);
    resetKimiClientDeps();
  });

  it('falls back to a warning instead of replacing an open confirm dialog', async () => {
    const dialog = useConfirmDialog();
    const existing = dialog.confirm({ title: 'delete workspace' });

    expect(await confirmSessionOccupied(occupiedError(), 's1')).toBe(false);
    expect(dialog.current.value).toMatchObject({ title: 'delete workspace' });
    expect(warningsStore().warnings).toHaveLength(1);
    expect(trackSpy).not.toHaveBeenCalled();
    dialog.settle(true);
    expect(await existing).toBe(true);
  });

  it('shows the holder display name in the dialog and keeps client identity in telemetry', async () => {
    setKimiClientDeps({
      api: () => ({}) as unknown as KimiWebApi,
      t: translateWithClient,
    });
    const decision = confirmSessionOccupied(
      occupiedError('kimi_code_desktop', 'Kimi Code Desktop'),
      's1',
    );

    await vi.waitFor(() => expect(useConfirmDialog().current.value).toMatchObject({
      message: 'warnings.sessionOccupied.messageWithClient:Kimi Code Desktop',
    }));
    expect(trackSpy).toHaveBeenCalledWith('occupied_prompt_shown', {
      holder_client: 'kimi_code_desktop',
      opener_client: 'web',
    });
    useConfirmDialog().settle(false);
    expect(await decision).toBe(false);
  });

  it('shows the holder display name in occupied warnings', () => {
    setKimiClientDeps({
      api: () => ({}) as unknown as KimiWebApi,
      t: translateWithClient,
    });
    createSendFailureNotifier({ pushOperationFailure })(
      'sendPrompt',
      occupiedError('kimi_code_cli', 'Kimi Code Web'),
      's1',
    );

    expect(warningsStore().warnings).toEqual([{
      severity: 'warning',
      title: 'warnings.sessionOccupied.title',
      message: 'warnings.sessionOccupied.messageWithClient:Kimi Code Web',
      position: 'bottom-right',
    }]);
  });

  it.each([undefined, ''])('falls back to the generic warning when the display name is %s', (displayName) => {
    createSendFailureNotifier({ pushOperationFailure })(
      'sendPrompt',
      occupiedError('kimi_code_cli', displayName),
      's1',
    );

    expect(warningsStore().warnings).toEqual([{
      severity: 'warning',
      title: 'warnings.sessionOccupied.title',
      message: 'warnings.sessionOccupied.message',
      position: 'bottom-right',
    }]);
  });

  it.each([
    ['confirmed', true, 2, 'retry'],
    ['cancelled', false, 1, 'cancel'],
  ] as const)('retries in place while occupied when the dialog is %s', async (_label, confirmed, callCount, choice) => {
    const err = occupiedError('cli');
    const run = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('done');
    const result = retryWhileOccupied('s1', run);

    await vi.waitFor(() => expect(useConfirmDialog().current.value).toMatchObject({
      title: 'warnings.sessionOccupied.title',
      message: 'warnings.sessionOccupied.message',
      confirmLabel: 'warnings.sessionOccupied.retry',
      variant: 'primary',
    }));
    expect(trackSpy).toHaveBeenCalledWith('occupied_prompt_shown', { holder_client: 'cli', opener_client: 'web' });
    useConfirmDialog().settle(confirmed);

    await (confirmed ? expect(result).resolves.toBe('done') : expect(result).rejects.toBe(err));
    expect(run).toHaveBeenCalledTimes(callCount);
    expect(trackSpy).toHaveBeenCalledWith('occupied_choice', { choice });
  });

  it.each([
    ['takes over the lock and retries', true],
    ['gives up without taking over', false],
  ] as const)('offers takeover once a retry is still occupied and %s', async (_label, confirmed) => {
    const takeoverSessionLock = vi.fn(async () => {});
    setKimiClientDeps({
      api: () => ({ takeoverSessionLock }) as unknown as KimiWebApi,
      t: (key) => key,
    });
    const err = new DaemonApiError({
      code: 40931,
      msg: 'session occupied',
      requestId: 'req-1',
      details: { holder: { pid: 1234, hostname: 'host-a', clientIdentity: 'cli' } },
    });
    const run = vi.fn().mockRejectedValueOnce(err).mockRejectedValueOnce(err).mockResolvedValue('done');
    const result = retryWhileOccupied('s1', run);

    await vi.waitFor(() => expect(useConfirmDialog().current.value).toMatchObject({
      confirmLabel: 'warnings.sessionOccupied.retry',
    }));
    useConfirmDialog().settle(true);
    await vi.waitFor(() => expect(useConfirmDialog().current.value).toMatchObject({
      title: 'warnings.sessionOccupied.stillTitle',
      message: 'warnings.sessionOccupied.takeoverMessage',
      confirmLabel: 'warnings.sessionOccupied.takeover',
      variant: 'danger',
      initialFocus: 'cancel',
    }));
    if (confirmed) {
      await useConfirmDialog().runAction();
    } else {
      useConfirmDialog().settle(false);
    }

    await (confirmed ? expect(result).resolves.toBe('done') : expect(result).rejects.toBe(err));
    expect(run).toHaveBeenCalledTimes(confirmed ? 3 : 2);
    expect(takeoverSessionLock).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    if (confirmed) expect(takeoverSessionLock).toHaveBeenCalledWith('s1');
    expect(trackSpy).toHaveBeenLastCalledWith('occupied_choice', {
      choice: confirmed ? 'takeover' : 'cancel',
    });
  });

  it('declines the retry when the user has switched to another session', async () => {
    const decision = confirmSessionOccupied(occupiedError(), 's1');

    sessionsStore().setActiveSessionId('s2');
    useConfirmDialog().settle(true);
    expect(await decision).toBe(false);
  });

  const otherError = new DaemonApiError({ code: 40999, msg: 'other', requestId: 'req-3' });
  it.each([
    ['an occupied warning', occupiedError(), 'warnings.sessionOccupied'],
    ['the stale notice', staleError(), 'warnings.sessionStale'],
    ['the generic failure', otherError, undefined],
  ] as const)('routes send failures to %s', (_label, err, warningKey) => {
    const notify = createSendFailureNotifier({ pushOperationFailure });
    notify('sendPrompt', err, 's1');

    expect(useConfirmDialog().current.value).toBeNull();
    expect(warningsStore().warnings).toEqual(warningKey === undefined
      ? []
      : [{ severity: 'warning', title: `${warningKey}.title`, message: `${warningKey}.message`, position: 'bottom-right' }]);
    expect(pushOperationFailure).toHaveBeenCalledTimes(warningKey === undefined ? 1 : 0);
  });
});

describe('submitWithNetworkRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resends the same request after network failures', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue('accepted');

    const result = submitWithNetworkRetry(send);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toBe('accepted');
    expect(send).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['a prompt id conflict', promptIdConflict()],
    ['a server error', new DaemonApiError({ code: 50001, msg: 'internal', requestId: 'req-internal' })],
    ['a non-daemon error', new TypeError('fetch failed')],
  ])('does not resend after %s', async (_label, err) => {
    const send = vi.fn().mockRejectedValue(err);

    const settled = expect(submitWithNetworkRetry(send)).rejects.toBe(err);
    await vi.advanceTimersByTimeAsync(2_000);

    await settled;
    expect(send).toHaveBeenCalledOnce();
  });
});
