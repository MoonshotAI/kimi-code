import { describe, expect, it } from 'vitest';

import type { GitStatusEntry } from '../src/api/types';
import { pullRequestDisplay, summarizeGitStatus } from '../src/lib/gitStatusSummary';

function entry(overrides: Partial<GitStatusEntry> = {}): GitStatusEntry {
  return { branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null, ...overrides };
}

const pullRequest = { number: 7, state: 'open', url: 'https://example.test/7' };

describe('summarizeGitStatus', () => {
  it('reports a branch without an upstream as not pushed', () => {
    expect(summarizeGitStatus(entry())).toMatchObject({ branch: 'main', notPushed: true, upstream: null, detached: false });
    expect(summarizeGitStatus(entry({ upstream: 'origin/main', ahead: 2, behind: 1 }))).toMatchObject({
      notPushed: false,
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
    });
  });

  it('shows a detached HEAD by its short sha instead of a push state', () => {
    expect(summarizeGitStatus(entry({ detached: true, head: '0123456789' }))).toMatchObject({
      detached: true,
      shortHead: '0123456789',
      notPushed: false,
    });
    expect(summarizeGitStatus(entry({ detached: false })).shortHead).toBeNull();
  });

  it('counts untracked or binary entries as changes even without line counts', () => {
    expect(summarizeGitStatus(entry()).hasChanges).toBe(false);
    expect(summarizeGitStatus(entry({ additions: 3 })).hasChanges).toBe(true);
    expect(summarizeGitStatus(entry({ entries: { 'logo.png': 'untracked' } })).hasChanges).toBe(true);
  });

  it('keeps the raw output when change counting failed', () => {
    expect(summarizeGitStatus(entry()).statsError).toBeNull();
    expect(summarizeGitStatus(entry({ statsError: 'fatal: bad object' })).statsError).toBe('fatal: bad object');
  });

  it('shows a found pull request', () => {
    expect(summarizeGitStatus(entry({ pullRequest, pullRequestStatus: 'found' }))).toMatchObject({
      pullRequest,
      pullRequestDisplay: 'shown',
      pullRequestError: null,
    });
    expect(pullRequestDisplay(entry({ pullRequest }))).toBe('shown');
  });

  it('hides the pull request row when there is none or gh is unavailable', () => {
    expect(pullRequestDisplay(entry())).toBe('hidden');
    expect(pullRequestDisplay(entry({ pullRequestStatus: 'none' }))).toBe('hidden');
    expect(summarizeGitStatus(entry({ pullRequest, pullRequestStatus: 'unavailable' }))).toMatchObject({
      pullRequest: null,
      pullRequestDisplay: 'hidden',
    });
  });

  it('reports a failed pull request read with its raw output', () => {
    expect(summarizeGitStatus(entry({ pullRequest, pullRequestStatus: 'failed', pullRequestError: 'gh: timeout' }))).toMatchObject({
      pullRequest: null,
      pullRequestDisplay: 'failed',
      pullRequestError: 'gh: timeout',
    });
  });
});
