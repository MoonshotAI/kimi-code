import { permissionRuleMatcher } from '../language/tool-matchers';
import type { PermissionFileAccess } from '../types';

import type { PermissionPolicyContext } from './chain';

export function fileAccesses(context: PermissionPolicyContext): readonly PermissionFileAccess[] {
  if (context.args === undefined) return [];
  return permissionRuleMatcher(context.toolCall.name)?.fileAccesses?.(context.args) ?? [];
}

export function writeFileAccesses(
  context: PermissionPolicyContext,
): readonly PermissionFileAccess[] {
  return fileAccesses(context).filter(
    (access) => access.operation === 'write' || access.operation === 'readwrite',
  );
}
