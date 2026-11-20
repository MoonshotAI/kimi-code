import { describe, expect, it } from 'vitest';
import { worktreeSetup } from '@moonshot-ai/app-client/testing';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { AppSessionWorktree, AppWorktreeSetup, AppWorktreeSetupStep } from '@moonshot-ai/app-core/api';
import {
  createBlockView,
  createDecisionCardView,
  createElapsedSeconds,
  createInvalidCardView,
  createStepLabel,
  type CreateTranslate,
} from '../src/worktree/createPresentation';

const i18n = createKimiI18n({ locale: 'en' });
const t = i18n.global.t as unknown as CreateTranslate;

function worktree(overrides: Partial<AppWorktreeSetup> = {}, extra: Partial<AppSessionWorktree> = {}): AppSessionWorktree {
  return { ...extra, setup: worktreeSetup(overrides) };
}

function step(kind: AppWorktreeSetupStep['kind'], state: AppWorktreeSetupStep['state'], extra: Partial<AppWorktreeSetupStep> = {}): AppWorktreeSetupStep {
  return { kind, state, ...extra };
}

const actionIds = (view: { actions: { id: string }[] } | null) => view?.actions.map((item) => item.id);
const actionLabels = (view: { actions: { label: string }[] } | null) => view?.actions.map((item) => item.label);

describe('worktree creation step copy', () => {
  const ref = 'origin/main';

  it.each<[AppWorktreeSetupStep, string]>([
    [step('fetch', 'pending', { ref }), 'Fetch origin/main'],
    [step('fetch', 'running', { ref }), 'Fetching origin/main'],
    [step('fetch', 'done', { ref }), 'Fetched origin/main'],
    [step('fetch', 'failed', { ref }), 'Failed to fetch origin/main'],
    [step('fetch', 'failed', { ref, timedOut: true }), 'Fetching origin/main timed out'],
    [step('fetch', 'stopped', { ref }), 'Stopped fetching origin/main'],
    [step('create', 'pending'), 'Create Worktree'],
    [step('create', 'running', { ref }), 'Creating Worktree from origin/main'],
    [step('create', 'done', { ref: 'main' }), 'Worktree created from main'],
    [step('create', 'failed', { ref }), 'Worktree creation failed'],
    [step('changes', 'pending'), 'Include local uncommitted changes'],
    [step('changes', 'failed'), 'Failed to include local changes'],
    [step('script', 'running'), 'Running initialization script'],
    [step('script', 'skipped'), 'Initialization script skipped'],
    [step('script', 'failed', { timedOut: true }), 'Initialization script timed out'],
    [step('prune', 'running'), 'Cleaning up invalid Worktree record'],
  ])('labels %j as "%s"', (item, label) => {
    expect(createStepLabel(item, t)).toBe(label);
  });
});

