import { describe, expect, it, vi } from 'vitest';

import { handleCompactThresholdCommand } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

type SessionStatusLike = {
  compactionTriggerRatio?: number;
  compactionTriggerRatioOverridden?: boolean;
};

function makeHost(options: { hasSession?: boolean; status?: SessionStatusLike } = {}) {
  const session = {
    setCompactionTriggerRatio: vi.fn(async () => {}),
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
      ...(options.status ?? {}),
    })),
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

describe('handleCompactThresholdCommand', () => {
  it('errors when no session is active', async () => {
    const { host, session } = makeHost({ hasSession: false });

    await handleCompactThresholdCommand(host, '0.3');

    expect(host.showError).toHaveBeenCalledTimes(1);
    expect(session.setCompactionTriggerRatio).not.toHaveBeenCalled();
  });

  it('shows the effective threshold with its source when called without arguments', async () => {
    const { host } = makeHost({
      status: { compactionTriggerRatio: 0.3, compactionTriggerRatioOverridden: true },
    });

    await handleCompactThresholdCommand(host, '');

    expect(host.showNotice).toHaveBeenCalledWith('Auto-compact threshold: 0.3', expect.any(String));
    const detail = (host.showNotice as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(detail).toContain('session override');
  });

  it('reports the config source when the value comes from config.toml', async () => {
    const { host } = makeHost({ status: { compactionTriggerRatio: 0.7 } });

    await handleCompactThresholdCommand(host, '   ');

    expect(host.showNotice).toHaveBeenCalledWith('Auto-compact threshold: 0.7', expect.any(String));
    const detail = (host.showNotice as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(detail).toContain('config.toml');
  });

  it('reports the built-in default when neither override nor config is set', async () => {
    const { host } = makeHost({ status: {} });

    await handleCompactThresholdCommand(host, '');

    expect(host.showNotice).toHaveBeenCalledWith(
      'Auto-compact threshold: 0.85',
      expect.any(String),
    );
  });

  it('sets a valid in-range ratio as the session override', async () => {
    const { host, session } = makeHost();

    await handleCompactThresholdCommand(host, '0.3');

    expect(session.setCompactionTriggerRatio).toHaveBeenCalledWith(0.3);
    expect(host.showNotice).toHaveBeenCalledTimes(1);
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('accepts the new 0.05 minimum boundary', async () => {
    const { host, session } = makeHost();

    await handleCompactThresholdCommand(host, '0.05');

    expect(session.setCompactionTriggerRatio).toHaveBeenCalledWith(0.05);
  });

  it('rejects values below 0.05 without touching the session', async () => {
    const { host, session } = makeHost();

    await handleCompactThresholdCommand(host, '0.04');

    expect(session.setCompactionTriggerRatio).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledTimes(1);
  });

  it('rejects values above 0.99 without touching the session', async () => {
    const { host, session } = makeHost();

    await handleCompactThresholdCommand(host, '1.5');

    expect(session.setCompactionTriggerRatio).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledTimes(1);
  });

  it('rejects non-numeric values without touching the session', async () => {
    const { host, session } = makeHost();

    await handleCompactThresholdCommand(host, 'abc');

    expect(session.setCompactionTriggerRatio).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledTimes(1);
  });

  it('clears the override with "off"', async () => {
    const { host, session } = makeHost();

    await handleCompactThresholdCommand(host, 'off');

    expect(session.setCompactionTriggerRatio).toHaveBeenCalledWith(undefined);
    expect(host.showNotice).toHaveBeenCalledTimes(1);
  });

  it('surfaces engine errors when setting fails', async () => {
    const { host, session } = makeHost();
    (session.setCompactionTriggerRatio as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('engine says no'),
    );

    await handleCompactThresholdCommand(host, '0.4');

    expect(host.showError).toHaveBeenCalledTimes(1);
  });
});