import { estimateMessageTokens, estimateUsedContextTokens } from '#/agent/context-usage';
import { inputSubmitted, messageAppended, turnEnded, turnStarted } from '#/agent/events';
import type { QueuedPrompt } from '#/agent/slices';
import { createUserEntry, type HistoryMessage, type UserEntry } from '#/agent/turn';
import type { ExternalEvent } from '#/eventStore/events';
import { createUserMessage, type UserMessage } from '#/llm/message';

import summaryPrefixTemplate from './compaction-summary-prefix.md?raw';

const COMPACTION_SUMMARY_PREFIX = summaryPrefixTemplate.trimEnd();
const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;
const COMPACT_USER_MESSAGE_HEAD_TOKENS = 2_000;

export interface CompactionSeed {
  events: ExternalEvent[];
  tokensAfter: number;
  keptUserMessageCount: number;
  keptHeadUserMessageCount?: number;
}

interface CompactionUserSelection {
  head: UserEntry[];
  tail: UserEntry[];
  elided: boolean;
  omittedTokens: number;
}

export function buildCompactionSeed(input: {
  turnId: number;
  history: readonly HistoryMessage[];
  summary: string;
  queue: readonly QueuedPrompt[];
}): CompactionSeed {
  const compactable = input.history.filter(isKeptUserEntry);
  const selection = selectCompactionUserMessages(
    compactable,
    COMPACT_USER_MESSAGE_MAX_TOKENS,
    COMPACT_USER_MESSAGE_HEAD_TOKENS,
  );
  const elision = selection.elided
    ? createUserEntry(createUserMessage(elisionText(selection.omittedTokens)), {
        source: 'compaction',
        key: 'elision',
      })
    : undefined;
  const summaryEntry = createUserEntry(createUserMessage(summaryText(input.summary)), {
    source: 'compaction',
    key: 'summary',
  });
  const kept: HistoryMessage[] = [
    ...selection.head,
    ...(elision === undefined ? [] : [elision]),
    ...selection.tail,
  ];
  const seeded = [...kept, summaryEntry];
  const events: ExternalEvent[] = [
    turnStarted({ turnId: input.turnId }),
    ...seeded.map((message) => messageAppended({ message })),
    turnEnded({ turnId: input.turnId, outcome: 'done' }),
    ...input.queue.map((item) => inputSubmitted({ id: item.id, message: item.message })),
  ];
  return {
    events,
    tokensAfter: estimateUsedContextTokens(seeded),
    keptUserMessageCount: selection.head.length + selection.tail.length,
    keptHeadUserMessageCount: selection.elided ? selection.head.length : undefined,
  };
}

export function compactionContinuationMessage(): UserMessage {
  return createUserMessage(
    wrapSystemReminder(
      'Context compaction is complete — continue the work that was in progress when it began.',
    ),
  );
}

function summaryText(summary: string): string {
  const trimmed = summary.trim();
  return `${COMPACTION_SUMMARY_PREFIX}\n${trimmed.length > 0 ? trimmed : '(no summary available)'}`;
}

function elisionText(omittedTokens: number): string {
  return wrapSystemReminder(
    `Some of this conversation's user messages were omitted here during compaction: the messages above this note are the oldest user input, the messages below are the most recent, and roughly ${String(omittedTokens)} tokens in between were dropped. The omitted content is covered by the compaction summary at the end of the conversation.`,
  );
}

function wrapSystemReminder(content: string): string {
  return `<system-reminder>\n${content.trim()}\n</system-reminder>`;
}

function isKeptUserEntry(entry: HistoryMessage): entry is UserEntry {
  if (entry.message.role !== 'user') return false;
  if (entry.meta.source === 'compaction') return false;
  return entry.meta.source === undefined || entry.meta.source === 'input';
}

function selectCompactionUserMessages(
  messages: readonly UserEntry[],
  maxTokens: number,
  headTokens: number,
): CompactionUserSelection {
  let totalTokens = 0;
  for (const entry of messages) {
    totalTokens += estimateMessageTokens(entry.message);
  }
  if (totalTokens <= maxTokens) {
    return { head: [], tail: [...messages], elided: false, omittedTokens: 0 };
  }

  const headBudget = Math.min(Math.max(headTokens, 0), maxTokens);
  const tail: UserEntry[] = [];
  let tailRemaining = maxTokens - headBudget;
  let headEndExclusive = messages.length;
  let tailBoundaryDroppedPrefix: UserEntry | null = null;
  for (let i = messages.length - 1; i >= 0 && tailRemaining > 0; i--) {
    const entry = messages[i] as UserEntry;
    const tokens = estimateMessageTokens(entry.message);
    if (tokens <= tailRemaining) {
      tail.push(entry);
      tailRemaining -= tokens;
      headEndExclusive = i;
      continue;
    }
    const fullText = textOf(entry.message);
    const keptSuffix = truncateTextToTokensFromEnd(fullText, tailRemaining);
    tail.push(replaceEntryText(entry, keptSuffix));
    headEndExclusive = i;
    const droppedPrefix = fullText.slice(0, fullText.length - keptSuffix.length);
    if (droppedPrefix.length > 0) {
      tailBoundaryDroppedPrefix = replaceEntryText(entry, droppedPrefix);
    }
    break;
  }
  tail.reverse();

  const headCandidates = messages.slice(0, headEndExclusive);
  if (tailBoundaryDroppedPrefix !== null) {
    headCandidates.push(tailBoundaryDroppedPrefix);
  }
  const head: UserEntry[] = [];
  let headRemaining = headBudget;
  for (const entry of headCandidates) {
    if (headRemaining <= 0) break;
    const tokens = estimateMessageTokens(entry.message);
    if (tokens <= headRemaining) {
      head.push(entry);
      headRemaining -= tokens;
      continue;
    }
    head.push(replaceEntryText(entry, truncateTextToTokens(textOf(entry.message), headRemaining)));
    break;
  }

  let keptTokens = 0;
  for (const entry of head) keptTokens += estimateMessageTokens(entry.message);
  for (const entry of tail) keptTokens += estimateMessageTokens(entry.message);
  return { head, tail, elided: true, omittedTokens: Math.max(0, totalTokens - keptTokens) };
}

function textOf(message: UserMessage): string {
  let text = '';
  for (const part of message.content) {
    if (part.type === 'text') {
      text += part.text;
    }
  }
  return text;
}

function replaceEntryText(entry: UserEntry, text: string): UserEntry {
  return { ...entry, message: { ...entry.message, content: [{ type: 'text', text }] } };
}

function truncateTextToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  let asciiCount = 0;
  let nonAsciiCount = 0;
  let end = 0;
  for (const char of text) {
    if ((char.codePointAt(0) as number) <= 127) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
    if (Math.ceil(asciiCount / 4) + nonAsciiCount > maxTokens) break;
    end += char.length;
  }
  return text.slice(0, end);
}

function truncateTextToTokensFromEnd(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  const chars = Array.from(text);
  let tokens = 0;
  let start = chars.length;
  for (let i = chars.length - 1; i >= 0; i--) {
    const code = chars[i]?.codePointAt(0) ?? 0;
    tokens += code <= 127 ? 0.25 : 1;
    if (Math.ceil(tokens) > maxTokens) break;
    start = i;
  }
  return chars.slice(start).join('');
}
