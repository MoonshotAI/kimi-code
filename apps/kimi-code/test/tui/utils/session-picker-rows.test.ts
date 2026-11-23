import type { SessionSummary } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { sessionRowsForPicker } from '#/tui/utils/session-picker-rows';

function summary(input: {
  readonly id: string;
  readonly title?: string;
  readonly lastPrompt?: string;
}): SessionSummary {
  return {
    id: input.id,
    title: input.title,
    lastPrompt: input.lastPrompt,
    workDir: '/tmp/project',
    sessionDir: `/tmp/home/sessions/${input.id}`,
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('sessionRowsForPicker', () => {
  it('omits the current session when the TUI session has no content', () => {
    const rows = sessionRowsForPicker(
      [
        summary({ id: 'ses_current', title: 'New Session' }),
        summary({ id: 'ses_previous', title: 'New Session' }),
      ],
      'ses_current',
      false,
    );

    expect(rows.map((row) => row.id)).toEqual(['ses_previous']);
  });

  it('keeps the current session when the TUI session has content', () => {
    const rows = sessionRowsForPicker(
      [
        summary({
          id: 'ses_current',
          title: 'Implement feature',
          lastPrompt: 'Implement feature',
        }),
      ],
      'ses_current',
      true,
    );

    expect(rows.map((row) => row.id)).toEqual(['ses_current']);
  });

  it('does not filter empty historical sessions', () => {
    const rows = sessionRowsForPicker(
      [
        summary({ id: 'ses_current', title: 'New Session' }),
        summary({ id: 'ses_previous_empty', title: 'New Session' }),
      ],
      'ses_current',
      false,
    );

    expect(rows.map((row) => row.id)).toEqual(['ses_previous_empty']);
  });

  it('carries the project directory and the location tags of each working directory', () => {
    const worktreeSession = { ...summary({ id: 'ses_wt' }), workDir: '/tmp/wt/x', projectWorkDir: '/tmp/project' };
    const goneSession = { ...summary({ id: 'ses_gone' }), workDir: '/tmp/gone' };
    const rows = sessionRowsForPicker(
      [worktreeSession, goneSession, summary({ id: 'ses_plain' })],
      '',
      false,
      new Map([
        ['/tmp/wt/x', { worktree: 'x', missing: false }],
        ['/tmp/gone', { missing: true }],
      ]),
    );

    expect(rows.map(({ id, project_work_dir, worktree, missing }) => ({ id, project_work_dir, worktree, missing }))).toEqual([
      { id: 'ses_wt', project_work_dir: '/tmp/project', worktree: 'x', missing: false },
      { id: 'ses_gone', project_work_dir: undefined, worktree: undefined, missing: true },
      { id: 'ses_plain', project_work_dir: undefined, worktree: undefined, missing: undefined },
    ]);
  });
});
