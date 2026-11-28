import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type {
  ProjectAgentsMdBelief,
  WorkdirMoveBaseline,
} from '#/agent/environmentBinding/environmentBindingOps';

export const WORKDIR_MOVED_REMINDER_VARIANT = 'workdir_moved';

export interface WorkdirMovedDisclosure {
  readonly kind: 'workdir_moved';
  readonly cwd: string;
  readonly checkoutRoot: string;
  readonly projectAgentsMd: readonly ProjectAgentsMdBelief[];
}

export interface PrepareWorkdirRelocationInput {
  readonly oldWorkDir: string;
  readonly nextWorkDir: string;
}

export interface PreparedWorkdirRelocation {
  readonly originCwd?: string;
  readonly pendingBaseline?: WorkdirMoveBaseline;
  readonly previousOriginCwd?: string;
  readonly previousPendingBaseline?: WorkdirMoveBaseline;
}

export interface IAgentWorkdirMoveService {
  readonly _serviceBrand: undefined;
  readonly originCwd: string | undefined;
  prepareRelocation(input: PrepareWorkdirRelocationInput): Promise<PreparedWorkdirRelocation>;
  restoreAgentsMdSnapshot(workDir: string): Promise<void>;
}

export const IAgentWorkdirMoveService: ServiceIdentifier<IAgentWorkdirMoveService> =
  createDecorator<IAgentWorkdirMoveService>('agentWorkdirMoveService');
