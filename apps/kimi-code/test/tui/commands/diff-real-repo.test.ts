/**
 * Integration test for /diff: uses a real git repository on disk and verifies
 * the selector / diff-panel behaviour end-to-end.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Key, matchesKey } from '@moonshot-ai/pi-tui';

import { handleDiffCommand } from '#/tui/commands/diff';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { runGitNumstat, runUntrackedNumstat } from '#/utils/git/git-diff';

const DOWN_ARROW = '\u001B[B';
const RIGHT_ARROW = '\u001B[C';
const LEFT_ARROW = '\u001B[D';
const ENTER = '\r';

function makeHost(workDir: string, transcriptEntries: unknown[] = []) {
  const state = {
    appState: { workDir },
    transcriptEntries,
    transcriptContainer: { addChild: vi.fn() },
    ui: { requestRender: vi.fn() },
  };
  const host = {
    state,
    showError: vi.fn(),
    showStatus: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
  } as unknown as SlashCommandHost & {
    state: typeof state;
    showError: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    restoreEditor: ReturnType<typeof vi.fn>;
  };
  return host;
}

function runGit(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function editToolEntry(path: string, before: string, after: string, turnId?: string) {
  return {
    id: '1',
    kind: 'tool_call' as const,
    renderMode: 'plain' as const,
    content: '',
    turnId,
    toolCallData: {
      id: 'tc-1',
      name: 'Edit',
      args: {},
      display: { kind: 'file_io' as const, operation: 'edit' as const, path, before, after },
    },
  };
}

function userEntry(content: string, turnId?: string) {
  return {
    id: 'u-1',
    kind: 'user' as const,
    renderMode: 'plain' as const,
    content,
    turnId,
  };
}

describe('handleDiffCommand with real git repo', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'kimi-diff-test-'));
    runGit(repoDir, 'init', '--quiet');
    runGit(repoDir, 'config', 'user.email', 'test@example.com');
    runGit(repoDir, 'config', 'user.name', 'Test User');

    writeFileSync(join(repoDir, 'hello.txt'), 'first line\n', 'utf8');
    runGit(repoDir, 'add', 'hello.txt');
    runGit(repoDir, 'commit', '--quiet', '-m', 'initial');
  });

  afterEach(() => {
    execFileSync('rm', ['-rf', repoDir]);
  });

  it('renders a diff panel directly when only one file changed', async () => {
    writeFileSync(join(repoDir, 'hello.txt'), 'first line\nsecond line\n', 'utf8');
    const host = makeHost(repoDir);

    await handleDiffCommand(host, '');

    expect(host.showError).not.toHaveBeenCalled();
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.state.transcriptContainer.addChild).toHaveBeenCalledTimes(1);
    expect(host.state.ui.requestRender).toHaveBeenCalledTimes(1);

    const panel = host.state.transcriptContainer.addChild.mock.calls[0]![0] as {
      render(width: number): string[];
    };
    const rendered = panel.render(120).join('\n');

    expect(rendered).toContain('diff --git a/hello.txt b/hello.txt');
    expect(rendered).toContain('+second line');
    expect(rendered).toContain(' Diff ');
  });

  it('shows a status message when there are no changes', async () => {
    const host = makeHost(repoDir);

    await handleDiffCommand(host, '');

    expect(host.showStatus).toHaveBeenCalledWith('No changed files.');
    expect(host.state.transcriptContainer.addChild).not.toHaveBeenCalled();
  });

  it('opens a selector when multiple files changed', async () => {
    writeFileSync(join(repoDir, 'hello.txt'), 'first line\nsecond line\n', 'utf8');
    writeFileSync(join(repoDir, 'world.txt'), 'new file\n', 'utf8');
    const host = makeHost(repoDir);

    await handleDiffCommand(host, '');

    expect(host.mountEditorReplacement).toHaveBeenCalledTimes(1);
    expect(host.state.transcriptContainer.addChild).not.toHaveBeenCalled();
  });

  it('renders a diff panel for an untracked file', async () => {
    writeFileSync(join(repoDir, 'untracked.txt'), 'untracked content\n', 'utf8');
    const host = makeHost(repoDir);

    await handleDiffCommand(host, '');

    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.state.transcriptContainer.addChild).toHaveBeenCalledTimes(1);

    const panel = host.state.transcriptContainer.addChild.mock.calls[0]![0] as {
      render(width: number): string[];
    };
    const rendered = panel.render(120).join('\n');

    expect(rendered).toContain('untracked.txt');
    expect(rendered).toContain('+untracked content');
  });

  it('renders a session-edit diff when selecting it from the file list', async () => {
    const fooPath = join(repoDir, 'foo.ts');
    writeFileSync(fooPath, 'original line\n', 'utf8');
    runGit(repoDir, 'add', 'foo.ts');
    runGit(repoDir, 'commit', '--quiet', '-m', 'add foo');

    writeFileSync(fooPath, 'original line\nnew line\n', 'utf8');
    writeFileSync(join(repoDir, 'bar.ts'), 'bar content\n', 'utf8');

    const host = makeHost(repoDir, [
      userEntry('prompt', 't1'),
      editToolEntry(fooPath, 'original line\n', 'original line\nnew line\n', 't1'),
    ]);

    await handleDiffCommand(host, '');

    expect(host.mountEditorReplacement).toHaveBeenCalledTimes(1);
    const selector = host.mountEditorReplacement.mock.calls[0]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };

    const list = selector.render(80).join('\n');
    expect(list).toContain('bar.ts');
    expect(list).toContain('foo.ts');

    selector.handleInput(RIGHT_ARROW);
    const turnTab = selector.render(80).join('\n');
    expect(turnTab).toContain('foo.ts');
    expect(turnTab).not.toContain('bar.ts');

    selector.handleInput(ENTER);

    // Wait for the async diff viewer to mount and load.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(host.mountEditorReplacement).toHaveBeenCalledTimes(2);
    expect(host.showError).not.toHaveBeenCalled();
    const viewer = host.mountEditorReplacement.mock.calls[1]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    const rendered = viewer.render(120).join('\n');
    expect(rendered).toContain('foo.ts');
    expect(rendered).not.toContain('No changes.');
    expect(rendered).toMatch(/original line|new line/);
    expect(rendered).toContain('ctrl+o expand context');

    // Expand context with ctrl+o and verify the diff still renders.
    viewer.handleInput('\u000F');
    await vi.waitFor(() => {
      const expanded = viewer.render(120).join('\n');
      return expanded.includes('ctrl+o collapse context');
    });
    const expanded = viewer.render(120).join('\n');
    expect(expanded).toContain('foo.ts');
    expect(expanded).toMatch(/original line|new line/);

    // Collapse back with ctrl+o.
    viewer.handleInput('\u000F');
    await vi.waitFor(() => {
      const collapsed = viewer.render(120).join('\n');
      return collapsed.includes('ctrl+o expand context');
    });

    // Esc returns to the file list.
    viewer.handleInput('\u001B');
    expect(host.mountEditorReplacement).toHaveBeenCalledTimes(3);
  });

  it('renders a git diff when selecting a git-only file from the list', async () => {
    writeFileSync(join(repoDir, 'foo.ts'), 'original line\n', 'utf8');
    runGit(repoDir, 'add', 'foo.ts');
    runGit(repoDir, 'commit', '--quiet', '-m', 'add foo');

    writeFileSync(join(repoDir, 'foo.ts'), 'original line\nnew line\n', 'utf8');
    writeFileSync(join(repoDir, 'bar.ts'), 'bar content\n', 'utf8');

    const host = makeHost(repoDir);

    await handleDiffCommand(host, '');

    expect(host.mountEditorReplacement).toHaveBeenCalledTimes(1);
    const selector = host.mountEditorReplacement.mock.calls[0]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };

    // Move down to select bar.ts (untracked).
    selector.handleInput(DOWN_ARROW);
    selector.handleInput(ENTER);

    // Wait for the async git diff to complete.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(host.mountEditorReplacement).toHaveBeenCalledTimes(2);
    expect(host.showError).not.toHaveBeenCalled();
    const viewer = host.mountEditorReplacement.mock.calls[1]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    const rendered = viewer.render(120).join('\n');

    expect(rendered).toContain('bar.ts');
    expect(rendered).not.toContain('No changes.');
    expect(rendered).toContain('+bar content');
    expect(rendered).toContain('ctrl+o expand context');

    // Expand context with ctrl+o and verify the diff still renders.
    viewer.handleInput('\u000F');
    await vi.waitFor(() => {
      const expanded = viewer.render(120).join('\n');
      return expanded.includes('ctrl+o collapse context');
    });
    const expanded = viewer.render(120).join('\n');
    expect(expanded).toContain('bar.ts');
    expect(expanded).toContain('+bar content');

    // Collapse back with ctrl+o.
    viewer.handleInput('\u000F');
    await vi.waitFor(() => {
      const collapsed = viewer.render(120).join('\n');
      return collapsed.includes('ctrl+o expand context');
    });

    // Esc returns to the file list.
    viewer.handleInput('\u001B');
    expect(host.mountEditorReplacement).toHaveBeenCalledTimes(3);
  });

  it('renders diffs correctly when the workDir is a git subdirectory', async () => {
    writeFileSync(join(repoDir, 'foo.txt'), 'foo content\n', 'utf8');
    mkdirSync(join(repoDir, 'sub'));
    runGit(repoDir, 'add', 'foo.txt');
    runGit(repoDir, 'commit', '--quiet', '-m', 'init');

    writeFileSync(join(repoDir, 'sub', 'bar.ts'), 'bar content\n', 'utf8');

    const host = makeHost(join(repoDir, 'sub'));

    await handleDiffCommand(host, '');

    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.state.transcriptContainer.addChild).toHaveBeenCalledTimes(1);

    const panel = host.state.transcriptContainer.addChild.mock.calls[0]![0] as {
      render(width: number): string[];
    };
    const rendered = panel.render(120).join('\n');

    expect(rendered).toContain('bar.ts');
    expect(rendered).not.toContain('No changes.');
    expect(rendered).toContain('+bar content');
  });

  it('renders turn tabs for session edits grouped by turn', async () => {
    writeFileSync(join(repoDir, 'a.ts'), 'a original\n', 'utf8');
    writeFileSync(join(repoDir, 'b.ts'), 'b original\n', 'utf8');
    runGit(repoDir, 'add', 'a.ts', 'b.ts');
    runGit(repoDir, 'commit', '--quiet', '-m', 'add files');

    const aPath = join(repoDir, 'a.ts');
    const bPath = join(repoDir, 'b.ts');
    const host = makeHost(repoDir, [
      userEntry('first prompt', 't1'),
      editToolEntry(aPath, 'a original\n', 'a edited\n', 't1'),
      userEntry('second prompt', 't2'),
      editToolEntry(bPath, 'b original\n', 'b edited\n', 't2'),
    ]);

    await handleDiffCommand(host, '');

    expect(host.mountEditorReplacement).toHaveBeenCalledTimes(1);
    const selector = host.mountEditorReplacement.mock.calls[0]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };

    const rendered = selector.render(80).join('\n');
    expect(rendered).toContain('Current');
    expect(rendered).toContain('T1');
    expect(rendered).toContain('T2');
    expect(rendered).not.toContain('a.ts');
    expect(rendered).not.toContain('b.ts');

    selector.handleInput(RIGHT_ARROW);
    const t2 = selector.render(80).join('\n');
    expect(t2).toContain('b.ts');
    expect(t2).not.toContain('a.ts');

    selector.handleInput(RIGHT_ARROW);
    const t1 = selector.render(80).join('\n');
    expect(t1).toContain('a.ts');
    expect(t1).not.toContain('b.ts');
  });

  it('includes session-edited files in the Current source', async () => {
    writeFileSync(join(repoDir, 'a.ts'), 'a original\n', 'utf8');
    writeFileSync(join(repoDir, 'git-only.ts'), 'git original\n', 'utf8');
    runGit(repoDir, 'add', 'a.ts', 'git-only.ts');
    runGit(repoDir, 'commit', '--quiet', '-m', 'add files');

    writeFileSync(join(repoDir, 'git-only.ts'), 'git modified\n', 'utf8');

    const aPath = join(repoDir, 'a.ts');
    writeFileSync(aPath, 'a edited\n', 'utf8');
    const host = makeHost(repoDir, [
      userEntry('prompt', 't1'),
      editToolEntry(aPath, 'a original\n', 'a edited\n', 't1'),
    ]);

    await handleDiffCommand(host, '');

    const selector = host.mountEditorReplacement.mock.calls[0]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };

    const current = selector.render(80).join('\n');
    expect(current).toContain('git-only.ts');
    expect(current).toContain('a.ts');

    selector.handleInput(RIGHT_ARROW);
    const turnTab = selector.render(80).join('\n');
    expect(turnTab).toContain('a.ts');
    expect(turnTab).not.toContain('git-only.ts');
  });
});

describe('git diff numstat helpers', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'kimi-diff-numstat-test-'));
    runGit(repoDir, 'init', '--quiet');
    runGit(repoDir, 'config', 'user.email', 'test@example.com');
    runGit(repoDir, 'config', 'user.name', 'Test User');

    writeFileSync(join(repoDir, 'tracked.txt'), 'line1\nline2\n', 'utf8');
    runGit(repoDir, 'add', 'tracked.txt');
    runGit(repoDir, 'commit', '--quiet', '-m', 'initial');
  });

  afterEach(() => {
    execFileSync('rm', ['-rf', repoDir]);
  });

  it('returns stats for tracked modifications', async () => {
    writeFileSync(join(repoDir, 'tracked.txt'), 'line1\nline2\nline3\n', 'utf8');

    const stats = await runGitNumstat(repoDir);

    expect(stats.get('tracked.txt')).toEqual({ additions: 1, deletions: 0 });
  });

  it('returns stats for untracked files', async () => {
    writeFileSync(join(repoDir, 'untracked.txt'), 'new1\nnew2\nnew3\n', 'utf8');

    const stat = await runUntrackedNumstat(repoDir, 'untracked.txt');

    expect(stat).toEqual({ additions: 3, deletions: 0 });
  });
});
