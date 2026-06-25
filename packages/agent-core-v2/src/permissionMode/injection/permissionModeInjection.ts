import type { PermissionMode } from '../../../../agent/permission';
import type { IDisposable } from "#/_base/di";
import type { IDynamicInjector } from '../../dynamicInjector/dynamicInjector';
import type { IPermissionModeService } from '../permissionMode';
import AUTO_MODE_ENTER_REMINDER from './permission-mode-auto-enter-reminder.md?raw';
import AUTO_MODE_EXIT_REMINDER from './permission-mode-auto-exit-reminder.md?raw';

const PERMISSION_MODE_INJECTION_VARIANT = 'permission_mode';

export function registerPermissionModeInjection(
  dynamicInjector: IDynamicInjector,
  permissionMode: Pick<IPermissionModeService, 'mode'>,
): IDisposable {
  let lastMode: PermissionMode | undefined;
  return dynamicInjector.register(PERMISSION_MODE_INJECTION_VARIANT, () => {
    const previousMode = lastMode;
    const currentMode = permissionMode.mode;
    if (currentMode === previousMode) return undefined;

    lastMode = currentMode;
    if (currentMode === 'auto') return AUTO_MODE_ENTER_REMINDER;
    if (previousMode === 'auto') return AUTO_MODE_EXIT_REMINDER;
    return undefined;
  });
}

export { registerPermissionModeInjection as PermissionModeInjection };
