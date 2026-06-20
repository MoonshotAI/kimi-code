/**
 * Kimi reasoning models hosted on OpenAI-compatible gateways (Moonshot API,
 * Microsoft Foundry, etc.) require `max_completion_tokens` instead of
 * `max_tokens`. On reasoning models, `max_tokens` shares the budget with
 * `reasoning_content`, so the model can exhaust the entire cap during thinking
 * and return no visible content or tool calls.
 *
 * Native {@link KimiChatProvider} already normalizes this; openai-legacy paths
 * (including azure-foundry) must apply the same rules when the deployment id
 * identifies a Kimi reasoning model.
 */

export function isKimiReasoningModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return (
    normalized.includes('kimi') ||
    normalized.includes('moonshot') ||
    /^k2(?:[-_.]|$)/.test(normalized)
  );
}

/** Whether outbound requests should use `max_completion_tokens` on the wire. */
export function usesMaxCompletionTokensOnWire(model: string): boolean {
  if (isKimiReasoningModel(model)) return true;
  const normalized = model.toLowerCase();
  return /^o\d(?:$|[-.])/.test(normalized) || /^gpt-5(?:$|[-.])/.test(normalized);
}

export interface KimiThinkingWireParams {
  readonly type: 'enabled' | 'disabled';
  readonly keep?: unknown;
}

/** Top-level `thinking` object for Kimi reasoning models. */
export function kimiThinkingWireParams(args: {
  readonly reasoningEffort: string | undefined;
  readonly thinkingExplicitlyOff: boolean;
  readonly thinkingKeep?: unknown;
}): KimiThinkingWireParams | undefined {
  if (args.thinkingExplicitlyOff) {
    return { type: 'disabled' };
  }
  if (args.reasoningEffort === undefined) return undefined;
  return args.thinkingKeep === undefined
    ? { type: 'enabled' }
    : { type: 'enabled', keep: args.thinkingKeep };
}
