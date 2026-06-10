/**
 * Claude model-id parsing shared by the anthropic provider (wire-level
 * behavior like omitting `thinking: disabled` on Fable) and the capability
 * registry (advertising `always_thinking`). Keeping a single parser means the
 * advertised capability and the request-building behavior cannot drift apart
 * across the naming variants vendors use for the same model.
 */

export type ClaudeFamily = 'opus' | 'sonnet' | 'haiku' | 'fable';

export interface ClaudeVersion {
  family: ClaudeFamily;
  major: number;
  minor: number | null;
}

// Family-first form: "opus-4-7", "sonnet-4.6", "haiku-4-5-20251001",
// "fable-5" (single version component — Fable ids carry no minor).
// Version numbers are capped at 1–2 digits with a non-digit lookahead so
// 8-digit date suffixes (e.g. `-20251001`) don't get consumed as version
// components.
const FAMILY_FIRST_RE =
  /(opus|sonnet|haiku|fable)[-._](\d{1,2})(?!\d)(?:[-._](\d{1,2})(?!\d))?/;
// Legacy version-first form: "3-5-sonnet", "3.7.opus" — used by older
// Anthropic model ids and Bedrock variants of Claude 3.x.
const VERSION_FIRST_RE = /(\d{1,2})[-._](\d{1,2})[-._](opus|sonnet|haiku)/;
// Bare family form for base Claude 3 (no minor): "3-opus", "3.haiku".
const BARE_FAMILY_RE = /(\d{1,2})[-._](opus|sonnet|haiku)/;

/**
 * Extract Claude family + version from a model id.
 *
 * Designed to survive the naming variants we see across vendors:
 * vendor prefixes (`anthropic.`, `aws/`, `openrouter/`,
 * `online-`), suffixes (date stamps like `-20251001`, build tags
 * like `-construct`, `-v1:0`), and `.` vs `-` separators between
 * the family and version components.
 *
 * Returns `null` when the id contains no Claude marker or no
 * recognizable family/version, in which case the resolver should fall
 * back to the override or the provider's fallback ceiling.
 */
export function parseClaudeVersion(model: string): ClaudeVersion | null {
  return parseClaudeFamilyVersion(model, true);
}

export function parseClaudeAliasVersion(model: string): ClaudeVersion | null {
  return parseClaudeFamilyVersion(model, false);
}

function parseClaudeFamilyVersion(model: string, requireClaudeMarker: boolean): ClaudeVersion | null {
  const normalized = model.toLowerCase();
  // Guard against false positives on non-Claude models that happen to
  // contain an `opus-4-7`-like substring (e.g. fine-tunes named after a
  // checkpoint). The Anthropic provider might still be configured for
  // non-Claude endpoints, so without this guard we'd quietly apply
  // Claude ceilings to unrelated models.
  if (requireClaudeMarker && !normalized.includes('claude')) return null;

  const familyFirst = FAMILY_FIRST_RE.exec(normalized);
  if (familyFirst !== null) {
    return {
      family: familyFirst[1] as ClaudeFamily,
      major: Number.parseInt(familyFirst[2]!, 10),
      minor: familyFirst[3] !== undefined ? Number.parseInt(familyFirst[3], 10) : null,
    };
  }
  const versionFirst = VERSION_FIRST_RE.exec(normalized);
  if (versionFirst !== null) {
    return {
      major: Number.parseInt(versionFirst[1]!, 10),
      minor: Number.parseInt(versionFirst[2]!, 10),
      family: versionFirst[3] as ClaudeFamily,
    };
  }
  const bare = BARE_FAMILY_RE.exec(normalized);
  if (bare !== null) {
    return {
      major: Number.parseInt(bare[1]!, 10),
      minor: null,
      family: bare[2] as ClaudeFamily,
    };
  }
  return null;
}

export function isFableModel(model: string): boolean {
  return parseClaudeAliasVersion(model)?.family === 'fable';
}
