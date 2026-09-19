import type { LlmModel } from '#/llm/model';
import {
  ThinkingConfigError,
  thinkingMetadataOf,
  type ThinkingEffort,
  type ThinkingRequestOptions,
} from '#/llm/thinking';

export const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';

export type AnthropicThinkingMode = 'budget' | 'adaptive';

export interface AnthropicModelProfile {
  readonly mode: AnthropicThinkingMode;
  readonly efforts: readonly string[];
  readonly supportsEffortParam: boolean;
  readonly canDisableThinking: boolean;
}

export type AnthropicModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos';

export interface AnthropicModelVersion {
  readonly family: AnthropicModelFamily;
  readonly major: number;
  readonly minor: number | null;
}

export const BUDGET_THINKING_EFFORTS = ['low', 'medium', 'high'] as const;
const ADAPTIVE_MAX_EFFORTS = ['low', 'medium', 'high', 'max'] as const;
export const LATEST_OPUS_THINKING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const BUDGET_PROFILE: AnthropicModelProfile = {
  mode: 'budget',
  efforts: BUDGET_THINKING_EFFORTS,
  supportsEffortParam: false,
  canDisableThinking: true,
};

const OPUS_45_PROFILE: AnthropicModelProfile = {
  ...BUDGET_PROFILE,
  supportsEffortParam: true,
};

const ADAPTIVE_MAX_PROFILE: AnthropicModelProfile = {
  mode: 'adaptive',
  efforts: ADAPTIVE_MAX_EFFORTS,
  supportsEffortParam: true,
  canDisableThinking: true,
};

export const LATEST_OPUS_PROFILE: AnthropicModelProfile = {
  mode: 'adaptive',
  efforts: LATEST_OPUS_THINKING_EFFORTS,
  supportsEffortParam: true,
  canDisableThinking: true,
};

const ALWAYS_ADAPTIVE_PROFILE: AnthropicModelProfile = {
  ...LATEST_OPUS_PROFILE,
  canDisableThinking: false,
};

const ALWAYS_ADAPTIVE_MAX_PROFILE: AnthropicModelProfile = {
  ...ADAPTIVE_MAX_PROFILE,
  canDisableThinking: false,
};

const FAMILY_FIRST_RE =
  /(opus|sonnet|haiku|fable|mythos)[-._](\d{1,2})(?!\d)(?:[-._](\d{1,2})(?!\d))?/;
const VERSION_FIRST_RE = /(\d{1,2})[-._](\d{1,2})[-._](opus|sonnet|haiku)/;
const BARE_FAMILY_RE = /(\d{1,2})[-._](opus|sonnet|haiku)/;

export function parseAnthropicModelVersion(
  model: string,
  requireClaudeMarker = false,
): AnthropicModelVersion | null {
  const normalized = model.toLowerCase();
  if (requireClaudeMarker && !normalized.includes('claude')) return null;

  const familyFirst = FAMILY_FIRST_RE.exec(normalized);
  if (familyFirst !== null) {
    return {
      family: familyFirst[1] as AnthropicModelFamily,
      major: Number.parseInt(familyFirst[2]!, 10),
      minor: familyFirst[3] !== undefined ? Number.parseInt(familyFirst[3]!, 10) : null,
    };
  }

  const versionFirst = VERSION_FIRST_RE.exec(normalized);
  if (versionFirst !== null) {
    return {
      major: Number.parseInt(versionFirst[1]!, 10),
      minor: Number.parseInt(versionFirst[2]!, 10),
      family: versionFirst[3] as AnthropicModelFamily,
    };
  }

  const bare = BARE_FAMILY_RE.exec(normalized);
  if (bare !== null) {
    return {
      major: Number.parseInt(bare[1]!, 10),
      minor: null,
      family: bare[2] as AnthropicModelFamily,
    };
  }

  return null;
}

const CEILING_BY_FAMILY_VERSION: Readonly<Record<string, number>> = {
  'fable-5': 128000,
  'mythos-5': 128000,
  'opus-4-8': 128000,
  'opus-4-7': 128000,
  'opus-4-6': 128000,
  'opus-4-5': 64000,
  'opus-4-1': 32000,
  'opus-4-0': 32000,
  'opus-4': 32000,
  'sonnet-5': 128000,
  'sonnet-4-6': 128000,
  'sonnet-4-5': 64000,
  'sonnet-4-0': 64000,
  'sonnet-4': 64000,
  'haiku-4-5': 64000,
  'haiku-4': 64000,
  'opus-3-5': 8192,
  'sonnet-3-5': 8192,
  'sonnet-3-7': 8192,
  'haiku-3-5': 8192,
  'opus-3': 4096,
  'sonnet-3': 4096,
  'haiku-3': 4096,
};

const FALLBACK_MAX_TOKENS = 128000;

function lookupClaudeCeiling(version: AnthropicModelVersion): number | undefined {
  const { family, major, minor } = version;
  if (minor !== null) {
    for (let candidate = minor; candidate >= 0; candidate--) {
      const ceiling = CEILING_BY_FAMILY_VERSION[`${family}-${major}-${candidate}`];
      if (ceiling !== undefined) return ceiling;
    }
  }
  return CEILING_BY_FAMILY_VERSION[`${family}-${major}`];
}

export function resolveDefaultMaxTokens(model: string, override?: number): number {
  const parsed = parseAnthropicModelVersion(model, true);
  const ceiling = parsed === null ? undefined : lookupClaudeCeiling(parsed);
  if (ceiling === undefined) {
    return override ?? FALLBACK_MAX_TOKENS;
  }
  return override === undefined ? ceiling : Math.min(override, ceiling);
}

