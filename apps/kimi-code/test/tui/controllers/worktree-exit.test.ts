import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { ErrorCodes, KimiError, type WorktreeRemovalCheck } from '@moonshot-ai/kimi-code-sdk';
import type { Component, Focusable } from '@moonshot-ai/pi-tui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setExperimentalFeatures } from '#/tui/commands/experimental-flags';
import type { WorktreeRunRecord } from '#/tui/controllers/worktree-creation';
import {
  formatWorktreeExit,
  WorktreeExitController,
  worktreeHasIgnoredFiles,
  type WorktreeExitHost,
} from '#/tui/controllers/worktree-exit';
import { quoteShellArg } from '#/utils/shell-quote';

const ENTER = '\r';
const DOWN = '\u001B[B';
const ESC = '\u001B';
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';

const WORKTREE = '/home/me/.kimi-code/worktrees/wd_repo/fix-login';

function check(overrides: Partial<WorktreeRemovalCheck> = {}): WorktreeRemovalCheck {
  return {
    path: WORKTREE,
    missing: false,
    branch: undefined,
    uncommittedFiles: 0,
    uniqueCommits: 0,
    openSessionIds: [],
    closedSessionCount: 0,
    ...overrides,
  };
}

function makeHost() {
  let mounted: (Component & Focusable) | undefined;
  let onDisplaced: (() => void) | undefined;
  const createdThisRun = new Map<string, WorktreeRunRecord>();
  const backgroundTasks = new Map<string, { readonly status: 'running' | 'completed' }>();
  const events: string[] = [];
  const host = {
    harness: {
      inspectWorktreeRemoval: vi.fn(async (_input: { deleteBranch: boolean }) => check()),
      removeWorktree: vi.fn(async (_input: unknown) => {
        events.push('removeWorktree');
      }),
    },
    state: {
      appState: {
        sessionId: 'ses-1',
        environment: undefined,
        streamingPhase: 'idle' as 'idle' | 'waiting' | 'thinking' | 'composing' | 'shell',
        isCompacting: false,
        worktree: { root: WORKTREE, name: 'fix-login', repoRoot: '/repo' } as
          | { root: string; name: string; repoRoot: string }
          | undefined,
      },
    },
    worktreeCreation: { createdThisRun },
    backgroundTasks,
    hasIgnoredFiles: vi.fn(async () => false),
    hasSessionContent: vi.fn(() => true),
    mountEditorReplacement: vi.fn((panel: Component & Focusable, displaced?: () => void) => {
      mounted = panel;
      onDisplaced = displaced;
    }),
    restoreEditor: vi.fn(() => {
      mounted = undefined;
    }),
    stop: vi.fn(async () => {
      events.push('closeSession');
      await controller.finishShutdown();
      events.push('harnessClose');
    }),
  };
  const controller = new WorktreeExitController(host as unknown as WorktreeExitHost);
  const dialog = async (): Promise<{ text: string; press: (...keys: string[]) => void }> => {
    await vi.waitFor(() => {
      expect(mounted).toBeDefined();
    });
    const panel = mounted!;
    return {
      text: stripVTControlCharacters(panel.render(100).join('\n')),
      press: (...keys) => {
        for (const key of keys) panel.handleInput?.(key);
      },
    };
  };
  const untouched = (): void => {
    createdThisRun.set(WORKTREE, { name: 'fix-login', repoRoot: '/repo', setupScriptRan: false });
    host.state.appState.sessionId = '';
    host.hasSessionContent.mockReturnValue(false);
  };
  return { host, controller, dialog, untouched, events, displace: () => onDisplaced?.() };
}

