import { DEFAULT_AGENT_PROFILES } from '#/legacy/profile/index';
import { expect, it } from 'vitest';

it('renders the coder system prompt', () => {
  const profile = DEFAULT_AGENT_PROFILES['coder'];
  if (profile === undefined) throw new Error('coder profile missing');
  const prompt = profile.systemPrompt({
    osEnv: {
      osKind: 'Windows',
      osArch: 'x64',
      osVersion: '0',
      shellName: 'bash',
      shellPath: 'C:/Program Files/Git/bin/bash.exe',
    },
    cwd: 'D:/kimi/kimi-code',
    cwdListing: 'src/\ntests/\n',
    agentsMd: 'project instructions',
    additionalDirsInfo: '',
  } as never);
  expect(prompt.length).toBeGreaterThan(100);
  expect(prompt).toContain('D:/kimi/kimi-code');
  console.log('prompt chars:', prompt.length);
});
