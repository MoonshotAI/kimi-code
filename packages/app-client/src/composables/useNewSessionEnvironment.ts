import { newSessionEnvironmentStore, type NewSessionEnvironmentHost } from '../stores/newSessionEnvironment';
import { workspacesStore } from '../stores/workspaces';

export const clientNewSessionEnvironmentHost: NewSessionEnvironmentHost = {
  workspace: (workspaceId) => workspacesStore().mergedWorkspaces.find((workspace) => workspace.id === workspaceId),
  activeWorkspaceId: () => workspacesStore().activeWorkspaceId,
};

export function useNewSessionEnvironment() {
  const store = newSessionEnvironmentStore();
  store.bindHost(clientNewSessionEnvironmentHost);
  return store;
}
