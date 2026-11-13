import { getAnthropicModelCapability } from '#/llm/builtin/protocol/anthropic/capability';
import { getOpenAILegacyModelCapability } from '#/llm/builtin/protocol/openai/capability';
import { getOpenAIResponsesModelCapability } from '#/llm/builtin/protocol/openai-responses/capability';
import type { ModelCapability } from '#/llm/request';

export type BedrockWireProtocol = 'anthropic' | 'openai' | 'openai_responses';

const GEO_INFERENCE_PROFILE_PREFIX_RE = /^(?:[a-z]{2}|apac|global)$/;

export function stripBedrockInferenceProfilePrefix(model: string): string {
  const separator = model.indexOf('.');
  if (separator <= 0) return model;
  return GEO_INFERENCE_PROFILE_PREFIX_RE.test(model.slice(0, separator))
    ? model.slice(separator + 1)
    : model;
}

function stripBedrockVendorNamespace(model: string): string {
  const separator = model.indexOf('.');
  return separator <= 0 ? model : model.slice(separator + 1);
}

export function bedrockModelCapability(model: string): ModelCapability | undefined {
  const withoutGeo = stripBedrockInferenceProfilePrefix(model);
  const vendorModel = stripBedrockVendorNamespace(withoutGeo);
  const protocol = inferBedrockProtocol(withoutGeo);
  if (protocol === undefined) return undefined;
  switch (protocol) {
    case 'anthropic':
      return getAnthropicModelCapability(vendorModel);
    case 'openai':
      return getOpenAILegacyModelCapability(vendorModel);
    case 'openai_responses':
      return getOpenAIResponsesModelCapability(vendorModel);
    default:
      return undefined;
  }
}

export function bedrockWireProtocolOf(value: string | undefined): BedrockWireProtocol | undefined {
  return value === 'anthropic' || value === 'openai' || value === 'openai_responses'
    ? value
    : undefined;
}

export function inferBedrockProtocol(model: string): BedrockWireProtocol | undefined {
  const unprefixed = stripBedrockInferenceProfilePrefix(model).toLowerCase();
  if (unprefixed.startsWith('anthropic.')) return 'anthropic';
  if (unprefixed.startsWith('openai.gpt-oss')) return 'openai';
  if (unprefixed.startsWith('openai.')) return 'openai_responses';
  if (unprefixed.startsWith('moonshotai.') || unprefixed.startsWith('moonshot.')) return 'openai';
  return undefined;
}

export function bedrockRegionOf(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return nonEmpty(env['AWS_REGION']) ?? nonEmpty(env['AWS_DEFAULT_REGION']);
}

export function resolveBedrockBaseUrl(
  protocol: BedrockWireProtocol,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const region = bedrockRegionOf(env);
  if (region === undefined) return undefined;
  const suffix = protocol === 'anthropic' ? '/anthropic' : '/openai/v1';
  return `https://bedrock-runtime.${region}.amazonaws.com${suffix}`;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
