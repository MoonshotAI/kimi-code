import { nextTick, ref } from 'vue';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';

const renamingId = ref<string | null>(null);
const renameValue = ref('');
const renameOriginal = ref('');
const renameInputRef = ref<HTMLInputElement | null>(null);

export function useWorkspaceRename() {
  function startRenameWorkspace(id: string, name: string): void {
    renamingId.value = id;
    renameOriginal.value = name;
    renameValue.value = name;
    void nextTick().then(() => renameInputRef.value?.focus());
  }

  function confirmRenameWorkspace(): void {
    const id = renamingId.value;
    const name = renameValue.value.trim();
    if (id && name && name !== renameOriginal.value) {
      void useKimiWebClient().renameWorkspace(id, name);
    }
    renamingId.value = null;
  }

  function cancelRenameWorkspace(): void {
    renamingId.value = null;
  }

  function updateRenameValue(value: string): void {
    renameValue.value = value;
  }

  return {
    renamingId,
    renameValue,
    renameInputRef,
    startRenameWorkspace,
    confirmRenameWorkspace,
    cancelRenameWorkspace,
    updateRenameValue,
  };
}
