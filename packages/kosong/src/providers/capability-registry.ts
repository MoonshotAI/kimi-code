import { UNKNOWN_CAPABILITY, type ModelCapability } from '#/capability';

type CapabilityMatcher = (normalizedModelName: string) => boolean;

interface CapabilityCatalogEntry {
  readonly matches: CapabilityMatcher;
  readonly capability: ModelCapability;
}

const OPENAI_RESPONSES_DEVELOPER_ROLE_MODELS = new Set([
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-5-codex',
  'o1',
  'o1-mini',
  'o1-pro',
  'o3',
  'o3-mini',
  'o3-pro',
  'o4-mini',
]);

// OpenAI models that document `xhigh` and keep `v1/chat/completions` enabled.
// Pro/Codex xhigh models are Responses-only, so the Chat Completions adapter
// must clamp them at `high`.
const OPENAI_CHAT_COMPLETIONS_XHIGH_REASONING_MODELS = new Set([
  'gpt-5.2',
  'gpt-5.4',
  'gpt-5.5',
]);

const OPENAI_VISION_TOOL_PREFIXES = [
  'gpt-4o',
  'gpt-4-turbo',
  'gpt-4.1',
  'gpt-4.5',
] as const;

const CLAUDE_3_PREFIXES = ['claude-3-', 'claude-3.5-', 'claude-3.7-'] as const;

const CLAUDE_4_PREFIXES = [
  'claude-opus-4',
  'claude-sonnet-4',
  'claude-haiku-4',
] as const;

const GEMINI_CATALOGUED_PREFIXES = [
  'gemini-1.5-pro',
  'gemini-1.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-pro',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
] as const;

const OPENAI_REASONING_CAPABILITY: ModelCapability = Object.freeze({
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 0,
});

const OPENAI_VISION_TOOL_CAPABILITY: ModelCapability = Object.freeze({
  image_in: true,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: 0,
});

const OPENAI_TEXT_TOOL_CAPABILITY: ModelCapability = Object.freeze({
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: 0,
});

const ANTHROPIC_VISION_TOOL_CAPABILITY: ModelCapability = Object.freeze({
  image_in: true,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: 0,
});

const ANTHROPIC_THINKING_VISION_TOOL_CAPABILITY: ModelCapability = Object.freeze({
  image_in: true,
  video_in: false,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 0,
});

const GEMINI_MULTIMODAL_TOOL_CAPABILITY: ModelCapability = Object.freeze({
  image_in: true,
  video_in: true,
  audio_in: true,
  thinking: false,
  tool_use: true,
  max_context_tokens: 0,
});

const GEMINI_THINKING_MULTIMODAL_TOOL_CAPABILITY: ModelCapability = Object.freeze({
  image_in: true,
  video_in: true,
  audio_in: true,
  thinking: true,
  tool_use: true,
  max_context_tokens: 0,
});

const OPENAI_LEGACY_CAPABILITY_CATALOG: readonly CapabilityCatalogEntry[] = [
  {
    matches: isOpenAIReasoningModel,
    capability: OPENAI_REASONING_CAPABILITY,
  },
  {
    matches: (name) => hasPrefix(name, OPENAI_VISION_TOOL_PREFIXES),
    capability: OPENAI_VISION_TOOL_CAPABILITY,
  },
  {
    matches: (name) => name.startsWith('gpt-3.5-turbo'),
    capability: OPENAI_TEXT_TOOL_CAPABILITY,
  },
];

const OPENAI_RESPONSES_CAPABILITY_CATALOG: readonly CapabilityCatalogEntry[] = [
  {
    matches: isOpenAIReasoningModel,
    capability: OPENAI_REASONING_CAPABILITY,
  },
  {
    matches: (name) => hasPrefix(name, OPENAI_VISION_TOOL_PREFIXES),
    capability: OPENAI_VISION_TOOL_CAPABILITY,
  },
];

const ANTHROPIC_CAPABILITY_CATALOG: readonly CapabilityCatalogEntry[] = [
  {
    matches: (name) => hasPrefix(name, CLAUDE_3_PREFIXES),
    capability: ANTHROPIC_VISION_TOOL_CAPABILITY,
  },
  {
    matches: (name) => hasPrefix(name, CLAUDE_4_PREFIXES),
    capability: ANTHROPIC_THINKING_VISION_TOOL_CAPABILITY,
  },
];

function normalizeModelName(modelName: string): string {
  return modelName.toLowerCase();
}

function modelIdLeaf(modelName: string): string {
  return normalizeModelName(modelName).trim().split('/').at(-1) ?? '';
}

function hasPrefix(modelName: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => modelName.startsWith(prefix));
}

function isOpenAIReasoningModel(modelName: string): boolean {
  return /^o\d/.test(modelName);
}

function capabilityFromCatalog(
  modelName: string,
  catalog: readonly CapabilityCatalogEntry[],
): ModelCapability {
  const normalized = normalizeModelName(modelName);
  for (const entry of catalog) {
    if (entry.matches(normalized)) {
      return entry.capability;
    }
  }
  return UNKNOWN_CAPABILITY;
}

export function getOpenAILegacyModelCapability(modelName: string): ModelCapability {
  return capabilityFromCatalog(modelName, OPENAI_LEGACY_CAPABILITY_CATALOG);
}

export function getOpenAIResponsesModelCapability(modelName: string): ModelCapability {
  return capabilityFromCatalog(modelName, OPENAI_RESPONSES_CAPABILITY_CATALOG);
}

export function getAnthropicModelCapability(modelName: string): ModelCapability {
  return capabilityFromCatalog(modelName, ANTHROPIC_CAPABILITY_CATALOG);
}

export function getGoogleGenAIModelCapability(modelName: string): ModelCapability {
  const normalized = normalizeModelName(modelName);
  if (!normalized.startsWith('gemini-')) return UNKNOWN_CAPABILITY;
  if (!hasPrefix(normalized, GEMINI_CATALOGUED_PREFIXES)) return UNKNOWN_CAPABILITY;

  if (normalized.startsWith('gemini-2.5-') || normalized.includes('thinking')) {
    return GEMINI_THINKING_MULTIMODAL_TOOL_CAPABILITY;
  }
  return GEMINI_MULTIMODAL_TOOL_CAPABILITY;
}

export function supportsOpenAIChatCompletionsXHighReasoning(modelName: string): boolean {
  return OPENAI_CHAT_COMPLETIONS_XHIGH_REASONING_MODELS.has(modelIdLeaf(modelName));
}

export function usesOpenAIResponsesDeveloperRole(modelName: string): boolean {
  const normalized = normalizeModelName(modelName);
  if (OPENAI_RESPONSES_DEVELOPER_ROLE_MODELS.has(normalized)) return true;
  for (const cataloguedModel of OPENAI_RESPONSES_DEVELOPER_ROLE_MODELS) {
    if (normalized.startsWith(cataloguedModel + '-')) return true;
  }
  return false;
}
