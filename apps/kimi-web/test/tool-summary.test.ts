// apps/kimi-web/test/tool-summary.test.ts
//
// toolSummary derives the per-tool header/body string from a tool's arguments.
// An EMPTY argument (e.g. `{}`) must not clutter the collapsed header title, but
// the expanded body (full mode) still shows it.

import { describe, expect, it } from 'vitest';
import { toolSummary } from '../src/lib/toolMeta';

describe('toolSummary empty-argument handling', () => {
  it('omits an empty {} argument from the collapsed header', () => {
    expect(toolSummary('SomeTool', '{}')).toBe('');
    expect(toolSummary('SomeTool', '   {}  ')).toBe('');
    expect(toolSummary('SomeTool', '')).toBe('');
    expect(toolSummary('SomeTool', '[]')).toBe('');
  });

  it('still shows the empty argument in the expanded body (full mode)', () => {
    expect(toolSummary('SomeTool', '{}', true)).toBe('{}');
  });

  it('still shows a non-empty argument in the header', () => {
    expect(toolSummary('Bash', '{"command":"ls -la"}')).toContain('ls -la');
    expect(toolSummary('Read', '{"path":"src/app.ts"}')).toContain('src/app.ts');
  });
});
