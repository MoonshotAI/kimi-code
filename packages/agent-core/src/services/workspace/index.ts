export {
  IWorkspaceRegistry,
  WorkspaceNotFoundError,
  WorkspaceRootNotFoundError,
  type WorkspacePatch,
} from './workspaceRegistry';
export { WorkspaceRegistryService, detectGit } from './workspaceRegistryService';
export {
  IWorkspaceFsService,
  WorkspaceFsNotAbsoluteError,
  WorkspaceFsNotFoundError,
  WorkspaceFsPermissionError,
  RECENT_ROOTS_LIMIT,
} from './workspaceFs';
export { WorkspaceFsService } from './workspaceFsService';
