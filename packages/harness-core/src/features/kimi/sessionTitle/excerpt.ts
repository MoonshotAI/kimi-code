import {
  stripBundledSkillBlocks,
  type ContentPart,
  type HistoryMessage,
  type UserEntry,
} from '@moonshot-ai/agent-core';

export type SessionTitleSource = 'user_prompts' | 'first_turn' | 'digest';

const MAX_TITLE_INPUT_LENGTH = 1000;

const MAX_TITLE_PROMPTS = 3;

const MAX_TITLE_USER_SEGMENT = 400;

const MAX_TITLE_FIRST_TURN_ASSISTANT = 300;

const MAX_TITLE_DIGEST_USER_SEGMENT = 200;

const MAX_TITLE_DIGEST_ASSISTANT = 200;

const MAX_TITLE_DIGEST_INPUT_LENGTH = 3000;

const MAX_TITLE_EXCERPT_TEXT = 4000;

const TITLE_DIGEST_ELISION_MARKER = '...';

export interface TitleTurnExcerpt {
  readonly user?: string;
  readonly assistant?: string;
}

export interface TitleDigestTurn {
  readonly user: string;
  readonly assistant?: string;
}

export function composeTitleInput(
  history: readonly HistoryMessage[],
  source: SessionTitleSource,
): string | undefined {
  if (source === 'first_turn') {
    const excerpt = firstTurnExcerpt(history);
    if (excerpt.user === undefined || excerpt.assistant === undefined) return undefined;
    return [
      `user: ${excerpt.user.slice(0, MAX_TITLE_USER_SEGMENT)}`,
      `assistant: ${excerpt.assistant.slice(0, MAX_TITLE_FIRST_TURN_ASSISTANT)}`,
    ].join('\n');
  }
  if (source === 'digest') {
    const turns: string[][] = [];
    for (const turn of digestExcerpt(history)) {
      const group = [`user: ${turn.user.slice(0, MAX_TITLE_DIGEST_USER_SEGMENT)}`];
      if (turn.assistant !== undefined) {
        group.push(`assistant: ${turn.assistant.slice(0, MAX_TITLE_DIGEST_ASSISTANT)}`);
      }
      turns.push(group);
    }
    return elideTitleDigestTurns(turns);
  }
  const prompts = firstUserPromptTexts(history, MAX_TITLE_PROMPTS);
  if (prompts.length === 0) return undefined;
  return prompts
    .map((prompt) => `user: ${prompt.slice(0, MAX_TITLE_USER_SEGMENT)}`)
    .join('\n')
    .slice(0, MAX_TITLE_INPUT_LENGTH);
}

export function firstUserPromptTexts(
  history: readonly HistoryMessage[],
  limit: number,
): readonly string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) return [];
  const result: string[] = [];
  const seenMessageIds = new Set<string>();
  for (const entry of history) {
    if (result.length >= limit || !isNaturalLanguagePrompt(entry)) continue;
    const messageId = entry.meta?.userMessageId;
    if (messageId !== undefined) {
      if (seenMessageIds.has(messageId)) continue;
      seenMessageIds.add(messageId);
    }
    const text = excerptTextFromParts(stripBundledSkillBlocks(entry.message));
    if (text !== undefined) result.push(text);
  }
  return result;
}

export function firstTurnExcerpt(history: readonly HistoryMessage[]): TitleTurnExcerpt {
  const firstUserIndex = history.findIndex(isNaturalLanguagePrompt);
  if (firstUserIndex < 0) return {};
  const first = history[firstUserIndex] as UserEntry;
  const user = excerptTextFromParts(stripBundledSkillBlocks(first.message));
  const span: HistoryMessage[] = [];
  for (const entry of history.slice(firstUserIndex + 1)) {
    if (isNaturalLanguagePrompt(entry)) break;
    span.push(entry);
  }
  return { user, assistant: finalAssistantText(span) };
}