describe('worktree creation block', () => {
  it('lists pending steps and hides the command count while running', () => {
    const view = createBlockView(
      worktree({
        status: 'running',
        steps: [
          step('fetch', 'done', { ref: 'origin/main', command: 'git fetch --no-tags origin main' }),
          step('create', 'running', { ref: 'origin/main', command: 'git worktree add --no-track -b kimi/1 /w origin/main', output: 'Preparing worktree' }),
          step('script', 'pending'),
        ],
        commandsRan: 1,
      }),
      t,
    );
    expect(view.title).toBe('Creating Worktree');
    expect(view.running).toBe(true);
    expect(view.meta).toBeNull();
    expect(view.defaultOpen).toBe(true);
    expect(view.steps.map((item) => [item.tone, item.label])).toEqual([
      ['done', 'Fetched origin/main'],
      ['running', 'Creating Worktree from origin/main'],
      ['pending', 'Run initialization script'],
    ]);
    expect(view.steps[1]?.output).toBe('Preparing worktree');
    expect(view.steps[2]?.command).toBeUndefined();
  });

  it('collapses a finished creation and notes included local changes', () => {
    const view = createBlockView(
      worktree(
        { status: 'ready', commandsRan: 2, steps: [step('create', 'done', { ref: 'main' }), step('changes', 'done')] },
        { path: '/w', includedLocalChanges: true },
      ),
      t,
    );
    expect(view.title).toBe('Worktree created');
    expect(view.meta).toBe('2 commands ran');
    expect(view.defaultOpen).toBe(false);
    expect(view.expandable).toBe(true);
    expect(view.note).toBe(
      'Local uncommitted changes were included (without staging state). The original directory is unaffected.',
    );
    expect(view.steps[0]?.label).toBe('Worktree created from main');
  });

  it.each<[Partial<AppWorktreeSetup>, string]>([
    [{ status: 'ready', script: 'skipped' }, 'Worktree created; initialization script skipped'],
    [{ status: 'awaiting_script_confirmation', script: 'pending' }, 'Worktree created; initialization script awaiting confirmation'],
    [{ status: 'failed', failure: { kind: 'fetch_failed' } }, 'Remote fetch failed'],
    [{ status: 'failed', failure: { kind: 'fetch_timeout' } }, 'Remote fetch timed out'],
    [{ status: 'failed', failure: { kind: 'conflict' } }, 'Local changes conflict with the remote'],
    [{ status: 'failed', failure: { kind: 'disk_full' } }, 'Worktree creation failed'],
    [{ status: 'failed', failure: { kind: 'create_failed' } }, 'Worktree creation failed'],
    [{ status: 'failed', failure: { kind: 'script_failed' } }, 'Initialization script failed'],
    [{ status: 'failed', failure: { kind: 'script_timeout' } }, 'Initialization script timed out'],
    [{ status: 'stopped', stoppedStep: 'create' }, 'Worktree creation stopped'],
    [{ status: 'stopped', stoppedStep: 'script' }, 'Initialization script stopped'],
    [{ status: 'local' }, 'Switched to Local Mode'],
  ])('titles %j as "%s"', (overrides, title) => {
    expect(createBlockView(worktree(overrides), t).title).toBe(title);
  });

  it('expands on failure and keeps the failed step output', () => {
    const view = createBlockView(
      worktree({
        status: 'failed',
        failure: { kind: 'fetch_failed' },
        commandsRan: 1,
        steps: [step('fetch', 'failed', { ref: 'origin/main', command: 'git fetch', output: 'fatal: unable to access\n' })],
      }),
      t,
    );
    expect(view.defaultOpen).toBe(true);
    expect(view.steps[0]).toMatchObject({ tone: 'failed', label: 'Failed to fetch origin/main', output: 'fatal: unable to access' });
  });

  it('keeps the original creation block during and after a recreate run', () => {
    const original = worktree(
      { status: 'ready', commandsRan: 2, steps: [step('fetch', 'done', { ref: 'origin/main' }), step('create', 'done', { ref: 'origin/main' })] },
      { path: '/w' },
    );
    const recreating = worktree({ purpose: 'recreate', status: 'running', steps: [step('prune', 'running'), step('create', 'pending')] });
    const remembered = createBlockView(recreating, t, original);
    expect(remembered.title).toBe('Worktree created');
    expect(remembered.running).toBe(false);
    expect(remembered.meta).toBe('2 commands ran');
    expect(remembered.steps).toHaveLength(2);

    const fallback = createBlockView(recreating, t);
    expect(fallback).toMatchObject({ title: 'Worktree created', running: false, meta: null, expandable: false, steps: [] });

    const failed = worktree({ purpose: 'recreate', status: 'failed', failure: { kind: 'create_failed' } });
    expect(createBlockView(failed, t).title).toBe('Worktree created');
    expect(createBlockView(worktree({ purpose: 'recreate', status: 'local' }), t, original).title).toBe('Switched to Local Mode');
  });

  it('counts elapsed whole seconds from the start time', () => {
    const started = '2026-11-18T10:00:00.000Z';
    expect(createElapsedSeconds(started, Date.parse(started) + 12_400)).toBe(12);
    expect(createElapsedSeconds(started, Date.parse(started) - 500)).toBe(0);
    expect(createElapsedSeconds('not a date', 1000)).toBe(0);
  });
});

