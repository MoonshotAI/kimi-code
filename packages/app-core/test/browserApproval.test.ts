import { expect, it } from 'vitest';
import type { AppApprovalRequest } from '../src/api/types';
import { buildApprovalBlock } from '../src/client/toolCalls';

const request: AppApprovalRequest = {
  approvalId: 'approval', sessionId: 'session', toolCallId: 'tool',
  toolName: 'mcp__desktop_browser__run', action: 'Approve mcp__desktop_browser__run',
  display: { kind: 'generic', detail: { protocol: 'kimi.browser/1.0.0', operation: 'tab.navigate', url: 'https://example.com/path' } },
};

it('preserves browser operation arguments for localized approval rendering', () => {
  expect(buildApprovalBlock(request)).toEqual({
    kind: 'browser', input: { protocol: 'kimi.browser/1.0.0', operation: 'tab.navigate', url: 'https://example.com/path' },
  });
});

it('recognizes the tool identity rather than text in the approval message', () => {
  expect(buildApprovalBlock({ ...request, toolName: 'mcp__other__run' })).toEqual({ kind: 'generic', summary: request.action });
});

it.each([null, 'invalid', [], undefined])('handles missing or malformed browser approval arguments: %j', detail => {
  expect(buildApprovalBlock({ ...request, display: { kind: 'generic', detail } })).toEqual({ kind: 'browser', input: {} });
});


it('keeps oversized approval diffs bounded on the synchronous path', () => {
  const before = Array.from({ length: 5001 }, (_, i) => `line ${i}`).join('\n');
  const block = buildApprovalBlock({ ...request, toolName: 'Edit', display: { kind: 'diff', path: 'large.ts', before, after: before + '\nadded' } });
  expect(block.kind).toBe('diff');
  if (block.kind !== 'diff') throw new Error('Expected a diff approval');
  expect(block.diff).toHaveLength(1002);
  expect(block.diff.at(-1)?.text).toContain('more lines');
});
