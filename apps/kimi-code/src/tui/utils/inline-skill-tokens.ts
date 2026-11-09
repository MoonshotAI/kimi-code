import type { InlineSkillActivation } from '../types';
import { parseSlashInput } from '../commands/parse';

export interface InlineSkillToken {
  readonly commandName: string;
  readonly start: number;
  readonly end: number;
}

export function rebaseInlineSkillActivations(
  activations: readonly InlineSkillActivation[],
  offset: number,
): InlineSkillActivation[] {
  if (offset === 0) return [...activations];
  return activations.map((activation) => ({
    ...activation,
    start: activation.start === undefined ? undefined : activation.start + offset,
    occurrences: activation.occurrences?.map((occurrence) => ({
      ...occurrence,
      start: occurrence.start + offset,
    })),
  }));
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
    if (commandName.includes('/') && (!isLeadingSlash || parseSlashInput(text.slice(i, end)) === null)) continue;
    if (commandName.length === 0 && options.allowEmpty !== true) continue;
    if (!options.isKnownSkill(commandName)) continue;

    tokens.push({ commandName, start: i, end });
  }

  return tokens;
}

export interface ExtractInlineSkillActivationsOptions {
  /** Also treat a `/` at the very start of the input as a skill token. */
  readonly includeLeading?: boolean;
  readonly skillVariantPathForCommand?: (commandName: string, tokenStart: number) => string | undefined;
  readonly defaultSkillPathForCommand?: (commandName: string) => string | undefined;
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
    isKnownSkill: (commandName) => {
      const normalized = commandName.toLowerCase();
      return skillCommandMap.has(normalized) || skillCommandMap.has(`skill:${normalized}`);
    },
    includeLeading: options?.includeLeading,
  });

  const byKey = new Map<string, {
    activation: InlineSkillActivation;
    occurrences: Array<{ commandName: string; start: number }>;
  }>();
  for (const token of tokens) {
    const normalized = token.commandName.toLowerCase();
    const skillName = skillCommandMap.get(token.commandName) ?? skillCommandMap.get(`skill:${token.commandName}`) ??
      skillCommandMap.get(normalized) ?? skillCommandMap.get(`skill:${normalized}`);
    if (skillName === undefined) continue;
    const path = options?.skillVariantPathForCommand?.(token.commandName, token.start) ??
      options?.defaultSkillPathForCommand?.(token.commandName);
    const key = `${skillName}\0${path ?? ''}`;
    const existing = byKey.get(key);
    if (existing !== undefined) {
      existing.occurrences.push({ commandName: token.commandName, start: token.start });
      continue;
    }
    byKey.set(key, {
      activation: { skillName, path, start: token.start },
      occurrences: [{ commandName: token.commandName, start: token.start }],
    });
  }
  return [...byKey.values()].map(({ activation, occurrences }) =>
    occurrences.length === 1 ? activation : { ...activation, occurrences }
  );
}
