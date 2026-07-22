/**
 * Anthropic effort and thinking profiles, matched from model identifiers.
 * Keep this matrix aligned with:
 * https://platform.claude.com/docs/en/build-with-claude/effort
 * https://platform.claude.com/docs/en/build-with-claude/extended-thinking
 */

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
export const LATEST_OPUS_THINKING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

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
      minor: familyFirst[3] !== undefined ? Number.parseInt(familyFirst[3], 10) : null,
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

export function matchKnownAnthropicModelProfile(
  model: string,
): AnthropicModelProfile | undefined {
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

/**
 * Fallback profile for Anthropic-compatible endpoints whose model name is
 * recognizably a Claude model but encodes no known version — either a
 * `claude` marker (e.g. a proxied `claude-latest`) or a bare family word
 * (`sonnet-latest`, `opus-latest`, …). Clearly non-Claude names (Kimi `k3`,
 * GLM, DeepSeek, … served over the Anthropic protocol) return undefined so
 * the catalog never advertises Claude effort levels for them. The wire-path
 * counterpart {@link inferAnthropicModelProfile} keeps its unconditional
 * fallback: an Anthropic-protocol endpoint still needs some profile to shape
 * requests.
 */
export function matchUnknownClaudeProfile(model: string): AnthropicModelProfile | undefined {
  const normalized = model.toLowerCase();
  return normalized.includes('claude') || CLAUDE_FAMILY_WORD_RE.test(normalized)
    ? LATEST_OPUS_PROFILE
    : undefined;
}

const CLAUDE_FAMILY_WORD_RE = /\b(?:opus|sonnet|haiku|fable|mythos)\b/;
