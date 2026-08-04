/**
 * `_base/utils/paths` — unit tests for `subtreeWatchFilter`.
 */

import { describe, expect, it } from 'vitest';

import { subtreeWatchFilter } from '#/_base/utils/paths';

describe('subtreeWatchFilter', () => {
  const root = '/repo';
  const candidates = ['/repo/.kimi-code/skills', '/repo/.agents/skills'];

  it('keeps the root, candidate ancestors and candidate subtrees watched', () => {
    const ignored = subtreeWatchFilter(root, candidates);
    expect(ignored('/repo')).toBe(false);
    expect(ignored('/repo/.agents')).toBe(false);
    expect(ignored('/repo/.agents/skills')).toBe(false);
    expect(ignored('/repo/.agents/skills/demo/SKILL.md')).toBe(false);
    expect(ignored('/repo/src')).toBe(true);
    expect(ignored('/repo/src/index.ts')).toBe(true);
  });

  it('prunes skipped entries and over-depth paths below candidates', () => {
    const ignored = subtreeWatchFilter(root, candidates, {
      maxDepth: 3,
      skipEntry: (name) => name === 'node_modules' || name.startsWith('.'),
    });
    expect(ignored('/repo/.agents/skills/demo/node_modules')).toBe(true);
    expect(ignored('/repo/.agents/skills/demo/node_modules/pkg/x.js')).toBe(true);
    expect(ignored('/repo/.agents/skills/demo/.venv/bin/python')).toBe(true);
    expect(ignored('/repo/.agents/skills/demo/scripts/run.sh')).toBe(false);
    expect(ignored('/repo/.agents/skills/a/b/c/d/e/f/SKILL.md')).toBe(true);
  });

  it('never prunes the candidate ancestor chain itself', () => {
    const ignored = subtreeWatchFilter(root, candidates, {
      skipEntry: (name) => name.startsWith('.'),
    });
    expect(ignored('/repo/.agents')).toBe(false);
    expect(ignored('/repo/.agents/skills')).toBe(false);
    expect(ignored('/repo/.agents/skills/demo')).toBe(false);
  });
});
