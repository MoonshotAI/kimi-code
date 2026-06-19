import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_PROFILES } from '../../src/profile';

const baseContext = {
  osEnv: {
    osKind: 'macOS',
    osArch: 'arm64',
    osVersion: '0',
    shellName: 'bash',
    shellPath: '/bin/bash',
  },
  cwd: '/workspace',
  now: '2026-05-09T00:00:00.000Z',
  cwdListing: '',
  agentsMd: '',
  skills: '',
} as const;

describe('output style system prompt plumbing', () => {
  it('injects outputStyleBody into the rendered system prompt', () => {
    const context = { ...baseContext, outputStyleBody: 'BE_TERSE_MARKER' };
    const prompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(context) ?? '';
    expect(prompt).toContain('BE_TERSE_MARKER');
    expect(prompt).toContain('# Output Style');
  });

  it('omits the Output Style section when outputStyleBody is absent', () => {
    const prompt = DEFAULT_AGENT_PROFILES['agent']?.systemPrompt(baseContext) ?? '';
    expect(prompt).not.toContain('# Output Style');
  });
});
