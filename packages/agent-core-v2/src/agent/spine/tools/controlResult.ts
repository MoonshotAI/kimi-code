import type { ExecutableToolResult } from '#/tool/toolContract';

import type { SpineTransitionResult } from '#/agent/spine/spine';

export const ACCEPTED_OUTPUT = 'accepted — commits after this step completes';

export function toControlResult(result: SpineTransitionResult): ExecutableToolResult {
  if (result.accepted) return { isError: false, output: ACCEPTED_OUTPUT };
  return { isError: true, output: result.reason };
}

export const TRIM_ACCEPTED_OUTPUT = 'trim accepted';

export function toTrimResult(result: SpineTransitionResult): ExecutableToolResult {
  if (result.accepted) return { isError: false, output: TRIM_ACCEPTED_OUTPUT };
  return { isError: true, output: result.reason };
}

export function toSpawnResult(
  result: SpineTransitionResult & { readonly receipt?: string },
): ExecutableToolResult {
  if (result.accepted) {
    return { isError: false, output: result.receipt ?? '' };
  }
  return { isError: true, output: result.reason };
}
