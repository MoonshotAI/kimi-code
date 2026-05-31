import { handleGoalCommand, type SlashCommandHost } from '#/tui/commands/index';
import { describe, expect, it, vi } from 'vitest';

function makeHost(overrides: Partial<SlashCommandHost> = {}): SlashCommandHost {
  return {
    session: {
      getGoal: vi.fn().mockResolvedValue(null),
      pauseGoal: vi.fn().mockRejectedValue(new Error('pause should not be called')),
      resumeGoal: vi.fn().mockRejectedValue(new Error('resume should not be called')),
    },
    showNotice: vi.fn(),
    showError: vi.fn(),
    ...overrides,
  } as unknown as SlashCommandHost;
}

describe('handleGoalCommand', () => {
  it('shows a friendly notice for /goal pause without an active goal', async () => {
    const host = makeHost();

    await handleGoalCommand(host, 'pause');

    expect(host.session?.getGoal).toHaveBeenCalledOnce();
    expect(host.session?.pauseGoal).not.toHaveBeenCalled();
    expect(host.showNotice).toHaveBeenCalledWith('No active goal');
  });

  it('shows a friendly notice for /goal resume without an active goal', async () => {
    const host = makeHost();

    await handleGoalCommand(host, 'resume');

    expect(host.session?.getGoal).toHaveBeenCalledOnce();
    expect(host.session?.resumeGoal).not.toHaveBeenCalled();
    expect(host.showNotice).toHaveBeenCalledWith('No active goal');
  });
});
