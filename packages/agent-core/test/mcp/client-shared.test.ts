import { describe, expect, test } from 'vitest';

import { toMcpToolResult } from '../../src/mcp/client-shared';

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

  test('ignores a non-object structuredContent from a non-conforming server', () => {
    const result = toMcpToolResult({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: 'not-an-object',
    });

    expect(result.structuredContent).toBeUndefined();
  });
});
