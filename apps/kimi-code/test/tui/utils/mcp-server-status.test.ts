import { describe, expect, it } from 'vitest';

import { MCP_STATUS_ERROR_MAX_CHARS } from '#/tui/constant/rendering';
import { formatMcpServerErrorSummary } from '#/tui/utils/mcp-server-status';

describe('formatMcpServerErrorSummary', () => {
  it('collapses an HTML error page to its first readable line', () => {
    const summary = formatMcpServerErrorSummary(
      '<html>\n<head><title>403 Forbidden</title></head>\n<body><h1>Access denied</h1></body>\n</html>',
    );

    expect(summary).toBe('403 Forbidden');
    expect(summary).not.toContain('\n');
    expect(summary).not.toContain('<');
  });

  it('keeps a plain one-line error intact', () => {
    expect(formatMcpServerErrorSummary('fetch failed')).toBe('fetch failed');
  });

  it('skips blank leading lines and folds the stderr tail onto one line', () => {
    expect(
      formatMcpServerErrorSummary(
        '\n\nMCP error -32000: Connection closed\nstderr: usage: bridge [--host HOST]',
      ),
    ).toBe('MCP error -32000: Connection closed');
  });

  it('caps a long single line with an ellipsis', () => {
    const summary = formatMcpServerErrorSummary(`reason: ${'x'.repeat(1000)}`);

    expect(summary).toHaveLength(MCP_STATUS_ERROR_MAX_CHARS);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('returns an empty string for blank input', () => {
    expect(formatMcpServerErrorSummary('  \n  <br/>\n ')).toBe('');
  });
});
