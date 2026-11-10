import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  log,
  type InstallPluginInput,
  type PluginSummary,
} from '@moonshot-ai/kimi-code-sdk';
import { resetCapabilitiesCache, setCapabilities, type Component } from '@moonshot-ai/pi-tui';

import { __pluginsCommandInternals } from '#/tui/commands/plugins';
import { NoticeMessageComponent } from '#/tui/components/messages/status-message';
import { PluginStopProcessesConfirmComponent } from '#/tui/components/dialogs/plugins-selector';
import {
  capabilityIdForMarketplaceEntry,
  installedPluginForMarketplaceEntry,
} from '#/tui/utils/capability-marketplace';

const {
  installCapabilityFromPanel,
  installMarketplaceEntryFromPanel,
  installPluginFromSource,
  isDefaultMarketplaceCatalog,
  loadMarketplaceCatalog,
  pollCapabilityInstall,
  removePlugin,
} = __pluginsCommandInternals;

function fakeHost(overrides: {
  capabilityStatus?: () => Promise<{
    state?: string;
    steps?: readonly unknown[];
    install: {
      running: boolean;
      step?: string;
      percent?: number;
      error?: string;
      confirmationRequired?: 'stop-processes';
    };
  }>;
  installed?: readonly PluginSummary[];
}) {
  const statuses: string[] = [];
  const notices: { title: string; detail?: string }[] = [];
  const renders: number[] = [];
  const transcriptEntries: Component[] = [];
  const installed = overrides.installed ?? [];
  const installCapability = vi.fn(() => Promise.resolve());
  const installPlugin = vi.fn((input: InstallPluginInput): Promise<PluginSummary> => {
    const marketplace = 'marketplaceId' in input;
    const id = marketplace ? input.marketplaceId : 'custom-plugin';
    return Promise.resolve({
      id,
      displayName: id,
      version: marketplace ? input.expectedVersion : '1.0.0',
      enabled: true,
      state: 'ok',
      skillCount: 0,
      mcpServerCount: 0,
      enabledMcpServerCount: 0,
      hookCount: 0,
      commandCount: 0,
      hasErrors: false,
      source: marketplace ? 'zip-url' : 'local-path',
      originalSource: marketplace
        ? 'https://code.kimi.com/kimi-code/plugins/official/demo.zip'
        : undefined,
      origin: marketplace ? 'marketplace' : 'custom',
      installedAt: '2026-01-01T00:00:00.000Z',
    });
  });
  const getCapability =
    overrides.capabilityStatus ??
    (() => Promise.resolve({ state: 'ready', steps: [], install: { running: false } }));
  const reloadPlugins = vi.fn(async () => undefined);
  const refreshPluginCommands = vi.fn(async () => undefined);
  const mountEditorReplacement = vi.fn();
  const restoreEditor = vi.fn();
  const host = {
    session: undefined,
    harness: {
      listPlugins: () => Promise.resolve(installed),
      installPlugin,
      removePlugin: () => Promise.resolve(),
      reloadPlugins,
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
    showNotice: (title: string, detail?: string) => {
      notices.push({ title, detail });
      transcriptEntries.push(new NoticeMessageComponent(title, detail));
    },
    refreshPluginCommands,
    restoreEditor,
    mountEditorReplacement,
    state: {
      appState: { workDir: '/workspace' },
      ui: { requestRender: () => renders.push(1) },
      transcriptContainer: {
        addChild: (entry: Component) => transcriptEntries.push(entry),
      },
    },
  };
  return {
    host: host as never,
    statuses,
    notices,
    renders,
    transcriptEntries,
    installCapability,
    installPlugin,
    reloadPlugins,
    refreshPluginCommands,
    mountEditorReplacement,
    restoreEditor,
  };
}

function installedPlugin(id: string, version = '1.0.0'): PluginSummary {
  return {
    id,
    displayName: id,
    version,
    enabled: true,
    state: 'ok',
    skillCount: 0,
    mcpServerCount: 0,
    enabledMcpServerCount: 0,
    hookCount: 0,
    commandCount: 0,
    hasErrors: false,
    source: 'local-path',
    origin: 'custom',
    installedAt: '2026-01-01T00:00:00.000Z',
  };
}

function fakePanel(
  expectedVersion?: (entry: { version?: string }) => string | undefined,
) {
  const lines: (string | undefined)[] = [];
  return {
    panel: {
      setInstalling: (label: string) => {
        lines.push(label);
      },
      clearInstalling: () => {
        lines.push(undefined);
      },
      expectedMarketplaceVersion: expectedVersion ?? ((entry: { version?: string }) => entry.version),
    } as never,
    lines,
  };
}

function visibleLines(entries: readonly Component[], width = 100): string[] {
  return entries
    .flatMap((entry) => entry.render(width))
    .map((line) =>
      line
        .replaceAll(/\u001B]8;;[^\u001B]*\u001B\\/g, '')
        .replaceAll(/\u001B\[[0-9;]*m/g, '')
        .trimEnd(),
    );
}

function unwrappedVisibleText(entries: readonly Component[]): string {
  return visibleLines(entries)
    .join('\n')
    .replaceAll(/\s+/g, '');
}

describe('plugins command capability surface', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(log, 'info').mockImplementation(() => undefined);
    vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetCapabilitiesCache();
  });

  it('maps only known default-catalog entries to capabilities', () => {
    expect(capabilityIdForMarketplaceEntry('kimi-browser-extension', true)).toBe('kimi-webbridge');
    expect(capabilityIdForMarketplaceEntry('kimi-webbridge', true)).toBeUndefined();
    expect(capabilityIdForMarketplaceEntry('kimi-cu', true)).toBe('kimi-cu');
    expect(capabilityIdForMarketplaceEntry('kimi-cu-win', true)).toBe('kimi-cu');
    expect(capabilityIdForMarketplaceEntry('kimi-browser-extension', false)).toBeUndefined();
    expect(capabilityIdForMarketplaceEntry('kimi-cu', false)).toBeUndefined();
    expect(capabilityIdForMarketplaceEntry('superpowers', true)).toBeUndefined();
  });

  it('matches ordinary marketplace installs by catalog provenance', () => {
    const custom = installedPlugin('demo');
    const marketplace = { ...installedPlugin('renamed'), origin: 'marketplace' as const, catalogId: 'demo' };
    const legacy = { ...installedPlugin('demo'), origin: 'unknown' as const };

    expect(installedPluginForMarketplaceEntry('demo', [custom], undefined, true)).toBeUndefined();
    expect(installedPluginForMarketplaceEntry('demo', [marketplace], undefined, true)).toBe(marketplace);
    expect(installedPluginForMarketplaceEntry('demo', [legacy], undefined, true)).toBe(legacy);
  });

  it('refreshes plugin slash commands after marketplace availability reloads', async () => {
    const home = await mkdtemp(join(tmpdir(), 'plugins-command-marketplace-'));
    try {
      const { host, reloadPlugins, refreshPluginCommands } = fakeHost({});
      const setInstalled = vi.fn();
      const panel = {
        setInstalled,
        setMarketplace: vi.fn(),
        setMarketplaceCatalogVersions: vi.fn(),
        setMarketplaceError: vi.fn(),
      } as never;
      vi.stubEnv('KIMI_CODE_HOME', home);
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        plugins: [{
          id: 'demo',
          displayName: 'Demo',
          version: '1.0.0',
          source: 'https://cdn.example.test/demo.zip',
          clients: ['desktop'],
        }],
      }), { status: 200 })));

      await loadMarketplaceCatalog(host, panel, 'https://marketplace.test/catalog');

      expect(reloadPlugins).toHaveBeenCalledOnce();
      expect(refreshPluginCommands).toHaveBeenCalledOnce();
      expect(setInstalled).toHaveBeenCalledOnce();
      expect(refreshPluginCommands.mock.invocationCallOrder[0]).toBeGreaterThan(
        reloadPlugins.mock.invocationCallOrder[0]!,
      );

      await loadMarketplaceCatalog(host, panel, 'https://marketplace.test/catalog');
      expect(reloadPlugins).toHaveBeenCalledOnce();
      expect(refreshPluginCommands).toHaveBeenCalledOnce();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('installs ordinary marketplace entries by id, expected version and digest', async () => {
    const { host, installCapability, installPlugin } = fakeHost({});
    await installMarketplaceEntryFromPanel(
      host,
      fakePanel().panel,
      {
        id: 'demo',
        displayName: 'Demo',
        version: '2.0.0',
        sha256sum: 'a'.repeat(64),
        source: 'https://code.kimi.com/kimi-code/plugins/official/demo.zip',
      } as never,
      true,
    );

    expect(installPlugin).toHaveBeenCalledWith({
      marketplaceId: 'demo',
      expectedVersion: '2.0.0',
      expectedSha256: 'a'.repeat(64),
      migrateFrom: undefined,
      marketplaceSource: undefined,
    });
    expect(installCapability).not.toHaveBeenCalled();
  });

  it('installs a custom marketplace entry without a version or digest', async () => {
    const { host, installPlugin } = fakeHost({});
    await installMarketplaceEntryFromPanel(
      host,
      fakePanel().panel,
      {
        id: 'demo',
        displayName: 'Demo',
        source: 'https://code.kimi.com/kimi-code/plugins/official/demo.zip',
      } as never,
      false,
    );

    expect(installPlugin).toHaveBeenCalledWith({
      marketplaceId: 'demo',
      expectedVersion: undefined,
      expectedSha256: undefined,
      migrateFrom: undefined,
      marketplaceSource: undefined,
    });
  });

  it('uses the raw catalog version instead of an enriched display version', async () => {
    const { host, installPlugin } = fakeHost({});
    const { panel } = fakePanel(() => undefined);

    await installMarketplaceEntryFromPanel(
      host,
      panel,
      {
        id: 'demo',
        displayName: 'Demo',
        version: '7.0.0',
        source: 'https://code.kimi.com/kimi-code/plugins/official/demo.zip',
      } as never,
      false,
    );

    expect(installPlugin).toHaveBeenCalledWith({
      marketplaceId: 'demo',
      expectedVersion: undefined,
      expectedSha256: undefined,
      migrateFrom: undefined,
      marketplaceSource: undefined,
    });
  });

  it('installs custom sources with a source input', async () => {
    const { host, installCapability, installPlugin } = fakeHost({});
    await installPluginFromSource(host, './demo');

    expect(installPlugin).toHaveBeenCalledWith({ source: resolve('/workspace', 'demo') });
    expect(installCapability).not.toHaveBeenCalled();
  });

  it.each([
    ['kimi-browser-extension', 'kimi-webbridge'],
    ['kimi-cu-win', 'kimi-cu'],
  ] as const)('dispatches %s to the %s capability', async (entryId, capabilityId) => {
    const { host, installCapability, installPlugin } = fakeHost({});
    await installMarketplaceEntryFromPanel(
      host,
      fakePanel().panel,
      {
        id: entryId,
        displayName: entryId,
        version: '1.0.0',
        source: 'https://example.test/plugin.zip',
      } as never,
      true,
    );

    expect(installCapability).toHaveBeenCalledWith(capabilityId);
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it('rejects a stale legacy WebBridge selection without a ZIP install fallback', async () => {
    const { host, installCapability, installPlugin } = fakeHost({});
    await expect(
      installMarketplaceEntryFromPanel(
        host,
        fakePanel().panel,
        {
          id: 'kimi-webbridge',
          displayName: 'Legacy WebBridge',
          version: '1.0.0',
          source: 'https://example.test/legacy.zip',
        } as never,
        false,
        '/tmp/legacy.json',
      ),
    ).rejects.toThrow('install "kimi-browser-extension" instead');

    expect(installCapability).not.toHaveBeenCalled();
    expect(installPlugin).not.toHaveBeenCalled();
  });

  it('keeps the selected catalog for a same-id/version artifact and migrates legacy ids', async () => {
    const { host, installCapability, installPlugin } = fakeHost({
      installed: [
        installedPlugin('kimi-webbridge'),
        installedPlugin('kimi-browser-extension', '2.0.0'),
      ],
    });
    await installMarketplaceEntryFromPanel(
      host,
      fakePanel().panel,
      {
        id: 'kimi-browser-extension',
        displayName: 'Kimi Browser Extension',
        version: '3.0.0',
        sha256sum: 'b'.repeat(64),
        source: 'https://code.kimi.com/kimi-code/plugins/official/alternate/kimi-browser-extension.zip',
        builtIn: true,
      } as never,
      false,
      '/tmp/alternate-marketplace.json',
    );

    expect(installCapability).not.toHaveBeenCalled();
    expect(installPlugin).toHaveBeenCalledWith({
      marketplaceId: 'kimi-browser-extension',
      expectedVersion: '3.0.0',
      expectedSha256: 'b'.repeat(64),
      migrateFrom: 'kimi-webbridge',
      marketplaceSource: '/tmp/alternate-marketplace.json',
    });
  });

  it('logs progress without replacing the generic installing label', async () => {
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
    const result = await pollCapabilityInstall(host, 'kimi-cu');

    expect(result?.install.running).toBe(false);
    expect(log.info).toHaveBeenCalledWith('capability install progress', {
      capabilityId: 'kimi-cu',
      step: 'download',
      percent: 40,
    });
  });

  it('removePlugin notes that capability environments are left untouched', async () => {
    const { host, statuses } = fakeHost({});
    await removePlugin(host, 'kimi-cu');
    expect(statuses.some((s) => s.includes('Removed kimi-cu'))).toBe(true);
    expect(statuses.some((s) => s.includes('runtime binaries were left untouched'))).toBe(true);
    expect(statuses.some((s) => s.includes('plugin wiring is disabled for new sessions'))).toBe(true);
    expect(statuses.some((s) => s.includes('Restart Kimi Code before reinstalling'))).toBe(true);
    expect(statuses.some((s) => s.includes('Run /new or /reload'))).toBe(false);
  });

  it('keeps the runtime note for the Windows backing plugin id', async () => {
    const { host, statuses } = fakeHost({});
    await removePlugin(host, 'kimi-cu-win');
    expect(statuses.some((s) => s.includes('Removed kimi-cu-win'))).toBe(true);
    expect(statuses.some((s) => s.includes('runtime binaries were left untouched'))).toBe(true);
  });

  it('keeps the runtime note for the canonical WebBridge plugin id', async () => {
    const { host, statuses } = fakeHost({});
    await removePlugin(host, 'kimi-browser-extension');
    expect(statuses.some((s) => s.includes('Removed kimi-browser-extension'))).toBe(true);
    expect(statuses.some((s) => s.includes('runtime binaries were left untouched'))).toBe(true);
  });

  it('treats managed base URL catalogs as default and explicit catalogs as custom', () => {
    vi.stubEnv('KIMI_CODE_BASE_URL', 'https://api.kimi.com/coding/v1');
    expect(isDefaultMarketplaceCatalog(undefined, {})).toBe(true);
    vi.stubEnv('KIMI_CODE_BASE_URL', 'https://coding.deva.msh.team/coding/v1');
    expect(isDefaultMarketplaceCatalog(undefined, {})).toBe(true);
    vi.stubEnv('KIMI_CODE_BASE_URL', 'https://gateway.example.test/coding/v1');
    expect(isDefaultMarketplaceCatalog(undefined, {})).toBe(true);
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
    const { host, statuses } = fakeHost({});
    await removePlugin(host, 'superpowers');
    expect(statuses.some((s) => s.includes('runtime binaries'))).toBe(false);
  });

  it('starts a capability install only when none is running', async () => {
    const idle = fakeHost({});
    await installCapabilityFromPanel(
      idle.host,
      fakePanel().panel,
      { id: 'kimi-cu', displayName: 'Kimi Computer Use', source: 'capability:kimi-cu' } as never,
      'kimi-cu',
    );
    expect(idle.installCapability).toHaveBeenCalledWith('kimi-cu');
  });

  it.each(['cancel', 'escape', 'confirm', 'retry-error', 'still-blocked'] as const)(
    'handles process confirmation: %s',
    async (action) => {
      const pending = fakeHost({
        capabilityStatus: () => Promise.resolve({
          state: 'ready',
          steps: [],
          install: pending.installCapability.mock.calls.length < 2 || action === 'still-blocked'
            ? { running: false, confirmationRequired: 'stop-processes' }
            : { running: false },
        }),
      });
      if (action === 'retry-error') {
        pending.installCapability.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Access denied'));
      }
      const panel = fakePanel();
      const installing = installCapabilityFromPanel(
        pending.host,
        panel.panel,
        { id: 'kimi-cu-win', displayName: 'Kimi Computer Use', source: 'capability:kimi-cu' } as never,
        'kimi-cu',
      );
      await vi.waitFor(() => {
        expect(pending.mountEditorReplacement).toHaveBeenCalled();
      }, { timeout: 2000 });
      expect(pending.installCapability).toHaveBeenCalledTimes(1);
      expect(pending.installCapability).toHaveBeenCalledWith('kimi-cu');
      const dialog = pending.mountEditorReplacement.mock.calls[0]![0] as PluginStopProcessesConfirmComponent;
      expect(dialog).toBeInstanceOf(PluginStopProcessesConfirmComponent);
      if (action === 'escape') {
        dialog.handleInput('\u001B');
      } else {
        if (action !== 'cancel') dialog.handleInput('\u001B[B');
        dialog.handleInput('\r');
      }
      await installing;
      expect(pending.restoreEditor).toHaveBeenCalled();
      expect(panel.lines.at(-1)).toBeUndefined();
      if (action === 'cancel' || action === 'escape') {
        expect(pending.installCapability).toHaveBeenCalledTimes(1);
        expect(pending.statuses).toContain('Install cancelled: Kimi Computer Use.');
      } else {
        expect(pending.installCapability).toHaveBeenCalledTimes(2);
        expect(pending.installCapability).toHaveBeenLastCalledWith('kimi-cu', { stopRunningProcesses: true });
        expect(pending.mountEditorReplacement).toHaveBeenLastCalledWith(panel.panel);
        if (action === 'retry-error') {
          expect(pending.statuses).toContain('Failed to install Kimi Computer Use: Access denied');
        } else if (action === 'still-blocked') {
          expect(pending.statuses.some((status) => status.includes('Processes are still running'))).toBe(true);
          expect(pending.statuses).not.toContain('Kimi Computer Use is installed.');
        } else {
          expect(pending.statuses).toContain('Kimi Computer Use is installed.');
        }
      }
    },
  );

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
      'kimi-cu',
    );

    // The service rejects duplicate starts (40922) — a healthy in-progress
    // install must be followed via polling, never reported as a failure.
    expect(installCapability).not.toHaveBeenCalled();
    expect(statuses.some((s) => s.includes('Failed to install'))).toBe(false);
    expect(statuses.some((s) => s.includes('is installed'))).toBe(true);
  });

  it('renders visible clickable store URLs after canonical WebBridge installs in a hyperlink-capable terminal', async () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });
    const { host, statuses, notices, transcriptEntries } = fakeHost({});

    await installCapabilityFromPanel(
      host,
      fakePanel().panel,
      {
        id: 'kimi-browser-extension',
        displayName: 'Kimi Browser Extension',
        source: 'https://example.test/kimi-browser-extension.zip',
      } as never,
      'kimi-webbridge',
    );

    expect(notices).toContainEqual({ title: 'Kimi Browser Extension is installed.', detail: undefined });
    expect(statuses).not.toContain('Run /new or /reload to apply plugin changes.');
    const rendered = transcriptEntries.flatMap((entry) => entry.render(100)).join('\n');
    expect(rendered).toContain(
      '\u001B]8;;https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc\u001B\\',
    );
    expect(rendered).toContain('Chrome Web Store');
    expect(rendered).toContain('Edge Add-ons');
    expect(rendered).toContain('Manual installation guide');
    expect(rendered).toContain('/reload');
    expect(rendered).toContain('/new');
  });

  it('renders full store URLs after WebBridge installs in a terminal without hyperlinks', async () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    const { host, transcriptEntries } = fakeHost({});

    await installCapabilityFromPanel(
      host,
      fakePanel().panel,
      {
        id: 'kimi-webbridge',
        displayName: 'Kimi Browser Extension',
        source: 'capability:kimi-webbridge',
      } as never,
      'kimi-webbridge',
    );

    const rendered = transcriptEntries.flatMap((entry) => entry.render(100)).join('\n');
    expect(rendered).not.toContain('\u001B]8;;');
    expect(unwrappedVisibleText(transcriptEntries)).toContain(
      'https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc',
    );
  });

  it('separates the WebBridge install result from its setup steps with one blank line', async () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: true });
    const { host, transcriptEntries } = fakeHost({});

    await installCapabilityFromPanel(
      host,
      fakePanel().panel,
      {
        id: 'kimi-webbridge',
        displayName: 'Kimi Browser Extension',
        source: 'capability:kimi-webbridge',
      } as never,
      'kimi-webbridge',
    );

    const lines = visibleLines(transcriptEntries, 180);
    const installed = lines.findIndex((line) => line.includes('Kimi Browser Extension is installed.'));
    const intro = lines.findIndex((line) =>
      line.includes('Two steps left to use Kimi Browser Extension:'),
    );
    const firstStep = lines.findIndex((line) =>
      line.includes('Install the browser extension'),
    );
    const secondStep = lines.findIndex((line) => line.includes('Run /reload or /new to apply it.'));
    expect(lines.slice(installed + 1, intro)).toEqual(['']);
    expect(firstStep).toBe(intro + 1);
    expect(lines[firstStep]).toContain('1.');
    expect(lines.find((line) => line.includes('Chrome Web Store'))).toContain('•');
    expect(lines.find((line) => line.includes('Edge Add-ons'))).toContain('•');
    expect(lines.find((line) => line.includes('Manual installation guide'))).toContain('•');
    expect(lines[secondStep]).toContain('2.');
  });

  it('shows the engine error when a background capability install fails', async () => {
    const { host, statuses } = fakeHost({
      capabilityStatus: () =>
        Promise.resolve({
          state: 'not_installed',
          steps: [],
          install: { running: false, error: 'Authenticode signature is not valid' },
        }),
    });

    await installCapabilityFromPanel(
      host,
      fakePanel().panel,
      { id: 'kimi-cu', displayName: 'Kimi Computer Use', source: 'capability:kimi-cu' } as never,
      'kimi-cu',
    );

    expect(statuses).toContain(
      'Kimi Computer Use installation failed: Authenticode signature is not valid',
    );
    expect(statuses).toContain('Fix the reported error, then install again from /plugins.');
  });

  it('shows required permissions once after installation instead of exposing step details', async () => {
    const { host, statuses } = fakeHost({
      capabilityStatus: () => Promise.resolve({
        id: 'kimi-cu',
        state: 'partial',
        steps: [
          { id: 'permissions.accessibility', state: 'ok' },
          { id: 'permissions.screenRecording', state: 'missing' },
        ],
        install: { running: false },
      }),
    });

    await installCapabilityFromPanel(
      host,
      fakePanel().panel,
      {
        id: 'kimi-cu-win',
        displayName: 'Kimi Computer Use for Windows',
        source: 'https://example.test/kimi-cu-win.zip',
      } as never,
      'kimi-cu',
    );

    expect(statuses.some((s) => s.includes('Grant Accessibility and Screen Recording'))).toBe(true);
    expect(statuses.some((s) => s.includes('screenRecording'))).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      'capability needs attention',
      expect.objectContaining({
        capabilityId: 'kimi-cu',
        steps: [
          { id: 'permissions.accessibility', state: 'ok' },
          { id: 'permissions.screenRecording', state: 'missing' },
        ],
      }),
    );
  });
});
