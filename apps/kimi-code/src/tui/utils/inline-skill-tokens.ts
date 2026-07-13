/**
 * Shared scanner for inline skill `/tokens`.
 *
 * Used by dispatch, editor highlighting, and autocomplete so all three places
 * agree on what counts as an inline skill reference.
 */

export interface InlineSkillToken {
  readonly commandName: string;
  readonly start: number;
  readonly end: number;
}

interface FindInlineSkillTokensOptions {
  /**
   * Return only tokens whose command name passes this predicate. The predicate
   * is called after the syntactic checks (preceded by whitespace, no internal
   * `/`) so callers can decide whether the token is "known".
   */
  readonly isKnownSkill: (commandName: string) => boolean;
  /**
   * When true, include tokens with an empty command name (e.g. a trailing `/`
   * after whitespace). Defaults to false.
   */
  readonly allowEmpty?: boolean;
  /**
   * When true, treat a `/` at the very start of the message as a token. By
   * default the leading slash-command area is skipped so that existing
   * start-of-line slash commands continue to be handled separately.
   */
  readonly includeLeading?: boolean;
}

const WHITESPACE = /\s/;

/**
 * Scan `text` for inline `/token` references.
 *
 * Rules:
 *   - `/` at the start of the message is treated as a leading slash command
 *     and is skipped.
 *   - A token starts with `/` when the preceding character is whitespace
 *     (space, tab, or newline). The same whitespace rule is used to end a
 *     token, so token boundaries are consistent.
 *   - Tokens containing an internal `/` are rejected.
 *   - Tokens are returned in first-occurrence order.
 */
export function findInlineSkillTokens(
  text: string,
  options: FindInlineSkillTokensOptions,
): InlineSkillToken[] {
  const tokens: InlineSkillToken[] = [];

  // Skip the leading slash-command area so that `/skill:name` at the very
  // start continues to be handled by the existing slash-command path, unless
  // the caller explicitly asks to include it (e.g. when combining multiple
  // skill activations into one submission).
  let searchStart = 0;
  if (text.startsWith('/') && options.includeLeading !== true) {
    const firstSpace = text.search(WHITESPACE);
    searchStart = firstSpace === -1 ? text.length : firstSpace + 1;
  }

  for (let i = searchStart; i < text.length; i++) {
    if (text[i] !== '/') continue;

    const isLeadingSlash = i === 0 && options.includeLeading === true;
    const charBefore = i > 0 ? text[i - 1] : undefined;
    if (!isLeadingSlash && (charBefore === undefined || !WHITESPACE.test(charBefore))) continue;

    let end = i + 1;
    while (end < text.length && !WHITESPACE.test(text[end] ?? '')) {
      end++;
    }

    const commandName = text.slice(i + 1, end);
    if (commandName.includes('/')) continue;
    if (commandName.length === 0 && options.allowEmpty !== true) continue;
    if (!options.isKnownSkill(commandName)) continue;

    tokens.push({ commandName, start: i, end });
  }

  return tokens;
}

import type { InlineSkillActivation } from '../types';

export type { InlineSkillActivation };

/**
 * Scan `text` for inline skill tokens and return the deduplicated list of skill
 * activations in first-occurrence order.
 */
export interface ExtractInlineSkillActivationsOptions {
  /**
   * When true, treat a `/` at the very start of the message as a skill token.
   * Defaults to false.
   */
  readonly includeLeading?: boolean;
}

export function extractInlineSkillActivations(
  text: string,
  skillCommandMap: ReadonlyMap<string, string>,
  options?: ExtractInlineSkillActivationsOptions,
): InlineSkillActivation[] {
  const tokens = findInlineSkillTokens(text, {
    isKnownSkill: (commandName) => skillCommandMap.has(commandName),
    includeLeading: options?.includeLeading,
  });

  const seenSkillNames = new Set<string>();
  const activations: InlineSkillActivation[] = [];

  for (const token of tokens) {
    const skillName = skillCommandMap.get(token.commandName);
    if (skillName === undefined) continue;
    if (seenSkillNames.has(skillName)) continue;
    seenSkillNames.add(skillName);
    activations.push({ skillName });
  }

  return activations;
}
