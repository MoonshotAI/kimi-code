import type { SessionSummary } from '@moonshot-ai/kimi-code-sdk';
import type { EngineSessionRecord } from '#/cli/native-session-adapter';
import { describe, expect, it } from 'vitest';

import { nativeSessionRowsForPicker, sessionRowsForPicker } from '#/tui/utils/session-picker-rows';

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
});

function engineRecord(input: {
  readonly id: string;
  readonly updatedAt: string;
  readonly createdAt: string;
  readonly title?: string;
  readonly workDir?: string;
}): EngineSessionRecord {
  return {
    id: input.id,
    updated_at: input.updatedAt,
    created_at: input.createdAt,
    title: input.title ?? '',
    work_dir: input.workDir ?? '',
  };
}

describe('nativeSessionRowsForPicker', () => {
  it('maps engine wire records onto picker rows (ISO timestamps to ms)', () => {
    const rows = nativeSessionRowsForPicker(
      [engineRecord({ id: 'tui_1', updatedAt: '2026-07-30T12:00:00Z', createdAt: '2026-07-29T00:00:00Z', title: 'Native session' })],
      '/tmp/project',
      'ses_current',
      false,
    );

    expect(rows).toEqual([
      {
        id: 'tui_1',
        title: 'Native session',
        work_dir: '/tmp/project',
        updated_at: Date.parse('2026-07-30T12:00:00Z'),
      },
    ]);
  });

  it('omits the current session when the TUI session has no content', () => {
    const rows = nativeSessionRowsForPicker(
      [
        engineRecord({ id: 'tui_current', updatedAt: '2026-07-30T12:00:00Z', createdAt: '2026-07-29T00:00:00Z' }),
        engineRecord({ id: 'tui_previous', updatedAt: '2026-07-30T10:00:00Z', createdAt: '2026-07-29T00:00:00Z' }),
      ],
      '/tmp/project',
      'tui_current',
      false,
    );

    expect(rows.map((row) => row.id)).toEqual(['tui_previous']);
  });

  it('falls back to the workspace dir and 0 when record fields are missing', () => {
    const rows = nativeSessionRowsForPicker(
      [engineRecord({ id: 'tui_1', updatedAt: '', createdAt: '' })],
      '/tmp/project',
      'ses_current',
      false,
    );

    expect(rows).toEqual([
      { id: 'tui_1', title: null, work_dir: '/tmp/project', updated_at: 0 },
    ]);
  });
});
