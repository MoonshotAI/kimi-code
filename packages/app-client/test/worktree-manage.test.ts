import { describe, expect, it } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import {
  formatWorktreeSize,
  worktreeDeleteRows,
  worktreeFailureText,
  worktreeRemovalProgress,
  worktreeRemovalSummaryText,
  worktreeRiskRow,
  worktreeSessionDeleteRows,
  type WorktreeDeleteTarget,
  type WorktreeRemovalProgressItem,
} from '../src/lib/worktreeManage';

function translator(locale: 'en' | 'zh') {
  const i18n = createKimiI18n({ locale });
  return (key: string, params?: Record<string, unknown>): string =>
    params === undefined ? i18n.global.t(key) : i18n.global.t(key, params);
}

const en = translator('en');
const zh = translator('zh');

const MB = 1024 * 1024;
const GB = 1024 * MB;

function target(name: string, overrides: Partial<WorktreeDeleteTarget> = {}): WorktreeDeleteTarget {
  return {
    path: `/wt/${name}`,
    name,
    branch: `kimi/${name}`,
    projectName: 'kimi-code-app',
    sessionCount: 0,
    risk: { uncommittedFiles: 0, unpushedCommits: 0 },
    ...overrides,
  };
}

describe('risk wording', () => {
  it.each([
    [{ uncommittedFiles: 3, unpushedCommits: 0 }, false, 'risk', '3 files are uncommitted and cannot be recovered after deletion.'],
    [{ uncommittedFiles: 1, unpushedCommits: 0 }, false, 'risk', '1 file is uncommitted and cannot be recovered after deletion.'],
    [{ uncommittedFiles: 3, unpushedCommits: 2 }, false, 'risk', '3 files are uncommitted and cannot be recovered after deletion.'],
    [{ uncommittedFiles: 0, unpushedCommits: 2 }, true, 'risk', '2 commits have not been pushed and cannot be recovered after deletion.'],
    [{ uncommittedFiles: 0, unpushedCommits: 1 }, true, 'risk', '1 commit has not been pushed and cannot be recovered after deletion.'],
    [
      { uncommittedFiles: 3, unpushedCommits: 2 },
      true,
      'risk',
      '3 files are uncommitted and 2 commits have not been pushed; these cannot be recovered after deletion.',
    ],
    [{ uncommittedFiles: 0, unpushedCommits: 2 }, false, 'safe', 'There are no uncommitted files.'],
    [
      { uncommittedFiles: 0, unpushedCommits: 2, detached: true },
      false,
      'risk',
      '2 commits have not been pushed and cannot be recovered after deletion.',
    ],
    [{ uncommittedFiles: 0, unpushedCommits: 0 }, false, 'safe', 'There are no uncommitted files.'],
    [{ uncommittedFiles: 0, unpushedCommits: 0 }, true, 'safe', 'There are no uncommitted or unpushed changes.'],
  ] as const)('%j with branch deletion %s reads as %s', (risk, deleteBranch, kind, text) => {
    const row = worktreeRiskRow(risk, deleteBranch, en);
    expect(row.key).toBe(kind);
    expect(row.text).toBe(text);
    expect(row.tone).toBe(kind === 'risk' ? 'warning' : 'muted');
  });

  it('says so when the status could not be checked', () => {
    const row = worktreeRiskRow(null, true, en);
    expect(row.key).toBe('unknown');
    expect(row.tone).toBe('warning');
    expect(row.text).toBe('Couldn’t check for uncommitted or unpushed changes.');
  });
});

