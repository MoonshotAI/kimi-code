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
  it('omits the empty current session from the picker rows', () => {
    const rows = sessionRowsForPicker(
      [
        summary({ id: 'ses_current', title: 'New Session' }),
        summary({ id: 'ses_previous', title: 'New Session' }),
      ],
      'ses_current',
    );

    expect(rows.map((row) => row.id)).toEqual(['ses_previous']);
  });

  it('keeps the current session after prompt metadata exists', () => {
    const rows = sessionRowsForPicker(
      [
        summary({
          id: 'ses_current',
          title: 'Implement feature',
          lastPrompt: 'Implement feature',
        }),
      ],
      'ses_current',
    );

    expect(rows.map((row) => row.id)).toEqual(['ses_current']);
  });

  it('keeps a current session with a non-default title', () => {
    const rows = sessionRowsForPicker(
      [summary({ id: 'ses_current', title: 'Pinned workspace' })],
      'ses_current',
    );

    expect(rows.map((row) => row.id)).toEqual(['ses_current']);
  });
});
