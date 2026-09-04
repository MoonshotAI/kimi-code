// Which id shapes count as canonical (preserved) vs normalized, and how the two length regimes
// differ: the chat `tool_call.id` is uncapped so a canonical id survives at any length, while the
// Responses `call_id` is capped at 64 so an over-long canonical id falls back to normalization.
// End-to-end wiring through each provider is covered by the per-provider wire tests.
import {
  sanitizeOpenAIResponsesCallIdPreservingNative,
  sanitizeToolCallIdPreservingNative,
} from '#/providers/tool-call-id';
import { describe, expect, it } from 'vitest';

describe('sanitizeToolCallIdPreservingNative', () => {
  it('preserves canonical native ids verbatim', () => {
    expect(sanitizeToolCallIdPreservingNative('functions.Read:0', 64)).toBe('functions.Read:0');
    expect(sanitizeToolCallIdPreservingNative('functions.web_search:12', 64)).toBe(
      'functions.web_search:12',
    );
    // MCP tools are namespaced `mcp__<server>__<tool>` — all identifier chars, so their
    // native ids are preserved like any builtin.
    expect(sanitizeToolCallIdPreservingNative('functions.mcp__github__create_pr:3', 64)).toBe(
      'functions.mcp__github__create_pr:3',
    );
  });

  it('falls back to sanitizeToolCallId for non-canonical ids', () => {
    expect(sanitizeToolCallIdPreservingNative('Read:9', 64)).toBe('Read_9'); // no `functions.`
    expect(sanitizeToolCallIdPreservingNative('functions.Read:x', 64)).toBe('functions_Read_x'); // idx not numeric
    expect(sanitizeToolCallIdPreservingNative('functions_Read_0', 64)).toBe('functions_Read_0'); // already sanitized
    expect(sanitizeToolCallIdPreservingNative('call_abc123', 64)).toBe('call_abc123'); // OpenAI-style
    // A name carrying a `.` is ambiguous under `functions.{name}:{idx}` parsing, so it is treated
    // as non-canonical and normalized — the pre-existing behavior, no regression.
    expect(sanitizeToolCallIdPreservingNative('functions.a.b:0', 64)).toBe('functions_a_b_0');
  });

  it('preserves a canonical id longer than maxLength (chat tool_call.id is uncapped)', () => {
    // `functions.` (10) + 54-char name + `:0` (2) = 66 chars. OpenAI's 64-char cap is on the
    // function *name*, not on tool_call.id, so a long canonical id must round-trip intact — the
    // maxLength only bounds the sanitization fallback for non-canonical ids.
    const longId = `functions.${'a'.repeat(54)}:0`;
    expect(longId).toHaveLength(66);
    expect(sanitizeToolCallIdPreservingNative(longId, 64)).toBe(longId);
  });

  it('preserves a canonical id with a multi-digit idx', () => {
    expect(sanitizeToolCallIdPreservingNative('functions.Read:10', 64)).toBe('functions.Read:10');
  });
});

describe('sanitizeOpenAIResponsesCallIdPreservingNative', () => {
  it('preserves canonical native ids, including under a `|<itemId>` Responses suffix', () => {
    expect(sanitizeOpenAIResponsesCallIdPreservingNative('functions.Read:0', 64)).toBe(
      'functions.Read:0',
    );
    // The Responses transport can append `|<itemId>`; the canonical call-id part must still survive.
    expect(sanitizeOpenAIResponsesCallIdPreservingNative('functions.Read:0|item_abc', 64)).toBe(
      'functions.Read:0',
    );
  });

  it('falls back to the responses sanitizer for non-canonical ids', () => {
    expect(sanitizeOpenAIResponsesCallIdPreservingNative('call_abc123|item_1', 64)).toBe(
      'call_abc123',
    );
    expect(sanitizeOpenAIResponsesCallIdPreservingNative('Read:9', 64)).toBe('Read_9');
  });

  it('does not preserve a shape-canonical call-id longer than maxLength', () => {
    const longId = `functions.${'a'.repeat(54)}:0`;
    expect(longId).toHaveLength(66);
    const result = sanitizeOpenAIResponsesCallIdPreservingNative(longId, 64);
    expect(result).not.toBe(longId);
    expect(result.length).toBeLessThanOrEqual(64);
  });
});
