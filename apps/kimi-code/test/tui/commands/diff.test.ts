import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleDiffCommand } from '#/tui/commands/diff';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import {
  isInsideGitRepo,
  listChangedFiles,
  runGitDiffForFile,
  runGitNumstat,
  runUntrackedNumstat,
} from '#/utils/git/git-diff';

vi.mock('#/utils/git/git-diff', () => ({
  isInsideGitRepo: vi.fn(),
  listChangedFiles: vi.fn(),
  runGitDiffForFile: vi.fn(),
  runGitNumstat: vi.fn(),
  runUntrackedNumstat: vi.fn(),
}));

function makeHost(
  workDir: string,
  transcriptEntries: unknown[] = [],
  transcriptChildren: unknown[] = [],
) {
  const state = {
    appState: { workDir },
    transcriptEntries,
    transcriptContainer: { addChild: vi.fn(), children: transcriptChildren },
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

const mockedIsInsideGitRepo = vi.mocked(isInsideGitRepo);
const mockedListChangedFiles = vi.mocked(listChangedFiles);
const mockedRunGitDiffForFile = vi.mocked(runGitDiffForFile);
const mockedRunGitNumstat = vi.mocked(runGitNumstat);
const mockedRunUntrackedNumstat = vi.mocked(runUntrackedNumstat);

const RIGHT_ARROW = '\u001B[C';
const LEFT_ARROW = '\u001B[D';
const DOWN_ARROW = '\u001B[B';
const ENTER = '\r';

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

describe('handleDiffCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRunGitNumstat.mockResolvedValue(new Map());
    mockedRunUntrackedNumstat.mockResolvedValue({ additions: 0, deletions: 0 });
  });

  it('shows session edits when the workspace is not a git repository', async () => {
    mockedIsInsideGitRepo.mockReturnValue(false);
    const host = makeHost('/not-a-repo', [
      userEntry('prompt', 't1'),
      editToolEntry('a.ts', 'old', 'new', 't1'),
    ]);

    await handleDiffCommand(host, '');

    expect(mockedListChangedFiles).not.toHaveBeenCalled();
    expect(host.mountEditorReplacement).toHaveBeenCalled();
    const selector = host.mountEditorReplacement.mock.calls[0]![0] as {
      render(width: number): string[];
      handleInput(data: string): void;
    };
    selector.handleInput(RIGHT_ARROW); // switch to T1
    const rendered = selector.render(80).join('\n');
    expect(rendered).toContain('T1');
    expect(rendered).toContain('a.ts');
  });

  it('shows a status message when there are no changed files and no git repo', async () => {
    mockedIsInsideGitRepo.mockReturnValue(false);
    const host = makeHost('/not-a-repo');

    await handleDiffCommand(host, '');

    expect(mockedListChangedFiles).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('No changed files.');
  });

  it('shows a status message when there are no changed files', async () => {
    mockedIsInsideGitRepo.mockReturnValue(true);
    mockedListChangedFiles.mockResolvedValue([]);
    const host = makeHost('/repo');

    await handleDiffCommand(host, '');

    expect(host.showStatus).toHaveBeenCalledWith('No changed files.');
    expect(host.state.transcriptContainer.addChild).not.toHaveBeenCalled();
  });

  it('opens a selector with a turn tab when only one session file was edited', async () => {
    mockedIsInsideGitRepo.mockReturnValue(true);
    mockedListChangedFiles.mockResolvedValue([]);
    const host = makeHost('/repo', [
      userEntry('prompt', 't1'),
      editToolEntry('foo.ts', 'old', 'new', 't1'),
    ]);

    await handleDiffCommand(host, '');

    expect(host.mountEditorReplacement).toHaveBeenCalledTimes(1);
    const selector = host.mountEditorReplacement.mock.calls[0]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    selector.handleInput(RIGHT_ARROW);
    const rendered = selector.render(80).join('\n');
    expect(rendered).toContain('foo.ts');
    expect(mockedRunGitDiffForFile).not.toHaveBeenCalled();
  });

  it('opens a selector with Current and turn tabs', async () => {
    mockedIsInsideGitRepo.mockReturnValue(true);
    mockedListChangedFiles.mockResolvedValue([
      { path: 'git-only.ts', status: 'modified' },
    ]);
    const host = makeHost('/repo', [
      userEntry('prompt', 't1'),
      editToolEntry('session.ts', 'a', 'b', 't1'),
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
    expect(rendered).toContain('git-only.ts');
    expect(rendered).not.toContain('session.ts');

    selector.handleInput(RIGHT_ARROW);
    const turnTab = selector.render(80).join('\n');
    expect(turnTab).toContain('session.ts');
    expect(turnTab).not.toContain('git-only.ts');
  });

  it('renders session edit diff content when selecting a session file', async () => {
    mockedIsInsideGitRepo.mockReturnValue(true);
    mockedListChangedFiles.mockResolvedValue([
      { path: 'git-only.ts', status: 'modified' },
    ]);
    const host = makeHost('/repo', [
      userEntry('prompt', 't1'),
      editToolEntry('session.ts', 'old content', 'new content', 't1'),
    ]);

    await handleDiffCommand(host, '');

    expect(host.mountEditorReplacement).toHaveBeenCalledTimes(1);
    const selector = host.mountEditorReplacement.mock.calls[0]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    selector.handleInput(RIGHT_ARROW);
    selector.handleInput(ENTER);

    // showDiffViewer is async; wait for the viewer to finish loading.
    await vi.waitFor(() => expect(host.mountEditorReplacement).toHaveBeenCalledTimes(2));
    const viewer = host.mountEditorReplacement.mock.calls[1]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    await vi.waitFor(() => {
      const rendered = viewer.render(120).join('\n');
      return !rendered.includes('Loading diff');
    });
    const rendered = viewer.render(120).join('\n');
    expect(rendered).toContain('session.ts');
    expect(rendered).not.toContain('No changes.');
    expect(rendered).toMatch(/old content|new content/);
    expect(rendered).toContain('ctrl+o expand context');

    // Expand context with ctrl+o.
    viewer.handleInput('\u000F');
    await vi.waitFor(() => {
      const expanded = viewer.render(120).join('\n');
      return expanded.includes('ctrl+o collapse context');
    });

    // Collapse back with ctrl+o.
    viewer.handleInput('\u000F');
    await vi.waitFor(() => {
      const collapsed = viewer.render(120).join('\n');
      return collapsed.includes('ctrl+o expand context');
    });
  });

  it('uses git status as fallback for files not edited by tool calls', async () => {
    mockedIsInsideGitRepo.mockReturnValue(true);
    mockedListChangedFiles.mockResolvedValue([
      { path: 'bash-edited.ts', status: 'modified' },
    ]);
    mockedRunGitDiffForFile.mockResolvedValue('diff --git a/bash-edited.ts b/bash-edited.ts\n+change');
    const host = makeHost('/repo');

    await handleDiffCommand(host, '');

    expect(mockedRunGitDiffForFile).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ path: 'bash-edited.ts' }),
      expect.any(Number),
    );
    expect(host.state.transcriptContainer.addChild).toHaveBeenCalledTimes(1);
  });

  it('prefers session edits over git status for the same file', async () => {
    mockedIsInsideGitRepo.mockReturnValue(true);
    mockedListChangedFiles.mockResolvedValue([
      { path: 'foo.ts', status: 'modified' },
    ]);
    const host = makeHost('/repo', [
      userEntry('prompt', 't1'),
      editToolEntry('foo.ts', 'old', 'new', 't1'),
    ]);

    await handleDiffCommand(host, '');

    expect(host.mountEditorReplacement).toHaveBeenCalledTimes(1);
    expect(mockedRunGitDiffForFile).not.toHaveBeenCalled();
    const selector = host.mountEditorReplacement.mock.calls[0]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    selector.handleInput(RIGHT_ARROW);
    const rendered = selector.render(80).join('\n');
    expect(rendered).toContain('foo.ts');
    expect(rendered).not.toContain('git');
  });

  it('collects session edits from transcript ToolCallComponents when entries lack tool_call data', async () => {
    mockedIsInsideGitRepo.mockReturnValue(true);
    mockedListChangedFiles.mockResolvedValue([
      { path: 'foo.ts', status: 'modified' },
    ]);
    const component = new ToolCallComponent(
      {
        id: 'tc-1',
        name: 'Edit',
        args: {},
        display: {
          kind: 'file_io',
          operation: 'edit',
          path: 'foo.ts',
          before: 'old content',
          after: 'new content',
        },
      },
      undefined,
    );
    const host = makeHost('/repo', [], [component]);

    await handleDiffCommand(host, '');

    expect(host.mountEditorReplacement).toHaveBeenCalledTimes(1);
    const selector = host.mountEditorReplacement.mock.calls[0]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    // Components without a turnId land in the unnamed turn tab.
    selector.handleInput(RIGHT_ARROW);
    selector.handleInput(ENTER);

    await vi.waitFor(() => expect(host.mountEditorReplacement).toHaveBeenCalledTimes(2));
    expect(mockedRunGitDiffForFile).not.toHaveBeenCalled();
  });

  it('shows an error when git status fails', async () => {
    mockedIsInsideGitRepo.mockReturnValue(true);
    mockedListChangedFiles.mockRejectedValue(new Error('git crashed'));
    const host = makeHost('/repo');

    await handleDiffCommand(host, '');

    expect(host.showError).toHaveBeenCalledWith('git crashed');
  });

  it('groups session edits into turn tabs', async () => {
    mockedIsInsideGitRepo.mockReturnValue(true);
    mockedListChangedFiles.mockResolvedValue([]);
    const host = makeHost('/repo', [
      userEntry('first prompt', 't1'),
      editToolEntry('a.ts', 'old', 'new', 't1'),
      userEntry('second prompt', 't2'),
      editToolEntry('b.ts', 'x', 'y', 't2'),
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
    // Default active source is Current, which has no files here.
    expect(rendered).not.toContain('a.ts');
    expect(rendered).not.toContain('b.ts');

    // Turn sources are sorted newest-first, so the first turn tab is T2.
    selector.handleInput(RIGHT_ARROW);
    const newest = selector.render(80).join('\n');
    expect(newest).toContain('b.ts');
    expect(newest).not.toContain('a.ts');

    selector.handleInput(RIGHT_ARROW);
    const older = selector.render(80).join('\n');
    expect(older).toContain('a.ts');
    expect(older).not.toContain('b.ts');
  });

  it('switches turn tabs with left/right arrows', async () => {
    mockedIsInsideGitRepo.mockReturnValue(true);
    mockedListChangedFiles.mockResolvedValue([]);
    const host = makeHost('/repo', [
      userEntry('first prompt', 't1'),
      editToolEntry('a.ts', 'old', 'new', 't1'),
      userEntry('second prompt', 't2'),
      editToolEntry('b.ts', 'x', 'y', 't2'),
    ]);

    await handleDiffCommand(host, '');

    const selector = host.mountEditorReplacement.mock.calls[0]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    selector.handleInput(RIGHT_ARROW);
    expect(selector.render(80).join('\n')).toContain('b.ts');

    selector.handleInput(RIGHT_ARROW);
    expect(selector.render(80).join('\n')).toContain('a.ts');

    selector.handleInput(LEFT_ARROW);
    expect(selector.render(80).join('\n')).toContain('b.ts');
  });

  it('includes session-edited files in the Current source', async () => {
    mockedIsInsideGitRepo.mockReturnValue(true);
    mockedListChangedFiles.mockResolvedValue([
      { path: 'a.ts', status: 'modified' },
      { path: 'git-only.ts', status: 'modified' },
    ]);
    mockedRunGitNumstat.mockResolvedValue(
      new Map([
        ['a.ts', { additions: 1, deletions: 1 }],
        ['git-only.ts', { additions: 1, deletions: 0 }],
      ]),
    );
    const host = makeHost('/repo', [
      userEntry('prompt', 't1'),
      editToolEntry('a.ts', 'old', 'new', 't1'),
    ]);

    await handleDiffCommand(host, '');

    const selector = host.mountEditorReplacement.mock.calls[0]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    const current = selector.render(80).join('\n');
    expect(current).toContain('Current');
    expect(current).toContain('git-only.ts');
    expect(current).toContain('a.ts');

    selector.handleInput(RIGHT_ARROW);
    const turnTab = selector.render(80).join('\n');
    expect(turnTab).toContain('a.ts');
    expect(turnTab).not.toContain('git-only.ts');
  });

  it('shows the correct file for each turn source', async () => {
    mockedIsInsideGitRepo.mockReturnValue(true);
    mockedListChangedFiles.mockResolvedValue([]);
    const host = makeHost('/repo', [
      userEntry('first prompt', 't1'),
      editToolEntry('a.ts', 'old', 'new', 't1'),
      userEntry('second prompt', 't2'),
      editToolEntry('b.ts', 'x', 'y', 't2'),
    ]);

    await handleDiffCommand(host, '');

    const selector = host.mountEditorReplacement.mock.calls[0]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    // Default active source is Current; turn sources are sorted newest-first.
    selector.handleInput(RIGHT_ARROW);
    expect(selector.render(80).join('\n')).toContain('b.ts');

    selector.handleInput(RIGHT_ARROW);
    expect(selector.render(80).join('\n')).toContain('a.ts');
  });

  it('renders turn subtitles from user message content', async () => {
    mockedIsInsideGitRepo.mockReturnValue(true);
    mockedListChangedFiles.mockResolvedValue([]);
    const host = makeHost('/repo', [
      userEntry('hello world this is a long prompt that will be truncated', 't1'),
      editToolEntry('a.ts', 'old', 'new', 't1'),
    ]);

    await handleDiffCommand(host, '');

    const selector = host.mountEditorReplacement.mock.calls[0]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    selector.handleInput(RIGHT_ARROW);
    const rendered = selector.render(80).join('\n');
    expect(rendered).toContain('Turn 1');
    expect(rendered).toContain('hello world this is a long prompt that w...');
  });

  it('shows only the edits from the selected turn when a file was edited in multiple turns', async () => {
    mockedIsInsideGitRepo.mockReturnValue(true);
    mockedListChangedFiles.mockResolvedValue([]);
    const host = makeHost('/repo', [
      userEntry('first', 't1'),
      editToolEntry('foo.ts', 'line1\n', 'line1\nline2\n', 't1'),
      userEntry('second', 't2'),
      editToolEntry('foo.ts', 'line1\nline2\n', 'line1\nline2\nline3\n', 't2'),
    ]);

    await handleDiffCommand(host, '');

    const selector = host.mountEditorReplacement.mock.calls[0]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };

    // Turn sources are sorted newest-first, so first RIGHT_ARROW lands on T2.
    selector.handleInput(RIGHT_ARROW);
    selector.handleInput(ENTER);

    await vi.waitFor(() => expect(host.mountEditorReplacement).toHaveBeenCalledTimes(2));
    const viewerT2 = host.mountEditorReplacement.mock.calls[1]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    const t2Rendered = viewerT2.render(120).join('\n');
    expect(t2Rendered).toContain('+ line3');
    expect(t2Rendered).not.toContain('+ line2');

    // Go back and switch to T1.
    viewerT2.handleInput('\u001B');
    expect(host.mountEditorReplacement).toHaveBeenCalledTimes(3);
    const selectorAgain = host.mountEditorReplacement.mock.calls[2]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    selectorAgain.handleInput(RIGHT_ARROW);
    selectorAgain.handleInput(RIGHT_ARROW);
    selectorAgain.handleInput(ENTER);

    await vi.waitFor(() => expect(host.mountEditorReplacement).toHaveBeenCalledTimes(4));
    const viewerT1 = host.mountEditorReplacement.mock.calls[3]![0] as {
      render(width: number): string[];
    };
    const t1Rendered = viewerT1.render(120).join('\n');
    expect(t1Rendered).toContain('+ line2');
    expect(t1Rendered).not.toContain('+ line3');
  });

  it('returns to the same turn tab after exiting the file diff viewer', async () => {
    mockedIsInsideGitRepo.mockReturnValue(true);
    mockedListChangedFiles.mockResolvedValue([]);
    const host = makeHost('/repo', [
      userEntry('first prompt', 't1'),
      editToolEntry('a.ts', 'old', 'new', 't1'),
      userEntry('second prompt', 't2'),
      editToolEntry('b.ts', 'x', 'y', 't2'),
    ]);

    await handleDiffCommand(host, '');

    const selector = host.mountEditorReplacement.mock.calls[0]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };

    // Turn sources are sorted newest-first: first RIGHT_ARROW lands on T2.
    selector.handleInput(RIGHT_ARROW);
    selector.handleInput(ENTER);

    await vi.waitFor(() => expect(host.mountEditorReplacement).toHaveBeenCalledTimes(2));
    const viewer = host.mountEditorReplacement.mock.calls[1]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };

    // Exit the viewer with Esc; the selector should remount on T2.
    viewer.handleInput('\u001B');
    await vi.waitFor(() => expect(host.mountEditorReplacement).toHaveBeenCalledTimes(3));
    const selectorAgain = host.mountEditorReplacement.mock.calls[2]![0] as {
      render(width: number): string[];
    };
    const rendered = selectorAgain.render(80).join('\n');
    expect(rendered).toContain('b.ts');
    expect(rendered).not.toContain('a.ts');
  });

  it('returns to the same selected file after exiting the file diff viewer', async () => {
    mockedIsInsideGitRepo.mockReturnValue(true);
    mockedListChangedFiles.mockResolvedValue([]);
    const host = makeHost('/repo', [
      userEntry('prompt', 't1'),
      editToolEntry('a.ts', 'old-a', 'new-a', 't1'),
      editToolEntry('b.ts', 'old-b', 'new-b', 't1'),
    ]);

    await handleDiffCommand(host, '');

    const selector = host.mountEditorReplacement.mock.calls[0]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };

    // Move to T1 and select the second file (b.ts).
    selector.handleInput(RIGHT_ARROW);
    selector.handleInput(DOWN_ARROW);
    selector.handleInput(ENTER);

    await vi.waitFor(() => expect(host.mountEditorReplacement).toHaveBeenCalledTimes(2));
    const viewer = host.mountEditorReplacement.mock.calls[1]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };

    // Exit the viewer with Esc; the selector should remount with b.ts still selected.
    viewer.handleInput('\u001B');
    await vi.waitFor(() => expect(host.mountEditorReplacement).toHaveBeenCalledTimes(3));
    const selectorAgain = host.mountEditorReplacement.mock.calls[2]![0] as {
      render(width: number): string[];
    };
    const rendered = selectorAgain.render(80).join('\n');
    expect(rendered).toContain('❯ M b.ts');
    expect(rendered).not.toContain('❯ M a.ts');
  });

  it('shows per-file addition and deletion counts', async () => {
    mockedIsInsideGitRepo.mockReturnValue(true);
    mockedListChangedFiles.mockResolvedValue([
      { path: 'git-only.ts', status: 'modified' },
      { path: 'another.ts', status: 'untracked' },
    ]);
    mockedRunGitNumstat.mockResolvedValue(
      new Map([['git-only.ts', { additions: 3, deletions: 2 }]]),
    );
    mockedRunUntrackedNumstat.mockResolvedValue({ additions: 5, deletions: 0 });
    const host = makeHost('/repo');

    await handleDiffCommand(host, '');

    const selector = host.mountEditorReplacement.mock.calls[0]![0] as {
      render(width: number): string[];
    };
    const rendered = selector.render(80).join('\n');
    expect(rendered).toContain('+3');
    expect(rendered).toContain('-2');
    expect(rendered).toContain('+5');
    expect(rendered).toContain('git-only.ts');
  });

  it('renders turn subtitle with the correct 1-based turn number', async () => {
    mockedIsInsideGitRepo.mockReturnValue(true);
    mockedListChangedFiles.mockResolvedValue([]);
    const host = makeHost('/repo', [
      userEntry('hello world this is a prompt', 't1'),
      editToolEntry('a.ts', 'old', 'new', 't1'),
    ]);

    await handleDiffCommand(host, '');

    const selector = host.mountEditorReplacement.mock.calls[0]![0] as {
      handleInput(data: string): void;
      render(width: number): string[];
    };
    selector.handleInput(RIGHT_ARROW);
    const rendered = selector.render(80).join('\n');
    expect(rendered).toContain('Turn 1');
    expect(rendered).not.toContain('Turn 0');
  });

  it('shows session-edited files in the Current source when they are also git changes', async () => {
    mockedIsInsideGitRepo.mockReturnValue(true);
    mockedListChangedFiles.mockResolvedValue([
      { path: 'a.ts', status: 'modified' },
    ]);
    mockedRunGitNumstat.mockResolvedValue(
      new Map([['a.ts', { additions: 1, deletions: 1 }]]),
    );
    const host = makeHost('/repo', [
      userEntry('prompt', 't1'),
      editToolEntry('a.ts', 'old', 'new', 't1'),
    ]);

    await handleDiffCommand(host, '');

    const selector = host.mountEditorReplacement.mock.calls[0]![0] as {
      render(width: number): string[];
    };
    const rendered = selector.render(80).join('\n');
    expect(rendered).toContain('a.ts');
  });

  it('filters out git statuses that cannot be rendered', async () => {
    mockedIsInsideGitRepo.mockReturnValue(true);
    mockedListChangedFiles.mockResolvedValue([
      { path: 'git-only.ts', status: 'modified' },
      { path: 'another.ts', status: 'modified' },
      { path: 'ignored.ts', status: 'ignored' },
    ]);
    const host = makeHost('/repo');

    await handleDiffCommand(host, '');

    const selector = host.mountEditorReplacement.mock.calls[0]![0] as {
      render(width: number): string[];
    };
    const rendered = selector.render(80).join('\n');
    expect(rendered).toContain('git-only.ts');
    expect(rendered).toContain('another.ts');
    expect(rendered).not.toContain('ignored.ts');
  });

  it('falls back to line counts for large session edits to avoid full LCS', async () => {
    mockedIsInsideGitRepo.mockReturnValue(true);
    mockedListChangedFiles.mockResolvedValue([]);
    mockedRunGitNumstat.mockResolvedValue(new Map());

    const largeBefore = Array.from({ length: 1200 }, (_, i) => `before ${i}`).join('\n');
    const largeAfter = Array.from({ length: 1500 }, (_, i) => `after ${i}`).join('\n');

    const host = makeHost('/repo', [
      userEntry('prompt', 't1'),
      editToolEntry('a.ts', largeBefore, largeAfter, 't1'),
    ]);

    await handleDiffCommand(host, '');

    const selector = host.mountEditorReplacement.mock.calls[0]![0] as {
      render(width: number): string[];
      handleInput(data: string): void;
    };
    selector.handleInput(RIGHT_ARROW); // switch to T1
    const rendered = selector.render(80).join('\n');
    expect(rendered).toContain('+1500');
    expect(rendered).toContain('-1200');
  });
});
