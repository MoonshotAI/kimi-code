import { stripVTControlCharacters } from 'node:util';

import {
  ErrorCodes,
  KimiError,
  type CreatedWorktree,
  type WorktreeCreateEvent,
} from '@moonshot-ai/kimi-code-sdk';
import type { Component, Focusable } from '@moonshot-ai/pi-tui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WorktreeCreationController,
  type WorktreeCreationHost,
} from '#/tui/controllers/worktree-creation';

const ENTER = '\r';
const ESC = '\u001B';

const WORKTREE_PATH = '/home/me/.kimi-code/worktrees/wd_repo/fix-login';
const HEAD = 'abcdef1234567890';

function createdWorktree(overrides: Partial<CreatedWorktree> = {}): CreatedWorktree {
  return {
    worktree: { path: WORKTREE_PATH, name: 'fix-login', head: HEAD, branch: undefined, missing: false, managed: true },
    repoRoot: '/repo',
    sourceRoot: '/repo',
    cwd: WORKTREE_PATH,
    cwdFallback: false,
    copiedFiles: [],
    sourceDirty: false,
    ...overrides,
  };
}

type CreateOptions = { signal?: AbortSignal; onEvent?: (event: WorktreeCreateEvent) => void };

function emitUntil(
  onEvent: ((event: WorktreeCreateEvent) => void) | undefined,
  last: 'check' | 'add' | 'all',
): void {
  onEvent?.({ type: 'step', step: 'check', status: 'started' });
  if (last === 'check') return;
  onEvent?.({ type: 'step', step: 'check', status: 'finished' });
  onEvent?.({ type: 'planned', name: 'fix-login', path: WORKTREE_PATH, head: HEAD });
  onEvent?.({ type: 'step', step: 'add', status: 'started' });
  if (last === 'add') return;
  onEvent?.({ type: 'step', step: 'add', status: 'finished' });
  onEvent?.({ type: 'step', step: 'include', status: 'started' });
  onEvent?.({ type: 'step', step: 'include', status: 'finished' });
}

function succeed(created = createdWorktree()) {
  return async (_input: unknown, options: CreateOptions = {}) => {
    emitUntil(options.onEvent, 'all');
    return created;
  };
}

function makeHost() {
  const transcript: Component[] = [];
  let mounted: (Component & Focusable) | undefined;
  const host = {
    harness: {
      createWorktree: vi.fn(succeed()),
    },
    state: {
      appState: { workDir: '/repo' },
      transcriptContainer: {
        children: transcript,
        addChild: (component: Component) => transcript.push(component),
        removeChild: (component: Component) => transcript.splice(transcript.indexOf(component), 1),
      },
      ui: { requestRender: vi.fn() },
    },
    mountEditorReplacement: vi.fn((panel: Component & Focusable) => {
      mounted = panel;
    }),
    restoreEditor: vi.fn(() => {
      mounted = undefined;
    }),
    applyWorkLocation: vi.fn(async () => {}),
    showError: vi.fn(),
    exitWithError: vi.fn(),
  };
  const controller = new WorktreeCreationController(host as unknown as WorktreeCreationHost);
  const text = (): string =>
    stripVTControlCharacters(transcript.map((component) => component.render(120).join('\n')).join('\n'));
  const picker = async (title: string): Promise<Component & Focusable> => {
    await vi.waitFor(() => {
      expect(mounted).toBeDefined();
    });
    expect(stripVTControlCharacters(mounted!.render(80).join('\n'))).toContain(title);
    return mounted!;
  };
  const choose = async (title: string, keys: readonly string[]): Promise<void> => {
    const panel = await picker(title);
    for (const key of keys) panel.handleInput?.(key);
  };
  return { host, controller, text, choose };
}

