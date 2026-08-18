import type { HookResult } from './types';

export type PermissionHookDecision =
  | { readonly decision: 'allow' }
  | { readonly decision: 'deny'; readonly reason?: string };

export function reducePermissionDecisionResults(
  results: readonly HookResult[],
  permissionRequestId: string,
): PermissionHookDecision | undefined {
  const deny = results.find((result) => isExplicitDeny(result, permissionRequestId));
  if (deny !== undefined) {
    const reason = (deny.permissionDecisionReason ?? deny.reason)?.trim();
    return {
      decision: 'deny',
      reason: reason === undefined || reason.length === 0 ? undefined : reason,
    };
  }

  if (results.length === 0) return undefined;
  return results.every((result) => isAllowForRequest(result, permissionRequestId))
    ? { decision: 'allow' }
    : undefined;
}

function isExplicitDeny(result: HookResult, permissionRequestId: string): boolean {
  if (result.exitCode === 2) return true;
  return (
    result.exitCode === 0 &&
    result.structuredOutput === true &&
    result.permissionRequestId === permissionRequestId &&
    result.permissionDecision === 'deny'
  );
}

function isAllowForRequest(result: HookResult, permissionRequestId: string): boolean {
  return (
    result.exitCode === 0 &&
    result.structuredOutput === true &&
    result.permissionRequestId === permissionRequestId &&
    result.permissionDecision === 'allow'
  );
}
