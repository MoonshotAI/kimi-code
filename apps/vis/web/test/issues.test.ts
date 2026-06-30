import { describe, it, expect } from 'vitest';

import { computeIssues } from '../src/lib/issues';
import type { WireEntry } from '../src/types';

let line = 0;
function loop(event: Record<string, unknown>): WireEntry {
  line += 1;
  return { lineNo: line, data: { type: 'context.append_loop_event', event }, raw: {} } as unknown as WireEntry;
}

describe('computeIssues — runtime error categories', () => {
  it('flags tool errors, truncation, filtered + max_tokens steps', () => {
    line = 0;
    const entries: WireEntry[] = [
      loop({ type: 'step.begin', uuid: 's1', turnId: 'T', step: 0 }),
      loop({ type: 'tool.call', uuid: 'a', turnId: 'T', step: 0, stepUuid: 's1', toolCallId: 'c1', name: 'Bash' }),
      loop({ type: 'tool.result', parentUuid: 'a', toolCallId: 'c1', result: { output: 'boom', isError: true, message: 'exit 1' } }),
      loop({ type: 'tool.call', uuid: 'b', turnId: 'T', step: 0, stepUuid: 's1', toolCallId: 'c2', name: 'Read' }),
      loop({ type: 'tool.result', parentUuid: 'b', toolCallId: 'c2', result: { output: 'partial', truncated: true } }),
      loop({ type: 'step.end', uuid: 's1', turnId: 'T', step: 0, finishReason: 'filtered', rawFinishReason: 'content_filter' }),
      loop({ type: 'step.begin', uuid: 's2', turnId: 'T', step: 1 }),
      loop({ type: 'step.end', uuid: 's2', turnId: 'T', step: 1, finishReason: 'max_tokens' }),
    ];

    const issues = computeIssues(entries, []);
    const byKind = new Map(issues.map((i) => [i.kind, i]));

    expect(byKind.get('tool_error')).toMatchObject({ severity: 'error', detail: 'exit 1' });
    expect(byKind.get('tool_truncated')).toMatchObject({ severity: 'info' });
    expect(byKind.get('model_filtered')).toMatchObject({ severity: 'error', detail: 'content_filter' });
    expect(byKind.get('model_max_tokens')).toMatchObject({ severity: 'warning' });

    // The tool.result rows are properly paired, so no orphan noise.
    expect(issues.some((i) => i.kind === 'orphan_tool_call' || i.kind === 'missing_tool_result')).toBe(false);
  });
});
