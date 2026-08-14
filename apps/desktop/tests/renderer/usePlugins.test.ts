// apps/desktop/tests/renderer/usePlugins.test.ts
// usePlugins: marketplace + installed + capabilities load, unsupported-route
// detection, capability row merging (catalog suppression, update badge),
// per-row busy / error handling, live install progress, and notes.
// The daemon api is mocked at ../api.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  listPluginMarketplace: vi.fn(),
  listPlugins: vi.fn(),
  installPlugin: vi.fn(),
  removePlugin: vi.fn(),
  setPluginEnabled: vi.fn(),
  getCapability: vi.fn(),
  listCapabilities: vi.fn(),
  installCapability: vi.fn(),
}));

vi.mock('../../src/renderer/api', () => ({ getKimiWebApi: () => apiMock }));

import { DaemonApiError, DaemonNetworkError, type AppCapabilityStatus } from '@moonshot-ai/app-core';
import {
  usePlugins,
  __resetPluginsForTests,
  __setSettleTimersForTests,
  capabilityRowShowsInstall,
  handlePluginsShelfEvent,
  type CapabilityRow,
} from '../../src/renderer/composables/usePlugins';

/** Drive a server-side install settle through the WS fan-out shape. */
function emitCapabilitySettled(id: string, install: Record<string, unknown> = { running: false }): void {
  handlePluginsShelfEvent({
    type: 'capabilityChanged',
    capabilityId: id,
    install: { running: false, ...install },
  });
}

const entryVercel = {
  id: 'vercel-plugin',
  tier: 'official' as const,
  displayName: 'Vercel',
  source: 'https://cdn.example.test/vercel.zip',
};

const entrySuperpowers = {
  id: 'superpowers',
  tier: 'curated' as const,
  displayName: 'Superpowers',
  source: 'https://github.com/obra/superpowers',
};

// The kimi-webbridge capability's wiring plugin rides the marketplace catalog.
const entryWebbridge = {
  id: 'kimi-webbridge',
  tier: 'official' as const,
  displayName: 'Kimi WebBridge',
  version: '1.11.3',
  source: 'https://cdn.example.test/kimi-webbridge.zip',
  installed: { version: '1.11.0', enabled: true },
  updateAvailable: true,
};

const capabilityCu = {
  id: 'kimi-cu',
  pluginId: 'kimi-cu',
  displayName: 'Kimi Computer Use',
  description: 'GUI automation',
  supported: true,
  state: 'not_installed' as const,
  steps: [{ id: 'app', state: 'missing' as const }],
  install: { running: false },
};

const capabilityWebbridge = {
  id: 'kimi-webbridge',
  pluginId: 'kimi-webbridge',
  displayName: 'Kimi WebBridge',
  description: 'Browser control',
  supported: true,
  state: 'partial' as const,
  version: '1.11.0',
  steps: [{ id: 'skill', state: 'ok' as const }],
  install: { running: false },
};

function resetState(): void {
  const { state } = usePlugins();
  state.entries = [];
  state.installed = [];
  state.capabilities = [];
  state.loaded = false;
  state.loading = false;
  state.error = null;
  state.unsupported = false;
  state.capabilitiesUnsupported = false;
  state.capabilitiesLoadFailed = false;
  state.extensionHint = false;
  state.busy = {};
  state.rowErrors = {};
}

