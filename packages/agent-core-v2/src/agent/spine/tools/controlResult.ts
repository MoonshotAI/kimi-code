import type { ExecutableToolResult } from '#/tool/toolContract';

import type { SpineTransitionResult } from '#/agent/spine/spine';

export const ACCEPTED_OUTPUT = 'accepted — commits after this step completes';

export function toControlResult(result: SpineTransitionResult): ExecutableToolResult {
  if (result.accepted) return { isError: false, output: ACCEPTED_OUTPUT };
  return { isError: true, output: result.reason };
}

/**
 * Receipt of an accepted `spine_trim` call. Unlike a transition receipt the
 * trim takes effect immediately — the receipt landing in history IS the trim
 * — and the trim derivation matches this text verbatim.
 */
export const TRIM_ACCEPTED_OUTPUT = 'trim accepted';

export function toTrimResult(result: SpineTransitionResult): ExecutableToolResult {
  if (result.accepted) return { isError: false, output: TRIM_ACCEPTED_OUTPUT };
  return { isError: true, output: result.reason };
}

/**
 * Maps the result of `IAgentSpineService.executeSpawn` to an executable tool
 * result: accepted fissions return the structured JSON receipt verbatim so it
 * can be matched by `deriveSpineState`; rejected fissions surface the reason as
 * an error so the model can self-correct.
 */
export function toSpawnResult(
  result: SpineTransitionResult & { readonly receipt?: string },
): ExecutableToolResult {
  if (result.accepted) {
    return { isError: false, output: result.receipt ?? '' };
  }
  return { isError: true, output: result.reason };
}