describe('worktree decision cards', () => {
  it('offers local creation and retry when the fetch fails or times out', () => {
    const failed = createDecisionCardView(worktree({ status: 'failed', failure: { kind: 'fetch_failed' } }), t);
    expect(failed).toMatchObject({
      kind: 'fetchFailed',
      title: 'Remote fetch failed',
      body: 'Unable to connect to the remote. No Worktree was created, and this message has not been processed.',
    });
    expect(actionLabels(failed)).toEqual(['Create from local main', 'Retry']);
    expect(failed?.actions.at(-1)?.primary).toBe(true);
    expect(failed?.actions[0]?.primary).toBeUndefined();

    const timeout = createDecisionCardView(worktree({ status: 'failed', failure: { kind: 'fetch_timeout' } }), t);
    expect(timeout?.title).toBe('Remote fetch timed out');
    expect(timeout?.body).toBe(
      'The fetch did not complete within 30 seconds. No Worktree was created, and this message has not been processed.',
    );
    expect(actionIds(timeout)).toEqual(['createFromLocal', 'retry']);
  });

  it('lists conflicting files and makes local creation the primary choice', () => {
    const view = createDecisionCardView(
      worktree({
        status: 'failed',
        request: { sourceBranch: 'main', includeLocalChanges: true, useRemote: true },
        failure: { kind: 'conflict', remoteRef: 'origin/main', conflictFiles: ['src/greet.js'] },
      }),
      t,
    );
    expect(view?.title).toBe('Local changes conflict with the remote');
    expect(view?.body).toBe('The following files conflict with new commits on origin/main.');
    expect(view?.files).toEqual(['src/greet.js']);
    expect(actionLabels(view)).toEqual(['Create from Remote', 'Create from local main']);
    expect(view?.actions.at(-1)).toMatchObject({ id: 'createFromLocal', primary: true });
  });

  it('adds Manage only when the disk is full', () => {
    const full = createDecisionCardView(worktree({ status: 'failed', failure: { kind: 'disk_full' } }), t);
    expect(full?.title).toBe('Worktree creation failed');
    expect(full?.body).toBe(
      'Insufficient disk space. No directory or branch was retained. Remove unneeded Worktrees and try again.',
    );
    expect(actionIds(full)).toEqual(['manage', 'useLocal', 'retry']);

    const generic = createDecisionCardView(worktree({ status: 'failed', failure: { kind: 'create_failed' } }), t);
    expect(generic?.body).toBe('An error occurred while creating the Worktree. No directory or branch was retained.');
    expect(actionIds(generic)).toEqual(['useLocal', 'retry']);
    expect(actionIds(createDecisionCardView(worktree({ status: 'failed' }), t))).toEqual(['useLocal', 'retry']);
  });

  it('switches the stopped card buttons when the fetch was stopped', () => {
    const stopped = createDecisionCardView(worktree({ status: 'stopped', stoppedStep: 'create' }), t);
    expect(stopped?.title).toBe('Worktree creation stopped');
    expect(actionIds(stopped)).toEqual(['useLocal', 'retry']);
    const fetchStopped = createDecisionCardView(worktree({ status: 'stopped', stoppedStep: 'fetch' }), t);
    expect(actionLabels(fetchStopped)).toEqual(['Create from local main', 'Retry']);
  });

  it('only offers skip and run at a script pause', () => {
    const base = { path: '/w' };
    const failed = createDecisionCardView(
      worktree({ status: 'failed', stoppedStep: 'script', failure: { kind: 'script_failed', exitCode: 1 } }, base),
      t,
    );
    expect(failed).toMatchObject({ title: 'Initialization script failed', body: 'The script failed with exit code 1.' });
    expect(actionLabels(failed)).toEqual(['Skip Script', 'Run Again']);

    const timeout = createDecisionCardView(
      worktree({ status: 'failed', stoppedStep: 'script', failure: { kind: 'script_timeout', timeoutSeconds: 180 } }, base),
      t,
    );
    expect(timeout).toMatchObject({
      title: 'Initialization script timed out',
      body: 'The script ran for more than 3 minutes and has been stopped.',
    });
    expect(actionIds(timeout)).toEqual(['skipScript', 'runScript']);

    const stopped = createDecisionCardView(worktree({ status: 'stopped', stoppedStep: 'script' }, base), t);
    expect(stopped).toMatchObject({
      title: 'Initialization script stopped',
      body: 'The Worktree has been created, but this message has not been processed.',
    });
    expect(actionLabels(stopped)).toEqual(['Skip Script', 'Run Again']);

    const confirm = createDecisionCardView(
      worktree({ status: 'awaiting_script_confirmation', script: 'pending', scriptContent: 'pnpm install' }, base),
      t,
    );
    expect(confirm).toMatchObject({
      title: "Run this project's initialization script?",
      body: 'The script comes from the repository. You will be asked again when its content changes.',
      code: 'pnpm install',
    });
    expect(actionLabels(confirm)).toEqual(['Skip Script', 'Run']);
    expect(confirm?.actions.at(-1)).toMatchObject({ id: 'runScript', primary: true });
  });

  it('shows no decision card while running, ready, local or invalid', () => {
    expect(createDecisionCardView(null, t)).toBeNull();
    expect(createDecisionCardView(worktree({ status: 'running' }), t)).toBeNull();
    expect(createDecisionCardView(worktree({ status: 'ready' }, { path: '/w' }), t)).toBeNull();
    expect(createDecisionCardView(worktree({ status: 'local' }), t)).toBeNull();
    expect(createDecisionCardView(worktree({ status: 'ready' }, { path: '/w', missing: true }), t)).toBeNull();
    expect(
      createDecisionCardView(worktree({ purpose: 'recreate', status: 'failed', failure: { kind: 'create_failed' } }), t),
    ).toBeNull();
  });
});