describe('usePlugins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
    __resetPluginsForTests();
    // Defaults: empty shelf, no capabilities.
    apiMock.listPluginMarketplace.mockResolvedValue([]);
    apiMock.listPlugins.mockResolvedValue([]);
    apiMock.listCapabilities.mockResolvedValue([]);
  });

  it('loads the marketplace and groups by tier', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([entryVercel, entrySuperpowers]);
    const { state, officialEntries, thirdPartyEntries, refresh } = usePlugins();

    await refresh();

    expect(state.error).toBeNull();
    expect(state.loaded).toBe(true);
    expect(officialEntries.value.map((e) => e.id)).toEqual(['vercel-plugin']);
    expect(thirdPartyEntries.value.map((e) => e.id)).toEqual(['superpowers']);
  });

  it('marks unsupported on a bare 404 (older server) without an error banner', async () => {
    // A route-miss from an older server is a non-envelope 404 — the HTTP
    // client surfaces the status as the code.
    apiMock.listPlugins.mockRejectedValue(
      new DaemonApiError({ code: 404, msg: 'Not Found', requestId: 'r' }),
    );
    const { state, refresh } = usePlugins();

    await refresh();

    expect(state.unsupported).toBe(true);
    expect(state.error).toBeNull();
    expect(state.entries).toEqual([]);
  });

  it('a code-less-or-5xx failure is a load error, never unsupported', async () => {
    apiMock.listPlugins.mockRejectedValue(
      new DaemonApiError({ code: 500, msg: 'Internal Server Error', requestId: 'r' }),
    );
    const { state, refresh } = usePlugins();

    await refresh();

    expect(state.unsupported).toBe(false);
    expect(state.error).toBe('Internal Server Error');
  });

  it('marks unsupported on a 404 network-phase error', async () => {
    apiMock.listPlugins.mockRejectedValue(
      new DaemonNetworkError({
        message: 'HTTP 404',
        cause: null,
        method: 'GET',
        path: '/plugins/marketplace',
        url: 'http://x/plugins/marketplace',
        requestId: 'r',
        phase: 'fetch',
        timeoutMs: 0,
        status: 404,
      }),
    );
    const { state, refresh } = usePlugins();

    await refresh();
    expect(state.unsupported).toBe(true);
  });

  it('a catalog failure alone is a soft error — installed rows stay usable', async () => {
    apiMock.listPluginMarketplace
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce([entryVercel]);
    apiMock.listPlugins.mockResolvedValue([{ id: 'my-local', enabled: true }]);
    const { state, installedOnly, refresh } = usePlugins();

    await refresh();
    expect(state.error).toBeNull();
    expect(state.catalogError).toBe('network down');
    expect(state.unsupported).toBe(false);
    expect(installedOnly.value.map((p) => p.id)).toEqual(['my-local']);

    await refresh(true);
    expect(state.catalogError).toBeNull();
    expect(state.entries.map((e) => e.id)).toEqual(['vercel-plugin']);
  });

  it('a plugins-list failure is the load error', async () => {
    apiMock.listPlugins.mockRejectedValue(new Error('engine down'));
    const { state, refresh } = usePlugins();

    await refresh();
    expect(state.error).toBe('engine down');
    expect(state.unsupported).toBe(false);
  });

  it('tolerates missing capability routes (Built-in section just stays empty)', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([entryVercel]);
    apiMock.listCapabilities.mockRejectedValue(
      new DaemonApiError({ code: 404, msg: 'Not Found', requestId: 'r' }),
    );
    const { state, capabilityRows, refresh } = usePlugins();

    await refresh();

    expect(state.unsupported).toBe(false);
    expect(state.capabilitiesUnsupported).toBe(true);
    expect(capabilityRows.value).toEqual([]);
    expect(state.error).toBeNull();
  });

  it('claims capability catalog entries into the Built-in rows', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([entryWebbridge, entryVercel]);
    apiMock.listCapabilities.mockResolvedValue([capabilityCu, capabilityWebbridge]);
    apiMock.listPlugins.mockResolvedValue([
      { id: 'kimi-webbridge', enabled: true, version: '1.11.0' },
    ]);
    const { capabilityRows, officialEntries, refresh } = usePlugins();

    await refresh();

    // kimi-webbridge is claimed by its capability row, not the Official shelf.
    expect(officialEntries.value.map((e) => e.id)).toEqual(['vercel-plugin']);
    const webbridge = capabilityRows.value.find((r) => r.status.id === 'kimi-webbridge');
    expect(webbridge?.plugin?.version).toBe('1.11.0');
    expect(webbridge?.updateAvailable).toBe(true);
    const cu = capabilityRows.value.find((r) => r.status.id === 'kimi-cu');
    expect(cu?.plugin).toBeUndefined();
    expect(cu?.updateAvailable).toBe(false);
  });

  it('lists installed plugins the catalog does not carry', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([entryVercel]);
    apiMock.listPlugins.mockResolvedValue([
      { id: 'vercel-plugin', enabled: true },
      { id: 'my-local', enabled: false, version: '0.1.0', source: 'local-path' },
    ]);
    const { installedOnly, refresh } = usePlugins();

    await refresh();

    expect(installedOnly.value.map((p) => p.id)).toEqual(['my-local']);
  });

  it('installs via the entry source and refreshes', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([entryVercel]);
    apiMock.installPlugin.mockResolvedValue({ id: 'vercel-plugin' });
    const { state, install, refresh } = usePlugins();
    await refresh();

    await install(entryVercel);

    expect(apiMock.installPlugin).toHaveBeenCalledWith(entryVercel.source);
    expect(state.busy['vercel-plugin:install']).toBeUndefined();
    expect(state.rowErrors['vercel-plugin']).toBeUndefined();
    // refresh(true) reloaded the catalog after the mutation.
    expect(apiMock.listPluginMarketplace).toHaveBeenCalledTimes(2);
  });

  it('pins row errors without throwing and serializes the same action', async () => {
    apiMock.installPlugin.mockRejectedValue(new Error('zip broken'));
    const { state, install, refresh } = usePlugins();
    await refresh();

    const first = install(entryVercel);
    const second = install(entryVercel); // busy → no-op
    await Promise.all([first, second]);

    expect(apiMock.installPlugin).toHaveBeenCalledTimes(1);
    expect(state.rowErrors['vercel-plugin']).toBe('zip broken');
  });

  it('capability setup goes through the capability route and settles via events', async () => {
    apiMock.installCapability.mockResolvedValue({ install: { running: true } });
    apiMock.getCapability.mockResolvedValue({ id: 'kimi-cu', install: { running: false } });
    const { state, setupCapability, refresh } = usePlugins();
    await refresh();

    const pending = setupCapability('kimi-cu');
    emitCapabilitySettled('kimi-cu');
    await pending;

    expect(apiMock.installCapability).toHaveBeenCalledWith('kimi-cu');
    expect(apiMock.installPlugin).not.toHaveBeenCalled();
    expect(state.rowErrors['kimi-cu']).toBeUndefined();
  });

  it('capability setup failures land as row errors (backend reason verbatim)', async () => {
    apiMock.installCapability.mockResolvedValue({ install: { running: true } });
    apiMock.getCapability.mockResolvedValue({
      id: 'kimi-cu',
      install: { running: false, error: 'ditto failed' },
    });
    const { state, setupCapability, refresh } = usePlugins();
    await refresh();

    const pending = setupCapability('kimi-cu');
    emitCapabilitySettled('kimi-cu');
    await pending;

    expect(state.rowErrors['kimi-cu']).toBe('ditto failed');
  });

  it('follows an install already running server-side on refresh', async () => {
    apiMock.listCapabilities.mockResolvedValue([
      { ...capabilityCu, install: { running: true, step: 'download', percent: 10 } },
    ]);
    apiMock.getCapability.mockResolvedValue({ ...capabilityCu, install: { running: false } });
    const { state, refresh } = usePlugins();

    await refresh();
    emitCapabilitySettled('kimi-cu');
    await vi.waitFor(() => {
      expect(state.capabilities[0]?.install.running).toBe(false);
    });
    // Never restarted the install.
    expect(apiMock.installCapability).not.toHaveBeenCalled();
  });

  it('toggles apply locally before the API resolves and revert on failure', async () => {
    apiMock.listPlugins.mockResolvedValue([
      { id: 'vercel-plugin', enabled: true, version: '1.0.0' },
    ]);
    apiMock.listPluginMarketplace.mockResolvedValue([
      { ...entryVercel, installed: { version: '1.0.0', enabled: true } },
    ]);
    let release: ((e: Error) => void) | undefined;
    apiMock.setPluginEnabled.mockImplementation(
      () => new Promise((_, reject) => { release = reject; }),
    );
    const { state, setEnabled, refresh } = usePlugins();
    await refresh();

    const pending = setEnabled('vercel-plugin', false);
    // Optimistic: the local view flipped before the API answered.
    expect(state.installed[0]?.enabled).toBe(false);
    expect(state.entries[0]?.installed?.enabled).toBe(false);

    release?.(new Error('daemon down'));
    await pending;
    // Failure restored the prior state and pinned the row error.
    expect(state.installed[0]?.enabled).toBe(true);
    expect(state.rowErrors['vercel-plugin']).toBe('daemon down');
  });

  it('removes apply locally before the API resolves and revert on failure', async () => {
    apiMock.listPlugins.mockResolvedValue([{ id: 'my-local', enabled: true }]);
    let release: ((e: Error) => void) | undefined;
    apiMock.removePlugin.mockImplementation(
      () => new Promise((_, reject) => { release = reject; }),
    );
    const { state, remove, refresh } = usePlugins();
    await refresh();

    const pending = remove('my-local');
    expect(state.installed).toEqual([]);

    release?.(new Error('busy'));
    await pending;
    expect(state.installed.map((p) => p.id)).toEqual(['my-local']);
    expect(state.rowErrors['my-local']).toBe('busy');
  });

  it('installs a custom source through the reserved row key', async () => {
    apiMock.installPlugin.mockResolvedValue({ id: 'custom-plugin' });
    const { state, installSource, refresh } = usePlugins();
    await refresh();

    await installSource('https://example.test/custom.zip');

    expect(apiMock.installPlugin).toHaveBeenCalledWith('https://example.test/custom.zip');
    expect(state.busy['__custom__:install']).toBeUndefined();
    expect(state.rowErrors['__custom__']).toBeUndefined();
    // The shelf reloads after the mutation.
    expect(apiMock.listPluginMarketplace).toHaveBeenCalledTimes(2);
  });

  it('pins custom-source install errors on the reserved row', async () => {
    apiMock.installPlugin.mockRejectedValue(new Error('bad zip'));
    const { state, installSource, refresh } = usePlugins();
    await refresh();

    await installSource('/nope');

    expect(state.rowErrors['__custom__']).toBe('bad zip');
  });

  it('a toggle re-syncs only the installed list (no catalog fetch, no re-detect)', async () => {
    apiMock.listPlugins.mockResolvedValue([{ id: 'vercel-plugin', enabled: true }]);
    apiMock.setPluginEnabled.mockResolvedValue({ ok: true });
    const { setEnabled, refresh } = usePlugins();
    await refresh();

    await setEnabled('vercel-plugin', false);

    // No marketplace refetch and no capability re-detect on the toggle path.
    expect(apiMock.listPluginMarketplace).toHaveBeenCalledTimes(1);
    expect(apiMock.listCapabilities).toHaveBeenCalledTimes(1);
    expect(apiMock.listPlugins).toHaveBeenCalledTimes(2);
  });

  it('remove releases the busy state before the background re-sync settles', async () => {
    let marketplaceCalls = 0;
    apiMock.listPluginMarketplace.mockImplementation(() => {
      marketplaceCalls += 1;
      return marketplaceCalls === 1
        ? Promise.resolve([entryWebbridge])
        : new Promise(() => {}); // the post-remove re-sync never settles
    });
    let capCalls = 0;
    apiMock.listCapabilities.mockImplementation(() => {
      capCalls += 1;
      return Promise.resolve([
        { ...capabilityWebbridge, state: capCalls === 1 ? ('ready' as const) : ('partial' as const) },
      ]);
    });
    apiMock.listPlugins.mockResolvedValue([{ id: 'kimi-webbridge', enabled: true }]);
    apiMock.removePlugin.mockResolvedValue({ ok: true });
    const { state, remove, refresh } = usePlugins();
    await refresh();

    await remove('kimi-webbridge');

    // Busy cleared right after the mutation — not held by the slow re-sync.
    expect(state.busy['kimi-webbridge:remove']).toBeUndefined();
    // The capability flips to not-ready locally, offering Install at once.
    expect(state.capabilities[0]?.state).toBe('partial');
  });

  it('applies a finished install locally (no seconds-long wait for the re-sync)', async () => {
    apiMock.listPluginMarketplace.mockImplementation(
      () => new Promise(() => {}), // catalog never settles in this test
    );
    apiMock.listPlugins.mockResolvedValue([]);
    apiMock.installPlugin.mockResolvedValue({
      id: 'vercel-plugin',
      enabled: true,
      version: '1.0.0',
    });
    const { state, install } = usePlugins();

    await install(entryVercel);

    expect(state.installed.map((p) => p.id)).toEqual(['vercel-plugin']);
  });

  it('applies the settled capability status immediately and raises the extension hint', async () => {
    apiMock.listCapabilities.mockResolvedValue([capabilityWebbridge]);
    apiMock.installCapability.mockResolvedValue({ install: { running: true } });
    apiMock.getCapability.mockResolvedValue({
      id: 'kimi-webbridge',
      install: { running: false },
      steps: [{ id: 'extension', state: 'missing', optional: true }],
    });
    const { state, setupCapability, dismissExtensionHint, refresh } = usePlugins();
    await refresh();

    const pending = setupCapability('kimi-webbridge');
    emitCapabilitySettled('kimi-webbridge');
    await pending;

    expect(state.capabilities[0]?.install.running).toBe(false);
    expect(state.extensionHint).toBe(true);
    dismissExtensionHint();
    expect(state.extensionHint).toBe(false);
  });

  it('no extension hint when the extension is already connected', async () => {
    apiMock.installCapability.mockResolvedValue({ install: { running: true } });
    apiMock.getCapability.mockResolvedValue({
      id: 'kimi-webbridge',
      install: { running: false },
      steps: [{ id: 'extension', state: 'ok', optional: true }],
    });
    const { state, setupCapability, refresh } = usePlugins();
    await refresh();

    const pending = setupCapability('kimi-webbridge');
    emitCapabilitySettled('kimi-webbridge');
    await pending;

    expect(state.extensionHint).toBe(false);
  });

  it('toggle on a stale row self-heals to not-installed instead of pinning 40419', async () => {
    // Local view believes installed; the server has no record.
    apiMock.listPlugins.mockResolvedValue([{ id: 'vercel-plugin', enabled: true }]);
    apiMock.listPluginMarketplace.mockResolvedValue([
      { ...entryVercel, installed: { version: '1.0.0', enabled: true } },
    ]);
    apiMock.setPluginEnabled.mockRejectedValue(
      new DaemonApiError({ code: 40419, msg: 'Plugin "vercel-plugin" is not installed', requestId: 'r' }),
    );
    const { state, setEnabled, refresh } = usePlugins();
    await refresh();

    await setEnabled('vercel-plugin', false);

    // Converged to gone, no error pinned.
    expect(state.installed).toEqual([]);
    expect(state.entries[0]?.installed).toBeUndefined();
    expect(state.rowErrors['vercel-plugin']).toBeUndefined();
  });

  it('remove on an already-gone plugin is a quiet success', async () => {
    apiMock.listPlugins.mockResolvedValue([{ id: 'my-local', enabled: true }]);
    apiMock.removePlugin.mockRejectedValue(
      new DaemonApiError({ code: 40419, msg: 'not installed', requestId: 'r' }),
    );
    const { state, remove, refresh } = usePlugins();
    await refresh();

    await remove('my-local');

    expect(state.installed).toEqual([]);
    expect(state.rowErrors['my-local']).toBeUndefined();
  });

  it('a settle event reaches both a refresh-follower and an explicit setup', async () => {
    apiMock.listCapabilities.mockResolvedValue([
      { ...capabilityWebbridge, install: { running: true, step: 'download' } },
    ]);
    apiMock.installCapability.mockResolvedValue({ install: { running: true } });
    apiMock.getCapability.mockResolvedValue({
      id: 'kimi-webbridge',
      install: { running: false },
      steps: [{ id: 'extension', state: 'missing', optional: true }],
    });
    const { state, setupCapability, refresh } = usePlugins();
    await refresh(); // starts following the in-flight install

    const pending = setupCapability('kimi-webbridge');
    emitCapabilitySettled('kimi-webbridge');
    await pending;

    expect(state.capabilities[0]?.install.running).toBe(false);
    expect(state.extensionHint).toBe(true);
  });

  it('shows the wiring plugin switch right at settle (no dead window)', async () => {
    apiMock.listCapabilities.mockResolvedValue([capabilityWebbridge]);
    let pluginCalls = 0;
    apiMock.listPlugins.mockImplementation(() => {
      pluginCalls += 1;
      return Promise.resolve(
        pluginCalls === 1 ? [] : [{ id: 'kimi-webbridge', enabled: true }],
      );
    });
    apiMock.installCapability.mockResolvedValue({ install: { running: true } });
    apiMock.getCapability.mockResolvedValue({
      id: 'kimi-webbridge',
      install: { running: false },
      steps: [{ id: 'extension', state: 'ok', optional: true }],
    });
    const { state, setupCapability, refresh } = usePlugins();
    await refresh();
    expect(state.installed).toEqual([]);

    const pending = setupCapability('kimi-webbridge');
    emitCapabilitySettled('kimi-webbridge');
    await pending;

    // The installed list was re-pulled at settle — the Switch renders
    // immediately, not whenever the catalog re-sync lands.
    expect(state.installed.map((p) => p.id)).toEqual(['kimi-webbridge']);
    expect(state.extensionHint).toBe(false); // extension already connected
  });

  it('queues a forced refresh requested while another is in flight', async () => {
    let marketplaceCalls = 0;
    const stalledResolvers: Array<(v: unknown) => void> = [];
    apiMock.listPluginMarketplace.mockImplementation(() => {
      marketplaceCalls += 1;
      return marketplaceCalls === 1
        ? Promise.resolve([entryVercel])
        : new Promise((resolve) => stalledResolvers.push(resolve));
    });
    apiMock.installPlugin.mockResolvedValue({ id: 'vercel-plugin', enabled: true });
    const { install, refresh } = usePlugins();
    await refresh();

    await install(entryVercel); // fires a background re-sync that stalls…
    const forced = refresh(true); // …so this one queues instead of dropping
    for (const resolve of stalledResolvers.splice(0)) resolve([entryVercel]);
    await forced;

    await vi.waitFor(() => {
      expect(apiMock.listPluginMarketplace).toHaveBeenCalledTimes(3);
    });
    for (const resolve of stalledResolvers.splice(0)) resolve([entryVercel]);
  });

  it('arms the settle waiter before starting a capability install', async () => {
    // A settle event fired synchronously during the POST must still resolve.
    apiMock.installCapability.mockImplementation(() => {
      queueMicrotask(() => emitCapabilitySettled('kimi-cu'));
      return Promise.resolve({ install: { running: true } });
    });
    apiMock.getCapability.mockResolvedValue({ id: 'kimi-cu', install: { running: false } });
    const { state, setupCapability, refresh } = usePlugins();
    await refresh();

    await setupCapability('kimi-cu');

    expect(state.rowErrors['kimi-cu']).toBeUndefined();
  });

  it('a toggle-heal downgrades a ready capability so the row keeps Install', async () => {
    apiMock.listCapabilities.mockResolvedValue([{ ...capabilityWebbridge, state: 'ready' as const }]);
    apiMock.listPlugins.mockResolvedValue([{ id: 'kimi-webbridge', enabled: true }]);
    apiMock.setPluginEnabled.mockRejectedValue(
      new DaemonApiError({ code: 40419, msg: 'not installed', requestId: 'r' }),
    );
    const { state, setEnabled, refresh } = usePlugins();
    await refresh();

    await setEnabled('kimi-webbridge', false);

    expect(state.capabilities[0]?.state).toBe('partial');
    expect(state.rowErrors['kimi-webbridge']).toBeUndefined();
  });

  it('clears the extension hint once the extension reports connected', async () => {
    apiMock.listCapabilities.mockResolvedValue([capabilityWebbridge]);
    apiMock.installCapability.mockResolvedValue({ install: { running: true } });
    apiMock.getCapability.mockResolvedValue({
      id: 'kimi-webbridge',
      install: { running: false },
      steps: [{ id: 'extension', state: 'missing', optional: true }],
    });
    const { state, setupCapability, refresh } = usePlugins();
    await refresh();
    const pending = setupCapability('kimi-webbridge');
    emitCapabilitySettled('kimi-webbridge');
    await pending;
    expect(state.extensionHint).toBe(true);

    apiMock.listCapabilities.mockResolvedValue([
      {
        ...capabilityWebbridge,
        steps: [{ id: 'extension', state: 'ok' as const, optional: true }],
      },
    ]);
    await refresh(true);

    await vi.waitFor(() => {
      expect(state.extensionHint).toBe(false);
    });
  });

  it('clears the update flag when the install lands locally', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([
      { ...entryVercel, version: '2.0.0', installed: { version: '1.0.0', enabled: true }, updateAvailable: true },
    ]);
    apiMock.installPlugin.mockResolvedValue({ id: 'vercel-plugin', enabled: true, version: '2.0.0' });
    const { state, install, refresh } = usePlugins();
    await refresh();
    expect(state.entries[0]?.updateAvailable).toBe(true);

    await install(entryVercel);

    expect(state.entries[0]?.updateAvailable).toBeUndefined();
    expect(state.entries[0]?.installed?.version).toBe('2.0.0');
  });

  it('a plugin change event clears the update flag once versions match', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([
      {
        ...entryVercel,
        version: '2.0.0',
        installed: { version: '1.0.0', enabled: true },
        updateAvailable: true,
      },
    ]);
    let pluginCalls = 0;
    apiMock.listPlugins.mockImplementation(() => {
      pluginCalls += 1;
      // First read: still on the old version; later reads: post-update.
      return Promise.resolve([
        { id: 'vercel-plugin', enabled: true, version: pluginCalls === 1 ? '1.0.0' : '2.0.0' },
      ]);
    });
    const { state, refresh } = usePlugins();
    await refresh();
    expect(state.entries[0]?.updateAvailable).toBe(true);

    // Another client updated the plugin to the catalog version.
    handlePluginsShelfEvent({ type: 'pluginsChanged' });
    await vi.waitFor(() => {
      expect(state.entries[0]?.updateAvailable).toBeUndefined();
    });
    expect(state.entries[0]?.installed?.version).toBe('2.0.0');
  });

  it('keeps an installed capability wiring plugin visible in Installed when capability routes are missing', async () => {
    apiMock.listCapabilities.mockRejectedValue(
      new DaemonApiError({ code: 404, msg: 'Not Found', requestId: 'r' }),
    );
    apiMock.listPluginMarketplace.mockResolvedValue([
      { id: 'kimi-webbridge', tier: 'official' as const, displayName: 'WB', source: 'https://cdn.example.test/wb.zip', capabilityId: 'kimi-webbridge' },
    ]);
    apiMock.listPlugins.mockResolvedValue([{ id: 'kimi-webbridge', enabled: true, version: '1.11.5' }]);
    const { state, installedOnly, officialEntries, refresh } = usePlugins();
    await refresh();

    // Suppressed from the shelf (no capability route to install the runtime)…
    expect(officialEntries.value).toEqual([]);
    // …but still manageable in Installed.
    expect(installedOnly.value.map((p) => p.id)).toEqual(['kimi-webbridge']);
    expect(state.capabilitiesUnsupported).toBe(true);
  });

  it('cancels the settle waiter when the install start fails', async () => {
    apiMock.installCapability.mockRejectedValue(new Error('daemon rejected'));
    const { state, setupCapability, refresh } = usePlugins();
    await refresh();

    await setupCapability('kimi-cu');

    expect(state.rowErrors['kimi-cu']).toBe('daemon rejected');
    // The waiter was removed — a later non-running snapshot must not be
    // mistaken for this attempt's settle (and no stale timer survives).
    apiMock.listCapabilities.mockResolvedValue([capabilityCu]);
    await refresh(true);
    expect(state.extensionHint).toBe(false);
  });

  it('applies a failed settle status before surfacing its error', async () => {
    apiMock.listCapabilities.mockResolvedValue([capabilityCu]);
    apiMock.installCapability.mockResolvedValue({ install: { running: true } });
    apiMock.getCapability.mockResolvedValue({
      id: 'kimi-cu',
      install: { running: false, error: 'download stalled' },
    });
    const { state, setupCapability, refresh } = usePlugins();
    await refresh();

    const pending = setupCapability('kimi-cu');
    emitCapabilitySettled('kimi-cu');
    await pending;

    // The row left the loading state even though the install failed.
    expect(state.capabilities[0]?.install.running).toBe(false);
    expect(state.rowErrors['kimi-cu']).toBe('download stalled');
  });

  it('keeps the update flag when a custom source installs an older version', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([
      {
        ...entryVercel,
        version: '2.0.0',
        installed: { version: '1.0.0', enabled: true },
        updateAvailable: true,
      },
    ]);
    // A custom install of an OLDER build than the catalog.
    apiMock.installPlugin.mockResolvedValue({ id: 'vercel-plugin', enabled: true, version: '1.5.0' });
    const { state, installSource, refresh } = usePlugins();
    await refresh();

    await installSource('https://example.test/vercel-1.5.0.zip');

    expect(state.entries[0]?.updateAvailable).toBe(true);
  });

  it('suppresses capability rows when the capability refresh fails non-404', async () => {
    apiMock.listCapabilities.mockRejectedValue(new Error('detector wedge'));
    apiMock.listPluginMarketplace.mockResolvedValue([
      { id: 'kimi-cu', tier: 'official' as const, displayName: 'CU', source: 'capability:kimi-cu', capabilityId: 'kimi-cu' },
    ]);
    apiMock.listPlugins.mockResolvedValue([]);
    const { state, officialEntries, refresh } = usePlugins();
    await refresh();

    expect(state.capabilitiesUnsupported).toBe(false);
    expect(state.capabilitiesLoadFailed).toBe(true);
    expect(officialEntries.value).toEqual([]);
  });

  it('keeps waiting when the deadline passes mid-install (no premature settle)', async () => {
    __setSettleTimersForTests({ timeoutMs: 60, sliceMs: 10 });
    apiMock.listCapabilities.mockResolvedValue([capabilityWebbridge]);
    apiMock.installCapability.mockResolvedValue({ install: { running: true } });
    // Every read says still running.
    apiMock.getCapability.mockResolvedValue({
      id: 'kimi-webbridge',
      install: { running: true, step: 'download' },
    });
    const { state, setupCapability, refresh } = usePlugins();
    await refresh();

    await setupCapability('kimi-webbridge');

    // No premature settle: no hint, no error, no fake completion.
    expect(state.extensionHint).toBe(false);
    expect(state.rowErrors['kimi-webbridge']).toBeUndefined();
  });

  it('settles immediately when the install response is already non-running', async () => {
    apiMock.listCapabilities.mockResolvedValue([capabilityCu]);
    apiMock.installCapability.mockResolvedValue({ install: { running: true } });
    // The very first wait-loop read sees the settled state (idempotent no-op).
    apiMock.getCapability.mockResolvedValue({ id: 'kimi-cu', install: { running: false } });
    const { state, setupCapability, refresh } = usePlugins();
    await refresh();

    await setupCapability('kimi-cu');

    expect(state.rowErrors['kimi-cu']).toBeUndefined();
  });

  it('reconciles the installed list even when the settle carries an error', async () => {
    apiMock.listCapabilities.mockResolvedValue([capabilityWebbridge]);
    let pluginCalls = 0;
    apiMock.listPlugins.mockImplementation(() => {
      pluginCalls += 1;
      return Promise.resolve(
        pluginCalls === 1 ? [] : [{ id: 'kimi-webbridge', enabled: true, version: '1.11.5' }],
      );
    });
    apiMock.installCapability.mockResolvedValue({ install: { running: true } });
    // Install failed AFTER the wiring plugin landed.
    apiMock.getCapability.mockResolvedValue({
      id: 'kimi-webbridge',
      install: { running: false, error: 'daemon start failed' },
    });
    const { state, setupCapability, refresh } = usePlugins();
    await refresh();

    const pending = setupCapability('kimi-webbridge');
    emitCapabilitySettled('kimi-webbridge');
    await pending;

    expect(state.rowErrors['kimi-webbridge']).toBe('daemon start failed');
    // The wiring plugin face still refreshed (switch/remove available).
    expect(state.installed.map((p) => p.id)).toContain('kimi-webbridge');
  });

  it('discards an in-flight refresh snapshot once a forced refresh is queued', async () => {
    let entriesCalls = 0;
    const stalled: Array<(v: unknown) => void> = [];
    apiMock.listPluginMarketplace.mockImplementation(() => {
      entriesCalls += 1;
      return entriesCalls === 1
        ? Promise.resolve([entryVercel])
        : new Promise((resolve) => stalled.push(resolve));
    });
    let pluginCalls = 0;
    apiMock.listPlugins.mockImplementation(() => {
      pluginCalls += 1;
      return Promise.resolve(pluginCalls === 1 ? [] : [{ id: 'vercel-plugin', enabled: true }]);
    });
    apiMock.installPlugin.mockResolvedValue({ id: 'vercel-plugin', enabled: true });
    apiMock.removePlugin.mockResolvedValue({ ok: true });
    const { state, install, remove, refresh } = usePlugins();
    await refresh(); // call 1: entries [vercel], installed []

    // Install, then remove while the install's background re-sync is stalled.
    const installDone = install(entryVercel);
    await vi.waitFor(() => expect(stalled.length).toBeGreaterThanOrEqual(1));
    const removeDone = remove('vercel-plugin');
    // Its forced re-sync queues behind the stalled one.
    stalled.shift()?.([entryVercel]); // stale payload: would resurrect the row
    await Promise.all([installDone, removeDone]);
    for (const resolve of stalled.splice(0)) resolve([entryVercel]);
    await vi.waitFor(() => expect(entriesCalls).toBeGreaterThanOrEqual(3));

    // The stale snapshot was discarded: the post-remove state holds.
    expect(state.installed).toEqual([]);
    expect(state.entries[0]?.installed).toBeUndefined();
  });

  it('clears the extension hint via the live capability reconcile', async () => {
    apiMock.listCapabilities.mockResolvedValue([capabilityWebbridge]);
    apiMock.installCapability.mockResolvedValue({ install: { running: true } });
    apiMock.getCapability.mockResolvedValue({
      id: 'kimi-webbridge',
      install: { running: false },
      steps: [{ id: 'extension', state: 'missing', optional: true }],
    });
    const { state, setupCapability, refresh } = usePlugins();
    await refresh();
    const pending = setupCapability('kimi-webbridge');
    emitCapabilitySettled('kimi-webbridge');
    await pending;
    expect(state.extensionHint).toBe(true);

    // The extension connects externally; the plugin event re-detects.
    apiMock.listCapabilities.mockResolvedValue([
      {
        ...capabilityWebbridge,
        steps: [{ id: 'extension', state: 'ok' as const, optional: true }],
      },
    ]);
    handlePluginsShelfEvent({ type: 'pluginsChanged' });
    await vi.waitFor(() => {
      expect(state.extensionHint).toBe(false);
    });
  });

  it('reconciles plugins when a ready capability lacks its wiring record', async () => {
    // Capabilities respond ready while the parallel plugins read predates it.
    let pluginCalls = 0;
    apiMock.listPlugins.mockImplementation(() => {
      pluginCalls += 1;
      return Promise.resolve(
        pluginCalls === 1 ? [] : [{ id: 'kimi-webbridge', enabled: true, version: '1.11.5' }],
      );
    });
    apiMock.listCapabilities.mockResolvedValue([{ ...capabilityWebbridge, state: 'ready' as const }]);
    const { state, refresh } = usePlugins();

    await refresh();

    await vi.waitFor(() => {
      expect(state.installed.map((p) => p.id)).toContain('kimi-webbridge');
    });
  });

  it('probeSupport re-checks route existence in both directions', async () => {
    apiMock.listPlugins.mockRejectedValue(
      new DaemonApiError({ code: 404, msg: 'Not Found', requestId: 'r' }),
    );
    const { state, probeSupport } = usePlugins();

    await probeSupport();
    expect(state.unsupported).toBe(true);

    apiMock.listPlugins.mockResolvedValue([]);
    await probeSupport();
    expect(state.unsupported).toBe(false);
  });

  it('an already-running install (40924) is followed, not pinned as an error', async () => {
    apiMock.listCapabilities.mockResolvedValue([capabilityCu]);
    apiMock.installCapability.mockRejectedValue(
      new DaemonApiError({ code: 40924, msg: 'already installing', requestId: 'r' }),
    );
    apiMock.getCapability.mockResolvedValue({ id: 'kimi-cu', install: { running: false } });
    const { state, setupCapability, refresh } = usePlugins();
    await refresh();

    await setupCapability('kimi-cu');

    expect(state.rowErrors['kimi-cu']).toBeUndefined();
  });

  it('a live plugin event marks an in-flight refresh stale (fresh read wins)', async () => {
    let pluginCalls = 0;
    const stalled: Array<(v: unknown) => void> = [];
    apiMock.listPluginMarketplace.mockImplementation(() => {
      pluginCalls += 1;
      return pluginCalls === 1
        ? Promise.resolve([entryVercel])
        : new Promise((resolve) => stalled.push(resolve));
    });
    apiMock.listPlugins.mockImplementation(() => Promise.resolve(
      pluginCalls <= 1 ? [] : [{ id: 'vercel-plugin', enabled: true, version: '1.0.0' }],
    ));
    const { state, refresh } = usePlugins();
    await refresh();

    const force = refresh(true); // stalls on call 2
    await vi.waitFor(() => expect(stalled.length).toBe(1));
    // A plugin changed externally while the refresh was in flight.
    handlePluginsShelfEvent({ type: 'pluginsChanged' });
    // The in-flight snapshot gets discarded; a fresh read follows.
    for (const resolve of stalled.splice(0)) resolve([entryVercel]);
    await force;
    await vi.waitFor(() => expect(pluginCalls).toBeGreaterThanOrEqual(3));

    expect(state.installed.map((p) => p.id)).toEqual(['vercel-plugin']);
    expect(state.entries[0]?.installed?.enabled).toBe(true);
  });

  it('probeSupport clears unsupported on a real (non-404) error', async () => {
    apiMock.listPlugins.mockRejectedValue(
      new DaemonApiError({ code: 404, msg: 'Not Found', requestId: 'r' }),
    );
    const { state, probeSupport } = usePlugins();
    await probeSupport();
    expect(state.unsupported).toBe(true);

    apiMock.listPlugins.mockRejectedValue(new Error('engine wedge'));
    await probeSupport();
    expect(state.unsupported).toBe(false);
  });

  it('keeps an installed wiring plugin manageable when its capability is unsupported here', async () => {
    apiMock.listCapabilities.mockResolvedValue([
      { ...capabilityWebbridge, supported: false, state: 'unsupported' as const },
    ]);
    apiMock.listPluginMarketplace.mockResolvedValue([
      { id: 'kimi-webbridge', tier: 'official' as const, displayName: 'WB', source: 'https://cdn.example.test/wb.zip' },
    ]);
    apiMock.listPlugins.mockResolvedValue([{ id: 'kimi-webbridge', enabled: true, version: '1.11.5' }]);
    const { installedOnly, capabilityRows, officialEntries, refresh } = usePlugins();
    await refresh();

    expect(capabilityRows.value).toEqual([]); // hidden on unsupported platforms (TUI parity)
    expect(officialEntries.value).toEqual([]); // never a plain-plugin install
    expect(installedOnly.value.map((p) => p.id)).toEqual(['kimi-webbridge']);
  });

  it('suppresses capability-marked rows whose capability is absent from the server list', async () => {
    // Endpoint exists but returns a subset (older daemon / newer catalog).
    apiMock.listCapabilities.mockResolvedValue([capabilityCu]);
    apiMock.listPluginMarketplace.mockResolvedValue([
      { id: 'kimi-cu', tier: 'official' as const, displayName: 'CU', source: 'capability:kimi-cu', capabilityId: 'kimi-cu' },
      { id: 'kimi-webbridge', tier: 'official' as const, displayName: 'WB', source: 'https://cdn.example.test/wb.zip', capabilityId: 'kimi-webbridge' },
      entryVercel,
    ]);
    apiMock.listPlugins.mockResolvedValue([]);
    const { officialEntries, refresh } = usePlugins();
    await refresh();

    // kimi-cu is claimed by its Built-in row; kimi-webbridge (capabilityId
    // but no capability backing) is suppressed — neither is a plain install.
    expect(officialEntries.value.map((e) => e.id)).toEqual(['vercel-plugin']);
  });

  it('re-reads the catalog when a live reconcile finds a version mismatch', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([
      { ...entryVercel, version: '2.0.0', installed: { version: '2.0.0', enabled: true } },
    ]);
    apiMock.listPlugins.mockResolvedValue([{ id: 'vercel-plugin', enabled: true, version: '2.0.0' }]);
    const { refresh } = usePlugins();
    await refresh();
    expect(apiMock.listPluginMarketplace).toHaveBeenCalledTimes(1);

    // Another client installed an OLDER build — the flag verdict belongs to
    // the server, so a catalog re-read is queued.
    apiMock.listPlugins.mockResolvedValue([{ id: 'vercel-plugin', enabled: true, version: '1.5.0' }]);
    handlePluginsShelfEvent({ type: 'pluginsChanged' });
    await vi.waitFor(() => {
      expect(apiMock.listPluginMarketplace).toHaveBeenCalledTimes(2);
    });
  });

  it('remove and setEnabled hit the matching actions', async () => {
    apiMock.removePlugin.mockResolvedValue({ ok: true });
    apiMock.setPluginEnabled.mockResolvedValue({ ok: true });
    const { remove, setEnabled, refresh } = usePlugins();
    await refresh();

    await remove('my-local');
    await setEnabled('my-local', false);

    expect(apiMock.removePlugin).toHaveBeenCalledWith('my-local');
    expect(apiMock.setPluginEnabled).toHaveBeenCalledWith('my-local', false);
  });
});

