/**
 * `kosong/contract` usage + tokens — usage aggregation and token estimation.
 *
 * `TokenUsage` aggregates cache-aware input/output counters; the
 * `estimateTokens*` family sizes messages, tools, and content parts with the
 * ASCII/non-ASCII heuristic and the flat media estimate.
 */

import { describe, expect, it } from 'vitest';

import type { Message } from '#/kosong/contract/message';
import {
  estimateTokens,
  estimateTokensForContentPart,
  estimateTokensForMessage,
  estimateTokensForMessages,
  estimateTokensForTools,
  MEDIA_TOKEN_ESTIMATE,
} from '#/kosong/contract/tokens';
import { addUsage, emptyUsage, grandTotal, inputTotal } from '#/kosong/contract/usage';

describe('TokenUsage aggregation', () => {
  it('emptyUsage is all zeros', () => {
    expect(emptyUsage()).toEqual({
      inputOther: 0,
      output: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
  });

  it('addUsage sums every counter', () => {
    const a = { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 };
    const b = { inputOther: 10, output: 20, inputCacheRead: 30, inputCacheCreation: 40 };
    expect(addUsage(a, b)).toEqual({
      inputOther: 11,
      output: 22,
      inputCacheRead: 33,
      inputCacheCreation: 44,
    });
  });

  it('inputTotal sums all input counters, grandTotal adds output', () => {
    const usage = { inputOther: 5, output: 7, inputCacheRead: 11, inputCacheCreation: 13 };
    expect(inputTotal(usage)).toBe(29);
    expect(grandTotal(usage)).toBe(36);
  });
});

describe('estimateTokens', () => {
  it('estimates ASCII at four characters per token', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('estimates non-ASCII at one token per character', () => {
    expect(estimateTokens('你好')).toBe(2);
    expect(estimateTokens('ab你')).toBe(2); // ceil(2/4) + 1
  });
});

describe('estimateTokensForMessage(s)', () => {
  it('counts role, content, and tool calls', () => {
    const message: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'abcd' }],
      toolCalls: [{ type: 'function', id: 'c1', name: 'tool', arguments: '{}' }],
    };
    const expected =
      estimateTokens('assistant') +
      estimateTokens('abcd') +
      estimateTokens('tool') +
      estimateTokens('"{}"');
    expect(estimateTokensForMessage(message)).toBe(expected);
  });

  it('sums messages and memoizes per message object', () => {
    const message: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'hello world' }],
      toolCalls: [],
    };
    const first = estimateTokensForMessage(message);
    // The WeakMap memo returns the cached estimate for the same object even
    // when the content is later mutated.
    message.content.push({ type: 'text', text: 'mutated after the fact' });
    expect(estimateTokensForMessage(message)).toBe(first);
    expect(estimateTokensForMessages([message, message])).toBe(first * 2);
  });

  it('counts media parts with the flat media estimate', () => {
    expect(
      estimateTokensForContentPart({ type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } }),
    ).toBe(MEDIA_TOKEN_ESTIMATE);
    expect(
      estimateTokensForContentPart({ type: 'video_url', videoUrl: { url: 'data:video/mp4;base64,AAAA' } }),
    ).toBe(MEDIA_TOKEN_ESTIMATE);
    expect(estimateTokensForContentPart({ type: 'think', think: 'abcd' })).toBe(1);
  });
});

describe('estimateTokensForTools', () => {
  it('counts name, description, and serialized parameters', () => {
    const tool = { name: 'read', description: 'Read a file', parameters: { type: 'object' } };
    const expected =
      estimateTokens('read') +
      estimateTokens('Read a file') +
      estimateTokens(JSON.stringify({ type: 'object' }));
    expect(estimateTokensForTools([tool])).toBe(expected);
  });
});
