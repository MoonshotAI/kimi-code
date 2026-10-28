import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  createInstallPromptChoices,
  getDefaultInstallPromptSelection,
  moveInstallPromptSelection,
  promptForInstallChoice,
} from '#/cli/update/prompt';

describe('install prompt helpers', () => {
  it('defaults the selection to "Install update now"', () => {
    const choices = createInstallPromptChoices({
      kind: 'upgrade',
      target: { channel: 'stable', version: '0.0.2-beta.1' },
    });

    expect(getDefaultInstallPromptSelection(choices)).toBe(0);
    expect(choices[0]).toEqual({
      value: 'install',
      label: 'Install update now (0.0.2-beta.1)',
    });
    expect(choices[1]).toEqual({
      value: 'skip',
      label: 'Continue with current version',
    });
  });

  it('offers a bidirectional channel switch without calling it a downgrade', () => {
    const choices = createInstallPromptChoices({
      kind: 'switch-channel',
      sourceChannel: 'stable',
      target: { channel: 'canary', version: '2.3.3-canary.20261028012345-0123456' },
    });

    expect(choices).toEqual([
      { value: 'install', label: 'Switch to canary now (2.3.3-canary.20261028012345-0123456)' },
      { value: 'skip', label: 'Stay on stable' },
    ]);
  });

  it('moves selection with arrow directions and clamps at the edges', () => {
    expect(moveInstallPromptSelection(1, 'up', 2)).toBe(0);
    expect(moveInstallPromptSelection(0, 'up', 2)).toBe(0);
    expect(moveInstallPromptSelection(0, 'down', 2)).toBe(1);
    expect(moveInstallPromptSelection(1, 'down', 2)).toBe(1);
  });
});

describe('promptForInstallChoice', () => {
  it('renders the changelog, source channel, target channel, and versions', async () => {
    const CHANGELOG_URL = 'https://moonshotai.github.io/kimi-code/en/release-notes/changelog.html';

    const input = Object.assign(new EventEmitter(), {
      isRaw: false,
      setRawMode: () => {},
      resume: () => {},
      off: () => {},
    }) as unknown as NodeJS.ReadStream;

    const outputChunks: string[] = [];
    const output = {
      write: (chunk: string) => {
        outputChunks.push(chunk);
        return true;
      },
    } as NodeJS.WriteStream;

    const promptPromise = promptForInstallChoice({
      currentVersion: '2.3.3',
      plan: {
        kind: 'switch-channel',
        sourceChannel: 'stable',
        target: { channel: 'canary', version: '2.3.3-canary.20261028012345-0123456' },
      },
      installCommand: 'npm install -g @moonshot-ai/kimi-code@2.3.3-canary.20261028012345-0123456',
      installSource: 'npm-global',
      input,
      output,
    });

    input.emit('keypress', '', { name: 'escape' });
    await promptPromise;

    const rendered = outputChunks.join('');
    expect(rendered).toContain(CHANGELOG_URL);
    expect(rendered).toContain('View changelog');
    expect(rendered).toContain('stable -> canary');
    expect(rendered).toContain('2.3.3');
    expect(rendered).toContain('2.3.3-canary.20261028012345-0123456');
  });
});
