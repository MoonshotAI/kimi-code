import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@moonshot-ai/kimi-code-sdk';

import { handleTowerCommand } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import {
  LLM_NOT_SET_MESSAGE,
  TOWER_STATUS_PROMPT,
  TOWER_TEARDOWN_PROMPT,
} from '#/tui/constant/kimi-tui';

function makeHost(
  overrides: {
    hasSession?: boolean;
    towerMode?: boolean;
    engineV2?: boolean;
    refuseTowerEntry?: boolean;
    model?: string;
  } = {},
) {
  let engineMode = overrides.towerMode ?? false;
  const session = {
    setTowerMode: vi.fn(async (enabled: boolean) => {
      if (!(overrides.refuseTowerEntry && enabled)) engineMode = enabled;
    }),
    getStatus: vi.fn(async () => ({ towerMode: engineMode })),
  };
  const hasSession = overrides.hasSession ?? true;
  const host = {
    state: {
      appState: {
        towerMode: overrides.towerMode ?? false,
        model: overrides.model ?? 'test-model',
      },
    },
    engineV2: overrides.engineV2 ?? true,
    session: hasSession ? session : undefined,
    ensureSession: vi.fn(async () => {
      host.session = session as unknown as Session;
      return session as unknown as Session;
    }),
    requireSession: () => {
      if (host.session === undefined) throw new Error('No active session');
      return host.session;
    },
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(host.state.appState, patch)),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    sendNormalUserInput: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session };
}

describe('handleTowerCommand', () => {
  it('reports tower status when called without args, without touching the mode', async () => {
    const { host, session } = makeHost({ towerMode: false });

    await handleTowerCommand(host, '');

    expect(host.sendNormalUserInput).toHaveBeenCalledWith(TOWER_STATUS_PROMPT);
    expect(session.setTowerMode).not.toHaveBeenCalled();
    expect(host.ensureSession).not.toHaveBeenCalled();
  });

  it('reports tower status for the status subcommand, without touching the mode', async () => {
    const { host, session } = makeHost({ towerMode: true });

    await handleTowerCommand(host, 'status');

    expect(host.sendNormalUserInput).toHaveBeenCalledWith(TOWER_STATUS_PROMPT);
    expect(session.setTowerMode).not.toHaveBeenCalled();
  });

  it('sends the teardown instruction for the teardown subcommand, without touching the mode', async () => {
    const { host, session } = makeHost({ towerMode: true });

    await handleTowerCommand(host, 'teardown');

    expect(host.sendNormalUserInput).toHaveBeenCalledWith(TOWER_TEARDOWN_PROMPT);
    expect(session.setTowerMode).not.toHaveBeenCalled();
  });

  it('turns tower mode on with an explicit on subcommand', async () => {
    const { host, session } = makeHost({ towerMode: false });

    await handleTowerCommand(host, 'on');

    expect(session.setTowerMode).toHaveBeenCalledWith(true);
    expect(host.setAppState).toHaveBeenCalledWith({ towerMode: true });
    expect(host.showNotice).toHaveBeenCalledWith('Tower mode: ON');
    expect(host.showError).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('turns tower mode off with an explicit off subcommand', async () => {
    const { host, session } = makeHost({ towerMode: true });

    await handleTowerCommand(host, 'off');

    expect(session.setTowerMode).toHaveBeenCalledWith(false);
    expect(host.setAppState).toHaveBeenCalledWith({ towerMode: false });
    expect(host.showNotice).toHaveBeenCalledWith('Tower mode: OFF');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('reasserts the mode idempotently when tower mode is already on', async () => {
    const { host, session } = makeHost({ towerMode: true });

    await handleTowerCommand(host, 'on');

    expect(session.setTowerMode).toHaveBeenCalledWith(true);
    expect(host.showStatus).toHaveBeenCalledWith('Tower mode is already on.');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('reasserts the mode idempotently when tower mode is already off', async () => {
    const { host, session } = makeHost({ towerMode: false });

    await handleTowerCommand(host, 'off');

    expect(session.setTowerMode).toHaveBeenCalledWith(false);
    expect(host.showStatus).toHaveBeenCalledWith('Tower mode is already off.');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('enables tower mode and sends the objective as a normal prompt', async () => {
    const { host, session } = makeHost({ towerMode: false });

    await handleTowerCommand(host, 'Ship feature X');

    expect(session.setTowerMode).toHaveBeenCalledWith(true);
    expect(host.setAppState).toHaveBeenCalledWith({ towerMode: true });
    expect(host.showNotice).toHaveBeenCalledWith('Tower mode: ON');
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('refuses the objective without touching the mode when no model is configured', async () => {
    const { host, session } = makeHost({ towerMode: false, model: '' });

    await handleTowerCommand(host, 'Ship feature X');

    expect(host.showError).toHaveBeenCalledWith(LLM_NOT_SET_MESSAGE);
    expect(session.setTowerMode).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('re-asserts tower mode idempotently for the objective when already on, without a notice', async () => {
    const { host, session } = makeHost({ towerMode: true });

    await handleTowerCommand(host, 'Ship feature X');

    expect(session.setTowerMode).toHaveBeenCalledWith(true);
    expect(host.showNotice).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('does not send the objective when enabling tower mode fails', async () => {
    const { host, session } = makeHost({ towerMode: false });
    session.setTowerMode.mockRejectedValueOnce(new Error('denied'));

    await handleTowerCommand(host, 'Ship feature X');

    expect(host.showError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to enable tower mode'),
    );
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('reports a failure when disabling tower mode fails', async () => {
    const { host, session } = makeHost({ towerMode: true });
    session.setTowerMode.mockRejectedValueOnce(new Error('denied'));

    await handleTowerCommand(host, 'off');

    expect(host.showError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to disable tower mode'),
    );
    expect(host.setAppState).not.toHaveBeenCalledWith({ towerMode: false });
  });

  it('does not show ON or send the objective when the engine refuses entry', async () => {
    const { host } = makeHost({ towerMode: false, refuseTowerEntry: true });

    await handleTowerCommand(host, 'Ship feature X');

    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('could not be enabled'));
    expect(host.setAppState).toHaveBeenCalledWith({ towerMode: false });
    expect(host.showNotice).not.toHaveBeenCalledWith('Tower mode: ON');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('shows an error when no session is active on the legacy engine', async () => {
    const { host, session } = makeHost({ hasSession: false, engineV2: false });

    await handleTowerCommand(host, 'on');

    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('session'));
    expect(host.ensureSession).not.toHaveBeenCalled();
    expect(session.setTowerMode).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('lazy-creates the session on the v2 engine when none exists', async () => {
    const { host, session } = makeHost({ hasSession: false });

    await handleTowerCommand(host, 'on');

    expect(host.ensureSession).toHaveBeenCalled();
    expect(session.setTowerMode).toHaveBeenCalledWith(true);
    expect(host.showNotice).toHaveBeenCalledWith('Tower mode: ON');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('returns quietly when lazy session creation fails', async () => {
    const { host, session } = makeHost({ hasSession: false });
    host.ensureSession = vi.fn(async () => undefined);

    await handleTowerCommand(host, 'on');

    expect(session.setTowerMode).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });
});
