import { ref } from 'vue';

export interface WorkspaceFolderPickerRequest {
  hostId?: string;
  defaultPath?: string;
  multiple: boolean;
}

export function useWorkspaceFolderPicker() {
  const folderPickerResolve = ref<((paths: string[]) => void) | null>(null);
  const folderPickerRequest = ref<WorkspaceFolderPickerRequest | null>(null);

  function pickWorkspaceFolders(options: Partial<WorkspaceFolderPickerRequest> = {}): Promise<string[]> {
    folderPickerRequest.value = {
      hostId: options.hostId,
      defaultPath: options.defaultPath,
      multiple: options.multiple ?? true,
    };
    return new Promise((resolve) => {
      folderPickerResolve.value = resolve;
    });
  }

  function pickRemoteWorkspaceDirs(hostId: string, defaultPath = ''): Promise<string[]> {
    return pickWorkspaceFolders({ hostId, defaultPath, multiple: true });
  }

  function completeWorkspaceFolderPicker(paths: string[]): void {
    const resolve = folderPickerResolve.value;
    folderPickerResolve.value = null;
    folderPickerRequest.value = null;
    resolve?.(paths);
  }

  function cancelWorkspaceFolderPicker(): void {
    completeWorkspaceFolderPicker([]);
  }

  return {
    folderPickerResolve,
    folderPickerRequest,
    pickWorkspaceFolders,
    pickRemoteWorkspaceDirs,
    completeWorkspaceFolderPicker,
    cancelWorkspaceFolderPicker,
  };
}
