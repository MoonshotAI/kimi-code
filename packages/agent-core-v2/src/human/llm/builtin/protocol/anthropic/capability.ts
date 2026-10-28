const CLAUDE_VISION_TOOL_PREFIXES = ['claude-3-', 'claude-3.5-', 'claude-3.7-'] as const;

const CLAUDE_THINKING_VISION_TOOL_PREFIXES = [
  'claude-opus-4',
  'claude-sonnet-4',
  'claude-haiku-4',
  'claude-fable',
] as const;

const ANTHROPIC_VISION_TOOL_CAPABILITY = Object.freeze({
  image_in: true,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
});

const ANTHROPIC_THINKING_VISION_TOOL_CAPABILITY = Object.freeze({
  image_in: true,
  video_in: false,
  audio_in: false,
  thinking: true,
  tool_use: true,
});

export function getAnthropicModelCapability(modelName: string) {
  const normalized = modelName.toLowerCase();
  if (CLAUDE_VISION_TOOL_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return ANTHROPIC_VISION_TOOL_CAPABILITY;
  }
  if (CLAUDE_THINKING_VISION_TOOL_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return ANTHROPIC_THINKING_VISION_TOOL_CAPABILITY;
  }
  return undefined;
}
