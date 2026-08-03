import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __pluginsCommandInternals } from '#/tui/commands/plugins';

const { isCapabilityEntry, pollCapabilityInstall, removePlugin } = __pluginsCommandInternals;

function fakeHost(overrides: {
  engineV2?: boolean;
  capabilityIds?: readonly string[];
  capabilityStatus?: () => Promise<{
    install: { running: boolean; step?: string; percent?: number; error?: string };
  }>;
}) {
  const statuses: string[] = [];
  const renders: number[] = [];
  const session = {
    getCapability:
      overrides.capabilityStatus ??
      (() => Promise.resolve({ install: { running: false } })),
    listCapabilities: () =>
      Promise.resolve((overrides.capabilityIds ?? []).map((id) => ({ id }))),
    removePlugin: () => Promise.resolve(),
  };
  const host = {
    engineV2: overrides.engineV2 ?? false,
    requireSession: () => session,
    showStatus: (text: string) => {
      statuses.push(text);
    },
    state: { ui: { requestRender: () => renders.push(1) } },
  };
  return { host: host as never, statuses, renders };
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
      isCapabilityEntry(v2.host, { id: 'kimi-cu', source: 'capability:kimi-cu' } as never),
    ).toBe(true);
    expect(
      isCapabilityEntry(v2.host, {
        id: 'kimi-webbridge',
        source: 'capability:kimi-webbridge',
      } as never),
    ).toBe(true);
    expect(
      isCapabilityEntry(v2.host, { id: 'kimi-cu', source: 'https://example.test/plugin.zip' } as never),
    ).toBe(false);

    const v1 = fakeHost({});
    expect(
      isCapabilityEntry(v1.host, { id: 'kimi-cu', source: 'capability:kimi-cu' } as never),
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
    const { host, statuses } = fakeHost({ engineV2: true, capabilityIds: ['kimi-cu'] });
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
});
