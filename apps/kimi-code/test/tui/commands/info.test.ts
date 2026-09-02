import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { showStatusReport, showUsage } from '#/tui/commands/info';
import { NO_ACTIVE_SESSION_MESSAGE } from '#/tui/constant/kimi-tui';

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

interface CapturedPanel {
  render(width: number): string[];
}

function makeHost(overrides: {
  engineV2: boolean;
  hasSession: boolean;
  /** Simulate an in-flight lazy creation that installs the session when awaited. */
  installSessionOnWait?: boolean;
}) {
  const session = {
    getUsage: vi.fn(async () => ({ byModel: {} })),
    getStatus: vi.fn(async () => ({})),
  };
  const addedPanels: CapturedPanel[] = [];
  const host = {
    engineV2: overrides.engineV2,
    session: undefined as unknown,
    state: {
      appState: {
        version: '1.2.3',
        model: '',
        workDir: '/tmp/project',
        sessionId: '',
        sessionTitle: null,
        thinkingEffort: 'off',
        permissionMode: 'manual',
        planMode: false,
        contextUsage: 0,
        contextTokens: 0,
        maxContextTokens: 0,
        availableModels: {},
      },
      transcriptContainer: {
        addChild: vi.fn((panel: CapturedPanel) => {
          addedPanels.push(panel);
        }),
      },
      ui: { requestRender: vi.fn() },
    },
    requireSession: vi.fn(() => {
      if ((host as { session?: unknown }).session === undefined) {
        throw new Error(NO_ACTIVE_SESSION_MESSAGE);
      }
      return (host as { session?: unknown }).session;
    }),
    waitForLazyCreation: vi.fn(async () => {
      if (overrides.installSessionOnWait === true) {
        (host as { session?: unknown }).session = session;
      }
    }),
  } as unknown as SlashCommandHost;
  if (overrides.hasSession) {
    (host as { session?: unknown }).session = session;
  }
  return { host, addedPanels, session };
}

function renderLastPanel(panels: CapturedPanel[]): string {
  const panel = panels.at(-1);
  expect(panel).toBeDefined();
  return panel!.render(80).map(strip).join('\n');
}

describe('/usage before the first message', () => {
  it('does not tell the user to /login when the v2 engine is session-less', async () => {
    const { host, addedPanels } = makeHost({ engineV2: true, hasSession: false });

    await showUsage(host);

    const output = renderLastPanel(addedPanels);
    expect(output).toContain('No token usage recorded yet.');
    expect(output).not.toContain('/login');
    expect(host.requireSession).not.toHaveBeenCalled();
  });

  it('waits for an in-flight lazy session creation instead of rendering session-less', async () => {
    const { host, session } = makeHost({
      engineV2: true,
      hasSession: false,
      installSessionOnWait: true,
    });

    await showUsage(host);

    expect(host.waitForLazyCreation).toHaveBeenCalledTimes(1);
    expect(session.getUsage).toHaveBeenCalledTimes(1);
  });

  it('keeps the /login hint on the v1 engine, where no session means not signed in', async () => {
    const { host, addedPanels } = makeHost({ engineV2: false, hasSession: false });

    await showUsage(host);

    const output = renderLastPanel(addedPanels);
    expect(output).toContain(NO_ACTIVE_SESSION_MESSAGE);
  });
});

describe('/status before the first message', () => {
  it('shows no login warning when the v2 engine is session-less', async () => {
    const { host, addedPanels } = makeHost({ engineV2: true, hasSession: false });

    await showStatusReport(host);

    const output = renderLastPanel(addedPanels);
    expect(output).toContain('Session      none');
    expect(output).not.toContain('/login');
    expect(host.requireSession).not.toHaveBeenCalled();
  });

  it('waits for an in-flight lazy session creation instead of rendering session-less', async () => {
    const { host, session } = makeHost({
      engineV2: true,
      hasSession: false,
      installSessionOnWait: true,
    });

    await showStatusReport(host);

    expect(host.waitForLazyCreation).toHaveBeenCalledTimes(1);
    expect(session.getStatus).toHaveBeenCalledTimes(1);
  });

  it('keeps the /login warning on the v1 engine', async () => {
    const { host, addedPanels } = makeHost({ engineV2: false, hasSession: false });

    await showStatusReport(host);

    const output = renderLastPanel(addedPanels);
    expect(output).toContain(NO_ACTIVE_SESSION_MESSAGE);
  });
});