export function matchKnownAnthropicModelProfile(model: string): AnthropicModelProfile | undefined {
  const normalized = model.toLowerCase();
  if (/mythos[-._]preview/.test(normalized)) return ALWAYS_ADAPTIVE_MAX_PROFILE;

  const version = parseAnthropicModelVersion(model);
  if (version === null) return undefined;

  switch (version.family) {
    case 'opus':
      if (version.major === 4 && (version.minor === 7 || version.minor === 8)) {
        return LATEST_OPUS_PROFILE;
      }
      if (version.major === 4 && version.minor === 6) return ADAPTIVE_MAX_PROFILE;
      if (version.major === 4 && version.minor === 5) return OPUS_45_PROFILE;
      if (version.major < 4 || (version.major === 4 && (version.minor ?? 0) < 5)) {
        return BUDGET_PROFILE;
      }
      return undefined;
    case 'sonnet':
      if (version.major === 5) return LATEST_OPUS_PROFILE;
      if (version.major === 4 && version.minor === 6) return ADAPTIVE_MAX_PROFILE;
      if (version.major < 4 || (version.major === 4 && (version.minor ?? 0) <= 5)) {
        return BUDGET_PROFILE;
      }
      return undefined;
    case 'haiku':
      if (version.major < 4 || (version.major === 4 && (version.minor ?? 0) <= 5)) {
        return BUDGET_PROFILE;
      }
      return undefined;
    case 'fable':
      return version.major === 5 ? ALWAYS_ADAPTIVE_PROFILE : undefined;
    case 'mythos':
      return version.major === 5 ? ALWAYS_ADAPTIVE_PROFILE : undefined;
  }
}

export function inferAnthropicModelProfile(model: string): AnthropicModelProfile {
  return matchKnownAnthropicModelProfile(model) ?? LATEST_OPUS_PROFILE;
}

export function matchUnknownClaudeProfile(model: string): AnthropicModelProfile | undefined {
  const normalized = model.toLowerCase();
  return normalized.includes('claude') || CLAUDE_FAMILY_WORD_RE.test(normalized)
    ? LATEST_OPUS_PROFILE
    : undefined;
}

const CLAUDE_FAMILY_WORD_RE = /\b(?:opus|sonnet|haiku|fable|mythos)\b/;

export function shouldPreserveUnsignedThinking(model: string): boolean {
  return (
    parseAnthropicModelVersion(model) === null &&
    matchKnownAnthropicModelProfile(model) === undefined
  );
}

function requiresAdaptiveThinking(efforts: readonly string[]): boolean {
  return efforts.some((effort) => effort !== 'low' && effort !== 'medium' && effort !== 'high');
}

export function resolveThinkingProfile(model: LlmModel): AnthropicModelProfile {
  const inferred = inferAnthropicModelProfile(model.model);
  const meta = thinkingMetadataOf(model);
  const supportEfforts = meta?.supportEfforts;
  const adaptiveThinking = meta?.adaptiveThinking;
  if (adaptiveThinking === false) {
    return {
      ...inferred,
      mode: 'budget',
      efforts: supportEfforts ?? BUDGET_THINKING_EFFORTS,
      supportsEffortParam: false,
    };
  }
  if (adaptiveThinking === true) {
    return {
      ...inferred,
      mode: 'adaptive',
      efforts: supportEfforts ?? inferred.efforts,
      supportsEffortParam: true,
    };
  }
  if (supportEfforts === undefined) {
    return inferred;
  }
  const adaptive = requiresAdaptiveThinking(supportEfforts);
  return {
    ...inferred,
    mode: adaptive ? 'adaptive' : inferred.mode,
    efforts: supportEfforts,
    supportsEffortParam: adaptive || inferred.supportsEffortParam,
  };
}

function budgetTokensForEffort(effort: ThinkingEffort): number | undefined {
  if (effort === 'low') return 1024;
  if (effort === 'medium') return 4096;
  if (effort === 'on' || effort === 'high') return 32_000;
  return undefined;
}

export function encodeThinking(
  thinking: ThinkingRequestOptions,
  model: LlmModel,
): Record<string, unknown> | undefined {
  const profile = resolveThinkingProfile(model);
  const effort = thinking.effort;
  if (effort === 'off') {
    if (!profile.canDisableThinking) {
      throw new ThinkingConfigError(
        'thinking-cannot-disable',
        `Model '${model.model}' always reasons and thinking cannot be turned off. Choose a concrete thinking effort (${profile.efforts.join(', ')}) instead of 'off'.`,
      );
    }
    const patch: Record<string, unknown> = { thinking: { type: 'disabled' } };
    if (profile.mode === 'adaptive') {
      patch['betaFeatures'] = [];
    }
    return patch;
  }
  if (profile.mode === 'adaptive') {
    return {
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: effort === 'on' ? undefined : { effort },
      betaFeatures: [],
    };
  }
  const budgetTokens = budgetTokensForEffort(effort);
  const patch: Record<string, unknown> = {
    thinking:
      budgetTokens === undefined
        ? { type: 'enabled' }
        : { type: 'enabled', budget_tokens: budgetTokens },
  };
  if ((profile.supportsEffortParam || budgetTokens === undefined) && effort !== 'on') {
    patch['output_config'] = { effort };
  }
  return patch;
}
