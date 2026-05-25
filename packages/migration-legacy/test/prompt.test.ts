import { describe, expect, it } from 'vitest';

import { resolveMigrationScope } from '../src/prompt.js';

describe('resolveMigrationScope', () => {
  it('returns scope.sessions=false when user picks "config-only" at Prompt 2', () => {
    const result = resolveMigrationScope(['now', 'config-only']);
    expect(result.decision).toBe('now');
    expect(result.scope).toEqual({
      config: true,
      mcp: true,
      userHistory: true,
      skills: true,
      sessions: false,
    });
  });

  it('returns scope.sessions=true when user picks "all-sessions" at Prompt 2', () => {
    const result = resolveMigrationScope(['now', 'all-sessions']);
    expect(result.decision).toBe('now');
    expect(result.scope).toEqual({
      config: true,
      mcp: true,
      userHistory: true,
      skills: true,
      sessions: true,
    });
  });

  it('"later" short-circuits with no scope', () => {
    const result = resolveMigrationScope(['later']);
    expect(result.decision).toBe('later');
    expect(result.scope).toBeUndefined();
  });

  it('"never" returns decision=never (caller writes skip marker)', () => {
    const result = resolveMigrationScope(['never']);
    expect(result.decision).toBe('never');
    expect(result.scope).toBeUndefined();
  });
});
