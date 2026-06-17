import { describe, expect, it, vi } from 'vitest';

import type {
  ReviewFanOutOptions,
  ReviewFanOutRunner,
  ReviewResult,
  ReviewStartInput,
} from '../../src/review';
import { RunCodeReviewTool } from '../../src/tools/builtin';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

function context<Input>(args: Input) {
  return { turnId: '0', toolCallId: 'call_review', args, signal };
}

function fakeResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    target: { scope: 'working_tree' },
    intensity: 'thorough',
    status: 'complete',
    stats: { fileCount: 1, additions: 1, deletions: 0, files: [] },
    summary: 'Review completed for 1 file, +1 -0. No review comments.',
    comments: [],
    reviewId: 1,
    reviewSlug: 'auth-flow-review',
    ...overrides,
  };
}

function outputText(result: { readonly output: unknown }): string {
  return typeof result.output === 'string' ? result.output : '';
}

describe('RunCodeReviewTool', () => {
  it('runs the fan-out with the pilot directions and background', async () => {
    const calls: Array<{ input: ReviewStartInput; options: ReviewFanOutOptions }> = [];
    const tool = new RunCodeReviewTool(async (input, options) => {
      calls.push({ input, options });
      return fakeResult();
    });

    const result = await executeTool(tool, context({
      intensity: 'thorough' as const,
      target: { scope: 'working_tree' as const },
      background: 'Refactors the reader into a fullscreen-only component.',
      directions: ['Correctness', 'Tests'],
      change_type: 'TUI refactor',
    }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toMatchObject({
      target: { scope: 'working_tree' },
      intensity: 'thorough',
      directions: ['Correctness', 'Tests'],
      background: 'Refactors the reader into a fullscreen-only component.',
      changeType: 'TUI refactor',
    });
    expect(calls[0]?.options.parentToolCallId).toBe('call_review');
    expect(calls[0]?.options.signal).toBe(signal);
    expect(result.isError).toBeFalsy();
    expect(outputText(result)).toContain('auth-flow-review');
  });

  it('rejects a deep review with fewer than two directions before fanning out', async () => {
    const runner = vi.fn<ReviewFanOutRunner>();
    const tool = new RunCodeReviewTool(runner);

    const result = await executeTool(tool, context({
      intensity: 'deep' as const,
      target: { scope: 'working_tree' as const },
      background: 'A risky change.',
      directions: ['Only one direction'],
    }));

    expect(result.isError).toBe(true);
    expect(runner).not.toHaveBeenCalled();
  });

  it('surfaces runner failures as tool errors', async () => {
    const tool = new RunCodeReviewTool(async () => {
      throw new Error('No changes to review.');
    });

    const result = await executeTool(tool, context({
      intensity: 'standard' as const,
      target: { scope: 'working_tree' as const },
      background: 'A change.',
      directions: ['Correctness'],
    }));

    expect(result).toMatchObject({ isError: true });
    expect(outputText(result)).toContain('No changes to review.');
  });
});
