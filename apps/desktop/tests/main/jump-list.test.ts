import { describe, expect, it } from 'vitest';

import {
  asJumpListWorkspaces,
  buildJumpListCategories,
  filterRemovedJumpListWorkspaces,
  parseLaunchArgs,
  quoteWindowsCommandLineArg,
} from '../../src/main/jump-list';

describe('parseLaunchArgs', () => {
  it('returns no action for a plain launch', () => {
    expect(parseLaunchArgs(['C:\\Apps\\Kimi Code\\Kimi Code.exe'])).toEqual({ newChat: false });
    expect(parseLaunchArgs(['electron', '.'])).toEqual({ newChat: false });
  });

  it('parses --new-chat', () => {
    expect(parseLaunchArgs(['app', '--new-chat'])).toEqual({ newChat: true });
  });

  it('parses --workspace with a quoted root (Jump List args quote paths with spaces)', () => {
    expect(parseLaunchArgs(['app', '--workspace="D:\\My Projects\\kimi"'])).toEqual({
      newChat: false,
      workspace: 'D:\\My Projects\\kimi',
    });
  });

  it('also accepts an unquoted root (hand-typed)', () => {
    expect(parseLaunchArgs(['app', '--workspace=/work/kimi'])).toEqual({
      newChat: false,
      workspace: '/work/kimi',
    });
  });

  it('ignores an empty workspace value', () => {
    expect(parseLaunchArgs(['app', '--workspace=', '--new-chat'])).toEqual({ newChat: true });
    expect(parseLaunchArgs(['app', '--workspace=""'])).toEqual({ newChat: false });
  });

  it('parses both flags together', () => {
    expect(parseLaunchArgs(['app', '--new-chat', '--workspace=/work/kimi'])).toEqual({
      newChat: true,
      workspace: '/work/kimi',
    });
  });
});

describe('asJumpListWorkspaces', () => {
  it('accepts a well-formed list', () => {
    expect(
      asJumpListWorkspaces([
        { name: 'kimi', root: '/work/kimi' },
        { name: 'app', root: '/work/app' },
      ]),
    ).toEqual([
      { name: 'kimi', root: '/work/kimi' },
      { name: 'app', root: '/work/app' },
    ]);
  });

  it('drops the whole payload on any malformed entry (tray-attention policy)', () => {
    expect(asJumpListWorkspaces('nope')).toBeNull();
    expect(asJumpListWorkspaces([{ name: 'kimi' }])).toBeNull();
    expect(asJumpListWorkspaces([{ name: 'kimi', root: '' }])).toBeNull();
    expect(asJumpListWorkspaces([{ name: 1, root: '/work/kimi' }])).toBeNull();
    expect(asJumpListWorkspaces([null])).toBeNull();
  });

  it('truncates beyond the OS-visible cap instead of rejecting', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `w${i}`, root: `/work/w${i}` }));
    expect(asJumpListWorkspaces(many)).toHaveLength(9);
  });

  it('strips unknown extra fields', () => {
    expect(asJumpListWorkspaces([{ name: 'kimi', root: '/work/kimi', branch: 'main' }])).toEqual([
      { name: 'kimi', root: '/work/kimi' },
    ]);
  });
});

describe('quoteWindowsCommandLineArg', () => {
  it('doubles trailing backslashes so they cannot escape the closing quote', () => {
    expect(quoteWindowsCommandLineArg('C:\\')).toBe('"C:\\\\"');
    expect(quoteWindowsCommandLineArg('D:\\Projects\\')).toBe('"D:\\Projects\\\\"');
  });

  it('quotes spaces without changing ordinary path separators', () => {
    expect(quoteWindowsCommandLineArg('D:\\My Projects\\kimi')).toBe(
      '"D:\\My Projects\\kimi"',
    );
  });
});

describe('buildJumpListCategories', () => {
  const exec = 'C:\\Apps\\Kimi Code\\Kimi Code.exe';

  it('always carries the New Chat task, even with no workspaces', () => {
    expect(buildJumpListCategories([], 'en', exec)).toEqual([
      {
        type: 'tasks',
        items: [
          { type: 'task', program: exec, args: '--new-chat', title: 'New Session', iconPath: exec, iconIndex: 0 },
        ],
      },
    ]);
  });

  it('lists workspaces in a custom category ahead of the tasks, quoting roots', () => {
    const categories = buildJumpListCategories(
      [{ name: 'kimi', root: 'D:\\My Projects\\kimi' }],
      'zh',
      exec,
    );
    expect(categories).toHaveLength(2);
    expect(categories[0]).toMatchObject({ type: 'custom', name: '最近' });
    expect(categories[0]!.items).toEqual([
      {
        type: 'task',
        program: exec,
        args: '--workspace="D:\\My Projects\\kimi"',
        title: 'kimi',
        description: 'D:\\My Projects\\kimi',
        iconPath: exec,
        iconIndex: 0,
      },
    ]);
    expect(categories[1]).toMatchObject({ type: 'tasks' });
    expect(categories[1]!.items![0]).toMatchObject({ title: '新建会话', args: '--new-chat' });
  });

  it('escapes a drive-root workspace for Windows command-line parsing', () => {
    const categories = buildJumpListCategories([{ name: 'C drive', root: 'C:\\' }], 'en', exec);
    expect(categories[0]!.items![0]).toMatchObject({
      args: '--workspace="C:\\\\"',
      description: 'C:\\',
    });
  });

  it('caps workspace descriptions at the Windows limit', () => {
    const root = `C:\\${'nested\\'.repeat(50)}`;
    const categories = buildJumpListCategories([{ name: 'deep', root }], 'en', exec);
    const description = categories[0]!.items![0]!.description;
    expect(description).toHaveLength(260);
    expect(description?.endsWith('…')).toBe(true);
    expect(categories[0]!.items![0]!.args).toBe(
      `--workspace=${quoteWindowsCommandLineArg(root)}`,
    );
  });
});

describe('filterRemovedJumpListWorkspaces', () => {
  it('does not re-add workspace tasks removed by the user', () => {
    const workspaces = [
      { name: 'keep', root: 'D:\\keep' },
      { name: 'removed', root: 'C:\\' },
    ];
    expect(
      filterRemovedJumpListWorkspaces(workspaces, [
        { args: `--workspace=${quoteWindowsCommandLineArg('C:\\')}` },
        { args: '--new-chat' },
      ]),
    ).toEqual([{ name: 'keep', root: 'D:\\keep' }]);
  });
});
