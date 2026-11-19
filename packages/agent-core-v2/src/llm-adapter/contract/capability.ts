import type { LlmModelSpec, ModelCapability as CoreModelCapability } from '@moonshot-ai/core/llm/request';

export interface ModelCapability {
  readonly image_in: boolean;
  readonly video_in: boolean;
  readonly audio_in: boolean;
  readonly thinking: boolean;
  readonly tool_use: boolean;
  readonly max_context_tokens: number;
  readonly max_input_tokens?: number;
  readonly dynamically_loaded_tools?: boolean;
}

const UNKNOWN_CAPABILITY_MARKER = Symbol.for('moonshot-ai.kosong.UNKNOWN_CAPABILITY');

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

export function fromLlmModelSpec(spec: LlmModelSpec | undefined): ModelCapability {
  if (spec === undefined || spec.capability === undefined) return UNKNOWN_CAPABILITY;
  return {
    image_in: spec.capability?.image_in ?? false,
    video_in: spec.capability?.video_in ?? false,
    audio_in: spec.capability?.audio_in ?? false,
    thinking: spec.capability?.thinking ?? false,
    tool_use: spec.capability?.tool_use ?? false,
    max_context_tokens: spec.maxContextSize ?? 0,
    max_input_tokens: spec.maxInputSize,
    dynamically_loaded_tools: spec.capability?.dynamically_loaded_tools ?? false,
  };
}

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

export function toLlmCapability(capability: ModelCapability): CoreModelCapability {
  return {
    image_in: capability.image_in,
    video_in: capability.video_in,
    audio_in: capability.audio_in,
    thinking: capability.thinking,
    tool_use: capability.tool_use,
    dynamically_loaded_tools: capability.dynamically_loaded_tools,
  };
}
