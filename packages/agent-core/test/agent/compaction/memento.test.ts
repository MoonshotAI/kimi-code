import type { Message } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import {
  COMPACTION_SUMMARY_PREFIX,
  buildCompactionSummaryText,
  collectCompactableUserMessages,
  isCompactionSummaryMessage,
  selectRecentUserMessages,
} from '../../../src/agent/compaction';
import { estimateTokens, estimateTokensForMessage } from '../../../src/utils/tokens';

function textMessage(role: 'user' | 'assistant' | 'tool', text: string): Message {
  return { role, content: [{ type: 'text', text }], toolCalls: [] };
}

function messageText(message: Message): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

describe('isCompactionSummaryMessage', () => {
  it('detects the compaction origin', () => {
    const message = {
      ...textMessage('user', 'anything'),
      origin: { kind: 'compaction_summary' as const },
    };
    expect(isCompactionSummaryMessage(message)).toBe(true);
  });

  it('detects the summary prefix', () => {
    expect(isCompactionSummaryMessage(textMessage('user', `${COMPACTION_SUMMARY_PREFIX}\nsummary`))).toBe(true);
  });

  it('ignores ordinary user messages', () => {
    expect(isCompactionSummaryMessage(textMessage('user', 'hello'))).toBe(false);
  });
});

describe('collectCompactableUserMessages', () => {
  it('keeps only user messages', () => {
    const messages = [
      textMessage('user', 'u1'),
      textMessage('assistant', 'a1'),
      textMessage('tool', 't1'),
      textMessage('user', 'u2'),
    ];

    expect(collectCompactableUserMessages(messages).map(messageText)).toEqual(['u1', 'u2']);
  });

  it('drops previous compaction summaries', () => {
    const summary = {
      ...textMessage('user', `${COMPACTION_SUMMARY_PREFIX}\nold summary`),
      origin: { kind: 'compaction_summary' as const },
    };
    const messages = [textMessage('user', 'u1'), summary, textMessage('user', 'u2')];

    expect(collectCompactableUserMessages(messages).map(messageText)).toEqual(['u1', 'u2']);
  });
});

describe('selectRecentUserMessages', () => {
  it('keeps the most recent messages within the budget', () => {
    const messages = [
      textMessage('user', 'old'),
      textMessage('user', 'mid'),
      textMessage('user', 'recent'),
    ];
    const budget = estimateTokensForMessage(messages[1]!) + estimateTokensForMessage(messages[2]!);

    expect(selectRecentUserMessages(messages, budget).map(messageText)).toEqual(['mid', 'recent']);
  });

  it('truncates the oldest kept message when it would overflow the budget', () => {
    const long = 'x'.repeat(1_000);
    const messages = [textMessage('user', long), textMessage('user', 'recent')];
    const budget = estimateTokensForMessage(messages[1]!) + 10;

    const selected = selectRecentUserMessages(messages, budget);

    expect(selected).toHaveLength(2);
    expect(estimateTokens(messageText(selected[0]!))).toBeLessThanOrEqual(10);
    expect(messageText(selected[1]!)).toBe('recent');
  });

  it('truncates a CJK-heavy oldest message within the budget in one pass', () => {
    const cjk = '中'.repeat(40_000);
    const messages = [textMessage('user', cjk), textMessage('user', 'recent')];
    const budget = estimateTokensForMessage(messages[1]!) + 1_000;

    const selected = selectRecentUserMessages(messages, budget);

    expect(selected).toHaveLength(2);
    expect(messageText(selected[1]!)).toBe('recent');
    expect(estimateTokens(messageText(selected[0]!))).toBeLessThanOrEqual(1_000);
    expect(cjk.startsWith(messageText(selected[0]!))).toBe(true);
  });

  it('does not split surrogate pairs while truncating emoji text', () => {
    const emoji = '😀'.repeat(2_000);
    const messages = [textMessage('user', emoji), textMessage('user', 'recent')];
    const budget = estimateTokensForMessage(messages[1]!) + 333;

    const selected = selectRecentUserMessages(messages, budget);
    const truncated = messageText(selected[0]!);

    expect(selected).toHaveLength(2);
    expect(messageText(selected[1]!)).toBe('recent');
    expect(estimateTokens(truncated)).toBeLessThanOrEqual(333);
    expect([...truncated].every((char) => char === '😀')).toBe(true);
    expect(truncated.length % 2).toBe(0);
  });

  it('returns nothing when the budget is zero', () => {
    expect(selectRecentUserMessages([textMessage('user', 'hi')], 0)).toEqual([]);
  });
});

describe('buildCompactionSummaryText', () => {
  it('prefixes the summary', () => {
    expect(buildCompactionSummaryText('Summary.')).toBe(`${COMPACTION_SUMMARY_PREFIX}\nSummary.`);
  });

  it('falls back when the summary is empty', () => {
    expect(buildCompactionSummaryText('   ')).toBe(`${COMPACTION_SUMMARY_PREFIX}\n(no summary available)`);
  });
});
