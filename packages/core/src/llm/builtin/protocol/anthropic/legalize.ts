import type { ContentPart, Message } from '#/llm/message';
import { SyntaxRequestFormatError } from '#/llm/protocol/errors';
import type { ModelLegality } from '#/llm/protocol/rules/model';
import type { Pattern } from '#/llm/protocol/pattern';
import type { LlmModelSpec } from '#/llm/request';

const OMITTED_AUDIO_PLACEHOLDER = '(audio omitted: not supported by this provider)';

export const audioToPlaceholder: Pattern<Message> = {
  name: 'audioToPlaceholder',
  rewrite(items, index) {
    const message = items[index];
    if (message === undefined || message.role === 'system') return null;
    let changed = false;
    const content: ContentPart[] = [];
    for (const part of message.content) {
      if (part.type === 'audio_url') {
        const last = content.at(-1);
        if (last === undefined || last.type !== 'text' || last.text !== OMITTED_AUDIO_PLACEHOLDER) {
          content.push({ type: 'text', text: OMITTED_AUDIO_PLACEHOLDER });
        }
        changed = true;
      } else if (message.role === 'tool' && part.type === 'text' && part.text === '') {
        changed = true;
      } else {
        content.push(part);
      }
    }
    if (!changed) return null;
    return { consumed: 1, replacement: [{ ...message, content }] };
  },
};

export function anthropicPatterns(): readonly Pattern<Message>[] {
  return [audioToPlaceholder];
}

type AnthropicThinkingMode = 'budget' | 'adaptive';

export interface AnthropicModelProfile {
  readonly mode: AnthropicThinkingMode;
  readonly efforts: readonly string[];
  readonly supportsEffortParam: boolean;
  readonly canDisableThinking: boolean;
}

type AnthropicModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos';

interface AnthropicModelVersion {
  readonly family: AnthropicModelFamily;
  readonly major: number;
  readonly minor: number | null;
}

export const BUDGET_THINKING_EFFORTS = ['low', 'medium', 'high'] as const;
const ADAPTIVE_MAX_EFFORTS = ['low', 'medium', 'high', 'max'] as const;
const LATEST_OPUS_THINKING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

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

const LATEST_OPUS_PROFILE: AnthropicModelProfile = {
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

function parseAnthropicModelVersion(
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

const FALLBACK_MAX_TOKENS = 64000;

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

function inferAnthropicModelProfile(model: string): AnthropicModelProfile {
  return matchKnownAnthropicModelProfile(model) ?? LATEST_OPUS_PROFILE;
}

export function matchUnknownClaudeProfile(model: string): AnthropicModelProfile | undefined {
  const normalized = model.toLowerCase();
  return normalized.includes('claude') || CLAUDE_FAMILY_WORD_RE.test(normalized)
    ? LATEST_OPUS_PROFILE
    : undefined;
}

const CLAUDE_FAMILY_WORD_RE = /\b(?:opus|sonnet|haiku|fable|mythos)\b/;

function shouldPreserveUnsignedThinking(model: string): boolean {
  return (
    parseAnthropicModelVersion(model) === null &&
    matchKnownAnthropicModelProfile(model) === undefined
  );
}

function requiresAdaptiveThinking(efforts: readonly string[]): boolean {
  return efforts.some((effort) => effort !== 'low' && effort !== 'medium' && effort !== 'high');
}

export function resolveThinkingProfile(model: LlmModelSpec): AnthropicModelProfile {
  const inferred = inferAnthropicModelProfile(model.name);
  const meta = model.thinking;
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

function stripUnsignedThinking(options: { readonly preserve: boolean }): Pattern<Message> {
  return {
    name: 'stripUnsignedThinking',
    rewrite(items, index) {
      const message = items[index];
      if (message === undefined) return null;
      const content = message.content.filter((part) => {
        if (part.type !== 'think') return true;
        if (part.encrypted !== undefined) return true;
        return options.preserve;
      });
      if (content.length === message.content.length) return null;
      return { consumed: 1, replacement: [{ ...message, content }] };
    },
  };
}

export function anthropicThinkingHistoryPatterns(model: LlmModelSpec): readonly Pattern<Message>[] {
  return [stripUnsignedThinking({ preserve: shouldPreserveUnsignedThinking(model.name) })];
}

export const anthropicModelLegality: ModelLegality = {
  sampling: ['temperature', 'topP', 'topK', 'stop'],
  clampMaxOutputTokens: (maxOutputTokens, model) =>
    resolveDefaultMaxTokens(model.name, maxOutputTokens),
  verify: (model, ctx) => {
    if (model.responseFormat?.type === 'json_object') {
      throw new SyntaxRequestFormatError(
        'Anthropic requires a JSON schema for structured response output.',
      );
    }
    const effort = model.thinking?.effort;
    const known = model.spec.thinking?.supportEfforts?.filter((value) => value.length > 0) ?? [];
    if (effort === undefined || effort === 'on' || effort === 'off' || known.length === 0) return;
    if (known.includes(effort)) return;
    ctx.report({
      code: 'anthropic-thinking-effort-not-listed',
      message: `Thinking effort "${effort}" is not listed for model "${model.spec.name}" (known: ${known.join(', ')}). The configured value will be sent unchanged to the Anthropic-compatible backend.`,
      data: { effort, knownEfforts: known },
    });
  },
};
