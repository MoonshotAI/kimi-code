import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  createInstallPromptChoices,
  getDefaultInstallPromptSelection,
  moveInstallPromptSelection,
  promptForInstallConfirmation,
} from '#/cli/update/prompt';

describe('install prompt helpers', () => {
  it('defaults the selection to "Install update now"', () => {
    const choices = createInstallPromptChoices({ version: '0.0.2-beta.1' });

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

  it('moves selection with arrow directions and clamps at the edges', () => {
    expect(moveInstallPromptSelection(1, 'up', 2)).toBe(0);
    expect(moveInstallPromptSelection(0, 'up', 2)).toBe(0);
    expect(moveInstallPromptSelection(0, 'down', 2)).toBe(1);
    expect(moveInstallPromptSelection(1, 'down', 2)).toBe(1);
  });
});

describe('promptForInstallConfirmation', () => {
  it('renders changelog hyperlink in the prompt output', async () => {
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

    const promptPromise = promptForInstallConfirmation({
      currentVersion: '0.4.0',
      target: { version: '0.5.0' },
      installCommand: 'npm install -g @moonshot-ai/kimi-code@0.5.0',
      installSource: 'npm-global',
      input,
      output,
    });

    // Emit keypress to trigger initial render then exit
    input.emit('keypress', '', { name: 'escape' });

    await promptPromise;

    const rendered = outputChunks.join('');
    expect(rendered).toContain(CHANGELOG_URL);
    expect(rendered).toContain('View changelog');
  });
});
