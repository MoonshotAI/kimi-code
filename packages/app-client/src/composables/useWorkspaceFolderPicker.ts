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

  async function pickRemoteWorkspaceDir(hostId: string, defaultPath = ''): Promise<string | undefined> {
    const paths = await pickWorkspaceFolders({ hostId, defaultPath, multiple: false });
    return paths[0];
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
    pickRemoteWorkspaceDir,
    completeWorkspaceFolderPicker,
    cancelWorkspaceFolderPicker,
  };
}
