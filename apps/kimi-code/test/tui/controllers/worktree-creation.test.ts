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
const DOWN = '\u001B[B';
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
    setupScript: undefined,
    ...overrides,
  };
}

type CreateOptions = { signal?: AbortSignal; onEvent?: (event: WorktreeCreateEvent) => void };
type SetupOptions = { signal?: AbortSignal; onOutput?: (text: string) => void };

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
      runWorktreeSetupScript: vi.fn(async (_input: unknown, _options: SetupOptions = {}) => ({
        exitCode: 0,
      })),
      removeWorktree: vi.fn(async () => {}),
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
    stop: vi.fn(async () => {}),
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
  return { host, controller, text, picker, choose };
}

describe('WorktreeCreationController', () => {
  beforeEach(() => {
    vi.stubEnv('HOME', '/home/me');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('creates the worktree, enters it, and records it for this run', async () => {
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
    expect(controller.createdThisRun.get(WORKTREE_PATH)).toEqual({
      name: 'fix-login',
      repoRoot: '/repo',
      setupScriptRan: false,
    });
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
    expect(controller.createdThisRun.has(WORKTREE_PATH)).toBe(true);
    expect(controller.busy).toBe(false);
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

  it('skips the setup script on Esc and runs it on Run it', async () => {
    const setupScript = '/repo/.kimi-code/worktree-setup.sh';
    const skipped = makeHost();
    skipped.host.harness.createWorktree.mockImplementation(succeed(createdWorktree({ setupScript })));
    const skipRun = skipped.controller.run({});
    const prompt = await skipped.picker('Run the worktree setup script?');
    expect(stripVTControlCharacters(prompt.render(80).join('\n'))).toContain(
      '.kimi-code/worktree-setup.sh from /repo',
    );
    prompt.handleInput?.(ESC);
    await skipRun;
    expect(skipped.host.harness.runWorktreeSetupScript).not.toHaveBeenCalled();
    expect(skipped.controller.createdThisRun.get(WORKTREE_PATH)?.setupScriptRan).toBe(false);

    const ran = makeHost();
    ran.host.harness.createWorktree.mockImplementation(succeed(createdWorktree({ setupScript })));
    let finish!: (result: { exitCode: number }) => void;
    ran.host.harness.runWorktreeSetupScript.mockImplementation(
      (_input: unknown, options: SetupOptions = {}) =>
        new Promise<{ exitCode: number }>((resolve) => {
          options.onOutput?.('one\ntwo\nthree\nfour\nfive\nsix\n\u001B[32mseven\u001B[0m partial');
          finish = resolve;
        }),
    );
    const run = ran.controller.run({});
    await ran.choose('Run the worktree setup script?', [ENTER]);
    await vi.waitFor(() => {
      expect(ran.text()).toContain('Running .kimi-code/worktree-setup.sh');
    });
    expect(ran.text()).toContain(
      ['    │ three', '    │ four', '    │ five', '    │ six', '    │ seven partial'].join('\n'),
    );
    ran.host.state.ui.requestRender.mockClear();
    ran.host.applyWorkLocation.mockClear();
    finish({ exitCode: 0 });
    await run;

    expect(ran.host.harness.runWorktreeSetupScript).toHaveBeenCalledWith(
      { worktreePath: WORKTREE_PATH, sourceRoot: '/repo' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(ran.host.applyWorkLocation).toHaveBeenCalledOnce();
    expect(ran.controller.createdThisRun.get(WORKTREE_PATH)?.setupScriptRan).toBe(true);
  });

  it('offers to rerun, continue, or delete after the setup script fails', async () => {
    const setupScript = '/repo/.kimi-code/worktree-setup.sh';
    const again = makeHost();
    again.host.harness.createWorktree.mockImplementation(succeed(createdWorktree({ setupScript })));
    again.host.harness.runWorktreeSetupScript.mockResolvedValueOnce({ exitCode: 3 });
    const againRun = again.controller.run({});
    await again.choose('Run the worktree setup script?', [ENTER]);
    await again.choose('The setup script failed', []);
    expect(again.text()).toContain('✗ Setup script exited with code 3');
    await again.choose('The setup script failed', [ENTER]);
    await againRun;
    expect(again.host.harness.runWorktreeSetupScript).toHaveBeenCalledTimes(2);
    expect(again.text()).toContain('✓ Entered worktree fix-login');

    const skip = makeHost();
    skip.host.harness.createWorktree.mockImplementation(succeed(createdWorktree({ setupScript })));
    skip.host.harness.runWorktreeSetupScript.mockResolvedValueOnce({ exitCode: 1 });
    const skipRun = skip.controller.run({});
    await skip.choose('Run the worktree setup script?', [ENTER]);
    await skip.choose('The setup script failed', [DOWN, ENTER]);
    await skipRun;
    expect(skip.host.applyWorkLocation).toHaveBeenCalledOnce();

    const remove = makeHost();
    remove.host.harness.createWorktree.mockImplementation(succeed(createdWorktree({ setupScript })));
    remove.host.harness.runWorktreeSetupScript.mockResolvedValueOnce({ exitCode: 2 });
    const removeRun = remove.controller.run({});
    await remove.choose('Run the worktree setup script?', [ENTER]);
    await remove.choose('The setup script failed', [DOWN, DOWN, ENTER]);
    await removeRun;
    expect(remove.host.harness.removeWorktree).toHaveBeenCalledWith({
      repoRoot: '/repo',
      path: WORKTREE_PATH,
      deleteBranch: false,
      discard: 'all',
    });
    expect(remove.host.stop).toHaveBeenCalledWith(0);
    expect(remove.host.applyWorkLocation).not.toHaveBeenCalled();
    expect(remove.controller.createdThisRun.size).toBe(0);
  });

  it('reports an interrupted setup script', async () => {
    const { host, controller, text, choose } = makeHost();
    host.harness.createWorktree.mockImplementation(
      succeed(createdWorktree({ setupScript: '/repo/.kimi-code/worktree-setup.sh' })),
    );
    host.harness.runWorktreeSetupScript.mockImplementation(
      (_input: unknown, options: SetupOptions = {}) =>
        new Promise<{ exitCode: number }>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            reject(new KimiError(ErrorCodes.WORKTREE_CANCELLED, 'Worktree operation cancelled.'));
          });
        }),
    );
    const running = controller.run({});
    await choose('Run the worktree setup script?', [ENTER]);
    await vi.waitFor(() => {
      expect(controller.cancel()).toBe(true);
    });
    await choose('The setup script failed', []);
    expect(text()).toContain('✗ Setup script was interrupted');
    await choose('The setup script failed', [ESC]);
    await running;
    expect(host.applyWorkLocation).toHaveBeenCalledOnce();
  });
});