export function digestExcerpt(history: readonly HistoryMessage[]): readonly TitleDigestTurn[] {
  const seenMessageIds = new Set<string>();
  const userIndexes: number[] = [];
  for (let index = 0; index < history.length; index++) {
    const entry = history[index]!;
    if (!isNaturalLanguagePrompt(entry)) continue;
    const messageId = entry.meta?.userMessageId;
    if (messageId !== undefined) {
      if (seenMessageIds.has(messageId)) continue;
      seenMessageIds.add(messageId);
    }
    userIndexes.push(index);
  }
  const turns: TitleDigestTurn[] = [];
  for (let i = 0; i < userIndexes.length; i++) {
    const userIndex = userIndexes[i]!;
    const entry = history[userIndex] as UserEntry;
    const user = excerptTextFromParts(stripBundledSkillBlocks(entry.message));
    if (user === undefined) continue;
    const spanEnd = i + 1 < userIndexes.length ? userIndexes[i + 1]! : history.length;
    const assistant = finalAssistantText(history.slice(userIndex + 1, spanEnd));
    turns.push({ user, assistant });
  }
  return turns;
}

function isNaturalLanguagePrompt(entry: HistoryMessage): entry is UserEntry {
  if (entry.message.role !== 'user') return false;
  const meta = (entry as UserEntry).meta;
  if (meta?.source === 'compaction') return false;
  const origin = meta?.origin;
  return origin === undefined || origin.kind === 'user';
}

function finalAssistantText(entries: readonly HistoryMessage[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.message.role !== 'assistant') continue;
    const text = assistantTextFromParts(entry.message.content);
    if (text !== undefined) return text;
  }
  return undefined;
}

function assistantTextFromParts(parts: readonly ContentPart[]): string | undefined {
  const texts: string[] = [];
  for (const part of parts) {
    if (part.type === 'text' && part.text.trim().length > 0) texts.push(part.text);
  }
  if (texts.length === 0) return undefined;
  return sanitizeExcerptText(texts.join('\n'));
}

function excerptTextFromParts(parts: readonly ContentPart[]): string | undefined {
  const texts: string[] = [];
  for (const part of parts) {
    const text = excerptPartText(part);
    if (text !== undefined) texts.push(text);
  }
  return sanitizeExcerptText(texts.join('\n'));
}

function excerptPartText(part: ContentPart): string | undefined {
  switch (part.type) {
    case 'text':
      return part.text.trim().length === 0 ? undefined : part.text;
    case 'image_url':
      return '[image]';
    case 'audio_url':
      return '[audio]';
    case 'video_url':
      return '[video]';
    case 'think':
      return undefined;
  }
}

function sanitizeExcerptText(text: string): string | undefined {
  const sanitized = text
    .replaceAll(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
      '[redacted]',
    )
    .replaceAll(/\b(authorization)\s*:\s*bearer\s+\S+/gi, '$1: Bearer [redacted]')
    .replaceAll(
      /\b(api[_-]?key|token|secret|password|passwd|pwd)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1=[redacted]',
    )
    .replaceAll(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replaceAll(/\b[A-Za-z0-9][A-Za-z0-9+/=_-]{39,}\b/g, '[redacted]')
    .replaceAll(/\p{Cc}+/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  if (sanitized.length === 0) return undefined;
  return sanitized.slice(0, MAX_TITLE_EXCERPT_TEXT);
}

function elideTitleDigestTurns(turns: readonly (readonly string[])[]): string | undefined {
  if (turns.length === 0) return undefined;
  const joined = turns.flat().join('\n');
  if (joined.length <= MAX_TITLE_DIGEST_INPUT_LENGTH) return joined;
  let budget = MAX_TITLE_DIGEST_INPUT_LENGTH - TITLE_DIGEST_ELISION_MARKER.length - 2;
  const head: string[] = [];
  for (const line of turns[0]!) {
    if (budget < line.length + 1) break;
    head.push(line);
    budget -= line.length + 1;
  }
  const tail: string[] = [];
  for (let index = turns.length - 1; index >= 1; index--) {
    const group = turns[index]!;
    const cost = group.reduce((sum, line) => sum + line.length + 1, 0);
    if (budget < cost) break;
    tail.unshift(...group);
    budget -= cost;
  }
  return [...head, TITLE_DIGEST_ELISION_MARKER, ...tail].join('\n');
}
