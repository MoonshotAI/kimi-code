import { computed, getCurrentScope, onScopeDispose, ref, watch } from 'vue';
import { useKimiWebClient } from '../client/useKimiWebClient';

const rejectedIds = ref<string[]>([]);
const trustGateOpen = ref(false);
const busyByWorkspaceId = ref<Record<string, boolean>>({});
let sharedWatchInstalled = false;

export function useWorkspaceTrust() {
  const client = useKimiWebClient();

  if (!sharedWatchInstalled) {
    sharedWatchInstalled = true;
    const stop = watch(
      () => client.activeWorkspaceId.value,
      () => {
        trustGateOpen.value = false;
      },
    );
    if (getCurrentScope()) {
      onScopeDispose(() => {
        stop();
        sharedWatchInstalled = false;
      });
    }
  }

  const trustError = computed(() => client.activeWorkspaceTrustError.value);
  const busy = computed(() => {
    const id = client.activeWorkspaceId.value;
    return id !== null && (client.activeWorkspaceTrustLoading.value || busyByWorkspaceId.value[id] === true);
  });
  const showTrustCard = computed(() =>
    client.activeWorkspaceId.value !== null &&
    (client.activeWorkspaceTrust.value !== true || trustError.value !== undefined),
  );
  const trustDenied = computed(() =>
    client.activeWorkspaceTrust.value === false || trustError.value !== undefined,
  );
  const trustReadPending = computed(() => showTrustCard.value && !trustDenied.value);
  const trustRejected = computed(() => {
    const id = client.activeWorkspaceId.value;
    return id !== null && rejectedIds.value.includes(id);
  });

  function setBusy(id: string, value: boolean): void {
    busyByWorkspaceId.value = { ...busyByWorkspaceId.value, [id]: value };
  }

  async function trustWorkspace(): Promise<boolean> {
    const id = client.activeWorkspaceId.value;
    if (!id || (client.activeWorkspaceTrustLoading.value || busyByWorkspaceId.value[id] === true)) return false;
    setBusy(id, true);
    try {
      const result = await client.trustWorkspace(id);
      if (client.activeWorkspaceId.value !== id) return false;
      if (result.status !== 'success' || !result.trusted) {
        trustGateOpen.value = true;
        return false;
      }
      trustGateOpen.value = false;
      return true;
    } finally {
      setBusy(id, false);
    }
  }

  function rejectTrust(): void {
    const id = client.activeWorkspaceId.value;
    if (!id || rejectedIds.value.includes(id)) return;
    rejectedIds.value = [...rejectedIds.value, id];
  }

  async function retryTrustRead(): Promise<void> {
    const id = client.activeWorkspaceId.value;
    if (!id || (client.activeWorkspaceTrustLoading.value || busyByWorkspaceId.value[id] === true)) return;
    setBusy(id, true);
    try {
      const result = await client.ensureWorkspaceTrust(id, { background: false });
      if (client.activeWorkspaceId.value !== id) return;
      if (result.status === 'error' || (result.status === 'success' && !result.trusted)) {
        trustGateOpen.value = true;
      } else if (result.status === 'success') {
        trustGateOpen.value = false;
      }
    } finally {
      setBusy(id, false);
    }
  }

  function gateSubmitForTrust(): boolean {
    if (!showTrustCard.value) return true;
    if (trustDenied.value) {
      trustGateOpen.value = true;
      if (trustError.value !== undefined) void retryTrustRead();
    } else {
      void retryTrustRead();
    }
    return false;
  }

  return {
    showTrustCard,
    trustDenied,
    trustReadPending,
    trustRejected,
    trustGateOpen,
    busy,
    trustWorkspace,
    rejectTrust,
    gateSubmitForTrust,
  };
}
