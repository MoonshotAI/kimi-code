import { stripVTControlCharacters } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WorktreeProgressComponent,
  type WorktreeProgress,
} from '#/tui/components/messages/worktree-progress';
import { BRAILLE_SPINNER_FRAMES } from '#/tui/constant/rendering';

const PATH = '/home/me/.kimi-code/worktrees/wd_repo/fix-login';
const HEAD = 'abcdef1234567890';

function rendered(progress: WorktreeProgress, width = 120): string {
  const component = new WorktreeProgressComponent(() => {});
  component.update(progress);
  const text = component
    .render(width)
    .map((line) => stripVTControlCharacters(line).trimEnd())
    .join('\n');
  component.dispose();
  return text;
}

describe('WorktreeProgressComponent', () => {
  beforeEach(() => {
    vi.stubEnv('HOME', '/home/me');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('titles itself before and after the name is known', () => {
    expect(
      rendered({
        phase: 'creating',
        rows: [{ step: 'check', status: 'done', sourceDir: '/home/me/code/repo' }],
      }),
    ).toBe(['', '● Creating worktree', '  ✓ Checked ~/code/repo'].join('\n'));
  });

  it('renders finished steps with their details and a running step spinner', () => {
    expect(
      rendered({
        phase: 'creating',
        name: 'fix-login',
        rows: [
          { step: 'check', status: 'done', sourceDir: '/home/me/code/repo' },
          { step: 'add', status: 'done', path: PATH, head: HEAD },
          { step: 'include', status: 'running', copiedFiles: [] },
        ],
      }),
    ).toBe(
      [
        '',
        '● Creating worktree fix-login',
        '  ✓ Checked ~/code/repo',
        '  ✓ Created ~/.kimi-code/worktrees/wd_repo/fix-login  detached at abcdef1',
        `  ${BRAILLE_SPINNER_FRAMES[0]!} Copying files from .worktreeinclude`,
      ].join('\n'),
    );
    expect(
      rendered({
        phase: 'creating',
        name: 'fix-login',
        rows: [
          { step: 'check', status: 'done', sourceDir: '/home/me/code/repo' },
          { step: 'add', status: 'done', path: PATH, head: HEAD },
          { step: 'include', status: 'done', copiedFiles: ['.env', 'apps/web/.env.local', 'b', 'c', 'd'] },
        ],
      }),
    ).toBe(
      [
        '',
        '● Creating worktree fix-login',
        '  ✓ Checked ~/code/repo',
        '  ✓ Created ~/.kimi-code/worktrees/wd_repo/fix-login  detached at abcdef1',
        '  ✓ Copied 5 files from .worktreeinclude  .env, apps/web/.env.local, b +2 more',
      ].join('\n'),
    );
  });

  it('hides the include row when nothing was copied and shows a single copied file', () => {
    const base = { step: 'check', status: 'done', sourceDir: '/repo' } as const;
    expect(
      rendered({
        phase: 'creating',
        name: 'x',
        rows: [base, { step: 'include', status: 'done', copiedFiles: [] }],
      }),
    ).toBe(['', '● Creating worktree x', '  ✓ Checked /repo'].join('\n'));
    expect(
      rendered({
        phase: 'creating',
        name: 'x',
        rows: [{ step: 'include', status: 'done', copiedFiles: ['.env'] }],
      }),
    ).toContain('✓ Copied 1 file from .worktreeinclude  .env');
  });

  it('shows the last error lines under a failed step', () => {
    const output = Array.from({ length: 10 }, (_, index) => `line ${String(index + 1)}`);
    expect(
      rendered({
        phase: 'stopped',
        name: 'fix-login',
        rows: [{ step: 'add', status: 'failed', path: PATH, head: HEAD, output }],
      }),
    ).toBe(
      [
        '',
        '● Creating worktree fix-login',
        "  ✗ Couldn't create ~/.kimi-code/worktrees/wd_repo/fix-login",
        ...output.slice(2).map((line) => `    ${line}`),
      ].join('\n'),
    );
  });

  it('collapses into the entered line with its notes, or the cancel line', () => {
    expect(
      rendered({
        phase: 'entered',
        name: 'fix-login',
        sourceDir: '/home/me/code/repo',
        sourceDirty: false,
      }),
    ).toBe(['', '✓ Entered worktree fix-login'].join('\n'));
    expect(
      rendered({
        phase: 'entered',
        name: 'fix-login',
        sourceDir: '/home/me/code/repo',
        sourceDirty: true,
        missingSubdir: 'packages/foo',
      }),
    ).toBe(
      [
        '',
        '✓ Entered worktree fix-login',
        '  Uncommitted changes in ~/code/repo stay there.',
        "  packages/foo doesn't exist at this commit, so the session starts at the worktree root.",
      ].join('\n'),
    );
    expect(rendered({ phase: 'cancelled', sourceDir: '/home/me/code/repo' })).toBe(
      ['', '● Cancelled. Staying in ~/code/repo.'].join('\n'),
    );
  });

  it('keeps every line within a narrow width', () => {
    const component = new WorktreeProgressComponent(() => {});
    component.update({
      phase: 'creating',
      name: 'fix-login',
      rows: [{ step: 'add', status: 'running', path: PATH, head: HEAD }],
    });
    for (const width of [1, 10, 30]) {
      for (const line of component.render(width)) {
        expect(stripVTControlCharacters(line).length).toBeLessThanOrEqual(width);
      }
    }
    component.dispose();
  });
});
