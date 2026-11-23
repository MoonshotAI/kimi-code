import { setGoalHooks, type GoalHooks } from '../stores/goal';
import { setModeHooks, type ModeHooks } from '../stores/mode';
import { setPermissionsHooks } from '../stores/permissions';
import { warningsStore } from '../stores/warnings';
import { notifySwarmModeEnabled } from './modeNotifications';

interface WorkspaceHookOptions {
  persistSessionProfile: ModeHooks['persistSessionProfile'];
  confirmGoalStart: GoalHooks['confirmGoalStart'];
  promptPipeline: Pick<
    GoalHooks,
    'createDraftSession' | 'sendPrompt' | 'submitPromptInternal'
  >;
}

export function configureWorkspaceHooks(options: WorkspaceHookOptions): void {
  setModeHooks({
    persistSessionProfile: options.persistSessionProfile,
    notifySwarmEnabled: notifySwarmModeEnabled,
  });
  setGoalHooks({
    pushOperationFailure: warningsStore().pushOperationFailure,
    confirmGoalStart: options.confirmGoalStart,
    ...options.promptPipeline,
  });
  setPermissionsHooks({ persistSessionProfile: options.persistSessionProfile });
}