describe('capabilityRowShowsInstall', () => {
  const installedWiring = {
    id: 'kimi-webbridge',
    displayName: 'Kimi WebBridge',
    enabled: true,
    state: 'ok' as const,
    skillCount: 1,
    mcpServerCount: 0,
    enabledMcpServerCount: 0,
    hookCount: 0,
    commandCount: 0,
    hasErrors: false,
    source: 'github' as const,
  };

  function rowOf(
    status: AppCapabilityStatus,
    opts: { plugin?: typeof installedWiring; updateAvailable?: boolean } = {},
  ): CapabilityRow {
    return {
      status,
      pluginId: status.pluginId ?? status.id,
      plugin: opts.plugin,
      updateAvailable: opts.updateAvailable ?? false,
    };
  }

  it('offers install on a not-installed row', () => {
    expect(capabilityRowShowsInstall(rowOf(capabilityCu))).toBe(true);
  });

  it('never offers install on an installed row — readiness flaps must not flash it', () => {
    // The daemon probe hiccup / cold-start window: same installed wiring
    // plugin, readiness bouncing between partial and ready. The row reads
    // as installed throughout; repair goes through remove + install.
    expect(capabilityRowShowsInstall(rowOf(capabilityWebbridge, { plugin: installedWiring }))).toBe(false);
    // not_installed with the wiring still on disk (runtime deleted): still installed-face.
    expect(capabilityRowShowsInstall(rowOf(capabilityCu, { plugin: installedWiring }))).toBe(false);
    // Disabled wiring: the Switch is the affordance, not a reinstall.
    expect(
      capabilityRowShowsInstall(rowOf(capabilityWebbridge, { plugin: { ...installedWiring, enabled: false } })),
    ).toBe(false);
  });

  it('keeps the update affordance on a ready row with a newer catalog build', () => {
    const ready = { ...capabilityWebbridge, state: 'ready' as const };
    expect(capabilityRowShowsInstall(rowOf(ready, { plugin: installedWiring, updateAvailable: true }))).toBe(true);
    expect(capabilityRowShowsInstall(rowOf(ready, { plugin: installedWiring }))).toBe(false);
  });

  it('shows nothing on a ready row whose wiring record has not synced yet', () => {
    // The settle/reconcile window: capability already ready, plugin record a
    // beat behind — no phantom install where the Switch is about to appear.
    const ready = { ...capabilityWebbridge, state: 'ready' as const };
    expect(capabilityRowShowsInstall(rowOf(ready))).toBe(false);
  });

  it('keeps the loading affordance while an install runs', () => {
    const running = { ...capabilityWebbridge, install: { running: true, step: 'daemon' } };
    expect(capabilityRowShowsInstall(rowOf(running, { plugin: installedWiring }))).toBe(true);
  });
});
