import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContextMessage } from '@moonshot-ai/kimi-code-sdk';

import { findLastAssistantText, handleCopyCommand } from '#/tui/commands/copy';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { findBuiltInSlashCommand, resolveSlashCommandAvailability } from '#/tui/commands/index';

const mocks = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(),
}));

vi.mock('#/utils/clipboard/clipboard-text', () => ({
  copyTextToClipboard: mocks.copyTextToClipboard,
}));

function assistantText(text: string, extra: Partial<ContextMessage> = {}): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    toolCalls: [],
    ...extra,
  };
}

function userText(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

function makeHost(history: ContextMessage[]) {
  const host = {
    session: {
      id: 'ses-1',
      getContext: vi.fn(async () => ({ history, tokenCount: 0 })),
    },
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
  it('returns an empty string for empty history', () => {
    expect(findLastAssistantText([])).toBe('');
  });

  it('returns the newest assistant text across later user/tool noise', () => {
    const history = [
      assistantText('first answer'),
      userText('follow-up question'),
      assistantText('second answer'),
      userText('typing…'),
    ];

    expect(findLastAssistantText(history)).toBe('second answer');
  });

  it('joins multiple text parts with a blank line', () => {
    const history: ContextMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'part one' },
          { type: 'think', think: 'hidden reasoning' },
          { type: 'text', text: 'part two' },
        ],
        toolCalls: [],
      },
    ];

    expect(findLastAssistantText(history)).toBe('part one\n\npart two');
  });

  it('skips error, internal, and text-less assistant messages', () => {
    const history = [
      assistantText('real answer'),
      assistantText('api failure', { isError: true }),
      assistantText('hook noise', { origin: { kind: 'hook_result', event: 'Stop' } }),
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: 'call-1', name: 'Bash', arguments: '{"command":"ls"}' },
        ],
      } as ContextMessage,
    ];

    expect(findLastAssistantText(history)).toBe('real answer');
  });
});

describe('handleCopyCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.copyTextToClipboard.mockResolvedValue('native');
  });

  it('copies the last assistant text and reports the character count', async () => {
    const host = makeHost([userText('hi'), assistantText('final summary')]);

    await handleCopyCommand(host);

    expect(mocks.copyTextToClipboard).toHaveBeenCalledWith('final summary');
    expect(host.showStatus).toHaveBeenCalledWith(
      `Copied to clipboard (${String('final summary'.length)} characters).`,
    );
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('marks the copy as unverified when only the terminal escape delivered it', async () => {
    mocks.copyTextToClipboard.mockResolvedValue('osc52');
    const host = makeHost([userText('hi'), assistantText('final summary')]);

    await handleCopyCommand(host);

    expect(host.showStatus).toHaveBeenCalledWith(
      `Copied via terminal escape sequence (unverified, ${String('final summary'.length)} characters).`,
    );
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('warns when there is no assistant message to copy', async () => {
    const host = makeHost([userText('hi')]);

    await handleCopyCommand(host);

    expect(mocks.copyTextToClipboard).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('No assistant message to copy.', 'warning');
  });

  it('shows an error when there is no active session', async () => {
    const host = makeHost([]);
    (host as { session?: unknown }).session = undefined;

    await handleCopyCommand(host);

    expect(host.showError).toHaveBeenCalledOnce();
    expect(mocks.copyTextToClipboard).not.toHaveBeenCalled();
  });

  it('shows an error when the clipboard write fails', async () => {
    mocks.copyTextToClipboard.mockRejectedValue(new Error('pbcopy exited'));
    const host = makeHost([assistantText('final summary')]);

    await handleCopyCommand(host);

    expect(host.showError).toHaveBeenCalledWith('Failed to copy to clipboard: pbcopy exited');
  });
});