describe('single deletion dialog', () => {
  it('puts the affected sessions between the target and the risk', () => {
    const rows = worktreeDeleteRows([target('a', { sessionCount: 3 })], false, en);
    expect(rows.map((row) => [row.key, row.icon, row.text])).toEqual([
      ['target', 'folder', 'The Worktree directory for kimi/a will be deleted.'],
      ['sessions', 'message', '3 associated sessions will no longer be able to use this directory.'],
      ['safe', 'circle-check', 'There are no uncommitted files.'],
    ]);
    expect(worktreeDeleteRows([target('a', { sessionCount: 1 })], false, en)[1]?.text).toBe(
      '1 associated session will no longer be able to use this directory.',
    );
  });

  it('falls back to the directory name for a worktree without a branch', () => {
    const rows = worktreeDeleteRows([target('task-3', { branch: undefined })], false, en);
    expect(rows[0]?.text).toBe('The Worktree directory for task-3 will be deleted.');
  });
});

describe('batch deletion dialog', () => {
  const targets = [
    target('clean', { projectName: 'demo', sessionCount: 1 }),
    target('dirty', { risk: { uncommittedFiles: 3, unpushedCommits: 2 }, sessionCount: 3 }),
    target('one', { risk: { uncommittedFiles: 1, unpushedCommits: 0 } }),
  ];

  it('heads the list, sorts risky worktrees first and states what each would lose', () => {
    const rows = worktreeDeleteRows(targets, false, en);
    expect(rows[0]).toMatchObject({ key: 'target', text: 'Worktrees to delete', trailing: '3 total' });
    expect(rows[0]?.items).toEqual([
      { key: '/wt/dirty', name: 'kimi/dirty', nameIsDirectory: false, meta: 'kimi-code-app', loss: '3 uncommitted files' },
      { key: '/wt/one', name: 'kimi/one', nameIsDirectory: false, meta: 'kimi-code-app', loss: '1 uncommitted file' },
      { key: '/wt/clean', name: 'kimi/clean', nameIsDirectory: false, meta: 'demo', loss: '' },
    ]);
    expect(rows.slice(1).map((row) => [row.key, row.text])).toEqual([
      ['sessions', '4 associated sessions will no longer be able to use these directories.'],
      ['risk', 'Contents of 2 Worktrees cannot be recovered after deletion.'],
    ]);
  });

  it('adds unpushed commits to the list when branches are deleted too', () => {
    const rows = worktreeDeleteRows(targets, true, en);
    expect(rows[0]?.text).toBe('Worktrees and local branches to delete');
    expect(rows[0]?.items?.[0]?.loss).toBe('3 uncommitted files, 2 unpushed commits');
  });

  it('reports no risk only when every worktree is clean', () => {
    const clean = [target('a'), target('b', { risk: { uncommittedFiles: 0, unpushedCommits: 4 } })];
    expect(worktreeDeleteRows(clean, false, en).at(-1)).toMatchObject({
      key: 'safe',
      text: 'There are no uncommitted files.',
    });
    expect(worktreeDeleteRows(clean, true, en).at(-1)).toMatchObject({
      key: 'risk',
      text: 'Contents of 1 Worktree cannot be recovered after deletion.',
    });
    expect(worktreeDeleteRows([target('a'), target('b')], true, en).at(-1)?.text).toBe(
      'There are no uncommitted or unpushed changes.',
    );
  });

  it('flags worktrees whose status could not be checked instead of calling them clean', () => {
    const rows = worktreeDeleteRows([target('a'), target('b', { risk: null })], false, en);
    expect(rows[0]?.items?.map((item) => item.loss)).toEqual(['', 'Status unknown']);
    expect(rows.at(-1)).toMatchObject({
      key: 'unknown',
      text: 'Couldn’t check 1 Worktree for uncommitted or unpushed changes.',
    });
    expect(rows.some((row) => row.key === 'safe')).toBe(false);
  });
});

