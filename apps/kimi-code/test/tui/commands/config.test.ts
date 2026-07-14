import { describe, expect, it, vi } from 'vitest';

import { handlePlanCommand } from '#/tui/commands/config';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

function makeHost(opts: { planMode?: boolean; hasSession?: boolean } = {}) {
  const session = {
    setPlanMode: vi.fn(async () => {}),
    clearPlan: vi.fn(async () => {}),
    getPlan: vi.fn(async () => null),
  };
  const hasSession = opts.hasSession ?? true;
  const host = {
    state: { appState: { planMode: opts.planMode ?? false } },
    session: hasSession ? session : undefined,
    setAppState: vi.fn((patch: Record<string, unknown>) =>
      Object.assign(host.state.appState, patch),
    ),
    showNotice: vi.fn(),
    showError: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session };
}

describe('handlePlanCommand', () => {
  it('does not re-enter plan mode when already on', async () => {
    const { host, session } = makeHost({ planMode: true });

    await handlePlanCommand(host, 'on');

    expect(session.setPlanMode).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.showNotice).toHaveBeenCalledWith('Plan mode is already on');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('does not leave plan mode when already off', async () => {
    const { host, session } = makeHost({ planMode: false });

    await handlePlanCommand(host, 'off');

    expect(session.setPlanMode).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.showNotice).toHaveBeenCalledWith('Plan mode is already off');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('turns plan mode on when off', async () => {
    const { host, session } = makeHost({ planMode: false });

    await handlePlanCommand(host, 'on');

    expect(session.setPlanMode).toHaveBeenCalledWith(true);
    expect(host.setAppState).toHaveBeenCalledWith({ planMode: true });
    expect(host.showNotice).toHaveBeenCalledWith('Plan mode: ON', undefined);
  });

  it('turns plan mode off when on', async () => {
    const { host, session } = makeHost({ planMode: true });

    await handlePlanCommand(host, 'off');

    expect(session.setPlanMode).toHaveBeenCalledWith(false);
    expect(host.setAppState).toHaveBeenCalledWith({ planMode: false });
    expect(host.showNotice).toHaveBeenCalledWith('Plan mode: OFF');
  });

  it('toggles plan mode on with no args', async () => {
    const { host, session } = makeHost({ planMode: false });

    await handlePlanCommand(host, '');

    expect(session.setPlanMode).toHaveBeenCalledWith(true);
  });

  it('toggles plan mode off with no args', async () => {
    const { host, session } = makeHost({ planMode: true });

    await handlePlanCommand(host, '');

    expect(session.setPlanMode).toHaveBeenCalledWith(false);
  });

  it('clears the plan', async () => {
    const { host, session } = makeHost({ planMode: true });

    await handlePlanCommand(host, 'clear');

    expect(session.clearPlan).toHaveBeenCalledOnce();
    expect(session.setPlanMode).not.toHaveBeenCalled();
    expect(host.showNotice).toHaveBeenCalledWith('Plan cleared');
  });

  it('rejects an unknown subcommand', async () => {
    const { host, session } = makeHost();

    await handlePlanCommand(host, 'bogus');

    expect(session.setPlanMode).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledWith('Unknown plan subcommand: bogus');
  });

  it('records plan mode in appState when there is no active session', async () => {
    const { host, session } = makeHost({ hasSession: false });

    await handlePlanCommand(host, 'on');

    // Session-less startup defers session creation: the choice lands in
    // appState and the lazily created session picks it up.
    expect(session.setPlanMode).not.toHaveBeenCalled();
    expect(host.setAppState).toHaveBeenCalledWith({ planMode: true });
    expect(host.showNotice).toHaveBeenCalledWith('Plan mode: ON');
    expect(host.showError).not.toHaveBeenCalled();
  });
});
