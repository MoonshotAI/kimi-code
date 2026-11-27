import { describe, expect, it } from 'vitest';
import { worktreeSetup } from '@moonshot-ai/app-client/testing';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { AppSessionWorktree, AppWorktreeSetup, AppWorktreeSetupStep } from '@moonshot-ai/app-core/api';
import {
  createBlockView,
  createDecisionCardView,
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
    [step('prune', 'running'), 'Cleaning up invalid Worktree record'],
  ])('labels %j as "%s"', (item, label) => {
    expect(createStepLabel(item, t)).toBe(label);
  });
});

describe('worktree creation block', () => {
  it.each<[Partial<AppWorktreeSetup>, string]>([
    [{ status: 'failed', failure: { kind: 'fetch_failed' } }, 'Remote fetch failed'],
    [{ status: 'failed', failure: { kind: 'fetch_timeout' } }, 'Remote fetch timed out'],
    [{ status: 'failed', failure: { kind: 'conflict' } }, 'Local changes conflict with the remote'],
    [{ status: 'failed', failure: { kind: 'disk_full' } }, 'Worktree creation failed'],
    [{ status: 'failed', failure: { kind: 'create_failed' } }, 'Worktree creation failed'],
    [{ status: 'stopped', stoppedStep: 'create' }, 'Worktree creation stopped'],
    [{ status: 'local' }, 'Switched to Local Mode'],
  ])('titles %j as "%s"', (overrides, title) => {
    expect(createBlockView(worktree(overrides), t).title).toBe(title);
  });

  it('falls back to a static block for a recreate run without the original creation', () => {
    const recreating = worktree({ purpose: 'recreate', status: 'running', steps: [step('prune', 'running'), step('create', 'pending')] });
    expect(createBlockView(recreating, t)).toMatchObject({ title: 'Worktree created', meta: null, expandable: false, steps: [] });
    const failed = worktree({ purpose: 'recreate', status: 'failed', failure: { kind: 'create_failed' } });
    expect(createBlockView(failed, t).title).toBe('Worktree created');
    const original = worktree({ status: 'ready', commandsRan: 1, steps: [step('create', 'done', { ref: 'main' })] }, { path: '/w' });
    expect(createBlockView(worktree({ purpose: 'recreate', status: 'local' }), t, original).title).toBe('Switched to Local Mode');
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

  it('shows no decision card for a missing worktree or a recreate run', () => {
    expect(createDecisionCardView(null, t)).toBeNull();
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

  it('shows no invalid card once the worktree is ready', () => {
    expect(createInvalidCardView(worktree({ purpose: 'recreate', status: 'ready' }, { path: '/w', branch: 'b' }), t)).toBeNull();
    expect(createInvalidCardView(worktree({ status: 'ready' }, { path: '/w' }), t)).toBeNull();
  });
});
