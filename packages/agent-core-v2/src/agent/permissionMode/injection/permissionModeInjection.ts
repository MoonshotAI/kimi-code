import { Service } from '#/_base/di/service';
import { defineState } from '#/state/state';
import {
  IAgentContextInjectorService,
  type ContextInjectionContext,
} from '#/agent/contextInjector/contextInjector';
import type { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { IAgentStateService } from '#/agent/state/agentState';
import AUTO_MODE_ENTER_REMINDER from './permission-mode-auto-enter-reminder.md?raw';
import AUTO_MODE_EXIT_REMINDER from './permission-mode-auto-exit-reminder.md?raw';

const PERMISSION_MODE_INJECTION_VARIANT = 'permission_mode';

export const permissionModeLastModeKey = defineState<PermissionMode | undefined>(
  'permissionMode.lastMode',
  () => undefined as PermissionMode | undefined,
);

export class PermissionModeInjection extends Service {
  constructor(
    private readonly permissionMode: Pick<IAgentPermissionModeService, 'mode'>,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.contributeState(permissionModeLastModeKey);
    this._register(
      injector.register(PERMISSION_MODE_INJECTION_VARIANT, (ctx) => this.reminder(ctx)),
    );
  }

  private get lastMode(): PermissionMode | undefined {
    return this.states.get(permissionModeLastModeKey);
  }

  private set lastMode(value: PermissionMode | undefined) {
    this.states.set(permissionModeLastModeKey, value);
  }

  private reminder({ injectedPositions }: ContextInjectionContext): string | undefined {
    const currentMode = this.permissionMode.mode;
    const previousMode = this.lastMode;
    if (currentMode === previousMode) {
      if (injectedPositions.length > 0 || currentMode !== 'auto') return undefined;
      return AUTO_MODE_ENTER_REMINDER;
    }
    this.lastMode = currentMode;
    if (currentMode === 'auto') return AUTO_MODE_ENTER_REMINDER;
    if (previousMode === 'auto') return AUTO_MODE_EXIT_REMINDER;
    return undefined;
  }
}
