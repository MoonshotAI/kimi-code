/**
 * Declared capabilities for a specific model.
 *
 * `getModelCapability(wire, model)` returns one of these so callers can gate
 * requests against modalities the model does not accept without dispatching
 * the request and watching it fail upstream.
 *
 * `max_context_tokens: 0` means "unknown"; callers that do not gate on
 * context length can ignore the field.
 */
export interface ModelCapability {
  readonly image_in: boolean;
  readonly video_in: boolean;
  readonly audio_in: boolean;
  readonly thinking: boolean;
  readonly tool_use: boolean;
  /** Total context window (input + output), used for completion budgeting. */
  readonly max_context_tokens: number;
  /**
   * Maximum prompt/input tokens when the model declares one below the total
   * window (e.g. gpt-5: 400k window, 272k input cap). Compaction and other
   * prompt-budget checks use this in preference to the total window; absent
   * means the total window is the only known ceiling.
   */
  readonly max_input_tokens?: number;
  /**
   * Model accepts message-level tool declarations (`messages[].tools`) — the
   * "dynamically loaded tools" wire feature that clients can drive with
   * progressive tool disclosure. Absent means unsupported: only models
   * explicitly catalogued or declared with this capability may ever receive a
   * message carrying `tools`.
   */
  readonly dynamically_loaded_tools?: boolean;
}

const UNKNOWN_CAPABILITY_MARKER = Symbol.for('moonshot-ai.kosong.UNKNOWN_CAPABILITY');

/**
 * Shared read-only default returned when a provider has not catalogued a
 * given model. Frozen so accidental mutation at one call site cannot leak
 * into another.
 */
export const UNKNOWN_CAPABILITY: ModelCapability = Object.freeze(
  Object.defineProperty(
    {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: false,
      max_context_tokens: 0,
      dynamically_loaded_tools: false,
    },
    UNKNOWN_CAPABILITY_MARKER,
    { value: true },
  ),
);

export function isUnknownCapability(capability: ModelCapability): boolean {
  if (capability === UNKNOWN_CAPABILITY) return true;
  const marked =
    (capability as unknown as Record<PropertyKey, unknown>)[UNKNOWN_CAPABILITY_MARKER] === true;
  if (marked) return true;
  return (
    !capability.image_in &&
    !capability.video_in &&
    !capability.audio_in &&
    !capability.thinking &&
    !capability.tool_use &&
    capability.dynamically_loaded_tools !== true &&
    capability.max_context_tokens === 0
  );
}
