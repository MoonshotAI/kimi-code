import { describe, expect, it, vi } from 'vitest';

import { handlePlanCommand } from '#/tui/commands/config';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

function makeHost() {
  const session = {
    clearPlan: vi.fn(async () => {}),
    getPlan: vi.fn(async () => ({ path: '/tmp/current-plan.md' })),
    setPlanMode: vi.fn(async () => {}),
  };
  const host = {
    state: {
      appState: {
        planMode: false,
      },
    },
    session,
    setAppState: vi.fn((patch: Record<string, unknown>) => {
      Object.assign(host.state.appState, patch);
    }),
    showError: vi.fn(),
    showNotice: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session };
}

describe('handlePlanCommand', () => {
  it('toggles plan mode without appending a transcript notice', async () => {
    const { host, session } = makeHost();

    await handlePlanCommand(host, 'on');

    expect(session.setPlanMode).toHaveBeenCalledWith(true);
    expect(host.setAppState).toHaveBeenCalledWith({ planMode: true });
    expect(host.showNotice).not.toHaveBeenCalled();
  });

  it('turns plan mode off without appending a transcript notice', async () => {
    const { host, session } = makeHost();
    host.state.appState.planMode = true;

    await handlePlanCommand(host, 'off');

    expect(session.setPlanMode).toHaveBeenCalledWith(false);
    expect(host.setAppState).toHaveBeenCalledWith({ planMode: false });
    expect(host.showNotice).not.toHaveBeenCalled();
  });

  it('keeps the explicit clear command feedback', async () => {
    const { host, session } = makeHost();

    await handlePlanCommand(host, 'clear');

    expect(session.clearPlan).toHaveBeenCalled();
    expect(host.showNotice).toHaveBeenCalledWith('Plan cleared');
  });
});