describe('invalid worktree card', () => {
  const missing = { path: '/w', branch: 'kimi/1111-3321', missing: true };

  it('offers recreate and local mode while the branch exists', () => {
    const view = createInvalidCardView(worktree({ status: 'ready' }, missing), t);
    expect(view).toMatchObject({
      phase: 'missing',
      title: 'Worktree no longer exists',
      body: 'You can recreate it from branch kimi/1111-3321 or switch to Local mode.',
    });
    expect(actionLabels(view)).toEqual(['Use Local Mode', 'Recreate Worktree']);
    expect(actionIds(view)).toEqual(['useLocal', 'recreate']);
  });

  it('only offers local mode when the branch is gone', () => {
    const view = createInvalidCardView(worktree({ status: 'ready' }, { ...missing, branchMissing: true }), t);
    expect(view?.phase).toBe('branchGone');
    expect(view?.body).toBe(
      'Branch kimi/1111-3321 has also been deleted, so the Worktree cannot be recreated. You can switch to Local mode.',
    );
    expect(actionIds(view)).toEqual(['useLocal']);
  });

  it('follows the recreate run from cleanup to creation', () => {
    const cleaning = createInvalidCardView(
      worktree(
        { purpose: 'recreate', status: 'running', steps: [step('prune', 'running', { command: 'git worktree prune' }), step('create', 'pending')] },
        { branch: 'kimi/1111-3321', missing: true },
      ),
      t,
    );
    expect(cleaning).toMatchObject({
      phase: 'recreating',
      title: 'Cleaning up invalid Worktree record',
      command: 'git worktree prune',
    });
    expect(actionIds(cleaning)).toEqual(['stop']);

    const creating = createInvalidCardView(
      worktree(
        {
          purpose: 'recreate',
          status: 'running',
          steps: [step('prune', 'done'), step('create', 'running', { command: 'git worktree add /w kimi/1111-3321' })],
        },
        { branch: 'kimi/1111-3321', missing: true },
      ),
      t,
    );
    expect(creating).toMatchObject({
      title: 'Recreating Worktree from kimi/1111-3321',
      command: 'git worktree add /w kimi/1111-3321',
    });
  });

  it('reports a failed recreate with raw output and the disk-full variant', () => {
    const steps = [step('prune', 'done'), step('create', 'failed', { command: 'git worktree add /w b', output: 'fatal: boom\n' })];
    const failed = createInvalidCardView(
      worktree({ purpose: 'recreate', status: 'failed', stoppedStep: 'create', failure: { kind: 'create_failed' }, steps }, { branch: 'b', missing: true }),
      t,
    );
    expect(failed).toMatchObject({
      phase: 'failed',
      title: 'Worktree recreation failed',
      body: 'An error occurred while recreating the Worktree. No directory was retained.',
      output: 'git worktree add /w b\nfatal: boom',
    });
    expect(actionLabels(failed)).toEqual(['View Raw Output', 'Use Local Mode', 'Retry']);
    expect(actionIds(failed)).toEqual(['viewOutput', 'useLocal', 'retry']);

    const full = createInvalidCardView(
      worktree({ purpose: 'recreate', status: 'failed', failure: { kind: 'disk_full' }, steps }, { branch: 'b', missing: true }),
      t,
    );
    expect(full?.body).toBe('Insufficient disk space. No directory was retained. Remove unneeded Worktrees and try again.');
    expect(actionIds(full)).toEqual(['viewOutput', 'manage', 'useLocal', 'retry']);
  });

  it('reports a stopped recreate', () => {
    const view = createInvalidCardView(
      worktree({ purpose: 'recreate', status: 'stopped', stoppedStep: 'create' }, { branch: 'b', missing: true }),
      t,
    );
    expect(view).toMatchObject({ phase: 'stopped', title: 'Worktree recreation stopped', body: 'No directory was retained.' });
    expect(actionIds(view)).toEqual(['useLocal', 'retry']);
  });

  it('hands a recreated worktree paused at its script back to the script cards', () => {
    const paused = worktree(
      { purpose: 'recreate', status: 'failed', stoppedStep: 'script', failure: { kind: 'script_failed', exitCode: 2 } },
      { path: '/w', branch: 'b' },
    );
    expect(createInvalidCardView(paused, t)).toBeNull();
    expect(createDecisionCardView(paused, t)?.kind).toBe('scriptFailed');
    expect(createInvalidCardView(worktree({ purpose: 'recreate', status: 'ready' }, { path: '/w', branch: 'b' }), t)).toBeNull();
    expect(createInvalidCardView(worktree({ status: 'ready' }, { path: '/w' }), t)).toBeNull();
  });
});
