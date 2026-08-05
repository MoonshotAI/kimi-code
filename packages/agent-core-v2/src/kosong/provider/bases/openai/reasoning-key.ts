/**
 * The OpenAI-compatible Chat Completions ecosystem never standardized a wire
 * field for reasoning/thinking content. Three names circulate in the wild:
 *
 * - `reasoning_content` — DeepSeek's original convention, used by the Moonshot
 *   Kimi API, pre-rename vLLM, and most OpenAI-compatible gateways.
 * - `reasoning_details` — OpenRouter.
 * - `reasoning` — OpenAI's GPT-OSS guidance; current vLLM renamed to this
 *   (vllm-project/vllm#27752) and its request side accepts ONLY this name
 *   (vllm-project/vllm#38488).
 *
 * Inbound we accept any of them via a priority scan; outbound we echo back the
 * dialect the peer actually spoke, learned per endpoint by ReasoningKeyDialect.
 */

// Inbound scan order; the first entry doubles as the default outbound dialect
// before any observation. Both arms can be pinned by an explicit key (see
// ReasoningKeyDialect).
export const KNOWN_REASONING_KEYS = [
  'reasoning_content',
  'reasoning_details',
  'reasoning',
] as const;

export type ReasoningKey = (typeof KNOWN_REASONING_KEYS)[number];

export const DEFAULT_REASONING_KEY: ReasoningKey = KNOWN_REASONING_KEYS[0];

export function extractReasoning(
  source: unknown,
  explicitKey?: string,
): { key: string; value: string } | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const record = source as Record<string, unknown>;
  const keys: readonly string[] = explicitKey !== undefined ? [explicitKey] : KNOWN_REASONING_KEYS;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return { key, value };
  }
  return undefined;
}

export class ReasoningKeyDialect {
  private _detected: string | undefined;

  constructor(private readonly _explicitKey?: string) {}

  observe(source: unknown): string | undefined {
    const found = extractReasoning(source, this._explicitKey);
    if (found === undefined) return undefined;
    if (this._explicitKey === undefined) {
      this._detected = found.key;
    }
    return found.value;
  }

  outboundKey(): string {
    return this._explicitKey ?? this._detected ?? DEFAULT_REASONING_KEY;
  }
}
