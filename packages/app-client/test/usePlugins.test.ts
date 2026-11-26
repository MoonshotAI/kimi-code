
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setKimiClientDeps } from '../src/client/deps';

const apiMock = {
  listPluginMarketplace: vi.fn(),
  listPlugins: vi.fn(),
  installPlugin: vi.fn(),
  removePlugin: vi.fn(),
  setPluginEnabled: vi.fn(),
  getPluginInfo: vi.fn(),
  previewPlugin: vi.fn(),
  getCapability: vi.fn(),
  listCapabilities: vi.fn(),
  installCapability: vi.fn(),
  requestCapabilityPermissions: vi.fn(),
};

setKimiClientDeps({ api: () => apiMock as never, t: (key) => key });

import { DaemonApiError, DaemonNetworkError, type AppCapabilityStatus } from '@moonshot-ai/app-core';
import {
  usePlugins,
  __resetPluginsForTests,
  __setSettleTimersForTests,
  pluginRowShowsInstall,
  handlePluginsShelfEvent,
  type PluginViewModel,
} from '../src/composables/usePlugins';

function emitCapabilitySettled(id: string, install: Record<string, unknown> = { running: false }): void {
  handlePluginsShelfEvent({
    type: 'capabilityChanged',
    capabilityId: id,
    install: { running: false, ...install },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const entryVercel = {
  id: 'vercel-plugin',
  tier: 'official' as const,
  displayName: 'Vercel',
  version: '2.0.0',
  sha256sum: 'a'.repeat(64),
  source: 'https://cdn.example.test/vercel.zip',
};

const entrySuperpowers = {
  id: 'superpowers',
  tier: 'curated' as const,
  displayName: 'Superpowers',
  version: '1.0.0',
  source: 'https://github.com/obra/superpowers',
};

const entryWebbridge = {
  id: 'kimi-webbridge',
  tier: 'official' as const,
  displayName: 'Kimi WebBridge',
  version: '1.11.3',
  source: 'https://cdn.example.test/kimi-webbridge.zip',
  capabilityId: 'kimi-webbridge',
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
  state.catalogError = null;
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
    apiMock.listPluginMarketplace.mockResolvedValue([]);
    apiMock.listPlugins.mockResolvedValue([]);
    apiMock.listCapabilities.mockResolvedValue([]);
  });

  it('loads the marketplace and groups by tier', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([entryVercel, entrySuperpowers]);
    const { state, officialRows, curatedRows, refresh } = usePlugins();

    await refresh();

    expect(state.error).toBeNull();
    expect(state.loaded).toBe(true);
    expect(officialRows.value.map((e) => e.id)).toEqual(['vercel-plugin']);
    expect(curatedRows.value.map((e) => e.id)).toEqual(['superpowers']);
  });

  it('marks unsupported on a bare 404 (older server) without an error banner', async () => {
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
    const { state, installedRows, installedGroups, refresh } = usePlugins();

    await refresh();
    expect(state.error).toBeNull();
    expect(state.catalogError).toBe('network down');
    expect(state.unsupported).toBe(false);
    expect(installedRows.value.map((p) => p.id)).toEqual(['my-local']);
    expect(installedGroups.value.custom.map((row) => row.id)).toEqual(['my-local']);

    await refresh(true);
    expect(state.catalogError).toBeNull();
    expect(state.entries.map((e) => e.id)).toEqual(['vercel-plugin']);
    expect(installedGroups.value.custom.map((row) => row.id)).toEqual(['my-local']);
  });

  it('keeps only installed management after a cold-start catalog failure', async () => {
    apiMock.listPluginMarketplace.mockRejectedValue(new Error('catalog offline'));
    apiMock.listCapabilities.mockResolvedValue([capabilityCu, capabilityWebbridge]);
    apiMock.listPlugins.mockResolvedValue([
      { id: 'kimi-webbridge', enabled: true, version: '1.11.0' },
    ]);
    const { state, rows, installedRows, installRow, refresh } = usePlugins();

    await refresh();

    expect(state.entries).toEqual([]);
    expect(state.catalogError).toBe('catalog offline');
    expect(rows.value.map((row) => row.id)).toEqual(['kimi-webbridge']);
    expect(installedRows.value.map((row) => row.id)).toEqual(['kimi-webbridge']);
    const installedOnly = rows.value[0]!;
    expect(installedOnly.catalogEntry).toBeUndefined();
    expect(pluginRowShowsInstall(installedOnly)).toBe(false);

    await installRow(installedOnly);
    expect(apiMock.installCapability).not.toHaveBeenCalled();
  });

  it('does not inject capability rows when the catalog returns empty', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([]);
    apiMock.listCapabilities.mockResolvedValue([capabilityCu, capabilityWebbridge]);
    apiMock.listPlugins.mockResolvedValue([
      { id: 'kimi-webbridge', enabled: true, version: '1.11.0' },
    ]);
    const { state, marketplaceRows, installedRows, refresh } = usePlugins();

    await refresh();

    expect(state.catalogError).toBeNull();
    expect(state.entries).toEqual([]);
    expect(marketplaceRows.value).toEqual([]);
    expect(installedRows.value.map((row) => row.id)).toEqual(['kimi-webbridge']);
  });

  it('drops stale rows and blocks their installs after a catalog refresh failure', async () => {
    apiMock.listPluginMarketplace.mockResolvedValueOnce([entryVercel, entryWebbridge]);
    apiMock.listCapabilities.mockResolvedValue([capabilityCu, capabilityWebbridge]);
    apiMock.listPlugins.mockResolvedValue([
      { id: 'kimi-webbridge', enabled: true, version: '1.11.0' },
    ]);
    const { state, rows, install, installRow, refresh } = usePlugins();
    await refresh();
    const staleCapabilityRow = rows.value.find((row) => row.id === 'kimi-webbridge')!;

    apiMock.listPluginMarketplace.mockRejectedValue(new Error('refresh offline'));
    await refresh(true);

    expect(state.entries).toEqual([]);
    expect(state.catalogError).toBe('refresh offline');
    expect(rows.value.map((row) => row.id)).toEqual(['kimi-webbridge']);
    expect(rows.value[0]?.catalogEntry).toBeUndefined();
    expect(pluginRowShowsInstall(rows.value[0]!)).toBe(false);

    await installRow(staleCapabilityRow);
    await install(entryVercel);
    expect(apiMock.installCapability).not.toHaveBeenCalled();
    expect(apiMock.installPlugin).not.toHaveBeenCalled();
  });

  it('associates catalog entries and local updates by catalogId', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([entryVercel]);
    apiMock.listPlugins.mockResolvedValue([
      { id: 'package-plugin', catalogId: 'vercel-plugin', enabled: true, version: '1.0.0' },
    ]);
    apiMock.installPlugin.mockResolvedValue({
      id: 'package-plugin',
      catalogId: 'vercel-plugin',
      enabled: true,
      version: entryVercel.version,
    });
    const { state, rows, install, refresh } = usePlugins();
    await refresh();

    expect(rows.value).toHaveLength(1);
    expect(rows.value[0]?.installedPlugin?.id).toBe('package-plugin');

    await install(entryVercel);

    expect(rows.value).toHaveLength(1);
    expect(rows.value[0]?.installedPlugin?.version).toBe(entryVercel.version);
    expect(state.entries[0]?.updateAvailable).toBeUndefined();
  });

  it('keeps same-ID custom installs separate while matching legacy unknown records', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([{ ...entryVercel, updateAvailable: true }]);
    apiMock.listPlugins.mockResolvedValue([{
      id: 'vercel-plugin',
      enabled: true,
      version: entryVercel.version,
      origin: 'custom',
    }]);
    const { state, rows, installedRows, refresh } = usePlugins();
    await refresh();

    const marketplaceRow = rows.value.find((row) => row.catalogEntry !== undefined)!;
    expect(marketplaceRow.installedPlugin).toBeUndefined();
    expect(marketplaceRow.updateAvailable).toBe(false);
    expect(state.entries[0]?.updateAvailable).toBe(true);
    expect(rows.value.find((row) => row.installedPlugin?.origin === 'custom')?.catalogEntry)
      .toBeUndefined();
    expect(installedRows.value).toHaveLength(1);

    apiMock.listPlugins.mockResolvedValue([{
      id: 'vercel-plugin',
      enabled: true,
      version: '1.0.0',
      origin: 'unknown',
    }]);
    await refresh(true);

    expect(rows.value).toHaveLength(1);
    expect(rows.value[0]?.installedPlugin?.origin).toBe('unknown');
    expect(rows.value[0]?.updateAvailable).toBe(true);
  });

  it('refreshes 40934 before retrying with the current expected version', async () => {
    const changedEntry = { ...entryVercel, version: '3.0.0' };
    apiMock.listPluginMarketplace
      .mockResolvedValueOnce([entryVercel])
      .mockResolvedValue([changedEntry]);
    apiMock.installPlugin
      .mockRejectedValueOnce(
        new DaemonApiError({ code: 40934, msg: 'catalog changed', requestId: 'r' }),
      )
      .mockResolvedValue({ id: 'vercel-plugin', enabled: true, version: '3.0.0' });
    const { state, rows, install, refresh } = usePlugins();
    await refresh();
    const staleEntry = rows.value[0]!.catalogEntry!;

    await install(staleEntry);

    expect(apiMock.listPluginMarketplace).toHaveBeenCalledTimes(2);
    expect(state.entries[0]?.version).toBe('3.0.0');
    expect(rows.value[0]?.catalogEntry?.version).toBe('3.0.0');
    expect(state.rowErrors['vercel-plugin']).toBe('catalog changed');

    await install(staleEntry);

    expect(apiMock.installPlugin).toHaveBeenNthCalledWith(1, {
      marketplaceId: 'vercel-plugin',
      expectedVersion: '2.0.0',
      expectedSha256: 'a'.repeat(64),
    });
    expect(apiMock.installPlugin).toHaveBeenNthCalledWith(2, {
      marketplaceId: 'vercel-plugin',
      expectedVersion: '3.0.0',
      expectedSha256: 'a'.repeat(64),
    });
    expect(state.rowErrors['vercel-plugin']).toBeUndefined();
  });

  it('keeps the 40934 error and blocks install when the forced refresh fails', async () => {
    apiMock.listPluginMarketplace
      .mockResolvedValueOnce([entryVercel])
      .mockRejectedValue(new Error('catalog refresh failed'));
    apiMock.installPlugin.mockRejectedValue(
      new DaemonApiError({ code: 40934, msg: 'catalog changed', requestId: 'r' }),
    );
    const { state, rows, install, refresh } = usePlugins();
    await refresh();

    await install(entryVercel);

    expect(state.rowErrors['vercel-plugin']).toBe('catalog changed');
    expect(state.catalogError).toBe('catalog refresh failed');
    expect(state.entries).toEqual([]);
    expect(rows.value).toEqual([]);

    await install(entryVercel);
    expect(apiMock.installPlugin).toHaveBeenCalledTimes(1);
  });

  it('a plugins-list failure is the load error', async () => {
    apiMock.listPlugins.mockRejectedValue(new Error('engine down'));
    const { state, refresh } = usePlugins();

    await refresh();
    expect(state.error).toBe('engine down');
    expect(state.unsupported).toBe(false);
  });

  it('tolerates missing capability routes (capability rows just stay empty)', async () => {
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

  it('claims capability catalog entries into the capability rows', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([entryWebbridge, entryVercel]);
    apiMock.listCapabilities.mockResolvedValue([capabilityCu, capabilityWebbridge]);
    apiMock.listPlugins.mockResolvedValue([
      { id: 'kimi-webbridge', enabled: true, version: '1.11.0' },
    ]);
    const { capabilityRows, officialRows, refresh } = usePlugins();

    await refresh();

    expect(officialRows.value.map((row) => row.id)).toEqual([
      'kimi-webbridge',
      'vercel-plugin',
    ]);
    const webbridge = capabilityRows.value.find((row) => row.capability?.id === 'kimi-webbridge');
    expect(webbridge?.installedPlugin?.version).toBe('1.11.0');
    expect(webbridge?.updateAvailable).toBe(true);
    expect(capabilityRows.value.some((row) => row.capability?.id === 'kimi-cu')).toBe(false);
  });

  it('includes every installed plugin in installed rows', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([entryVercel]);
    apiMock.listPlugins.mockResolvedValue([
      {
        id: 'vercel-plugin',
        enabled: true,
        origin: 'marketplace',
        installedAt: '2026-01-02T00:00:00Z',
      },
      {
        id: 'my-local',
        enabled: false,
        version: '0.1.0',
        source: 'local-path',
        origin: 'custom',
        installedAt: '2026-01-01T00:00:00Z',
        shortDescription: 'Local short description',
        longDescription: 'Local long description',
      },
    ]);
    const { installedRows, refresh } = usePlugins();

    await refresh();

    expect(installedRows.value.map((row) => row.id)).toEqual(['vercel-plugin', 'my-local']);
    expect(installedRows.value[1]).toMatchObject({
      shortDescription: 'Local short description',
      longDescription: 'Local long description',
    });
  });

  it('installs a marketplace entry by id and expected version and refreshes', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([entryVercel]);
    apiMock.installPlugin.mockResolvedValue({ id: 'vercel-plugin' });
    const { state, install, refresh } = usePlugins();
    await refresh();

    await install(entryVercel);

    expect(apiMock.installPlugin).toHaveBeenCalledWith({
      marketplaceId: entryVercel.id,
      expectedVersion: entryVercel.version,
      expectedSha256: entryVercel.sha256sum,
    });
    expect(state.busy['vercel-plugin:install']).toBeUndefined();
    expect(state.rowErrors['vercel-plugin']).toBeUndefined();
    expect(apiMock.listPluginMarketplace).toHaveBeenCalledTimes(2);
  });

  it('installs a custom marketplace entry without a version or digest', async () => {
    const custom = { ...entryVercel, version: undefined, sha256sum: undefined };
    apiMock.listPluginMarketplace.mockResolvedValue([custom]);
    apiMock.installPlugin.mockResolvedValue({ id: 'vercel-plugin' });
    const { install, refresh } = usePlugins();
    await refresh();

    await install(custom);

    expect(apiMock.installPlugin).toHaveBeenCalledWith({
      marketplaceId: 'vercel-plugin',
      expectedVersion: undefined,
      expectedSha256: undefined,
    });
  });

  it('pins row errors without throwing and serializes the same action', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([entryVercel]);
    apiMock.installPlugin.mockRejectedValue(new Error('zip broken'));
    const { state, install, refresh } = usePlugins();
    await refresh();

    const first = install(entryVercel);
    const second = install(entryVercel);
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

    expect(apiMock.installCapability).toHaveBeenCalledWith('kimi-cu', undefined);
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
    expect(state.installed[0]?.enabled).toBe(false);

    release?.(new Error('daemon down'));
    await pending;
    expect(state.installed[0]?.enabled).toBe(true);
    expect(state.rowErrors['vercel-plugin']).toBe('daemon down');
  });

  it('removes locally only after the API succeeds and preserves the record on failure', async () => {
    apiMock.listPlugins.mockResolvedValue([{ id: 'my-local', enabled: true }]);
    let release: ((e: Error) => void) | undefined;
    apiMock.removePlugin.mockImplementation(
      () => new Promise((_, reject) => { release = reject; }),
    );
    const { state, remove, refresh } = usePlugins();
    await refresh();

    const pending = remove('my-local');
    expect(state.installed.map((p) => p.id)).toEqual(['my-local']);

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
        : new Promise(() => {});
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

    expect(state.busy['kimi-webbridge:remove']).toBeUndefined();
    expect(state.capabilities[0]?.state).toBe('partial');
  });

  it('applies a finished install locally (no seconds-long wait for the re-sync)', async () => {
    apiMock.listPluginMarketplace.mockImplementation(
      () => new Promise(() => {}),
    );
    apiMock.listPlugins.mockResolvedValue([]);
    apiMock.installPlugin.mockResolvedValue({
      id: 'vercel-plugin',
      enabled: true,
      version: '1.0.0',
    });
    const { state, install } = usePlugins();
    state.entries = [entryVercel];

    await install(entryVercel);

    expect(state.installed.map((p) => p.id)).toEqual(['vercel-plugin']);
  });

  it('applies the settled capability status immediately and raises the extension hint', async () => {
    apiMock.listCapabilities.mockResolvedValue([capabilityWebbridge]);
    apiMock.installCapability.mockResolvedValue({ install: { running: true } });
    apiMock.getCapability.mockResolvedValue({
      ...capabilityWebbridge,
      state: 'ready' as const,
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

    expect(state.installed).toEqual([]);
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
      ...capabilityWebbridge,
      state: 'ready' as const,
      install: { running: false },
      steps: [{ id: 'extension', state: 'missing', optional: true }],
    });
    const { state, setupCapability, refresh } = usePlugins();
    await refresh();

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

    expect(state.installed.map((p) => p.id)).toEqual(['kimi-webbridge']);
    expect(state.extensionHint).toBe(false);
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

    await install(entryVercel);
    const forced = refresh(true);
    for (const resolve of stalledResolvers.splice(0)) resolve([entryVercel]);
    await forced;

    await vi.waitFor(() => {
      expect(apiMock.listPluginMarketplace).toHaveBeenCalledTimes(3);
    });
    for (const resolve of stalledResolvers.splice(0)) resolve([entryVercel]);
  });

  it('arms the settle waiter before starting a capability install', async () => {
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
      ...capabilityWebbridge,
      state: 'ready' as const,
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
    apiMock.installPlugin.mockResolvedValue({
      id: 'vercel-plugin',
      catalogId: 'vercel-plugin',
      enabled: true,
      version: '2.0.0',
      origin: 'marketplace',
    });
    const { state, install, refresh } = usePlugins();
    await refresh();
    expect(state.entries[0]?.updateAvailable).toBe(true);

    await install(entryVercel);

    expect(state.entries[0]?.updateAvailable).toBeUndefined();
    expect(state.installed[0]?.version).toBe('2.0.0');
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
      return Promise.resolve([
        {
          id: 'vercel-plugin',
          catalogId: 'vercel-plugin',
          enabled: true,
          version: pluginCalls === 1 ? '1.0.0' : '2.0.0',
          origin: 'marketplace',
        },
      ]);
    });
    const { state, refresh } = usePlugins();
    await refresh();
    expect(state.entries[0]?.updateAvailable).toBe(true);

    handlePluginsShelfEvent({ type: 'pluginsChanged' });
    await vi.waitFor(() => {
      expect(state.entries[0]?.updateAvailable).toBeUndefined();
    });
    expect(state.installed[0]?.version).toBe('2.0.0');
  });

  it('requeues the catalog when a different package ID changes version by catalogId', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([entryVercel]);
    let pluginCalls = 0;
    apiMock.listPlugins.mockImplementation(() => {
      pluginCalls += 1;
      return Promise.resolve([
        {
          id: 'package-plugin',
          catalogId: 'vercel-plugin',
          enabled: true,
          version: pluginCalls === 1 ? entryVercel.version : '1.5.0',
        },
      ]);
    });
    const { refresh } = usePlugins();
    await refresh();

    handlePluginsShelfEvent({ type: 'pluginsChanged' });

    await vi.waitFor(() => {
      expect(apiMock.listPluginMarketplace).toHaveBeenCalledTimes(2);
    });
  });

  it('keeps installed wiring manageable without downgrading a missing capability route', async () => {
    apiMock.listCapabilities.mockRejectedValue(
      new DaemonApiError({ code: 404, msg: 'Not Found', requestId: 'r' }),
    );
    apiMock.listPluginMarketplace.mockResolvedValue([
      { id: 'kimi-webbridge', tier: 'official' as const, displayName: 'WB', source: 'https://cdn.example.test/wb.zip', capabilityId: 'kimi-webbridge' },
    ]);
    apiMock.listPlugins.mockResolvedValue([{ id: 'kimi-webbridge', enabled: true, version: '1.11.5' }]);
    const { state, installedRows, officialRows, refresh } = usePlugins();
    await refresh();

    expect(officialRows.value).toHaveLength(1);
    expect(officialRows.value[0]?.capabilityUnavailable).toBe(true);
    expect(pluginRowShowsInstall(officialRows.value[0]!)).toBe(false);
    expect(installedRows.value.map((row) => row.id)).toEqual(['kimi-webbridge']);
    expect(state.capabilitiesUnsupported).toBe(true);
  });

  it.each([false, true])('requires consent before retrying an install with process termination: %s', async (confirmed) => {
    const pendingConfirmation = {
      ...capabilityCu,
      install: { running: false, confirmationRequired: 'stop-processes' as const },
    };
    apiMock.listCapabilities.mockResolvedValue([capabilityCu]);
    apiMock.installCapability.mockResolvedValue(pendingConfirmation);
    apiMock.getCapability.mockResolvedValueOnce(pendingConfirmation).mockResolvedValue(capabilityCu);
    const confirmStopProcesses = vi.fn(async () => confirmed);
    const { state, refresh, setupCapability } = usePlugins();
    await refresh();
    await setupCapability('kimi-cu', { confirmStopProcesses });
    expect(confirmStopProcesses).toHaveBeenCalledOnce();
    expect(apiMock.installCapability).toHaveBeenCalledTimes(confirmed ? 2 : 1);
    if (confirmed) {
      expect(apiMock.installCapability).toHaveBeenLastCalledWith('kimi-cu', { stopRunningProcesses: true });
    }
    expect(state.rowErrors['kimi-cu']).toBeUndefined();
  });

  it('cancels the settle waiter when the install start fails', async () => {
    apiMock.installCapability.mockRejectedValue(new Error('daemon rejected'));
    const { state, setupCapability, refresh } = usePlugins();
    await refresh();

    await setupCapability('kimi-cu');

    expect(state.rowErrors['kimi-cu']).toBe('daemon rejected');
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
    apiMock.installPlugin.mockResolvedValue({ id: 'vercel-plugin', enabled: true, version: '1.5.0' });
    const { state, installSource, refresh } = usePlugins();
    await refresh();

    await installSource('https://example.test/vercel-1.5.0.zip');

    expect(state.entries[0]?.updateAvailable).toBe(true);
  });

  it('shows an unavailable capability row without a normal install fallback', async () => {
    apiMock.listCapabilities.mockRejectedValue(new Error('detector wedge'));
    apiMock.listPluginMarketplace.mockResolvedValue([
      { id: 'kimi-cu', tier: 'official' as const, displayName: 'CU', source: 'capability:kimi-cu', capabilityId: 'kimi-cu' },
    ]);
    apiMock.listPlugins.mockResolvedValue([]);
    const { state, officialRows, refresh } = usePlugins();
    await refresh();

    expect(state.capabilitiesUnsupported).toBe(false);
    expect(state.capabilitiesLoadFailed).toBe(true);
    expect(officialRows.value).toHaveLength(1);
    expect(officialRows.value[0]?.capabilityUnavailable).toBe(true);
    expect(pluginRowShowsInstall(officialRows.value[0]!)).toBe(false);
  });

  it('keeps waiting when the deadline passes mid-install (no premature settle)', async () => {
    __setSettleTimersForTests({ timeoutMs: 60, sliceMs: 10 });
    apiMock.listCapabilities.mockResolvedValue([capabilityWebbridge]);
    apiMock.installCapability.mockResolvedValue({ install: { running: true } });
    apiMock.getCapability.mockResolvedValue({
      id: 'kimi-webbridge',
      install: { running: true, step: 'download' },
    });
    const { state, setupCapability, refresh } = usePlugins();
    await refresh();

    await setupCapability('kimi-webbridge');

    expect(state.extensionHint).toBe(false);
    expect(state.rowErrors['kimi-webbridge']).toBeUndefined();
  });

  it('settles immediately when the install response is already non-running', async () => {
    apiMock.listCapabilities.mockResolvedValue([capabilityCu]);
    apiMock.installCapability.mockResolvedValue({ install: { running: true } });
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
    await refresh();

    const installDone = install(entryVercel);
    await vi.waitFor(() => expect(stalled.length).toBeGreaterThanOrEqual(1));
    const removeDone = remove('vercel-plugin');
    stalled.shift()?.([entryVercel]);
    await Promise.all([installDone, removeDone]);
    for (const resolve of stalled.splice(0)) resolve([entryVercel]);
    await vi.waitFor(() => expect(entriesCalls).toBeGreaterThanOrEqual(3));

    expect(state.installed).toEqual([]);
  });

  it('clears the extension hint via the live capability reconcile', async () => {
    apiMock.listCapabilities.mockResolvedValue([capabilityWebbridge]);
    apiMock.installCapability.mockResolvedValue({ install: { running: true } });
    apiMock.getCapability.mockResolvedValue({
      ...capabilityWebbridge,
      state: 'ready' as const,
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
    handlePluginsShelfEvent({ type: 'pluginsChanged' });
    await vi.waitFor(() => {
      expect(state.extensionHint).toBe(false);
    });
  });

  it('reconciles plugins when a ready capability lacks its wiring record', async () => {
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

  it('keeps a retryable capability row when the wiring reconcile rejects', async () => {
    const followUp = deferred<unknown>();
    apiMock.listPluginMarketplace.mockResolvedValue([entryWebbridge]);
    apiMock.listPlugins
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => followUp.promise);
    apiMock.listCapabilities.mockResolvedValue([
      { ...capabilityWebbridge, state: 'ready' as const },
    ]);
    const { state, capabilityRows, refresh } = usePlugins();
    await refresh();

    followUp.reject(new Error('wiring read failed'));
    await vi.waitFor(() => {
      expect(state.rowErrors['kimi-webbridge']).toBe('wiring read failed');
    });

    const row = capabilityRows.value[0];
    expect(row?.installedPlugin).toBeUndefined();
    expect(pluginRowShowsInstall(row!)).toBe(true);
    expect(apiMock.installPlugin).not.toHaveBeenCalled();
  });

  it('discards an older empty wiring response that arrives after a newer plugin list', async () => {
    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    apiMock.listPlugins
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    apiMock.listCapabilities.mockResolvedValue([
      { ...capabilityWebbridge, state: 'ready' as const },
    ]);
    const { state, refresh } = usePlugins();
    await refresh();

    handlePluginsShelfEvent({ type: 'pluginsChanged' });
    newer.resolve([{ id: 'kimi-webbridge', enabled: true, version: '1.11.5' }]);
    await vi.waitFor(() => {
      expect(state.installed.map((plugin) => plugin.id)).toEqual(['kimi-webbridge']);
    });

    older.resolve([]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.installed.map((plugin) => plugin.id)).toEqual(['kimi-webbridge']);
    expect(state.rowErrors['kimi-webbridge']).toBeUndefined();
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

    const force = refresh(true);
    await vi.waitFor(() => expect(stalled.length).toBe(1));
    handlePluginsShelfEvent({ type: 'pluginsChanged' });
    for (const resolve of stalled.splice(0)) resolve([entryVercel]);
    await force;
    await vi.waitFor(() => expect(pluginCalls).toBeGreaterThanOrEqual(3));

    expect(state.installed.map((p) => p.id)).toEqual(['vercel-plugin']);
    expect(state.installed[0]?.enabled).toBe(true);
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
      { id: 'kimi-webbridge', tier: 'official' as const, displayName: 'WB', source: 'https://cdn.example.test/wb.zip', capabilityId: 'kimi-webbridge' },
    ]);
    apiMock.listPlugins.mockResolvedValue([{ id: 'kimi-webbridge', enabled: true, version: '1.11.5' }]);
    const { installedRows, capabilityRows, officialRows, refresh } = usePlugins();
    await refresh();

    expect(capabilityRows.value).toHaveLength(1);
    expect(officialRows.value).toHaveLength(1);
    expect(pluginRowShowsInstall(officialRows.value[0]!)).toBe(false);
    expect(installedRows.value.map((row) => row.id)).toEqual(['kimi-webbridge']);
  });

  it('keeps capability-marked entries unavailable when their status is absent', async () => {
    apiMock.listCapabilities.mockResolvedValue([capabilityCu]);
    apiMock.listPluginMarketplace.mockResolvedValue([
      { id: 'kimi-cu', tier: 'official' as const, displayName: 'CU', source: 'capability:kimi-cu', capabilityId: 'kimi-cu' },
      { id: 'kimi-webbridge', tier: 'official' as const, displayName: 'WB', source: 'https://cdn.example.test/wb.zip', capabilityId: 'kimi-webbridge' },
      entryVercel,
    ]);
    apiMock.listPlugins.mockResolvedValue([]);
    const { officialRows, refresh } = usePlugins();
    await refresh();

    expect(officialRows.value.map((row) => row.id)).toEqual([
      'kimi-cu',
      'kimi-webbridge',
      'vercel-plugin',
    ]);
    expect(officialRows.value[1]?.capabilityUnavailable).toBe(true);
    expect(pluginRowShowsInstall(officialRows.value[1]!)).toBe(false);
  });

  it('re-reads the catalog when a live reconcile finds a version mismatch', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([
      { ...entryVercel, version: '2.0.0', installed: { version: '2.0.0', enabled: true } },
    ]);
    apiMock.listPlugins.mockResolvedValue([{
      id: 'vercel-plugin',
      catalogId: 'vercel-plugin',
      enabled: true,
      version: '2.0.0',
      origin: 'marketplace',
    }]);
    const { refresh } = usePlugins();
    await refresh();
    expect(apiMock.listPluginMarketplace).toHaveBeenCalledTimes(1);

    apiMock.listPlugins.mockResolvedValue([{
      id: 'vercel-plugin',
      catalogId: 'vercel-plugin',
      enabled: true,
      version: '1.5.0',
      origin: 'marketplace',
    }]);
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

  it('loads capability details for the selected source and current locale', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([entryVercel]);
    apiMock.listPlugins.mockResolvedValue([
      {
        id: 'vercel-plugin',
        catalogId: 'vercel-plugin',
        enabled: true,
        version: '1.0.0',
        origin: 'marketplace',
      },
    ]);
    apiMock.getPluginInfo.mockResolvedValue({ skills: [{ name: 'local-skill' }], mcpServers: [] });
    apiMock.previewPlugin.mockResolvedValue({ skills: [{ name: 'preview-skill' }], mcpServers: [] });
    let currentLocale = 'zh-CN';
    const { rows, loadPluginCapabilities, refresh } = usePlugins({ locale: () => currentLocale });
    await refresh();
    const row = rows.value[0]!;

    await expect(loadPluginCapabilities(row, 'installed')).resolves.toEqual({
      skills: [{ name: 'local-skill' }],
      mcpServers: [],
    });
    expect(apiMock.getPluginInfo).toHaveBeenCalledWith('vercel-plugin', 'zh-CN');
    expect(apiMock.previewPlugin).not.toHaveBeenCalled();

    currentLocale = 'en-US';
    await expect(loadPluginCapabilities(row, 'marketplace')).resolves.toEqual({
      skills: [{ name: 'preview-skill' }],
      mcpServers: [],
    });
    await expect(loadPluginCapabilities({ ...row, installedPlugin: undefined }, 'marketplace')).resolves.toEqual({
      skills: [{ name: 'preview-skill' }],
      mcpServers: [],
    });
    expect(apiMock.previewPlugin).toHaveBeenCalledTimes(2);
    expect(apiMock.previewPlugin).toHaveBeenCalledWith({
      marketplaceId: 'vercel-plugin',
      expectedVersion: '2.0.0',
      expectedSha256: 'a'.repeat(64),
      locale: 'en-US',
    });
  });

  it('uses installed capabilities in marketplace details when the versions match', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([{ ...entryVercel, version: '1.0.0' }]);
    apiMock.listPlugins.mockResolvedValue([
      {
        id: 'vercel-plugin',
        catalogId: 'vercel-plugin',
        enabled: true,
        version: '1.0.0',
        origin: 'marketplace',
      },
    ]);
    apiMock.getPluginInfo.mockResolvedValue({ skills: [{ name: 'local-skill' }], mcpServers: [] });
    const { rows, loadPluginCapabilities, refresh } = usePlugins();
    await refresh();

    await expect(loadPluginCapabilities(rows.value[0]!, 'marketplace')).resolves.toEqual({
      skills: [{ name: 'local-skill' }],
      mcpServers: [],
    });
    expect(apiMock.getPluginInfo).toHaveBeenCalledWith('vercel-plugin', 'en');
    expect(apiMock.previewPlugin).not.toHaveBeenCalled();
  });

  it('previews marketplace capabilities without a digest instead of reading the installed package', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([
      { ...entryVercel, sha256sum: undefined },
    ]);
    apiMock.listPlugins.mockResolvedValue([
      { id: 'vercel-plugin', enabled: true, version: '1.0.0', origin: 'marketplace' },
    ]);
    apiMock.previewPlugin.mockResolvedValue({ skills: [{ name: 'preview-skill' }], mcpServers: [] });
    const { rows, loadPluginCapabilities, refresh } = usePlugins();
    await refresh();
    const row = rows.value[0]!;

    await expect(loadPluginCapabilities(row, 'marketplace')).resolves.toEqual({
      skills: [{ name: 'preview-skill' }],
      mcpServers: [],
    });

    expect(apiMock.previewPlugin).toHaveBeenCalledWith({
      marketplaceId: 'vercel-plugin',
      expectedVersion: '2.0.0',
      expectedSha256: undefined,
      locale: 'en',
    });
    expect(apiMock.getPluginInfo).not.toHaveBeenCalled();
  });

  it('associates a capability by capabilityId across different plugin IDs', async () => {
    const entry = {
      id: 'kimi-browser-extension',
      tier: 'official' as const,
      displayName: 'Kimi browser extension',
      version: '2.0.0',
      source: 'https://cdn.example.test/browser.zip',
      capabilityId: 'kimi-webbridge',
      installed: { version: '2.0.0', enabled: true },
      updateAvailable: true,
    };
    const capability = {
      ...capabilityWebbridge,
      id: 'kimi-webbridge',
      pluginId: 'kimi-browser-extension',
      state: 'ready' as const,
    };
    apiMock.listPluginMarketplace.mockResolvedValue([entry]);
    apiMock.listCapabilities.mockResolvedValue([capability]);
    apiMock.listPlugins.mockResolvedValue([
      {
        id: 'kimi-browser-extension',
        enabled: false,
        version: '1.0.0',
        origin: 'marketplace',
        installedAt: '2026-01-01T00:00:00Z',
      },
    ]);
    apiMock.installCapability.mockResolvedValue(capability);
    apiMock.getCapability.mockResolvedValue(capability);
    const { rows, installedRows, refresh, install } = usePlugins();
    await refresh();

    expect(rows.value).toHaveLength(1);
    expect(rows.value[0]?.catalogEntry?.id).toBe('kimi-browser-extension');
    expect(rows.value[0]?.capability?.id).toBe('kimi-webbridge');
    expect(rows.value[0]?.installedPlugin?.id).toBe('kimi-browser-extension');
    expect(rows.value[0]?.installedPlugin?.enabled).toBe(false);
    expect(rows.value[0]?.updateAvailable).toBe(true);
    expect(installedRows.value).toHaveLength(1);

    await install(entry);

    expect(apiMock.installCapability).toHaveBeenCalledWith('kimi-webbridge', undefined);
    expect(apiMock.installPlugin).not.toHaveBeenCalled();
  });

  it('keeps same-ID custom plugins out of capability rows', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([entryWebbridge]);
    apiMock.listCapabilities.mockResolvedValue([capabilityWebbridge]);
    apiMock.listPlugins.mockResolvedValue([{
      id: 'kimi-webbridge',
      enabled: true,
      version: '1.0.0',
      origin: 'custom',
    }]);
    const { rows, installedRows, refresh } = usePlugins();
    await refresh();

    const official = rows.value.find((row) => row.capability !== undefined)!;
    expect(official.installedPlugin).toBeUndefined();
    expect(official.updateAvailable).toBe(false);
    expect(pluginRowShowsInstall(official)).toBe(true);
    const custom = rows.value.find((row) => row.installedPlugin?.origin === 'custom')!;
    expect(custom.catalogEntry).toBeUndefined();
    expect(custom.capability).toBeUndefined();
    expect(installedRows.value.map((row) => row.installedPlugin?.origin)).toEqual(['custom']);
  });

  it('associates a legacy WebBridge installation with the canonical migration entry', async () => {
    const entry = {
      id: 'kimi-browser-extension',
      tier: 'official' as const,
      displayName: 'Kimi browser extension',
      version: '2.0.0',
      source: 'https://cdn.example.test/browser.zip',
      capabilityId: 'kimi-webbridge',
      updateAvailable: true,
    };
    const capability = {
      ...capabilityWebbridge,
      pluginId: 'kimi-browser-extension',
      state: 'ready' as const,
    };
    apiMock.listPluginMarketplace.mockResolvedValue([entry]);
    apiMock.listCapabilities.mockResolvedValue([capability]);
    apiMock.listPlugins.mockResolvedValue([
      {
        id: 'kimi-webbridge',
        enabled: false,
        version: '1.0.0',
        origin: 'unknown',
        installedAt: '2026-01-01T00:00:00Z',
      },
    ]);
    apiMock.installCapability.mockResolvedValue(capability);
    apiMock.getCapability.mockResolvedValue(capability);
    const { rows, installedRows, installedGroups, refresh, installRow } = usePlugins();
    await refresh();

    expect(rows.value).toHaveLength(1);
    const row = rows.value[0]!;
    expect(row.catalogEntry?.id).toBe('kimi-browser-extension');
    expect(row.installedPlugin?.id).toBe('kimi-webbridge');
    expect(row.installedPlugin?.enabled).toBe(false);
    expect(row.updateAvailable).toBe(true);
    expect(pluginRowShowsInstall(row)).toBe(true);
    expect(installedRows.value).toHaveLength(1);
    expect(installedGroups.value.marketplace.map((item) => item.installedPlugin?.id)).toEqual([
      'kimi-webbridge',
    ]);

    await installRow(row);

    expect(apiMock.installCapability).toHaveBeenCalledWith('kimi-webbridge', undefined);
    expect(apiMock.installPlugin).not.toHaveBeenCalled();
  });

  it('selects localized names and descriptions in the renderer', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([
      {
        id: 'localized',
        tier: 'official' as const,
        displayName: 'Localized name',
        source: 'localized',
        description: 'Top description',
        cliDescription: 'CLI description',
        locale: {
          'zh-CN': {
            displayName: '本地化名称',
            shortDescription: '中文短描述',
            longDescription: '中文长描述',
          },
        },
      },
      {
        id: 'long-only',
        tier: 'official' as const,
        displayName: 'Long only',
        source: 'long-only',
        locale: { zh: { longDescription: '同语言长描述' } },
      },
      {
        id: 'default-locale',
        tier: 'official' as const,
        displayName: 'Default locale',
        source: 'default-locale',
        defaultLocale: 'en-US',
        description: 'Top default long',
        locale: { 'en-us': { shortDescription: 'Default short', longDescription: 'Default long' } },
      },
      {
        id: 'regional-priority',
        tier: 'official' as const,
        displayName: 'Regional priority',
        source: 'regional-priority',
        defaultLocale: 'en-US',
        description: 'Default US long',
        locale: {
          'en-GB': { shortDescription: 'Current GB short', longDescription: 'Current GB long' },
        },
      },
      {
        id: 'top-fallback',
        tier: 'official' as const,
        displayName: 'Top fallback',
        source: 'top-fallback',
        defaultLocale: 'en-US',
        description: 'Top fallback long',
        locale: { 'en-us': { shortDescription: 'Only short' } },
      },
      {
        id: 'top-level',
        tier: 'official' as const,
        displayName: 'Top level',
        source: 'top-level',
        description: 'Top description',
        cliDescription: 'CLI description',
      },
      {
        id: 'top-fields',
        tier: 'official' as const,
        displayName: 'Top fields',
        source: 'top-fields',
        defaultLocale: 'en-US',
        shortDescription: 'Top short',
        longDescription: 'Top long',
        description: 'Top description',
        locale: {
          'zh-cn': { shortDescription: '顶部短描述', longDescription: '顶部长描述' },
        },
      },
      {
        id: 'cli-only',
        tier: 'official' as const,
        displayName: 'CLI only',
        source: 'cli-only',
        cliDescription: 'CLI description',
      },
    ]);
    const { officialRows, refresh } = usePlugins({ locale: 'zh-CN' });
    await refresh();

    expect(officialRows.value.map((row) => [
      row.id,
      row.displayName,
      row.shortDescription,
      row.longDescription,
    ])).toEqual([
      ['localized', '本地化名称', '中文短描述', '中文长描述'],
      ['long-only', 'Long only', '-', '同语言长描述'],
      ['default-locale', 'Default locale', 'Default short', 'Default long'],
      ['regional-priority', 'Regional priority', 'Current GB short', 'Current GB long'],
      ['top-fallback', 'Top fallback', 'Only short', 'Top fallback long'],
      ['top-level', 'Top level', '-', 'Top description'],
      ['top-fields', 'Top fields', '顶部短描述', '顶部长描述'],
      ['cli-only', 'CLI only', '-', undefined],
    ]);

    const english = usePlugins({ locale: 'en' });
    await english.refresh();
    expect(english.officialRows.value.find((row) => row.id === 'default-locale')).toMatchObject({
      shortDescription: 'Default short',
      longDescription: 'Default long',
    });
    expect(english.officialRows.value.find((row) => row.id === 'regional-priority')).toMatchObject({
      shortDescription: 'Current GB short',
      longDescription: 'Current GB long',
    });
    expect(english.officialRows.value.find((row) => row.id === 'top-fields')).toMatchObject({
      shortDescription: 'Top short',
      longDescription: 'Top long',
    });
  });

  it('matches a language-only UI locale to a regional marketplace locale', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([{
      id: 'regional',
      tier: 'official' as const,
      displayName: 'Regional',
      source: 'regional',
      locale: {
        'zh-cn': {
          shortDescription: '区域短描述',
          longDescription: '区域长介绍',
        },
      },
    }]);
    const { officialRows, refresh } = usePlugins({ locale: 'zh' });
    await refresh();

    expect(officialRows.value[0]).toMatchObject({
      shortDescription: '区域短描述',
      longDescription: '区域长介绍',
    });
  });

  it('prefers the default regional locale for a language-only UI locale', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([{
      id: 'regional',
      tier: 'official' as const,
      displayName: 'Regional',
      source: 'regional',
      defaultLocale: 'en-US',
      locale: {
        'en-GB': { shortDescription: 'British short', longDescription: 'British long' },
        'en-US': { shortDescription: 'Default short', longDescription: 'Default long' },
      },
    }]);
    const { officialRows, refresh } = usePlugins({ locale: 'en' });
    await refresh();

    expect(officialRows.value[0]).toMatchObject({
      shortDescription: 'Default short',
      longDescription: 'Default long',
    });
  });

  it('groups explicit origins and classifies legacy records by catalog match', async () => {
    const plugin = (
      id: string,
      origin: 'marketplace' | 'custom' | 'unknown',
      installedAt: string,
    ) => ({ id, displayName: id, enabled: true, source: 'local-path', origin, installedAt });
    apiMock.listPluginMarketplace.mockResolvedValue([{ ...entryVercel, id: 'unknown-b' }]);
    apiMock.listPlugins.mockResolvedValue([
      plugin('unknown-b', 'unknown', 'invalid'),
      plugin('market-old', 'marketplace', '2025-01-01T00:00:00Z'),
      plugin('custom-b', 'custom', '2026-02-01T00:00:00Z'),
      plugin('custom-z', 'custom', 'invalid'),
      plugin('unknown-a', 'unknown', ''),
      plugin('custom-new', 'custom', '2026-03-01T00:00:00Z'),
      plugin('market-new', 'marketplace', '2026-01-01T00:00:00Z'),
      plugin('custom-a', 'custom', '2026-02-01T00:00:00Z'),
    ]);
    const { installedRows, installedGroups, refresh } = usePlugins();
    await refresh();

    expect(installedGroups.value.custom.map((row) => row.id)).toEqual([
      'custom-new',
      'custom-a',
      'custom-b',
      'custom-z',
      'unknown-a',
    ]);
    expect(installedGroups.value.marketplace.map((row) => row.id)).toEqual([
      'market-new',
      'market-old',
      'unknown-b',
    ]);
    expect(Object.keys(installedGroups.value)).toEqual(['marketplace', 'custom']);
    expect(installedRows.value.map((row) => row.id)).toEqual([
      'market-new',
      'market-old',
      'unknown-b',
      'custom-new',
      'custom-a',
      'custom-b',
      'custom-z',
      'unknown-a',
    ]);
  });

  it('uses only installed records for installation existence and enabled state', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([
      { ...entryVercel, installed: { version: '1.0.0', enabled: true } },
    ]);
    apiMock.listPlugins.mockResolvedValue([]);
    const { officialRows, refresh } = usePlugins();
    await refresh();

    expect(officialRows.value[0]?.installedPlugin).toBeUndefined();
    expect(pluginRowShowsInstall(officialRows.value[0]!)).toBe(true);

    apiMock.listPlugins.mockResolvedValue([
      {
        id: 'vercel-plugin',
        catalogId: 'vercel-plugin',
        enabled: false,
        origin: 'marketplace',
        installedAt: '2026-01-01T00:00:00Z',
      },
    ]);
    await refresh(true);

    expect(officialRows.value[0]?.installedPlugin?.enabled).toBe(false);
  });

  it('shows a ready extension hint on refresh and preserves dismissal after reconnection', async () => {
    const missing = {
      ...capabilityWebbridge,
      state: 'ready' as const,
      steps: [{ id: 'extension', state: 'missing' as const, optional: true }],
    };
    apiMock.listCapabilities.mockResolvedValue([missing]);
    const { state, refresh, dismissExtensionHint } = usePlugins();
    await refresh();
    expect(state.extensionHint).toBe(true);

    dismissExtensionHint();
    await refresh(true);
    expect(state.extensionHint).toBe(false);

    apiMock.listCapabilities.mockResolvedValue([
      { ...missing, steps: [{ id: 'extension', state: 'ok' as const, optional: true }] },
    ]);
    await refresh(true);
    apiMock.listCapabilities.mockResolvedValue([missing]);
    await refresh(true);
    expect(state.extensionHint).toBe(false);
  });

  it('restores a dismissed extension hint after a renderer reload', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    const missing = {
      ...capabilityWebbridge,
      state: 'ready' as const,
      steps: [{ id: 'extension', state: 'missing' as const, optional: true }],
    };
    apiMock.listCapabilities.mockResolvedValue([missing]);
    const { state, refresh, dismissExtensionHint } = usePlugins();
    await refresh();
    expect(state.extensionHint).toBe(true);
    dismissExtensionHint();

    vi.resetModules();
    const reloaded = await import('../src/composables/usePlugins');
    const next = reloaded.usePlugins();
    await next.refresh();

    expect(next.state.extensionHint).toBe(false);
    reloaded.__resetPluginsForTests();
    vi.unstubAllGlobals();
  });

  it('keeps a visible extension hint when WebBridge installation is rejected', async () => {
    const missing = {
      ...capabilityWebbridge,
      state: 'ready' as const,
      steps: [{ id: 'extension', state: 'missing' as const, optional: true }],
    };
    apiMock.listCapabilities.mockResolvedValue([missing]);
    apiMock.listPlugins.mockResolvedValue([{ id: 'kimi-webbridge', enabled: true }]);
    apiMock.installCapability.mockRejectedValue(new Error('installation rejected'));
    const { state, refresh, setupCapability } = usePlugins();
    await refresh();
    expect(state.extensionHint).toBe(true);

    await setupCapability('kimi-webbridge');

    expect(state.extensionHint).toBe(true);
    expect(state.rowErrors['kimi-webbridge']).toBe('installation rejected');
  });

  it('preserves a dismissed extension hint when WebBridge installation is rejected', async () => {
    const missing = {
      ...capabilityWebbridge,
      state: 'ready' as const,
      steps: [{ id: 'extension', state: 'missing' as const, optional: true }],
    };
    apiMock.listCapabilities.mockResolvedValue([missing]);
    apiMock.listPlugins.mockResolvedValue([{ id: 'kimi-webbridge', enabled: true }]);
    apiMock.installCapability.mockRejectedValue(new Error('installation rejected'));
    const { state, refresh, setupCapability, dismissExtensionHint } = usePlugins();
    await refresh();
    dismissExtensionHint();
    expect(state.extensionHint).toBe(false);

    await setupCapability('kimi-webbridge');
    await refresh(true);

    expect(state.extensionHint).toBe(false);
    expect(state.rowErrors['kimi-webbridge']).toBe('installation rejected');
  });

  it('allows a cloud plus local entry to use the ordinary local install route', async () => {
    const localEntry = { ...entryVercel, platforms: ['cloud', 'macos'] };
    apiMock.listPluginMarketplace.mockResolvedValue([localEntry]);
    apiMock.installPlugin.mockResolvedValue({ id: 'vercel-plugin', enabled: true });
    const { officialRows, refresh, install } = usePlugins();
    await refresh();

    expect(officialRows.value[0]?.cloudOnly).toBe(false);
    expect(pluginRowShowsInstall(officialRows.value[0]!)).toBe(true);
    await install(localEntry);

    expect(apiMock.installPlugin).toHaveBeenCalledWith({
      marketplaceId: localEntry.id,
      expectedVersion: localEntry.version,
      expectedSha256: localEntry.sha256sum,
    });
    expect(apiMock.installCapability).not.toHaveBeenCalled();
  });

  it('installs a marketplace entry without a version but with a digest', async () => {
    const missing = { ...entryVercel, version: undefined };
    apiMock.listPluginMarketplace.mockResolvedValue([missing]);
    const { install, refresh } = usePlugins();
    await refresh();

    await install(missing);

    expect(apiMock.installPlugin).toHaveBeenCalledWith({
      marketplaceId: missing.id,
      expectedVersion: undefined,
      expectedSha256: missing.sha256sum,
    });
  });

  it('refreshCapability updates a single capability and extension hint without toggling loading', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([entryWebbridge]);
    apiMock.listCapabilities.mockResolvedValue([
      {
        ...capabilityWebbridge,
        state: 'ready',
        steps: [
          { id: 'daemon', state: 'ok' },
          { id: 'skill', state: 'ok' },
          { id: 'extension', state: 'missing', optional: true },
        ],
      },
    ]);
    const { state, refresh, refreshCapability, rows } = usePlugins();
    await refresh();
    expect(state.extensionHint).toBe(true);

    apiMock.getCapability.mockResolvedValue({
      ...capabilityWebbridge,
      state: 'ready',
      steps: [
        { id: 'daemon', state: 'ok' },
        { id: 'skill', state: 'ok' },
        { id: 'extension', state: 'ok', optional: true },
      ],
    });

    const status = await refreshCapability('kimi-webbridge');

    expect(status?.steps.find((step) => step.id === 'extension')?.state).toBe('ok');
    expect(state.loading).toBe(false);
    expect(state.extensionHint).toBe(false);
    expect(rows.value[0]?.capability?.steps.find((step) => step.id === 'extension')?.state).toBe('ok');
    expect(apiMock.listPluginMarketplace).toHaveBeenCalledTimes(1);
  });

  it('refreshCapability ignores stale out-of-order responses', async () => {
    apiMock.listCapabilities.mockResolvedValue([capabilityWebbridge]);
    const { state, refresh, refreshCapability } = usePlugins();
    await refresh();

    const first = deferred<AppCapabilityStatus>();
    const second = deferred<AppCapabilityStatus>();
    apiMock.getCapability.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const firstCall = refreshCapability('kimi-webbridge');
    const secondCall = refreshCapability('kimi-webbridge');
    second.resolve({
      ...capabilityWebbridge,
      state: 'ready',
      steps: [{ id: 'extension', state: 'ok', optional: true }],
    });
    await secondCall;
    first.resolve({
      ...capabilityWebbridge,
      state: 'partial',
      steps: [{ id: 'extension', state: 'missing', optional: true }],
    });
    const stale = await firstCall;

    expect(stale).toBeUndefined();
    expect(state.capabilities[0]?.steps[0]?.state).toBe('ok');
  });

  it('installRow reports installed, failed, and cancelled outcomes', async () => {
    apiMock.listPluginMarketplace.mockResolvedValue([entryVercel, entryWebbridge]);
    apiMock.listCapabilities.mockResolvedValue([{ ...capabilityWebbridge, state: 'ready' }]);
    const { refresh, installRow, rows } = usePlugins();
    await refresh();

    apiMock.installPlugin.mockResolvedValueOnce({
      id: 'vercel-plugin',
      catalogId: 'vercel-plugin',
      enabled: true,
      origin: 'marketplace',
    });
    const vercelRow = rows.value.find((row) => row.id === 'vercel-plugin')!;
    await expect(installRow(vercelRow)).resolves.toBe('installed');

    apiMock.installPlugin.mockRejectedValueOnce(new Error('network down'));
    await expect(installRow(vercelRow)).resolves.toBe('failed');

    apiMock.installCapability.mockResolvedValue({ install: { running: true } });
    apiMock.getCapability.mockResolvedValue({
      ...capabilityWebbridge,
      state: 'ready',
      install: { running: false, confirmationRequired: 'stop-processes' },
    });
    const webbridgeRow = rows.value.find((row) => row.id === 'kimi-webbridge')!;
    await expect(
      installRow(webbridgeRow, { confirmStopProcesses: () => Promise.resolve(false) }),
    ).resolves.toBe('cancelled');
  });

  it('requestCapabilityPermissions preserves late errors even after a poll refresh starts', async () => {
    apiMock.listCapabilities.mockResolvedValue([capabilityCu]);
    const { state, refresh, refreshCapability, requestCapabilityPermissions } = usePlugins();
    await refresh();

    const slowRequest = deferred<AppCapabilityStatus>();
    apiMock.requestCapabilityPermissions.mockReturnValueOnce(slowRequest.promise);
    apiMock.getCapability.mockResolvedValueOnce(capabilityCu);

    const pending = requestCapabilityPermissions('kimi-cu');
    await refreshCapability('kimi-cu');
    slowRequest.reject(new Error('helper launch failed'));
    const result = await pending;

    expect(result).toBeUndefined();
    expect(state.rowErrors['kimi-cu']).toBe('helper launch failed');
  });
});


