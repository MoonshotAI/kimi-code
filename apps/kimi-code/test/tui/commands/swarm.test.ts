import { buildSwarmPrompt, handleSwarmCommand } from '#/tui/commands/swarm';
import { describe, expect, it, vi } from 'vitest';

describe('buildSwarmPrompt', () => {
  it('frames the task to force the Swarm tool', () => {
    const p = buildSwarmPrompt('compare three libraries');
    expect(p).toContain('Swarm');
    expect(p).toContain('compare three libraries');
  });
});

describe('handleSwarmCommand', () => {
  it('errors when there is no active session', async () => {
    const showError = vi.fn();
    await handleSwarmCommand({ session: undefined, showError } as never, 'do it');
    expect(showError).toHaveBeenCalled();
  });

  it('errors when args are empty', async () => {
    const showError = vi.fn();
    const prompt = vi.fn();
    await handleSwarmCommand({ session: { prompt }, showError } as never, '   ');
    expect(showError).toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('sends a framed prompt to the session', async () => {
    const prompt = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    const showError = vi.fn();
    await handleSwarmCommand({ session: { prompt }, showError } as never, 'compare libs');
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(String(prompt.mock.calls[0]?.[0])).toContain('compare libs');
  });
});
