/**
 * `mcpCore` domain tests — `toMcpToolResult` result conversion scenarios.
 *
 * Covers `structuredContent` / `_meta` handling at the SDK boundary: both
 * ride through to the model untouched whenever the server sends them. Run
 * with
 * `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/mcpCore/client-shared.test.ts`.
 */

import { describe, expect, test } from 'vitest';

import { toMcpToolResult } from '#/mcpCore/client-shared';

describe('toMcpToolResult', () => {
  test('passes structuredContent through alongside the content blocks', () => {
    const result = toMcpToolResult({
      content: [{ type: 'text', text: 'returned 6 item(s).' }],
      structuredContent: { items: [1, 2, 3] },
    });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'returned 6 item(s).' }],
      isError: false,
      structuredContent: { items: [1, 2, 3] },
    });
  });

  test('omits structuredContent when the server did not send one', () => {
    const result = toMcpToolResult({ content: [{ type: 'text', text: 'ok' }] });

    expect(result).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });
    expect(result.structuredContent).toBeUndefined();
  });

  test('passes a non-object structuredContent through untouched', () => {
    const result = toMcpToolResult({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: 'not-an-object',
    });

    expect(result.structuredContent).toBe('not-an-object');
  });

  test('passes _meta through alongside the content blocks', () => {
    const result = toMcpToolResult({
      content: [{ type: 'text', text: 'ok' }],
      _meta: { 'example.com/trace': 'abc' },
    });

    expect(result._meta).toEqual({ 'example.com/trace': 'abc' });
  });
});
