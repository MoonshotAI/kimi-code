import type {
  PermissionData,
  PermissionMode,
} from '../../../agent/permission';
import { createDecorator } from '../../../di';
import type {
  AuthorizeToolExecutionResult,
  ResolvedToolExecutionHookContext,
} from '../../../loop';
import type { PathClass } from '../../../tools/policies/path-access';

export interface PermissionPlanModeState {
  readonly isActive: boolean;
  readonly planFilePath: string | null;
  exit(id?: string): void;
}

export interface PermissionSwarmModeState {
  readonly isActive: boolean;
}

export interface PermissionGitWorkTreeMarker {
  readonly dotGitPath: string;
  readonly controlDirPath: string;
}

export interface PermissionServiceOptions {
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly agentType?: 'main' | 'sub';
  readonly cwd?: string;
  readonly additionalDirs?: readonly string[];
  readonly pathClass?: PathClass;
  readonly planMode?: PermissionPlanModeState;
  readonly swarmMode?: PermissionSwarmModeState;
  readonly gitWorkTreeMarker?: (
    cwd: string,
  ) => Promise<PermissionGitWorkTreeMarker | null> | PermissionGitWorkTreeMarker | null;
  readonly initialMode?: PermissionMode;
}

export interface IPermissionService {
  data(): PermissionData;
  authorize(
    context: ResolvedToolExecutionHookContext,
  ): Promise<AuthorizeToolExecutionResult | undefined>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IPermissionService =
  createDecorator<IPermissionService>('agentPermissionService');
