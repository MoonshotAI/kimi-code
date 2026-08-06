import { beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '@moonshot-ai/kimi-code-sdk';

import { __pluginsCommandInternals } from '#/tui/commands/plugins';

const {
  isCapabilityEntry,
  installCapabilityFromPanel,
  isDefaultMarketplaceCatalog,
  pollCapabilityInstall,
  removePlugin,
} = __pluginsCommandInternals;

function fakeHost(overrides: {
  engineV2?: boolean;
  capabilityStatus?: () => Promise<{
    state?: string;
    steps?: readonly unknown[];
    install: { running: boolean; step?: string; percent?: number; error?: string };
  }>;
}) {
  const statuses: string[] = [];
  const renders: number[] = [];
  const installCapability = vi.fn(() => Promise.resolve());
  const getCapability =
    overrides.capabilityStatus ??
    (() => Promise.resolve({ state: 'ready', steps: [], install: { running: false } }));
  const host = {
    engineV2: overrides.engineV2 ?? false,
    // Session-less (lazy session): plugin and capability calls fall back to
    // the harness facade.
    session: undefined,
    harness: {
      removePlugin: () => Promise.resolve(),
      getCapability,
      installCapability,
      listCapabilities: () => Promise.resolve([]),
    },
    requireSession: () => ({
      getCapability,
      installCapability,
    }),
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
    vi.spyOn(log, 'info').mockImplementation(() => undefined);
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
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

  it('logs progress without replacing the generic installing label', async () => {
    let calls = 0;
    const { host } = fakeHost({
      engineV2: true,
      capabilityStatus: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({ install: { running: true, step: 'download', percent: 40 } });
        }
        return Promise.resolve({ install: { running: false } });
      },
    });
    const result = await pollCapabilityInstall(host, 'kimi-cu');

    expect(result?.install.running).toBe(false);
    expect(log.info).toHaveBeenCalledWith('capability install progress', {
      capabilityId: 'kimi-cu',
      step: 'download',
      percent: 40,
    });
  });

  it('removePlugin notes that capability runtimes are left untouched', async () => {
    const { host, statuses } = fakeHost({ engineV2: true });
    await removePlugin(host, 'kimi-cu');
    expect(statuses.some((s) => s.includes('Removed kimi-cu'))).toBe(true);
    expect(statuses.some((s) => s.includes('runtime binaries were left untouched'))).toBe(true);
    expect(statuses.some((s) => s.includes('plugin wiring is disabled for new sessions'))).toBe(true);
  });

  it('keeps the runtime note for the Windows backing plugin id', async () => {
    const { host, statuses } = fakeHost({ engineV2: true });
    await removePlugin(host, 'kimi-cu-win');
    expect(statuses.some((s) => s.includes('Removed kimi-cu-win'))).toBe(true);
    expect(statuses.some((s) => s.includes('runtime binaries were left untouched'))).toBe(true);
  });

  it('treats only the default catalog (and the dev server) as injectable', () => {
    expect(isDefaultMarketplaceCatalog(undefined, {})).toBe(true);
    // The dev marketplace server started by scripts/dev.mjs serves this
    // repo's own catalog — it counts as default, not as a user override.
    expect(
      isDefaultMarketplaceCatalog(undefined, {
        KIMI_CODE_PLUGIN_MARKETPLACE_URL: 'http://127.0.0.1:60056/marketplace.json',
        KIMI_CODE_PLUGIN_MARKETPLACE_FROM_DEV_SERVER: '1',
      }),
    ).toBe(true);
    expect(
      isDefaultMarketplaceCatalog(undefined, {
        KIMI_CODE_PLUGIN_MARKETPLACE_URL: 'https://example.test/marketplace.json',
      }),
    ).toBe(false);
    expect(isDefaultMarketplaceCatalog('https://example.test/marketplace.json', {})).toBe(false);
  });

  it('removePlugin stays quiet for non-capability plugins', async () => {
    const { host, statuses } = fakeHost({ engineV2: true });
    await removePlugin(host, 'superpowers');
    expect(statuses.some((s) => s.includes('runtime binaries'))).toBe(false);
  });

  it('starts a capability install only when none is running', async () => {
    const idle = fakeHost({ engineV2: true });
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
      engineV2: true,
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
    expect(statuses.some((s) => s.includes('is installed'))).toBe(true);
  });

  it('shows required permissions once after installation instead of exposing step details', async () => {
    const { host, statuses } = fakeHost({
      engineV2: true,
      capabilityStatus: () => Promise.resolve({
        id: 'kimi-cu',
        state: 'partial',
        steps: [{ id: 'permissions', state: 'missing', detail: 'screenRecording' }],
        install: { running: false },
      }),
    });

    await installCapabilityFromPanel(
      host,
      fakePanel().panel,
      { id: 'kimi-cu', displayName: 'Kimi Computer Use', source: 'capability:kimi-cu' } as never,
    );

    expect(statuses.some((s) => s.includes('Grant Accessibility and Screen Recording'))).toBe(true);
    expect(statuses.some((s) => s.includes('screenRecording'))).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      'capability needs attention',
      expect.objectContaining({
        capabilityId: 'kimi-cu',
        steps: [expect.objectContaining({ detail: 'screenRecording' })],
      }),
    );
  });
});
