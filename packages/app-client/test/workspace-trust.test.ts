import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref, type EffectScope } from 'vue';
import type { WorkspaceTrustError } from '../src/stores/workspaces';
import { useWorkspaceTrust } from '../src/composables/useWorkspaceTrust';

const client = {
  activeWorkspaceId: ref<string | null>('ws/1'),
  activeWorkspaceTrust: ref<boolean | undefined>(undefined),
  activeWorkspaceTrustError: ref<WorkspaceTrustError | undefined>(undefined),
  activeWorkspaceTrustLoading: ref(false),
  ensureWorkspaceTrust: vi.fn(),
  trustWorkspace: vi.fn(),
};

vi.mock('../src/client/useKimiWebClient', () => ({ useKimiWebClient: () => client }));
vi.mock('../src/client/deps', () => ({ t: (key: string) => key }));

function failure(operation: 'read' | 'write', message: string): WorkspaceTrustError {
  return {
    operation,
    message,
    originalError: new Error(message),
    code: 50001,
    requestId: `req-${operation}`,
  };
}

describe('useWorkspaceTrust', () => {
  let scope: EffectScope;
  let trust: ReturnType<typeof useWorkspaceTrust>;

  beforeEach(() => {
    vi.resetAllMocks();
    client.activeWorkspaceId.value = 'ws/1';
    client.activeWorkspaceTrust.value = undefined;
    client.activeWorkspaceTrustError.value = undefined;
    client.activeWorkspaceTrustLoading.value = false;
    scope = effectScope();
    trust = scope.run(() => useWorkspaceTrust())!;
  });

  afterEach(async () => {
    client.activeWorkspaceId.value = null;
    await nextTick();
    scope.stop();
  });

  it('reports pending trust only until the active workspace has a result', () => {
    expect(trust.trustReadPending.value).toBe(true);
    client.activeWorkspaceTrustLoading.value = true;
    expect(trust.trustReadPending.value).toBe(true);

    client.activeWorkspaceTrust.value = true;
    expect(trust.trustReadPending.value).toBe(false);

    client.activeWorkspaceId.value = 'ws/2';
    client.activeWorkspaceTrust.value = undefined;
    expect(trust.trustReadPending.value).toBe(true);

    client.activeWorkspaceTrust.value = false;
    expect(trust.trustReadPending.value).toBe(false);

    client.activeWorkspaceTrust.value = undefined;
    client.activeWorkspaceTrustError.value = failure('read', 'trust read failed');
    expect(trust.trustReadPending.value).toBe(false);
    client.activeWorkspaceId.value = null;
    client.activeWorkspaceTrustError.value = undefined;
    expect(trust.trustReadPending.value).toBe(false);
  });

  it('does not open the dialog during the initial read and only allows explicit trust', async () => {
    let resolveRead!: (value: { status: 'success'; trusted: boolean }) => void;
    client.ensureWorkspaceTrust.mockReturnValue(new Promise((resolve) => {
      resolveRead = resolve;
    }));

    expect(trust.showTrustCard.value).toBe(true);
    expect(trust.trustDenied.value).toBe(false);
    expect(trust.gateSubmitForTrust()).toBe(false);
    expect(trust.trustGateOpen.value).toBe(false);

    client.activeWorkspaceTrust.value = true;
    resolveRead({ status: 'success', trusted: true });
    await vi.waitFor(() => expect(trust.busy.value).toBe(false));

    expect(trust.gateSubmitForTrust()).toBe(true);
    expect(trust.trustGateOpen.value).toBe(false);
  });

  it('opens on a read error and recovers after a later submit', async () => {
    const readFailure = failure('read', 'trust storage unavailable');
    client.ensureWorkspaceTrust.mockImplementationOnce(async () => {
      client.activeWorkspaceTrustError.value = readFailure;
      return { status: 'error', error: readFailure };
    });

    expect(trust.gateSubmitForTrust()).toBe(false);
    await vi.waitFor(() => expect(trust.trustGateOpen.value).toBe(true));

    expect(trust.trustDenied.value).toBe(true);
    expect(client.activeWorkspaceTrustError.value).toEqual(readFailure);

    client.ensureWorkspaceTrust.mockImplementationOnce(async () => {
      client.activeWorkspaceTrust.value = true;
      client.activeWorkspaceTrustError.value = undefined;
      return { status: 'success', trusted: true };
    });
    expect(trust.gateSubmitForTrust()).toBe(false);
    await vi.waitFor(() => expect(trust.busy.value).toBe(false));

    expect(trust.trustGateOpen.value).toBe(false);
    expect(trust.trustDenied.value).toBe(false);
    expect(client.activeWorkspaceTrustError.value).toBeUndefined();
  });

  it('opens immediately for an explicitly untrusted workspace', () => {
    client.activeWorkspaceTrust.value = false;

    expect(trust.gateSubmitForTrust()).toBe(false);

    expect(trust.trustGateOpen.value).toBe(true);
    expect(client.ensureWorkspaceTrust).not.toHaveBeenCalled();
  });

  it('keeps the dialog open on write failure and closes it after a successful write', async () => {
    client.activeWorkspaceTrust.value = false;
    expect(trust.gateSubmitForTrust()).toBe(false);
    const writeFailure = failure('write', 'trust marker is read-only');
    client.trustWorkspace.mockImplementationOnce(async () => {
      client.activeWorkspaceTrustError.value = writeFailure;
      return { status: 'error', error: writeFailure };
    });

    await expect(trust.trustWorkspace()).resolves.toBe(false);
    expect(trust.trustGateOpen.value).toBe(true);
    expect(client.activeWorkspaceTrustError.value).toEqual(writeFailure);

    client.trustWorkspace.mockImplementationOnce(async () => {
      client.activeWorkspaceTrust.value = true;
      client.activeWorkspaceTrustError.value = undefined;
      return { status: 'success', trusted: true };
    });
    await expect(trust.trustWorkspace()).resolves.toBe(true);

    expect(trust.trustGateOpen.value).toBe(false);
    expect(trust.showTrustCard.value).toBe(false);
    expect(trust).not.toHaveProperty('statusNote');
  });

  it('blocks trust actions while a background read is in flight', async () => {
    client.activeWorkspaceTrustError.value = failure('read', 'trust storage unavailable');
    client.activeWorkspaceTrustLoading.value = true;

    expect(trust.busy.value).toBe(true);
    expect(trust.gateSubmitForTrust()).toBe(false);
    expect(client.ensureWorkspaceTrust).not.toHaveBeenCalled();
    await expect(trust.trustWorkspace()).resolves.toBe(false);
    expect(client.trustWorkspace).not.toHaveBeenCalled();

    client.activeWorkspaceTrustLoading.value = false;
    await nextTick();
    expect(trust.busy.value).toBe(false);
  });

  it('does not block a new workspace while an earlier read is in flight', async () => {
    let finishFirst!: (value: { status: 'success'; trusted: boolean }) => void;
    client.ensureWorkspaceTrust.mockImplementationOnce(() => new Promise((resolve) => {
      finishFirst = resolve;
    }));
    expect(trust.gateSubmitForTrust()).toBe(false);
    const firstResult = client.ensureWorkspaceTrust.mock.results[0]!.value;
    expect(trust.busy.value).toBe(true);

    client.activeWorkspaceId.value = 'ws/2';
    client.activeWorkspaceTrustError.value = failure('read', 'second workspace failed');
    await nextTick();
    expect(trust.busy.value).toBe(false);

    client.trustWorkspace.mockImplementationOnce(async () => {
      client.activeWorkspaceTrust.value = true;
      client.activeWorkspaceTrustError.value = undefined;
      return { status: 'success', trusted: true };
    });
    await expect(trust.trustWorkspace()).resolves.toBe(true);

    finishFirst({ status: 'success', trusted: true });
    await firstResult;
    await nextTick();
  });

  it('resets the open dialog and error when switching workspaces', async () => {
    client.activeWorkspaceTrustError.value = failure('read', 'first workspace failed');
    expect(trust.gateSubmitForTrust()).toBe(false);
    expect(trust.trustGateOpen.value).toBe(true);

    client.activeWorkspaceId.value = 'ws/2';
    client.activeWorkspaceTrustError.value = undefined;
    await nextTick();

    expect(trust.trustGateOpen.value).toBe(false);
    expect(client.activeWorkspaceTrustError.value).toBeUndefined();
    expect(trust.trustDenied.value).toBe(false);
  });
});
