import { fromCallback } from 'xstate';

import type { AgentRuntimeContext } from '#/agent/runtime/agentRuntime';
import { AgentReminder } from '#/features/reminder/reminderAgentRuntime';
import type { ContextInjectionContext } from '#/features/reminder/types';
import type { PermissionModeState, WirePermissionMode } from '#/features/permissionMode/permissionModeOps';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import AUTO_MODE_ENTER_REMINDER from './permission-mode-auto-enter-reminder.md?raw';
import AUTO_MODE_EXIT_REMINDER from './permission-mode-auto-exit-reminder.md?raw';

const PERMISSION_MODE_INJECTION_VARIANT = 'permission_mode';

export const permissionModeReminderEffects = fromCallback(
  ({ input }: { input: { readonly runtime: AgentRuntimeContext<PermissionModeState> } }) => {
    let lastMode: WirePermissionMode | undefined;
    const reminder = input.runtime
      .get(IAgentLifecycleService)
      .resolve(input.runtime.agent, AgentReminder);
    const registration = reminder.register(
      PERMISSION_MODE_INJECTION_VARIANT,
      ({ injectedPositions }: ContextInjectionContext) => {
        const currentMode = input.runtime.getState().mode;
        const previousMode = lastMode;
        if (currentMode === previousMode) {
          if (injectedPositions.length > 0 || currentMode !== 'auto') return undefined;
          return AUTO_MODE_ENTER_REMINDER;
        }
        lastMode = currentMode;
        if (currentMode === 'auto') return AUTO_MODE_ENTER_REMINDER;
        if (previousMode === 'auto') return AUTO_MODE_EXIT_REMINDER;
        return undefined;
      },
    );
    return () => {
      registration.dispose();
    };
  },
);
