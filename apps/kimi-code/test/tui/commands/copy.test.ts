import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findLastAssistantText, handleCopyCommand } from '#/tui/commands/copy';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { findBuiltInSlashCommand, resolveSlashCommandAvailability } from '#/tui/commands/index';
import type { TranscriptEntry } from '#/tui/types';

const mocks = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(),
}));

vi.mock('#/utils/clipboard/clipboard-text', () => ({
  copyTextToClipboard: mocks.copyTextToClipboard,
}));

let nextEntryId = 0;

function entry(kind: TranscriptEntry['kind'], content: string): TranscriptEntry {
  return {
    id: `entry-${String(nextEntryId++)}`,
    kind,
    renderMode: 'markdown',
    content,
  };
}

function assistantEntry(content: string): TranscriptEntry {
  return { ...entry('assistant', content), modelText: true };
}

function makeHost(entries: TranscriptEntry[]) {
  const host = {
    state: { transcriptEntries: entries },
    showStatus: vi.fn(),
    showError: vi.fn(),
  } as unknown as SlashCommandHost & {
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
  };
  return host;
}

describe('copy slash command', () => {
  it('is registered as an idle-only built-in', () => {
    const command = findBuiltInSlashCommand('copy');
    expect(command).toBeDefined();
    expect(resolveSlashCommandAvailability(command!, '')).toBe('idle-only');
  });
});

describe('findLastAssistantText', () => {
  it('returns an empty string for an empty transcript', () => {
    expect(findLastAssistantText([])).toBe('');
  });

  it('returns the newest assistant entry across later non-assistant entries', () => {
    const entries = [
      assistantEntry('first answer'),
      entry('user', 'follow-up question'),
      assistantEntry('second answer'),
      entry('user', 'typing…'),
      entry('status', 'Working…'),
    ];

    expect(findLastAssistantText(entries)).toBe('second answer');
  });

  it('skips assistant entries with empty or whitespace-only content', () => {
    const entries = [assistantEntry('real answer'), assistantEntry('   \n  ')];

    expect(findLastAssistantText(entries)).toBe('real answer');
  });

  it('ignores thinking and other non-visible-reply kinds', () => {
    const entries = [
      assistantEntry('visible reply'),
      entry('thinking', 'hidden reasoning'),
      entry('tool_call', 'Bash ls'),
    ];

    expect(findLastAssistantText(entries)).toBe('visible reply');
  });

  it('skips synthetic assistant cards like hook results and goal completions', () => {
    const entries = [
      assistantEntry('real reply'),
      entry('assistant', '*PostToolUse hook* ran something'),
      entry('assistant', 'Goal completed: shipped the feature'),
    ];

    expect(findLastAssistantText(entries)).toBe('real reply');
  });
});

describe('handleCopyCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.copyTextToClipboard.mockResolvedValue('native');
  });

  it('copies the last visible assistant text and reports the character count', async () => {
    const host = makeHost([entry('user', 'hi'), assistantEntry('final summary')]);

    await handleCopyCommand(host);

    expect(mocks.copyTextToClipboard).toHaveBeenCalledWith('final summary');
    expect(host.showStatus).toHaveBeenCalledWith(
      `Copied to clipboard (${String('final summary'.length)} characters).`,
    );
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('marks the copy as unverified when only the terminal escape delivered it', async () => {
    mocks.copyTextToClipboard.mockResolvedValue('osc52');
    const host = makeHost([entry('user', 'hi'), assistantEntry('final summary')]);

    await handleCopyCommand(host);

    expect(host.showStatus).toHaveBeenCalledWith(
      `Copied via terminal escape sequence (unverified, ${String('final summary'.length)} characters).`,
    );
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('warns when there is no assistant message to copy', async () => {
    const host = makeHost([entry('user', 'hi')]);

    await handleCopyCommand(host);

    expect(mocks.copyTextToClipboard).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('No assistant message to copy.', 'warning');
  });

  it('shows an error when the clipboard write fails', async () => {
    mocks.copyTextToClipboard.mockRejectedValue(new Error('pbcopy exited'));
    const host = makeHost([assistantEntry('final summary')]);

    await handleCopyCommand(host);

    expect(host.showError).toHaveBeenCalledWith('Failed to copy to clipboard: pbcopy exited');
  });
});
