import { describe, expect, it } from 'vitest';

import { resolveTowerRepoRoot } from '../../../src/features/tower/protocol/repoRoot';

describe('resolveTowerRepoRoot', () => {
  it('returns the cwd unchanged when it is the main checkout', () => {
    expect(resolveTowerRepoRoot('/repo')).toBe('/repo');
    expect(resolveTowerRepoRoot('/repo/src/layer')).toBe('/repo/src/layer');
  });

  it('maps a tower worktree cwd back to the main checkout', () => {
    expect(resolveTowerRepoRoot('/repo/.tower/worktrees/wt-1')).toBe('/repo');
    expect(resolveTowerRepoRoot('/repo/.tower/worktrees/wt-12/src')).toBe('/repo');
  });

  it('does not mangle lookalike paths', () => {
    expect(resolveTowerRepoRoot('/repo/.tower/worktrees')).toBe('/repo/.tower/worktrees');
    expect(resolveTowerRepoRoot('/repo/.tower/worktreesmith/x')).toBe(
      '/repo/.tower/worktreesmith/x',
    );
  });

  it('handles windows separators', () => {
    expect(resolveTowerRepoRoot('C:\\repo\\.tower\\worktrees\\wt-1')).toBe('C:\\repo');
  });
});
