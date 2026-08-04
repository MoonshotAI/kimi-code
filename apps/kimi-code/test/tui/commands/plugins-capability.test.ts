import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __pluginsCommandInternals } from '#/tui/commands/plugins';

const { isCapabilityEntry, installCapabilityFromPanel, pollCapabilityInstall, removePlugin } =
  __pluginsCommandInternals;

function fakeHost(overrides: {
  engineV2?: boolean;
  capabilityStatus?: () => Promise<{
    state?: string;
    install: { running: boolean; step?: string; percent?: number; error?: string };
  }>;
}) {
  const statuses: string[] = [];
  const renders: number[] = [];
  const installCapability = vi.fn(() => Promise.resolve());
  const session = {
    getCapability:
      overrides.capabilityStatus ??
      (() => Promise.resolve({ state: 'ready', steps: [], install: { running: false } })),
    installCapability,
    removePlugin: () => Promise.resolve(),
  };
  const host = {
    engineV2: overrides.engineV2 ?? false,
    // Session-less (lazy session): plugin calls fall back to the harness facade.
    session: undefined,
    harness: {
      removePlugin: () => Promise.resolve(),
    },
    requireSession: () => session,
    showStatus: (text: string) => {
      statuses.push(text);
    },
    showError: (text: string) => {
      statuses.push(text);
    },
    restoreEditor: () => undefined,
    state: { ui: { requestRender: () => renders.push(1) } },
  };
  return { host: host as never, statuses, renders, installCapability };
}

function fakePanel() {
  const lines: (string | undefined)[] = [];
  return {
    panel: {
      setInstalling: (label: string) => {
        lines.push(label);
      },
      clearInstalling: () => {
        lines.push(undefined);
      },
    } as never,
    lines,
  };
}

describe('plugins command capability surface', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('routes built-in entries through capabilities only on v2', () => {
    const v2 = fakeHost({ engineV2: true });
    expect(
      isCapabilityEntry(v2.host, { id: 'kimi-cu', source: 'capability:kimi-cu', builtIn: true } as never),
    ).toBe(true);
    expect(
      isCapabilityEntry(v2.host, {
        id: 'kimi-webbridge',
        source: 'capability:kimi-webbridge',
        builtIn: true,
      } as never),
    ).toBe(true);
    expect(
      isCapabilityEntry(v2.host, { id: 'kimi-cu', source: 'https://example.test/plugin.zip' } as never),
    ).toBe(false);
    // A forged capability: source without the parser-proof flag is a plain row.
    expect(
      isCapabilityEntry(v2.host, { id: 'kimi-cu', source: 'capability:kimi-cu' } as never),
    ).toBe(false);

    const v1 = fakeHost({});
    expect(
      isCapabilityEntry(v1.host, { id: 'kimi-cu', source: 'capability:kimi-cu', builtIn: true } as never),
    ).toBe(false);
  });

  it('polls progress into the panel until the install settles', async () => {
    let calls = 0;
    const { host } = fakeHost({
      capabilityStatus: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({ install: { running: true, step: 'download', percent: 40 } });
        }
        return Promise.resolve({ install: { running: false } });
      },
    });
    const { panel, lines } = fakePanel();

    const result = await pollCapabilityInstall(host, panel, 'kimi-cu', 'Kimi Computer Use');

    expect(result?.install.running).toBe(false);
    expect(lines).toContain('Kimi Computer Use — download 40%');
  });

  it('removePlugin notes that capability runtimes are left untouched', async () => {
    const { host, statuses } = fakeHost({ engineV2: true });
    await removePlugin(host, 'kimi-cu');
    expect(statuses.some((s) => s.includes('Removed kimi-cu'))).toBe(true);
    expect(statuses.some((s) => s.includes('runtime binaries were left untouched'))).toBe(true);
    expect(statuses.some((s) => s.includes('plugin wiring is disabled for new sessions'))).toBe(true);
  });

  it('removePlugin stays quiet for non-capability plugins', async () => {
    const { host, statuses } = fakeHost({ engineV2: true });
    await removePlugin(host, 'superpowers');
    expect(statuses.some((s) => s.includes('runtime binaries'))).toBe(false);
  });

  it('starts a capability install only when none is running', async () => {
    const idle = fakeHost({});
    await installCapabilityFromPanel(
      idle.host,
      fakePanel().panel,
      { id: 'kimi-cu', displayName: 'Kimi Computer Use', source: 'capability:kimi-cu' } as never,
    );
    expect(idle.installCapability).toHaveBeenCalledWith('kimi-cu');
  });

  it('follows an in-progress capability install instead of restarting it', async () => {
    let calls = 0;
    const { host, installCapability, statuses } = fakeHost({
      capabilityStatus: () => {
        calls += 1;
        // The pre-check sees the running install; the poll then sees it settle.
        return Promise.resolve(
          calls === 1
            ? { state: 'partial', steps: [], install: { running: true, step: 'download', percent: 40 } }
            : { state: 'ready', steps: [], install: { running: false } },
        );
      },
    });

    await installCapabilityFromPanel(
      host,
      fakePanel().panel,
      { id: 'kimi-cu', displayName: 'Kimi Computer Use', source: 'capability:kimi-cu' } as never,
    );

    // The service rejects duplicate starts (40922) — a healthy in-progress
    // install must be followed via polling, never reported as a failure.
    expect(installCapability).not.toHaveBeenCalled();
    expect(statuses.some((s) => s.includes('Failed to install'))).toBe(false);
    expect(statuses.some((s) => s.includes('is ready'))).toBe(true);
  });
});