describe('WorktreeCreationController', () => {
  beforeEach(() => {
    vi.stubEnv('HOME', '/home/me');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('creates and enters the worktree', async () => {
    const { host, controller, text } = makeHost();
    host.harness.createWorktree.mockImplementation(
      succeed(
        createdWorktree({
          copiedFiles: ['.env', 'a/.env.local', 'b', 'c', 'd'],
          sourceDirty: true,
          cwdFallback: true,
        }),
      ),
    );
    host.state.appState.workDir = '/repo/packages/foo';

    await controller.run({ name: 'fix-login', base: 'v1.2.0' });

    expect(host.harness.createWorktree).toHaveBeenCalledWith(
      { cwd: '/repo/packages/foo', name: 'fix-login', base: 'v1.2.0' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(host.applyWorkLocation).toHaveBeenCalledWith({
      cwd: WORKTREE_PATH,
      projectRoot: '/repo',
      isGitRepo: true,
      worktree: { root: WORKTREE_PATH, name: 'fix-login', repoRoot: '/repo' },
    });
    expect(text()).toBe(
      [
        '',
        '✓ Entered worktree fix-login',
        '  Uncommitted changes in /repo stay there.',
        "  packages/foo doesn't exist at this commit, so the session starts at the worktree root.",
      ].join('\n'),
    );
    expect(controller.busy).toBe(false);
  });

  it('exits with the engine message when the check step fails', async () => {
    const { host, controller } = makeHost();
    host.harness.createWorktree.mockImplementation(async (_input: unknown, options: CreateOptions = {}) => {
      emitUntil(options.onEvent, 'check');
      throw new KimiError(
        ErrorCodes.WORKTREE_ALREADY_EXISTS,
        `A worktree already exists at ${WORKTREE_PATH}.`,
        { details: { path: WORKTREE_PATH } },
      );
    });

    await controller.run({ name: 'fix-login' });

    expect(host.exitWithError).toHaveBeenCalledWith(
      [
        `error: A worktree already exists at ${WORKTREE_PATH}.`,
        'To resume its last session, use kimi -r. To start a new session in it, use /worktree.',
      ].join('\n'),
    );
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.applyWorkLocation).not.toHaveBeenCalled();
  });

  it('hands a refused request to the caller and keeps the TUI running', async () => {
    const { host, controller, text } = makeHost();
    const refusal = new KimiError(
      ErrorCodes.WORKTREE_INVALID_NAME,
      'Worktree names cannot contain spaces.',
    );
    host.harness.createWorktree.mockImplementation(async (_input: unknown, options: CreateOptions = {}) => {
      emitUntil(options.onEvent, 'check');
      throw refusal;
    });
    const onRejected = vi.fn();
    const onAccepted = vi.fn();

    await controller.run({ name: 'fix login' }, { onRejected, onAccepted });

    expect(onRejected).toHaveBeenCalledWith(refusal);
    expect(onAccepted).not.toHaveBeenCalled();
    expect(host.exitWithError).not.toHaveBeenCalled();
    expect(text()).toBe('');
    expect(controller.busy).toBe(false);
  });

  it('lets the caller enter the worktree and keeps the result after the transcript is cleared', async () => {
    const { host, controller, text } = makeHost();
    const onAccepted = vi.fn();
    const enter = vi.fn(async () => {
      host.state.transcriptContainer.children.length = 0;
      return true;
    });

    await controller.run({}, { onAccepted, enter });

    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(enter).toHaveBeenCalledWith({
      cwd: WORKTREE_PATH,
      projectRoot: '/repo',
      isGitRepo: true,
      worktree: { root: WORKTREE_PATH, name: 'fix-login', repoRoot: '/repo' },
    });
    expect(host.applyWorkLocation).not.toHaveBeenCalled();
    expect(text()).toBe(['', '✓ Entered worktree fix-login'].join('\n'));
  });

  it('does not claim to have entered a worktree the caller could not enter', async () => {
    const { controller, text } = makeHost();

    await controller.run({}, { enter: async () => false });

    expect(text()).not.toContain('Entered worktree');
    expect(controller.busy).toBe(false);
  });

  it('rejects before creating a worktree when beforeCreate throws', async () => {
    const { host, controller, text } = makeHost();
    const onRejected = vi.fn();

    await controller.run(
      { name: 'fix-login', mode: 'move' },
      {
        beforeCreate: () => {
          throw new Error('Background task is still running.');
        },
        onRejected,
      },
    );

    expect(host.harness.createWorktree).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledWith(expect.objectContaining({ message: 'Background task is still running.' }));
    expect(text()).toBe('');
  });

  it('reports moved session completion and preserves the created worktree if moving throws', async () => {
    const { controller, text } = makeHost();

    await controller.run({ name: 'fix-login', mode: 'move' }, { enter: async () => true });
    expect(text()).toBe(['', '✓ Moved session to worktree fix-login'].join('\n'));

    const failed = makeHost();
    await failed.controller.run(
      { name: 'fix-login', mode: 'move' },
      {
        enter: async () => {
          throw new Error('Turn is running.');
        },
      },
    );
    expect(failed.text()).toBe(
      [
        '',
        "✗ Created worktree fix-login, couldn't move session",
        '  Turn is running.',
        '  Session stays in /repo. Run /worktree to open fix-login.',
      ].join('\n'),
    );
  });

  it('shows the git error under the failed step and retries on Try again', async () => {
    const { host, controller, text, choose } = makeHost();
    host.harness.createWorktree.mockImplementationOnce(
      async (_input: unknown, options: CreateOptions = {}) => {
        emitUntil(options.onEvent, 'add');
        throw new KimiError(
          ErrorCodes.WORKTREE_GIT_FAILED,
          'Could not create the worktree.\nfatal: disk full',
          { details: { stderr: 'fatal: disk full\n', exitCode: 128 } },
        );
      },
    );

    const running = controller.run({ name: 'fix-login' });
    await choose("Couldn't create the worktree", []);
    expect(text()).toContain(
      `✗ Couldn't create ~/.kimi-code/worktrees/wd_repo/fix-login\n    fatal: disk full`,
    );
    expect(controller.busy).toBe(true);
    await choose("Couldn't create the worktree", [ENTER]);
    await running;

    expect(host.harness.createWorktree).toHaveBeenCalledTimes(2);
    expect(text()).toContain('✓ Entered worktree fix-login');
  });

  it('stays in the source directory when the failure prompt is dismissed', async () => {
    const { host, controller, text, choose } = makeHost();
    host.harness.createWorktree.mockImplementation(async (_input: unknown, options: CreateOptions = {}) => {
      emitUntil(options.onEvent, 'all');
      throw new KimiError(
        ErrorCodes.WORKTREE_INCLUDE_FAILED,
        'Copying files listed in .worktreeinclude failed: EACCES',
      );
    });

    const running = controller.run({ name: 'fix-login' });
    await choose("Couldn't create the worktree", [ESC]);
    await running;

    expect(host.applyWorkLocation).not.toHaveBeenCalled();
    expect(text()).toContain("✗ Couldn't copy files from .worktreeinclude");
    expect(controller.busy).toBe(false);
  });

  it('cancels a running creation and stays in the source directory', async () => {
    const { host, controller, text } = makeHost();
    host.harness.createWorktree.mockImplementation(
      (_input: unknown, options: CreateOptions = {}) =>
        new Promise<CreatedWorktree>((_resolve, reject) => {
          emitUntil(options.onEvent, 'add');
          options.signal?.addEventListener('abort', () => {
            reject(new KimiError(ErrorCodes.WORKTREE_CANCELLED, 'Worktree operation cancelled.'));
          });
        }),
    );

    const running = controller.run({});
    await vi.waitFor(() => {
      expect(text()).toContain('Creating worktree fix-login');
    });
    expect(controller.cancel()).toBe(true);
    await running;

    expect(text()).toBe(['', '● Cancelled. Staying in /repo.'].join('\n'));
    expect(controller.cancel()).toBe(false);
    expect(host.applyWorkLocation).not.toHaveBeenCalled();
  });

  it('falls back to projectRoot when creating a worktree from a missing workDir', async () => {
    const { host, controller } = makeHost();
    host.state.appState = { workDir: '/nonexistent-kimi-missing-worktree', projectRoot: '/repo' } as {
      workDir: string;
      projectRoot?: string;
    };

    await controller.run({ name: 'fix-login' });

    expect(host.harness.createWorktree).toHaveBeenCalledWith(
      { cwd: '/repo', name: 'fix-login', base: undefined },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
