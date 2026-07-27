/**
 * `kosong/contract` domain (L0) — the provider-agnostic tool definition.
 *
 * A tool that the model may invoke during generation. The definition is
 * provider-agnostic; each provider implementation converts it to the
 * appropriate wire format (e.g. OpenAI function-calling, Anthropic tool-use,
 * Google function declarations).
 */

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  deferred?: true;
}
