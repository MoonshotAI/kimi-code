/**
 * Declared capabilities for a specific model exposed by a {@link ChatProvider}.
 *
 * Providers return one of these from {@link ChatProvider.getCapability} so
 * callers can gate requests against modalities the model does not accept
 * without dispatching the request and watching it fail upstream.
 *
 * `max_context_tokens: 0` means "unknown"; callers that do not gate on
 * context length can ignore the field.
 */
export interface ModelCapability {
  readonly image_in: boolean;
  readonly video_in: boolean;
  readonly audio_in: boolean;
  readonly thinking: boolean;
  /**
   * The model always reasons and cannot run with thinking turned off — e.g.
   * Claude Fable 5, where a request without a `thinking` field still runs
   * adaptive thinking. UIs should not offer a thinking-off toggle for these
   * models. Typed `true` (never `false`): absent means toggleable, and
   * present implies `thinking` is also `true`.
   */
  readonly always_thinking?: true;
  readonly tool_use: boolean;
  readonly max_context_tokens: number;
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
    capability.max_context_tokens === 0
  );
}
