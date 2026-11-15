import { describe, expect, it, vi } from 'vitest';

import type { Session } from '@moonshot-ai/kimi-code-sdk';

import { handleTowerCommand } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { TOWER_TEARDOWN_PROMPT } from '#/tui/constant/kimi-tui';

function makeHost(
  overrides: {
    hasSession?: boolean;
    towerMode?: boolean;
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
    getTowerStatus: vi.fn(async (): Promise<string> =>
      engineMode ? 'Tower mode: ON\nTower is not initialized.' : 'Tower mode: OFF',
    ),
  };
  const hasSession = overrides.hasSession ?? true;
  const host = {
    state: {
      appState: {
        towerMode: overrides.towerMode ?? false,
        model: overrides.model ?? 'test-model',
      },
    },
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
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session };
}

describe('handleTowerCommand', () => {
  it('reads tower status without args through the SDK without prompting or touching the editor', async () => {
    const { host, session } = makeHost({ towerMode: false });

    await handleTowerCommand(host, '');

    expect(session.getTowerStatus).toHaveBeenCalledOnce();
    expect(host.showNotice).toHaveBeenCalledWith('Tower mode: OFF', undefined);
    expect(session.setTowerMode).not.toHaveBeenCalled();
    expect(host.ensureSession).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.restoreEditor).not.toHaveBeenCalled();
    expect(host.restoreInputText).not.toHaveBeenCalled();
  });

  it('reports active but uninitialized status without calling it OFF', async () => {
    const { host, session } = makeHost({ towerMode: true });

    await handleTowerCommand(host, 'status');

    expect(session.getTowerStatus).toHaveBeenCalledOnce();
    expect(host.showNotice).toHaveBeenCalledWith('Tower mode: ON', 'Tower is not initialized.');
    expect(host.showNotice).not.toHaveBeenCalledWith('Tower mode: OFF', undefined);
    expect(session.setTowerMode).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('shows the engine-rendered status summary through showNotice', async () => {
    const { host, session } = makeHost({ towerMode: true });
    const detail = [
      'Base: main (mode: branch) · You are: tower',
      'Missions:',
      '  M1 Build engine — active · owner w1 · feat/build-engine',
      'Roster:',
      '  w1 (worker) — mission M1 · agent-w1',
      'Review gate:',
      '  M1 feat/build-engine — BLOCKED: not-completed',
      'Inbox: 2 message(s)',
      'Concurrency: budget: 3 agent(s) · inflight: 1 · spawns open',
      'Recent activity:',
      '  2026-09-30T00:00:00.000Z tower plan missions=1',
    ].join('\n');
    session.getTowerStatus.mockResolvedValueOnce(`Tower status — ON\n${detail}`);

    await handleTowerCommand(host, 'status');

    expect(host.showNotice).toHaveBeenCalledWith('Tower status — ON', detail);

    session.getTowerStatus.mockResolvedValueOnce(`Tower mode: OFF\n${detail}`);
    await handleTowerCommand(host, 'status');

    expect(host.showNotice).toHaveBeenCalledWith('Tower mode: OFF', detail);
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('lazy-creates a missing session before reading tower status', async () => {
    const { host, session } = makeHost({ hasSession: false });

    await handleTowerCommand(host, 'status');

    expect(host.ensureSession).toHaveBeenCalledOnce();
    expect(session.getTowerStatus).toHaveBeenCalledOnce();
    expect(host.showNotice).toHaveBeenCalledWith('Tower mode: OFF', undefined);
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('shows status errors without a prompt fallback', async () => {
    const { host, session } = makeHost({ towerMode: true });
    session.getTowerStatus.mockRejectedValueOnce(new Error('backend unavailable'));

    await handleTowerCommand(host, 'status');

    expect(host.showError).toHaveBeenCalledWith(
      'Failed to read tower status: backend unavailable',
    );
    expect(host.showNotice).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.restoreEditor).not.toHaveBeenCalled();
    expect(host.restoreInputText).not.toHaveBeenCalled();
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

    expect(session.setTowerMode).toHaveBeenCalledWith(true, undefined);
    expect(host.setAppState).toHaveBeenCalledWith({ towerMode: true });
    expect(host.showNotice).toHaveBeenCalledWith('Tower mode: ON');
    expect(host.showError).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('turns tower mode off with an explicit off subcommand', async () => {
    const { host, session } = makeHost({ towerMode: true });

    await handleTowerCommand(host, 'off');

    expect(session.setTowerMode).toHaveBeenCalledWith(false, undefined);
    expect(host.setAppState).toHaveBeenCalledWith({ towerMode: false });
    expect(host.showNotice).toHaveBeenCalledWith('Tower mode: OFF');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('reasserts the mode idempotently when tower mode is already on', async () => {
    const { host, session } = makeHost({ towerMode: true });

    await handleTowerCommand(host, 'on');

    expect(session.setTowerMode).toHaveBeenCalledWith(true, undefined);
    expect(host.showStatus).toHaveBeenCalledWith('Tower mode is already on.');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('reasserts the mode idempotently when tower mode is already off', async () => {
    const { host, session } = makeHost({ towerMode: false });

    await handleTowerCommand(host, 'off');

    expect(session.setTowerMode).toHaveBeenCalledWith(false, undefined);
    expect(host.showStatus).toHaveBeenCalledWith('Tower mode is already off.');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('turns tower mode on with a base branch', async () => {
    const { host, session } = makeHost({ towerMode: false });

    await handleTowerCommand(host, 'develop');

    expect(session.setTowerMode).toHaveBeenCalledWith(true, 'develop');
    expect(host.setAppState).toHaveBeenCalledWith({ towerMode: true });
    expect(host.showNotice).toHaveBeenCalledWith('Tower mode: ON (base: develop)');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('updates the base when tower mode is already on', async () => {
    const { host, session } = makeHost({ towerMode: true });

    await handleTowerCommand(host, 'develop');

    expect(session.setTowerMode).toHaveBeenCalledWith(true, 'develop');
    expect(host.showNotice).toHaveBeenCalledWith('Tower base: develop');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not show the base notice when enabling with a base fails', async () => {
    const { host, session } = makeHost({ towerMode: false });
    session.setTowerMode.mockRejectedValueOnce(new Error('not a local branch'));

    await handleTowerCommand(host, 'develop');

    expect(host.showError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to enable tower mode'),
    );
    expect(host.showNotice).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('reports a failure when enabling tower mode fails', async () => {
    const { host, session } = makeHost({ towerMode: false });
    session.setTowerMode.mockRejectedValueOnce(new Error('denied'));

    await handleTowerCommand(host, 'on');

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

  it('does not show ON when the engine refuses entry', async () => {
    const { host } = makeHost({ towerMode: false, refuseTowerEntry: true });

    await handleTowerCommand(host, 'on');

    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('could not be enabled'));
    expect(host.setAppState).toHaveBeenCalledWith({ towerMode: false });
    expect(host.showNotice).not.toHaveBeenCalledWith('Tower mode: ON');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('lazy-creates the session on the v2 engine when none exists', async () => {
    const { host, session } = makeHost({ hasSession: false });

    await handleTowerCommand(host, 'on');

    expect(host.ensureSession).toHaveBeenCalled();
    expect(session.setTowerMode).toHaveBeenCalledWith(true, undefined);
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
