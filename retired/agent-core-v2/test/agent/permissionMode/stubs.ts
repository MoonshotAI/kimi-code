/**
 * `permissionMode` test stubs — shared doubles for
 * `IAgentPermissionModeService`.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or
 * `../permissionMode/stubs`).
 */

import { Event } from '#/_base/event';
import type {
  IAgentPermissionModeService,
  PermissionModeChangedContext,
} from '#/agent/permissionMode/permissionMode';
import type { PermissionMode } from '#/agent/permissionPolicy/types';

export function stubPermissionModeService(
  mode: () => PermissionMode,
): IAgentPermissionModeService {
  return {
    _serviceBrand: undefined,
    get mode() {
      return mode();
    },
    setMode: () => {},
    onDidChangeMode: Event.None as Event<PermissionModeChangedContext>,
  };
}