describe('WorktreeExitController', () => {
  beforeEach(() => {
    vi.stubEnv('HOME', '/home/me');
    setExperimentalFeatures([{ id: 'worktree', enabled: true }]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setExperimentalFeatures([]);
  });

  it('exits right away outside a Kimi worktree', async () => {
    const { host, controller } = makeHost();
    host.state.appState.worktree = undefined;

    await controller.exit();

    expect(host.stop).toHaveBeenCalledOnce();
    expect(host.harness.inspectWorktreeRemoval).not.toHaveBeenCalled();
    expect(controller.outcome).toBeUndefined();
  });

  it('exits right away while the worktree flag is off', async () => {
    const { host, controller } = makeHost();
    setExperimentalFeatures([]);

    await controller.exit();

    expect(host.stop).toHaveBeenCalledOnce();
    expect(host.harness.inspectWorktreeRemoval).not.toHaveBeenCalled();
    expect(controller.outcome).toBeUndefined();
  });

  it('keeps a worktree another window has open, without asking', async () => {
    const { host, controller } = makeHost();
    host.harness.inspectWorktreeRemoval.mockResolvedValue(
      check({ uncommittedFiles: 2, openSessionIds: ['ses-2'] }),
    );

    await controller.exit();

    expect(host.harness.inspectWorktreeRemoval).toHaveBeenCalledWith({
      repoRoot: '/repo',
      path: WORKTREE,
      deleteBranch: false,
      excludeSessionId: 'ses-1',
    });
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.harness.removeWorktree).not.toHaveBeenCalled();
    expect(host.stop).toHaveBeenCalledOnce();
    expect(formatWorktreeExit(controller.outcome!)).toEqual([
      'Kept worktree fix-login: it is open in another Kimi Code window.',
    ]);
  });

  it('deletes an untouched worktree this run created, without asking', async () => {
    const { host, controller, untouched, events } = makeHost();
    untouched();

    await controller.exit();

    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.harness.removeWorktree).toHaveBeenCalledWith({
      repoRoot: '/repo',
      path: WORKTREE,
      excludeSessionId: undefined,
      deleteBranch: false,
      discard: { uncommittedFiles: 0, uniqueCommits: 0 },
    });
    expect(host.stop).toHaveBeenCalledOnce();
    expect(events).toEqual(['closeSession', 'removeWorktree', 'harnessClose']);
    expect(formatWorktreeExit(controller.outcome!)).toEqual(['Deleted worktree fix-login.']);
  });

  it('also deletes silently when the current session started here and is still empty', async () => {
    const { host, controller, untouched } = makeHost();
    untouched();
    host.state.appState.sessionId = 'ses-new';
    controller.noteNewSession('ses-new');

    await controller.exit();

    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.harness.removeWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ excludeSessionId: 'ses-new' }),
    );
    expect(controller.outcome).toEqual({ kind: 'deleted', name: 'fix-login', branch: undefined });
  });

  it.each([
    [
      'the setup script ran',
      (h: ReturnType<typeof makeHost>) => {
        h.host.worktreeCreation.createdThisRun.set(WORKTREE, {
          name: 'fix-login',
          repoRoot: '/repo',
          setupScriptRan: true,
        });
      },
    ],
    [
      'an earlier run created it',
      (h: ReturnType<typeof makeHost>) => {
        h.host.worktreeCreation.createdThisRun.clear();
      },
    ],
    [
      'the session was resumed or brought in',
      (h: ReturnType<typeof makeHost>) => {
        h.host.state.appState.sessionId = 'ses-resumed';
      },
    ],
    [
      'a message was sent',
      (h: ReturnType<typeof makeHost>) => {
        h.host.hasSessionContent.mockReturnValue(true);
      },
    ],
    [
      'a file changed',
      (h: ReturnType<typeof makeHost>) => {
        h.host.harness.inspectWorktreeRemoval.mockResolvedValue(check({ uncommittedFiles: 1 }));
      },
    ],
    [
      'a commit exists only here',
      (h: ReturnType<typeof makeHost>) => {
        h.host.harness.inspectWorktreeRemoval.mockResolvedValue(check({ uniqueCommits: 1 }));
      },
    ],
    [
      'a branch is checked out',
      (h: ReturnType<typeof makeHost>) => {
        h.host.harness.inspectWorktreeRemoval.mockResolvedValue(check({ branch: 'feat' }));
      },
    ],
    [
      'an earlier session worked here',
      (h: ReturnType<typeof makeHost>) => {
        h.host.harness.inspectWorktreeRemoval.mockResolvedValue(check({ closedSessionCount: 1 }));
      },
    ],
    [
      'an ignored file exists in the worktree',
      (h: ReturnType<typeof makeHost>) => {
        h.host.hasIgnoredFiles.mockResolvedValue(true);
      },
    ],
    [
      'an initialized submodule exists in the worktree',
      (h: ReturnType<typeof makeHost>) => {
        h.host.harness.inspectWorktreeRemoval.mockResolvedValue(check({ hasSubmodules: true }));
      },
    ],
    [
      'the worktree is locked',
      (h: ReturnType<typeof makeHost>) => {
        h.host.harness.inspectWorktreeRemoval.mockResolvedValue(check({ locked: true }));
      },
    ],
    [
      'a background task is still running',
      (h: ReturnType<typeof makeHost>) => {
        h.host.backgroundTasks.set('task-1', { status: 'running' });
      },
    ],
    [
      'a foreground turn is still running',
      (h: ReturnType<typeof makeHost>) => {
        h.host.state.appState.streamingPhase = 'thinking';
      },
    ],
  ])('asks instead of deleting when %s', async (_case, vary) => {
    const harness = makeHost();
    harness.untouched();
    vary(harness);

    const exiting = harness.controller.exit();
    const { text } = await harness.dialog();

    expect(text).toContain('Leaving worktree fix-login');
    expect(harness.host.harness.removeWorktree).not.toHaveBeenCalled();
    expect(harness.host.stop).not.toHaveBeenCalled();
    harness.displace();
    await exiting;
  });

  it('reports the error and exits when the silent delete fails after shutdown', async () => {
    const { host, controller, untouched, events } = makeHost();
    untouched();
    host.harness.removeWorktree.mockRejectedValueOnce(
      new KimiError(ErrorCodes.WORKTREE_GIT_FAILED, 'Could not remove the worktree.'),
    );

    await controller.exit();

    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.stop).toHaveBeenCalledOnce();
    expect(events).toEqual(['closeSession', 'harnessClose']);
    expect(controller.outcome?.kind).toBe('delete-failed');
    expect(formatWorktreeExit(controller.outcome!)).toEqual([
      "Couldn't delete worktree fix-login (~/.kimi-code/worktrees/wd_repo/fix-login): Could not remove the worktree.",
    ]);
  });

  it('keeps the worktree by default and says how to save its commits', async () => {
    const { host, controller, dialog } = makeHost();
    host.harness.inspectWorktreeRemoval.mockResolvedValue(
      check({ uncommittedFiles: 3, uniqueCommits: 2 }),
    );

    const exiting = controller.exit();
    const { text, press } = await dialog();
    expect(text).toContain('↑↓ navigate · Enter select · Esc stay · Ctrl+C keep and exit');
    expect(text).toContain('3 uncommitted files will be lost.');
    expect(text).toContain('2 commits exist only in this worktree.');
    expect(text).toMatch(/❯ Keep it\n\s+Delete worktree\n\s+Discards 3 files and 2 commits/);
    expect(text).not.toContain('Delete worktree and branch');
    press(ENTER);
    await exiting;

    expect(host.harness.removeWorktree).not.toHaveBeenCalled();
    expect(host.stop).toHaveBeenCalledOnce();
    expect(formatWorktreeExit(controller.outcome!)).toEqual([
      'Kept worktree fix-login at ~/.kimi-code/worktrees/wd_repo/fix-login (detached HEAD).',
      '2 commits exist only in this worktree. To keep them on a branch:',
      `  git -C ${quoteShellArg(WORKTREE)} switch -c <branch-name>`,
    ]);
  });

  it('shell-quotes the full path in the retained-worktree git command when home has spaces or quotes', () => {
    vi.stubEnv('HOME', "/Users/Example User's");
    const spacedPath = "/Users/Example User's/.kimi-code/worktrees/wd_repo/fix-login";
    expect(
      formatWorktreeExit({
        kind: 'kept',
        name: 'fix-login',
        path: spacedPath,
        branch: undefined,
        uniqueCommits: 1,
      }),
    ).toEqual([
      'Kept worktree fix-login at ~/.kimi-code/worktrees/wd_repo/fix-login (detached HEAD).',
      '1 commit exists only in this worktree. To keep it on a branch:',
      `  git -C ${quoteShellArg(spacedPath)} switch -c <branch-name>`,
    ]);
  });

  it.each([
    ['Ctrl+C', CTRL_C],
    ['Ctrl+D', CTRL_D],
  ])('keeps the worktree and exits on %s in the dialog', async (_key, key) => {
    const { host, controller, dialog } = makeHost();
    host.harness.inspectWorktreeRemoval.mockResolvedValue(check({ uncommittedFiles: 1 }));

    const exiting = controller.exit();
    (await dialog()).press(DOWN, key);
    await exiting;

    expect(host.harness.removeWorktree).not.toHaveBeenCalled();
    expect(host.stop).toHaveBeenCalledOnce();
    expect(controller.outcome?.kind).toBe('kept');
  });

  it('cancels the exit on Esc and asks again on the next exit', async () => {
    const { host, controller, dialog } = makeHost();

    const first = controller.exit();
    (await dialog()).press('x', ESC);
    await first;

    expect(host.restoreEditor).toHaveBeenCalledOnce();
    expect(host.stop).not.toHaveBeenCalled();
    expect(controller.outcome).toBeUndefined();

    const second = controller.exit();
    (await dialog()).press(ENTER);
    await second;
    expect(host.stop).toHaveBeenCalledOnce();
  });

  it('deletes the worktree and its branch with the discards the dialog showed', async () => {
    const { host, controller, dialog, events } = makeHost();
    host.harness.inspectWorktreeRemoval.mockImplementation(async ({ deleteBranch }) =>
      check({ branch: 'feat', uncommittedFiles: 1, uniqueCommits: deleteBranch ? 2 : 0 }),
    );

    const exiting = controller.exit();
    const { text, press } = await dialog();
    expect(text).toContain('2 commits exist only on branch feat.');
    expect(text).toMatch(/Delete worktree\n\s+Discards 1 file\n/);
    expect(text).toMatch(/Delete worktree and branch feat\n\s+Discards 1 file and 2 commits/);
    press(DOWN, DOWN, ENTER);
    await exiting;

    expect(host.harness.removeWorktree).toHaveBeenCalledWith({
      repoRoot: '/repo',
      path: WORKTREE,
      excludeSessionId: 'ses-1',
      deleteBranch: true,
      discard: { uncommittedFiles: 1, uniqueCommits: 2 },
    });
    expect(events).toEqual(['closeSession', 'removeWorktree', 'harnessClose']);
    expect(formatWorktreeExit(controller.outcome!)).toEqual([
      'Deleted worktree fix-login and branch feat.',
    ]);
  });

  it('warns about running session work in the dialog and closes the session before deleting', async () => {
    const { host, controller, dialog, events } = makeHost();
    host.state.appState.streamingPhase = 'thinking';
    host.backgroundTasks.set('task-1', { status: 'running' });
    host.backgroundTasks.set('task-2', { status: 'completed' });

    const exiting = controller.exit();
    const { text, press } = await dialog();
    expect(text).toContain('Work is still running in this session and will be stopped.');
    expect(text).toContain('1 background task is still running and will be stopped.');
    press(DOWN, ENTER);
    await exiting;

    expect(events).toEqual(['closeSession', 'removeWorktree', 'harnessClose']);
    expect(controller.outcome).toEqual({ kind: 'deleted', name: 'fix-login', branch: undefined });
  });

  it('reports the error and exits when deleting after shutdown fails', async () => {
    const { host, controller, dialog, events } = makeHost();
    host.harness.inspectWorktreeRemoval.mockResolvedValue(check({ branch: 'feat' }));
    host.harness.removeWorktree.mockRejectedValueOnce(
      new KimiError(ErrorCodes.WORKTREE_GIT_FAILED, 'Could not delete branch feat.'),
    );

    const exiting = controller.exit();
    (await dialog()).press(DOWN, DOWN, ENTER);
    await exiting;

    expect(host.stop).toHaveBeenCalledOnce();
    expect(events).toEqual(['closeSession', 'harnessClose']);
    expect(controller.outcome?.kind).toBe('delete-failed');
    expect(formatWorktreeExit(controller.outcome!)).toEqual([
      "Couldn't delete worktree fix-login and branch feat (~/.kimi-code/worktrees/wd_repo/fix-login): Could not delete branch feat.",
    ]);
  });

  it('only executes a pending shutdown delete once', async () => {
    const { host, controller, untouched } = makeHost();
    untouched();

    await controller.exit();
    await controller.finishShutdown();

    expect(host.harness.removeWorktree).toHaveBeenCalledOnce();
  });

  it('exits and leaves the worktree alone when it cannot be checked', async () => {
    const { host, controller } = makeHost();
    host.harness.inspectWorktreeRemoval.mockRejectedValue(
      new KimiError(ErrorCodes.WORKTREE_NOT_FOUND, `No Kimi worktree at ${WORKTREE}.`),
    );

    await controller.exit();

    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.harness.removeWorktree).not.toHaveBeenCalled();
    expect(host.stop).toHaveBeenCalledOnce();
    expect(formatWorktreeExit(controller.outcome!)).toEqual([
      `Couldn't check worktree fix-login, so it was left as it is: No Kimi worktree at ${WORKTREE}.`,
    ]);
  });

  describe('worktreeHasIgnoredFiles', () => {
    it('detects ignored files and fails safe outside a git repository', async () => {
      const repo = mkdtempSync(join(tmpdir(), 'kimi-exit-ignored-repo-'));
      const nonGit = mkdtempSync(join(tmpdir(), 'kimi-exit-nongit-'));
      try {
        execFileSync('git', ['init', '-q'], { cwd: repo });
        writeFileSync(join(repo, '.gitignore'), '.env\n');
        execFileSync('git', ['add', '.gitignore'], { cwd: repo });
        execFileSync(
          'git',
          ['-c', 'user.name=test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'init'],
          { cwd: repo },
        );

        await expect(worktreeHasIgnoredFiles(repo)).resolves.toBe(false);

        writeFileSync(join(repo, '.env'), 'SECRET=1\n');
        await expect(worktreeHasIgnoredFiles(repo)).resolves.toBe(true);
        await expect(worktreeHasIgnoredFiles(nonGit)).resolves.toBe(true);
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(nonGit, { recursive: true, force: true });
      }
    });
  });
});
