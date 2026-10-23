import { afterEach, describe, expect, it, vi } from 'vitest';

import { dispatchInput, type SlashCommandHost } from '#/tui/commands/dispatch';
import { setRainbowDance } from '#/tui/easter-eggs/dance';

function makeHost(overrides: { streamingPhase?: string; isCompacting?: boolean } = {}) {
  const state = {
    appState: {
      model: 'k2',
      streamingPhase: overrides.streamingPhase ?? 'idle',
      isCompacting: overrides.isCompacting ?? false,
    },
  };
  const host = {
    state,
    skillCommandMap: new Map<string, string>(),
    pluginCommandMap: new Map<string, string>(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    track: vi.fn(),
    restoreInputText: vi.fn(),
    sendNormalUserInput: vi.fn(),
    sendInlineSkillUserInput: vi.fn(async () => {}),
    enqueueCompactCommand: vi.fn(() => true),
  } as unknown as SlashCommandHost & {
    showError: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    track: ReturnType<typeof vi.fn>;
    sendNormalUserInput: ReturnType<typeof vi.fn>;
    sendInlineSkillUserInput: ReturnType<typeof vi.fn>;
    enqueueCompactCommand: ReturnType<typeof vi.fn>;
  };
  return host;
}

async function flushDispatch(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('dispatchInput unknown slash command', () => {
  afterEach(() => {
    setRainbowDance(undefined);
  });

  it('blocks a mistyped command with a did-you-mean suggestion and sends nothing', async () => {
    const host = makeHost();

    dispatchInput(host, '/usgae');
    await flushDispatch();

    expect(host.showError).toHaveBeenCalledWith('Unknown command: /usgae. Did you mean /usage?');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(host.sendInlineSkillUserInput).not.toHaveBeenCalled();
    expect(host.enqueueCompactCommand).not.toHaveBeenCalled();
  });

  it('lists up to several suggestions when more than one candidate is close', async () => {
    const host = makeHost();
    host.skillCommandMap.set('xya', 'skill-a');
    host.skillCommandMap.set('xyb', 'skill-b');
    host.skillCommandMap.set('xyc', 'skill-c');

    dispatchInput(host, '/xyz');
    await flushDispatch();

    expect(host.showError).toHaveBeenCalledWith(
      'Unknown command: /xyz. Did you mean one of /xya, /xyb, /xyc?',
    );
  });

  it('points at the command list and the leading-space escape hatch when nothing is close', async () => {
    const host = makeHost();

    dispatchInput(host, '/xyzzy');
    await flushDispatch();

    expect(host.showError).toHaveBeenCalledWith(
      'Unknown command: /xyzzy. Type "/" for a list of supported commands. To send it as a message, start the line with a space.',
    );
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('shows the escape hatch only when there are no suggestions', async () => {
    const host = makeHost();

    dispatchInput(host, '/usgae');
    await flushDispatch();

    const message = host.showError.mock.calls[0]?.[0] as string;
    expect(message).not.toContain('start the line with a space');
  });

  it('blocks an unknown command immediately even while the agent is busy', async () => {
    const host = makeHost({ streamingPhase: 'streaming', isCompacting: true });

    dispatchInput(host, '/usgae');
    await flushDispatch();

    expect(host.showError).toHaveBeenCalledWith('Unknown command: /usgae. Did you mean /usage?');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(host.enqueueCompactCommand).not.toHaveBeenCalled();
  });

  it('lets /dance claim the input before the unknown-command error is shown', async () => {
    const start = vi.fn();
    setRainbowDance({ colored: false, phase: 0, start, stop: vi.fn(), dispose: vi.fn() });
    const host = makeHost();

    dispatchInput(host, '/dance on');
    await flushDispatch();

    expect(start).toHaveBeenCalledWith({ hold: true });
    expect(host.showError).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('tracks the rejected command', async () => {
    const host = makeHost();

    dispatchInput(host, '/usgae');
    await flushDispatch();

    expect(host.track).toHaveBeenCalledWith('input_command_invalid', {
      reason: 'unknown',
      command: 'usgae',
    });
  });
});
