import type { ResumedAgentState } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { appStateFromResumeAgent } from '#/tui/utils/message-replay';

function resumeAgent(toolStore?: Record<string, unknown>): ResumedAgentState {
  return {
    config: {},
    context: { tokenCount: 0 },
    plan: null,
    permission: { mode: 'manual' },
    toolStore,
  } as unknown as ResumedAgentState;
}

describe('appStateFromResumeAgent — todo status line hydration', () => {
  it('restores the persisted todo list on resume', () => {
    const patch = appStateFromResumeAgent(
      resumeAgent({
        todo: [
          { title: 'Read the code', status: 'done' },
          { title: 'Fix the footer', status: 'in_progress' },
        ],
      }),
    );

    expect(patch.todos).toEqual([
      { title: 'Read the code', status: 'done' },
      { title: 'Fix the footer', status: 'in_progress' },
    ]);
  });

  it('drops malformed entries instead of failing the resume', () => {
    const patch = appStateFromResumeAgent(
      resumeAgent({
        todo: [
          { title: 'Fix the footer', status: 'in_progress' },
          { title: '', status: 'pending' },
          'not-an-item',
        ],
      }),
    );

    expect(patch.todos).toEqual([{ title: 'Fix the footer', status: 'in_progress' }]);
  });

  it('clears stale todos when the resumed session has no list', () => {
    expect(appStateFromResumeAgent(resumeAgent(undefined)).todos).toBeNull();
    expect(appStateFromResumeAgent(resumeAgent({})).todos).toBeNull();
    expect(appStateFromResumeAgent(resumeAgent({ todo: 'garbage' })).todos).toBeNull();
  });

  it('leaves a fully-done list behind on resume', () => {
    const patch = appStateFromResumeAgent(
      resumeAgent({ todo: [{ title: 'Done work', status: 'done' }] }),
    );

    expect(patch.todos).toBeNull();
  });
});
