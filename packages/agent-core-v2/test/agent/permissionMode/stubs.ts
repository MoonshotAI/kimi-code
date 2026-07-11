/**
 * `permissionMode` test stubs — shared doubles for
 * `IAgentPermissionModeService`.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or
 * `../permissionMode/stubs`).
 */

import { createHooks } from '#/hooks';
import type { Hooks } from '#/hooks';
import type { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
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
    hooks: createHooks(['onDidChangeMode']) as Hooks<{
      onDidChangeMode: { mode: PermissionMode; previousMode: PermissionMode };
    }>,
  };
}
