import { describe, expect, it, vi } from 'vitest';

import { handleCompactThresholdKCommand } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

type SessionStatusLike = {
  compactionTriggerRatio?: number;
  compactionTriggerRatioOverridden?: boolean;
  compactionTokenBudget?: number;
  compactionTokenBudgetOverridden?: boolean;
};

function makeHost(options: { hasSession?: boolean; status?: SessionStatusLike } = {}) {
  const session = {
    setCompactionTokenBudget: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({
      model: 'kimi-model',
      thinkingEffort: 'high',
      permission: 'auto',
      planMode: false,
      swarmMode: false,
      towerMode: false,
      contextTokens: 0,
      maxContextTokens: 1000,
      contextUsage: 0,
      ...options.status,
    } as SessionStatusLike)),
  };
  const hasSession = options.hasSession ?? true;
  const host = {
    state: { appState: {} },
    session: hasSession ? session : undefined,
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    setAppState: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session };
}

describe('handleCompactThresholdKCommand', () => {
  it('errors when no session is active', async () => {
    const { host, session } = makeHost({ hasSession: false });

    await handleCompactThresholdKCommand(host, '120');

    expect(host.showError).toHaveBeenCalledTimes(1);
    expect(session.setCompactionTokenBudget).not.toHaveBeenCalled();
  });

  it('calls setCompactionTokenBudget(120) when given 120', async () => {
    const { host, session } = makeHost();

    await handleCompactThresholdKCommand(host, '120');

    expect(session.setCompactionTokenBudget).toHaveBeenCalledWith(120);
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('clears the override with "off"', async () => {
    const { host, session } = makeHost();

    await handleCompactThresholdKCommand(host, 'off');

    expect(session.setCompactionTokenBudget).toHaveBeenCalledWith(undefined);
    expect(host.showNotice).toHaveBeenCalledTimes(1);
  });

  it('rejects 0 without touching the session', async () => {
    const { host, session } = makeHost();

    await handleCompactThresholdKCommand(host, '0');

    expect(session.setCompactionTokenBudget).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledTimes(1);
  });

  it('rejects negative values without touching the session', async () => {
    const { host, session } = makeHost();

    await handleCompactThresholdKCommand(host, '-5');

    expect(session.setCompactionTokenBudget).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledTimes(1);
  });

  it('rejects non-numeric values without touching the session', async () => {
    const { host, session } = makeHost();

    await handleCompactThresholdKCommand(host, 'abc');

    expect(session.setCompactionTokenBudget).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledTimes(1);
  });

  it('rejects decimals without touching the session', async () => {
    const { host, session } = makeHost();

    await handleCompactThresholdKCommand(host, '2.5');

    expect(session.setCompactionTokenBudget).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledTimes(1);
  });

  it('rejects exponent notation without touching the session', async () => {
    const { host, session } = makeHost();

    await handleCompactThresholdKCommand(host, '1e6');

    expect(session.setCompactionTokenBudget).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledTimes(1);
  });

  it('shows the effective token budget with its source when called without arguments', async () => {
    const { host } = makeHost({
      status: { compactionTokenBudget: 200_000, compactionTokenBudgetOverridden: true },
    });

    await handleCompactThresholdKCommand(host, '');

    expect(host.showNotice).toHaveBeenCalledWith(
      'Auto-compact token budget: 200000',
      expect.any(String),
    );
    const detail = (host.showNotice as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(detail).toContain('session override');
  });

  it('reports the built-in default when no override and no config is set', async () => {
    const { host } = makeHost({ status: {} });

    await handleCompactThresholdKCommand(host, '');

    expect(host.showNotice).toHaveBeenCalledWith(
      expect.stringMatching(/^Auto-compact token budget: \d+$/),
      expect.any(String),
    );
    const detail = (host.showNotice as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(detail).toContain('built-in default');
  });

  it('surfaces engine errors when setting fails', async () => {
    const { host, session } = makeHost();
    (session.setCompactionTokenBudget as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('engine says no'),
    );

    await handleCompactThresholdKCommand(host, '120');

    expect(host.showError).toHaveBeenCalledTimes(1);
  });
});
