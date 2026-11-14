export type ArtexTerminalReason =
  | 'completed'
  | 'max_turns'
  | 'timeout'
  | 'model_error'
  | 'blocking_limit'
  | 'prompt_too_long'
  | 'image_error'
  | 'stop_hook_prevented'
  | 'hook_stopped'
  | 'aborted_streaming'
  | 'aborted_tools';

export const ARTEX_SYNTHESIZED_CANCEL_LABEL = 'context_canceled';

const reasonHint: Record<ArtexTerminalReason, string> = {
  completed:
    "the model ended this turn normally but left no text summary; facts and assets are as recorded by this turn's tool calls",
  max_turns:
    'reached the turn cap (MaxTurns): the SDK ran the wrap-up and wrote back facts and assets; the intent is marked exhausted so the planner can continue in a different direction, rather than being treated as failed',
  timeout:
    "reached this run's wall-clock budget (MaxDuration): at the deadline the in-flight tool is interrupted and the run settles in place, writing back the identified facts and assets; the intent is marked exhausted",
  model_error:
    'the model or API call failed (network, auth, rate limiting, provider 5xx, etc.) and retries were exhausted, so the intent is marked blocked — a transport-layer failure means this intent was barely explored; check its execution (get_worker_trace) before deciding whether to redispatch or switch tactics',
  blocking_limit:
    "context length hit the hard cap and the request was intercepted before being sent; narrow the intent's granularity or compress tool output",
  prompt_too_long:
    'the prompt was too long and context-compaction retries were exhausted; cannot continue',
  image_error:
    "the current model does not support this turn's multimodal content; switch to a vision-capable model or avoid returning images from tools",
  stop_hook_prevented:
    "a Stop hook prevented this turn from ending and the run could not continue afterwards; check whether the task's Guard rules are too strict",
  hook_stopped:
    'a tool or hook actively stopped execution, e.g. an out-of-scope target or a banned command; check the interception note on the last tool_result',
  aborted_streaming: 'the run was cancelled while the model was streaming its output',
  aborted_tools: 'the run was cancelled during tool execution',
};

export const ARTEX_TERMINAL_REASONS: readonly ArtexTerminalReason[] = Object.keys(
  reasonHint,
) as ArtexTerminalReason[];

export function isArtexTerminalReason(reason: string): reason is ArtexTerminalReason {
  return Object.prototype.hasOwnProperty.call(reasonHint, reason);
}

export function artexTerminalReasonLabel(reason: string): string {
  if (reason === '') return ARTEX_SYNTHESIZED_CANCEL_LABEL;
  return reason;
}

export function artexTerminalReasonHint(reason: string): string {
  if (isArtexTerminalReason(reason)) return reasonHint[reason];
  if (reason === '') {
    return "the run's context was cancelled, but no Terminal event was produced underneath";
  }
  return 'unknown terminal state; harness may have added a TerminalReason — please add it to reasonHint';
}

export function isArtexAbortedReason(reason: string): boolean {
  return reason === 'aborted_streaming' || reason === 'aborted_tools';
}

export function isArtexBudgetCapReason(reason: string): boolean {
  return reason === 'max_turns' || reason === 'timeout';
}
