/**
 * Scanner for inline skill `/tokens` inside a prompt.
 *
 * Dispatch, editor highlighting, and autocomplete share this so all three
 * agree on what counts as an inline skill reference: a `/name` token whose `/`
 * is preceded by whitespace (space, tab, or newline), with no internal `/`.
 * The leading slash-command area at the very start of the input is handled by
 * the regular slash-command path and is skipped here by default.
 */

import type { InlineSkillActivation } from '../types';

export interface InlineSkillToken {
  readonly commandName: string;
  readonly start: number;
  readonly end: number;
}

export interface FindInlineSkillTokensOptions {
  /** Decide whether a syntactically valid token names a known skill. */
  readonly isKnownSkill: (commandName: string) => boolean;
  /** Include tokens with an empty command name (a bare trailing `/`). */
  readonly allowEmpty?: boolean;
  /** Also treat a `/` at the very start of the input as a token. */
  readonly includeLeading?: boolean;
}

const WHITESPACE = /\s/;

export function findInlineSkillTokens(
  text: string,
  options: FindInlineSkillTokensOptions,
): InlineSkillToken[] {
  const tokens: InlineSkillToken[] = [];

  let searchStart = 0;
  if (text.startsWith('/') && options.includeLeading !== true) {
    const firstWhitespace = text.search(WHITESPACE);
    searchStart = firstWhitespace === -1 ? text.length : firstWhitespace + 1;
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

export interface ExtractInlineSkillActivationsOptions {
  /** Also treat a `/` at the very start of the input as a skill token. */
  readonly includeLeading?: boolean;
}

/**
 * Resolve the skill tokens of `text` through `skillCommandMap` (command name →
 * skill name, with the same `skill:` prefix fallback as the leading-command
 * path) and return the deduplicated activations in first-occurrence order.
 * Unknown tokens, paths, URLs, and fractions are ignored.
 */
export function extractInlineSkillActivations(
  text: string,
  skillCommandMap: ReadonlyMap<string, string>,
  options?: ExtractInlineSkillActivationsOptions,
): InlineSkillActivation[] {
  const tokens = findInlineSkillTokens(text, {
    isKnownSkill: (commandName) =>
      skillCommandMap.has(commandName) || skillCommandMap.has(`skill:${commandName}`),
    includeLeading: options?.includeLeading,
  });

  const seen = new Set<string>();
  const activations: InlineSkillActivation[] = [];
  for (const token of tokens) {
    const skillName =
      skillCommandMap.get(token.commandName) ?? skillCommandMap.get(`skill:${token.commandName}`);
    if (skillName === undefined || seen.has(skillName)) continue;
    seen.add(skillName);
    activations.push({ skillName });
  }
  return activations;
}
