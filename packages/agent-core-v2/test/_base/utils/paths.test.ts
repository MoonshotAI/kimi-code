/**
 * Scenario: recursive watches constrained to selected candidate subtrees.
 * Responsibilities: candidate ancestry, scan-depth bounds, and excluded-entry
 * probing. Wiring: pure path predicates with no external collaborators.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/_base/utils/paths.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { subtreeWatchFilter } from '#/_base/utils/paths';

describe('subtree watch filtering', () => {
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

  it('prunes what an excluded entry hides from the scanner, keeps what it still probes', () => {
    const ignored = subtreeWatchFilter(root, candidates, {
      maxDepth: 3,
      skipEntry: (name) => name === 'node_modules' || name.startsWith('.'),
      keepEntryFile: 'SKILL.md',
    });
    expect(ignored('/repo/.agents/skills/demo/node_modules')).toBe(false);
    expect(ignored('/repo/.agents/skills/demo/node_modules/SKILL.md')).toBe(false);
    expect(ignored('/repo/.agents/skills/demo/.hidden')).toBe(false);
    expect(ignored('/repo/.agents/skills/demo/.hidden/SKILL.md')).toBe(false);
    expect(ignored('/repo/.agents/skills/.flat.md')).toBe(false);
    expect(ignored('/repo/.agents/skills/demo/node_modules/pkg')).toBe(true);
    expect(ignored('/repo/.agents/skills/demo/node_modules/pkg/x.js')).toBe(true);
    expect(ignored('/repo/.agents/skills/demo/.venv/bin/python')).toBe(true);
    expect(ignored('/repo/.agents/skills/demo/scripts/run.sh')).toBe(false);
    expect(ignored('/repo/.agents/skills/a/b/c/d/e/f/SKILL.md')).toBe(true);
  });

  it('prunes an excluded entry beyond itself when no keepEntryFile is set', () => {
    const ignored = subtreeWatchFilter(root, candidates, {
      skipEntry: (name) => name === 'node_modules',
    });
    expect(ignored('/repo/.agents/skills/demo/node_modules')).toBe(false);
    expect(ignored('/repo/.agents/skills/demo/node_modules/SKILL.md')).toBe(true);
    expect(ignored('/repo/.agents/skills/demo/node_modules/pkg')).toBe(true);
  });

  it('applies max depth before excluded-entry exceptions', () => {
    const ignored = subtreeWatchFilter(root, candidates, {
      maxDepth: 3,
      skipEntry: (name) => name === 'node_modules',
      keepEntryFile: 'SKILL.md',
    });
    expect(ignored('/repo/.agents/skills/demo/a/b/node_modules')).toBe(true);
    expect(ignored('/repo/.agents/skills/demo/a/b/node_modules/SKILL.md')).toBe(true);
  });

  it('never prunes the candidate ancestor chain itself', () => {
    const ignored = subtreeWatchFilter(root, candidates, {
      skipEntry: (name) => name.startsWith('.'),
    });
    expect(ignored('/repo/.agents')).toBe(false);
    expect(ignored('/repo/.agents/skills')).toBe(false);
    expect(ignored('/repo/.agents/skills/demo')).toBe(false);
  });

  it('keeps direct probes but prunes payload below a terminal bundle', () => {
    const ignored = subtreeWatchFilter(root, candidates, {
      scannedDirectories: ['/repo/.agents/skills'],
      keepEntryFile: 'SKILL.md',
    });
    expect(ignored('/repo/.agents/skills/demo')).toBe(false);
    expect(ignored('/repo/.agents/skills/demo/SKILL.md')).toBe(false);
    expect(ignored('/repo/.agents/skills/demo/runtime')).toBe(true);
    expect(ignored('/repo/.agents/skills/demo/runtime/0.py')).toBe(true);
    expect(ignored('/repo/.agents/skills/.flat.md')).toBe(false);
  });

  it('keeps direct bundle probes when the candidate root has not been scanned yet', () => {
    const ignored = subtreeWatchFilter(root, candidates, {
      scannedDirectories: [],
      keepEntryFile: 'SKILL.md',
    });
    expect(ignored('/repo/.agents/skills/new-skill')).toBe(false);
    expect(ignored('/repo/.agents/skills/new-skill/SKILL.md')).toBe(false);
    expect(ignored('/repo/.agents/skills/new-skill/runtime')).toBe(true);
  });

  it('keeps direct sub-skill probes below a directory the scanner traversed', () => {
    const ignored = subtreeWatchFilter(root, candidates, {
      scannedDirectories: [
        '/repo/.agents/skills',
        '/repo/.agents/skills/parent',
      ],
      keepEntryFile: 'SKILL.md',
    });
    expect(ignored('/repo/.agents/skills/parent/child')).toBe(false);
    expect(ignored('/repo/.agents/skills/parent/child/SKILL.md')).toBe(false);
    expect(ignored('/repo/.agents/skills/parent/child/runtime')).toBe(true);
  });
});