describe('pluginRowShowsInstall', () => {
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
    origin: 'marketplace' as const,
    installedAt: '2026-01-01T00:00:00Z',
  };

  function rowOf(
    status: AppCapabilityStatus,
    opts: { plugin?: typeof installedWiring; updateAvailable?: boolean } = {},
  ): PluginViewModel {
    const catalogEntry = {
      id: status.pluginId ?? status.id,
      tier: 'official' as const,
      displayName: status.displayName,
      source: `capability:${status.id}`,
      capabilityId: status.id,
    };
    return {
      id: catalogEntry.id,
      installId: status.id,
      catalogEntry,
      installedPlugin: opts.plugin,
      capability: status,
      capabilityRequired: true,
      capabilityUnavailable: false,
      cloudOnly: false,
      official: true,
      displayName: status.displayName,
      updateAvailable: opts.updateAvailable ?? false,
    };
  }

  it('offers install on a not-installed row', () => {
    expect(pluginRowShowsInstall(rowOf(capabilityCu))).toBe(true);
  });

  it('does not offer install or repair on a partial row with installed wiring', () => {
    expect(pluginRowShowsInstall(rowOf(capabilityWebbridge, { plugin: installedWiring }))).toBe(false);
    expect(
      pluginRowShowsInstall(rowOf(capabilityWebbridge, { plugin: { ...installedWiring, enabled: false } })),
    ).toBe(false);
  });

  it('keeps the update affordance on a ready row with a newer catalog build', () => {
    const ready = { ...capabilityWebbridge, state: 'ready' as const };
    expect(pluginRowShowsInstall(rowOf(ready, { plugin: installedWiring, updateAvailable: true }))).toBe(true);
    expect(pluginRowShowsInstall(rowOf(ready, { plugin: installedWiring }))).toBe(false);
  });

  it('offers an update for a partial WebBridge row with a newer catalog build', () => {
    expect(
      pluginRowShowsInstall(rowOf(capabilityWebbridge, { plugin: installedWiring, updateAvailable: true })),
    ).toBe(true);
  });

  it('does not offer an update for other partial capabilities', () => {
    const partial = { ...capabilityCu, state: 'partial' as const };
    expect(
      pluginRowShowsInstall(rowOf(partial, { plugin: installedWiring, updateAvailable: true })),
    ).toBe(false);
  });

  it('offers an idempotent install on a ready row whose wiring record is missing', () => {
    const ready = { ...capabilityWebbridge, state: 'ready' as const };
    expect(pluginRowShowsInstall(rowOf(ready))).toBe(true);
  });

  it('keeps the loading affordance while an install runs', () => {
    const running = { ...capabilityWebbridge, install: { running: true, step: 'daemon' } };
    expect(pluginRowShowsInstall(rowOf(running, { plugin: installedWiring }))).toBe(true);
  });

  it('does not offer capability install or update without a catalog entry', () => {
    const row = rowOf(capabilityWebbridge, {
      plugin: installedWiring,
      updateAvailable: true,
    });
    row.catalogEntry = undefined;
    expect(pluginRowShowsInstall(row)).toBe(false);
  });

  it('does not fall back to a normal install when capability status is unavailable', () => {
    const row = rowOf(capabilityCu);
    row.capability = undefined;
    row.capabilityUnavailable = true;
    expect(pluginRowShowsInstall(row)).toBe(false);
  });
});
