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
  /**
   * Client-internal marker: the tool is executable but its schema must not be
   * serialized into the request's top-level `tools[]` — it was (or will be)
   * delivered through a message-level `tools` declaration instead, and the
   * top-level list must stay byte-stable for prompt caching. `generate()`
   * strips marked tools before the provider builds the request; the marker
   * itself never reaches the wire.
   */
  deferred?: true;
}
