import { describe, expect, it } from 'vitest';

import { buildOverrideProfile } from '../../src/session/subagent-host';
import { TEST_OS_ENV } from '../fixtures/test-kaos';

describe('buildOverrideProfile', () => {
  it('builds a profile whose renderer returns the literal system prompt', () => {
    const profile = buildOverrideProfile('swarm:Auditor', {
      systemPrompt: 'You are a dependency auditor.',
      tools: ['Read', 'Grep'],
    });

    expect(profile.name).toBe('swarm:Auditor');
    expect(profile.tools).toEqual(['Read', 'Grep']);
    expect(profile.systemPrompt({ osEnv: TEST_OS_ENV, cwd: '/tmp' })).toBe(
      'You are a dependency auditor.',
    );
  });

  it('ignores render context and always returns the override text', () => {
    const profile = buildOverrideProfile('swarm:X', { systemPrompt: 'fixed', tools: [] });
    expect(profile.systemPrompt({ osEnv: TEST_OS_ENV, cwd: '/a', cwdListing: 'noise' })).toBe(
      'fixed',
    );
  });
});
