/**
 * Kimi reasoning models hosted on OpenAI-compatible gateways require
 * `max_completion_tokens` instead of `max_tokens`. On reasoning models,
 * `max_tokens` shares the budget with `reasoning_content`, so the model can
 * exhaust the entire cap during thinking and return no visible content or tool
 * calls.
 *
 * The Moonshot-proprietary `thinking: { type: 'enabled' }` parameter is only
 * sent by {@link KimiChatProvider}. Gateways such as Microsoft Foundry expose
 * Kimi through the OpenAI chat-completions schema and enable reasoning via
 * `reasoning_effort` alone — sending `thinking` yields 400.
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