describe('session deletion dialog', () => {
  it('deletes the history and the directory when no other session uses the worktree', () => {
    const rows = worktreeSessionDeleteRows(
      { title: 'Fix login', otherSessions: 0, risk: { uncommittedFiles: 4, unpushedCommits: 1 }, deleteBranch: false },
      en,
    );
    expect(rows.map((row) => [row.icon, row.text])).toEqual([
      [
        'message',
        'The conversation history and Worktree directory for "Fix login" will be permanently deleted and cannot be recovered.',
      ],
      ['alert-triangle', '4 files are uncommitted and cannot be recovered after deletion.'],
    ]);
  });

  it('keeps the directory and drops the risk row while other sessions use it', () => {
    const rows = worktreeSessionDeleteRows(
      { title: 'Hello', otherSessions: 2, risk: { uncommittedFiles: 4, unpushedCommits: 1 }, deleteBranch: true },
      en,
    );
    expect(rows.map((row) => [row.key, row.icon, row.text])).toEqual([
      [
        'target',
        'message',
        'The conversation history for "Hello" will be permanently deleted and cannot be recovered.',
      ],
      ['retained', 'folder', 'The Worktree directory will be retained because 2 other sessions are using it.'],
    ]);
  });
});

describe('failure wording', () => {
  it.each([
    ['in_use', 'Deletion failed: directory in use', en],
    ['session_busy', 'Deletion failed: session is running', en],
    ['unknown', 'Deletion failed', en],
    ['in_use', '删除失败：目录被占用', zh],
  ] as const)('words %s as "%s"', (reason, text, t) => {
    expect(worktreeFailureText(reason, t)).toBe(text);
  });
});

describe('removal progress and receipts', () => {
  function item(name: string, state: WorktreeRemovalProgressItem['state'], branchDeleted?: boolean) {
    return { path: `/wt/${name}`, name: `kimi/${name}`, state, branchDeleted };
  }

  it('counts finished rows and puts failures first', () => {
    const progress = worktreeRemovalProgress([
      item('a', 'waiting'),
      item('b', 'deleted'),
      item('c', 'deleting'),
      item('d', 'failed'),
    ]);
    expect(progress).toMatchObject({ total: 4, completed: 2, deleted: 1, failed: 1, running: true });
    expect(progress.items.map((entry) => entry.state)).toEqual(['failed', 'deleting', 'deleted', 'waiting']);
    expect(worktreeRemovalProgress([item('a', 'deleted'), item('b', 'failed')]).running).toBe(false);
  });

  it.each([
    ['Worktree kimi/a deleted; branch retained', en, [item('a', 'deleted', false)]],
    ['Worktree kimi/a and its local branch deleted', en, [item('a', 'deleted', true)]],
    ['已删除 kimi/a 及本地分支', zh, [item('a', 'deleted', true)]],
    ['3 Worktrees deleted; branches retained', en, [item('a', 'deleted', false), item('b', 'deleted', false), item('c', 'deleted')]],
    ['已删除 3 个工作树，分支已保留', zh, [item('a', 'deleted', false), item('b', 'deleted', false), item('c', 'deleted')]],
    ['2 Worktrees and local branches deleted', en, [item('a', 'deleted', true), item('b', 'deleted', true)]],
    ['2 Worktrees deleted; 1 local branch deleted', en, [item('a', 'deleted', true), item('b', 'deleted', false)]],
    ['2 Worktrees deleted; 1 deletion failed', en, [item('a', 'deleted'), item('b', 'deleted'), item('c', 'failed')]],
    ['2 deletions failed', en, [item('a', 'failed'), item('b', 'failed')]],
    ['Deletion of kimi/a failed', en, [item('a', 'failed')]],
  ])('summarizes the run as "%s"', (text, t, items) => {
    expect(worktreeRemovalSummaryText(items, t)).toBe(text);
  });
});

describe('formatWorktreeSize', () => {
  it.each([
    [0, '0 MB'],
    [60 * MB, '60 MB'],
    [640.4 * MB, '640 MB'],
    [GB, '1.0 GB'],
    [5.3 * GB, '5.3 GB'],
    [undefined, ''],
    [null, ''],
    [Number.NaN, ''],
  ])('formats %s bytes as "%s"', (bytes, text) => {
    expect(formatWorktreeSize(bytes)).toBe(text);
  });
});
