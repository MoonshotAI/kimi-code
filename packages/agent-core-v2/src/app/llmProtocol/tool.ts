/**
 * A tool that the model may invoke during generation.
 *
 * The definition is provider-agnostic; each provider implementation converts
 * it to the appropriate wire format (e.g. OpenAI function-calling, Anthropic
 * tool-use, Google function declarations).
 */
export interface Tool {
  /** Unique tool name used to match invocations. */
  name: string;
  /** Human-readable description shown to the model. */
  description: string;
  /** JSON Schema describing the tool's parameters. */
  parameters: Record<string, unknown>;
}
