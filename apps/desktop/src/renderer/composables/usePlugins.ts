// apps/desktop/src/renderer/composables/usePlugins.ts
// Desktop-only plugins shelf state: marketplace catalog + installed plugins +
// built-in capabilities, all through the daemon REST routes (no IPC). The tab
// is hidden when the plugins routes are missing (older servers), so the web
// copy can mount the same panel later without feature-detection forks.
//
// Three data sources converge into row models:
//   - GET /plugins/marketplace — catalog merged with live install state
//   - GET /plugins             — installed plugins (catalog-less local installs
//                                surface in the Installed section)
//   - GET /capabilities        — built-in capability readiness (kimi-cu,
//                                kimi-webbridge); powers the Built-in section
//
// Capability wiring plugins (e.g. the kimi-webbridge skill plugin) are claimed
// by their capability row: the catalog sections drop them, and the capability
// row carries the wiring plugin's enable/remove actions. Capability installs
// go through the capability route (binary runtime + wiring with live progress);
// an install already running elsewhere (TUI, another client) is followed, never
// restarted.

import { computed, reactive } from 'vue';
import { getKimiWebApi } from '../api';
import { DaemonNetworkError, isDaemonApiError } from '@moonshot-ai/app-core';
import type {
  AppCapabilityInstallProgress,
  AppCapabilityStatus,
  AppPluginMarketplaceEntry,
  AppPluginSummary,
} from '@moonshot-ai/app-core';

export type PluginRowAction = 'install' | 'remove' | 'toggle';

/** Row id reserved for the custom-source install form (never a real plugin). */
export const CUSTOM_INSTALL_ROW_ID = '__custom__';

export interface CapabilityRow {
  status: AppCapabilityStatus;
  /** Wiring plugin id — `status.pluginId`, falling back to the capability id. */
  pluginId: string;
  /** Wiring plugin install state (undefined = wiring not installed). */
  plugin?: AppPluginSummary;
  /** Catalog entry for the wiring plugin, when the marketplace carries it. */
  catalogEntry?: AppPluginMarketplaceEntry;
  /** Catalog declares a strictly newer wiring plugin version. */
  updateAvailable: boolean;
}

export interface PluginsShelfState {
  entries: AppPluginMarketplaceEntry[];
  installed: AppPluginSummary[];
  capabilities: AppCapabilityStatus[];
  /** True once the first load attempt settled (success or failure). */
  loaded: boolean;
  loading: boolean;
  /** Load-level failure (plugins list unreachable / routes missing), if any. */
  error: string | null;
  /** Non-fatal: the marketplace catalog failed while the plugins list worked. */
  catalogError: string | null;
  /** True when the server has no plugins routes at all (40418-independent). */
  unsupported: boolean;
  /** True when the server has plugins routes but no capability routes. */
  capabilitiesUnsupported: boolean;
  /** True when the last capability probe failed with a real (non-404) error. */
  capabilitiesLoadFailed: boolean;
  /** One-shot browser-extension hint after a WebBridge install settles with
   *  the extension still missing (dismissed by the user or on remount). */
  extensionHint: boolean;
  /** Per-row busy marker keyed `${id}:${action}`. */
  busy: Record<string, true | undefined>;
  /** Per-row inline error keyed by row id (plugin id or capability id). */
  rowErrors: Record<string, string | undefined>;
}

const state = reactive<PluginsShelfState>({
  entries: [],
  installed: [],
  capabilities: [],
  loaded: false,
  loading: false,
  error: null,
  catalogError: null,
  unsupported: false,
  capabilitiesUnsupported: false,
  capabilitiesLoadFailed: false,
  extensionHint: false,
  busy: {},
  rowErrors: {},
});

/** One-shot settle listeners, notified by the `event.capability.changed`
 *  fan-out. Waiting on a settle is event-accelerated polling: the event only
 *  wakes the loop early, the direct read is always authoritative — so a lost
 *  or early frame never produces a stuck or premature settle. */
const settleListeners = new Set<(capabilityId: string) => void>();

let settleTimeoutMs = 180_000;
let settleReadSliceMs = 5_000;

/** Test hook: short settle windows + clean listener set. */
export function __setSettleTimersForTests(input: { timeoutMs: number; sliceMs: number }): void {
  settleTimeoutMs = input.timeoutMs;
  settleReadSliceMs = input.sliceMs;
}

export function __resetPluginsForTests(): void {
  settleListeners.clear();
  settleTimeoutMs = 180_000;
  settleReadSliceMs = 5_000;
}

function onSettleOnce(id: string): { promise: Promise<void>; dispose: () => void } {
  let listener: ((capabilityId: string) => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    listener = (capabilityId) => {
      if (capabilityId !== id) return;
      dispose();
      resolve();
    };
    settleListeners.add(listener);
  });
  function dispose(): void {
    if (listener !== undefined) {
      settleListeners.delete(listener);
      listener = undefined;
    }
  }
  return { promise, dispose };
}

/**
 * Wait for a capability install to settle. Every round re-reads the status
 * directly (an already-settled install, e.g. an idempotent no-op, resolves
 * immediately); the settle event only shortens the wait. Returns undefined
 * when the readback fails or the budget runs out with the install still
 * running — background refresh/event paths converge it later.
 */
async function awaitCapabilitySettle(id: string): Promise<AppCapabilityStatus | undefined> {
  const deadline = Date.now() + settleTimeoutMs;
  for (;;) {
    const status = await getKimiWebApi()
      .getCapability(id)
      .catch(() => undefined);
    if (status === undefined || !status.install.running) return status;
    if (Date.now() >= deadline) return undefined;
    const settleEvent = onSettleOnce(id);
    try {
      await Promise.race([
        settleEvent.promise,
        new Promise<void>((resolve) => {
          setTimeout(resolve, settleReadSliceMs);
        }),
      ]);
    } finally {
      settleEvent.dispose();
    }
  }
}

/** Passive settle from the event fan-out (install owned by another client):
 *  apply the settled status to the rows; explicit waiters re-read on their
 *  own loop. */
async function settleFromServerEvent(id: string): Promise<void> {
  const status = await getKimiWebApi()
    .getCapability(id)
    .catch(() => undefined);
  if (status !== undefined) await applySettled(id, status);
}

/**
 * Entry point for the server's plugin/capability lifecycle WS fan-out
 * (`event.plugin.changed` / `event.capability.changed`), called from the
 * client's central event handler (desktop divergence block).
 */
export function handlePluginsShelfEvent(
  event:
    | { type: 'pluginsChanged' }
    | { type: 'capabilityChanged'; capabilityId: string; install: AppCapabilityInstallProgress },
): void {
  if (state.unsupported) return;
  if (event.type === 'pluginsChanged') {
    void reconcilePlugins();
    void reconcileCapabilities();
    return;
  }
  // Same staleness rule as plugin events: an in-flight refresh may hold a
  // pre-event capabilities snapshot — discard and re-read.
  if (state.loading) pendingForceRefresh = true;
  // Live progress → the row's loading state follows the server.
  const capability = state.capabilities.find((c) => c.id === event.capabilityId);
  if (capability !== undefined) capability.install = event.install;
  if (!event.install.running) {
    for (const listener of settleListeners) listener(event.capabilityId);
    void settleFromServerEvent(event.capabilityId);
  }
}

function busyKey(id: string, action: PluginRowAction): string {
  return `${id}:${action}`;
}

function errorMessage(error: unknown): string {
  if (isDaemonApiError(error)) {
    // The envelope msg carries the backend's reason; some routes put extra
    // context in details — surface it when it adds information.
    const details = typeof error.details === 'string' ? error.details : undefined;
    if (details !== undefined && details.length > 0 && !error.message.includes(details)) {
      return `${error.message} — ${details}`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Fold the current installed list into the catalog rows' installed faces —
 *  the plugins list is the live record and wins over any catalog snapshot. */
function foldInstalledIntoEntries(opts?: { requeueCatalogOnDivergence?: boolean }): void {
  const byId = new Map(state.installed.map((p) => [p.id, p]));
  let versionsDiverged = false;
  for (const entry of state.entries) {
    const record = byId.get(entry.id);
    entry.installed =
      record === undefined
        ? undefined
        : { version: record.version, enabled: record.enabled };
    if (record?.version !== undefined && entry.version !== undefined) {
      if (record.version === entry.version) {
        // Installed == catalog version is definitionally not an update.
        entry.updateAvailable = undefined;
      } else if (entry.updateAvailable !== true) {
        // A mismatch without a flag needs the server's semver verdict.
        versionsDiverged = true;
      }
    }
  }
  // Re-read the catalog so the server recomputes updateAvailable (no semver
  // comparator here). Only the live-reconcile path opts in — refresh's own
  // fold must never recurse.
  if (versionsDiverged && opts?.requeueCatalogOnDivergence === true) void refresh(true);
}

/** The server's plugin record is gone while our local view claimed
 *  otherwise (the set changed under us — CLI, another window). */
function isPluginNotFound(error: unknown): boolean {
  return isDaemonApiError(error) && error.code === 40419;
}

/** Bare-404 detector for routes the server does not mount (older versions).
 *  The HTTP client surfaces a non-envelope error response's HTTP status as
 *  the code, so a route-miss arrives as 404 while genuine 5xx failures keep
 *  their status and must NOT be read as "unsupported". */
function isMissingRoute(error: unknown): boolean {
  if (error instanceof DaemonNetworkError) return error.status === 404;
  return isDaemonApiError(error) && error.code === 404;
}

/** Set when a forced refresh arrives mid-flight — the in-flight one may
 *  carry pre-mutation data, so a fresh one must follow. */
let pendingForceRefresh = false;

async function refresh(force = false): Promise<void> {
  if (state.loading) {
    if (force) pendingForceRefresh = true;
    return;
  }
  if (state.loaded && !force) return;
  state.loading = true;
  state.error = null;
  try {
    // Every source is settled independently: an unreachable catalog must not
    // take the installed list (and its Installed rows) down with it.
    const api0 = getKimiWebApi();
    const [marketplaceResult, installedResult, capabilitiesResult] =
      await Promise.allSettled([
        api0.listPluginMarketplace(),
        api0.listPlugins(),
        api0.listCapabilities(),
      ]);

    if (pendingForceRefresh) {
      // A mutation requested a forced re-sync while this one was fetching —
      // this snapshot may predate it. Publish nothing; the queued refresh
      // (fired in finally) delivers the post-mutation truth.
      return;
    }

    if (installedResult.status === 'rejected') {
      // Older servers have no plugins routes (bare fastify 404): hide the tab.
      state.unsupported = isMissingRoute(installedResult.reason);
      state.error = state.unsupported ? null : errorMessage(installedResult.reason);
      if (state.unsupported) {
        state.entries = [];
        state.installed = [];
      }
    } else {
      state.installed = installedResult.value;
      state.unsupported = false;
      if (marketplaceResult.status === 'fulfilled') {
        state.entries = marketplaceResult.value;
        state.catalogError = null;
      } else {
        // Catalog unreachable but the plugins list works — keep whatever rows
        // we had and report the catalog section softly.
        state.catalogError = errorMessage(marketplaceResult.reason);
      }
      // Whether fresh or retained, the rows' installed faces follow the
      // freshly read plugins list (the two snapshots can disagree).
      foldInstalledIntoEntries();
      state.error = null;
    }

    if (capabilitiesResult.status === 'fulfilled') {
      state.capabilities = capabilitiesResult.value;
      state.capabilitiesUnsupported = false;
      state.capabilitiesLoadFailed = false;
      const webbridge = state.capabilities.find((c) => c.id === 'kimi-webbridge');
      if (
        state.extensionHint &&
        webbridge?.steps.find((step) => step.id === 'extension')?.state === 'ok'
      ) {
        state.extensionHint = false;
      }
    } else {
      state.capabilities = [];
      state.capabilitiesUnsupported = isMissingRoute(capabilitiesResult.reason);
      // A real (non-404) failure is not "unsupported" — but it equally must
      // not leave capability rows installable as plain plugins.
      state.capabilitiesLoadFailed = !state.capabilitiesUnsupported;
    }

    // Follow installs already running server-side (TUI, another window) so
    // the rows show live progress instead of a stale "installing" badge.
    if (installedResult.status === 'fulfilled') {
      for (const capability of state.capabilities) {
        if (capability.install.running) void followAndSettle(capability.id);
      }
      // The two reads race: a capability may report ready while the plugins
      // snapshot predates its wiring install (row would render no controls).
      const byId = new Map(state.installed.map((p) => [p.id, p]));
      if (
        state.capabilities.some(
          (c) => c.state === 'ready' && byId.get(c.pluginId ?? c.id) === undefined,
        )
      ) {
        void reconcilePlugins();
      }
    }
  } finally {
    state.loading = false;
    state.loaded = true;
    if (pendingForceRefresh) {
      pendingForceRefresh = false;
      void refresh(true);
    }
  }
}

/** Apply a settled install everywhere the row reads from, then re-sync. */
async function applySettled(id: string, settled: AppCapabilityStatus): Promise<void> {
  applyCapabilityStatus(settled);
  // The wiring plugin record is what renders the Switch/trash — pull it in
  // now, not whenever the full re-sync lands.
  await reconcilePlugins();
  if (
    id === 'kimi-webbridge' &&
    settled.install.error === undefined &&
    settled.steps.find((step) => step.id === 'extension')?.state !== 'ok'
  ) {
    // The browser extension is a manual step the runtime cannot do — raise
    // the hint after EVERY completed install (dismissal only hides this one).
    state.extensionHint = true;
  }
}

/** Follow a running install to settlement, then refresh the rows. */
async function followAndSettle(id: string): Promise<void> {
  const settled = await awaitCapabilitySettle(id);
  if (settled === undefined) return;
  await applySettled(id, settled);
  await refresh(true);
}

async function run(
  id: string,
  action: PluginRowAction,
  task: () => Promise<unknown>,
  opts?: { fullRefresh?: boolean },
): Promise<void> {
  const key = busyKey(id, action);
  if (state.busy[key]) return;
  state.busy[key] = true;
  state.rowErrors[id] = undefined;
  let failed = false;
  try {
    await task();
  } catch (error) {
    failed = true;
    state.rowErrors[id] = errorMessage(error);
  } finally {
    // Release as soon as the mutation settles — the re-sync fetch can take
    // seconds and must not hold the row's buttons disabled.
    state.busy[key] = undefined;
  }
  if (failed) return;
  if (opts?.fullRefresh === false) {
    void reconcilePlugins();
  } else {
    void refresh(true);
  }
}

/** Cheap route-existence probe for the settings tab visibility check —
 *  retries in both directions (upgrade AND downgrade/reconnect), one local
 *  read, no catalog fetch. */
async function probeSupport(): Promise<void> {
  try {
    await getKimiWebApi().listPlugins();
    state.unsupported = false;
  } catch (error) {
    if (isMissingRoute(error)) {
      state.unsupported = true;
      state.entries = [];
      state.installed = [];
    } else {
      // Any other error means the routes exist (the daemon answered) — never
      // keep a stale unsupported mark from an older server.
      state.unsupported = false;
    }
  }
}

/** Light re-sync driven by `event.plugin.changed`: re-read the installed
 *  list and fold it back into the catalog rows' installed face (no catalog
 *  refetch). */
async function reconcilePlugins(): Promise<void> {
  // A refresh in flight carries a pre-event snapshot — mark it stale so it
  // discards and re-runs instead of publishing over this change.
  if (state.loading) pendingForceRefresh = true;
  try {
    state.installed = await getKimiWebApi().listPlugins();
    foldInstalledIntoEntries({ requeueCatalogOnDivergence: true });
  } catch {
    // Best-effort live sync; the next full refresh catches up.
  }
}

/** Re-read capability statuses (cheap detect), e.g. when the plugin set
 *  changed under us. */
async function reconcileCapabilities(): Promise<void> {
  if (state.capabilitiesUnsupported) return;
  try {
    state.capabilities = await getKimiWebApi().listCapabilities();
    // The extension hint is tied to readiness: once the extension reports
    // connected (even via the live path), the banner is done.
    if (state.extensionHint) {
      const webbridge = state.capabilities.find((c) => c.id === 'kimi-webbridge');
      if (webbridge?.steps.find((step) => step.id === 'extension')?.state === 'ok') {
        state.extensionHint = false;
      }
    }
  } catch {
    // Best-effort live sync; the next full refresh catches up.
  }
}

/** Apply a settled capability status locally — the install button's loading
 *  must end when the install ends, not when the background re-sync lands. */
function applyCapabilityStatus(status: AppCapabilityStatus): void {
  const index = state.capabilities.findIndex((c) => c.id === status.id);
  if (index >= 0) state.capabilities[index] = status;
  else state.capabilities.push(status);
}

/** Apply a freshly installed plugin summary locally (installed list + the
 *  catalog entry's installed face). */
function applyInstalledLocally(summary: AppPluginSummary): void {
  const index = state.installed.findIndex((p) => p.id === summary.id);
  if (index >= 0) state.installed[index] = summary;
  else state.installed.push(summary);
  const entry = state.entries.find((e) => e.id === summary.id);
  if (entry !== undefined) {
    entry.installed = { version: summary.version, enabled: summary.enabled };
    // Drop the update flag only when the install actually reached the
    // catalog version — a custom older source can still be behind.
    if (summary.version !== undefined && summary.version === entry.version) {
      entry.updateAvailable = undefined;
    }
  }
}

/** Apply an enable/disable locally; returns a revert for the failure path. */
function applyEnabledLocally(id: string, enabled: boolean): () => void {
  const plugin = state.installed.find((p) => p.id === id);
  const prevPluginEnabled = plugin?.enabled;
  if (plugin !== undefined) plugin.enabled = enabled;
  const entry = state.entries.find((e) => e.id === id);
  const prevEntryEnabled = entry?.installed?.enabled;
  if (entry?.installed !== undefined) entry.installed.enabled = enabled;
  return () => {
    if (plugin !== undefined && prevPluginEnabled !== undefined) {
      plugin.enabled = prevPluginEnabled;
    }
    if (entry?.installed !== undefined && prevEntryEnabled !== undefined) {
      entry.installed.enabled = prevEntryEnabled;
    }
  };
}

/** Drop a plugin from the local view; returns a revert for the failure path. */
function applyRemoveLocally(id: string): () => void {
  const index = state.installed.findIndex((p) => p.id === id);
  const removed = index >= 0 ? state.installed.splice(index, 1)[0] : undefined;
  const entry = state.entries.find((e) => e.id === id);
  const prevInstalled = entry?.installed;
  if (entry !== undefined) entry.installed = undefined;
  return () => {
    if (removed !== undefined) state.installed.splice(index, 0, removed);
    if (entry !== undefined) entry.installed = prevInstalled;
  };
}

/** The capability row's install affordance. The row reads as plain
 *  install / installed: once the wiring plugin is on disk the row is
 *  "installed" (Switch/remove), full stop — readiness is re-detected on
 *  every read and can flap (daemon hiccup, cold start), so keying the
 *  button off readiness would flash a phantom install on an installed row.
 *  Repair of a broken runtime goes through remove + install. The button
 *  survives only as: the followed in-flight install (loading affordance),
 *  the not-installed face, and the ready row's update. */
export function capabilityRowShowsInstall(row: CapabilityRow): boolean {
  if (row.status.install.running) return true;
  if (row.status.state === 'ready') return row.updateAvailable;
  return row.plugin === undefined;
}

/** Ids claimed by capability rows: capability ids and their wiring plugins. */
function claimedIds(capabilities: readonly AppCapabilityStatus[]): Set<string> {
  const ids = new Set<string>();
  for (const capability of capabilities) {
    ids.add(capability.id);
    if (capability.pluginId !== undefined) ids.add(capability.pluginId);
  }
  return ids;
}

export function usePlugins() {
  const capabilityRows = computed<CapabilityRow[]>(() =>
    state.capabilities
      .filter((capability) => capability.supported)
      .map((status) => {
        const pluginId = status.pluginId ?? status.id;
        const plugin = state.installed.find((p) => p.id === pluginId);
        const catalogEntry = state.entries.find((e) => e.id === pluginId || e.id === status.id);
        return {
          status,
          pluginId,
          plugin,
          catalogEntry,
          updateAvailable: catalogEntry?.updateAvailable === true,
        };
      }),
  );

  const catalogEntries = computed(() => {
    const claimed = claimedIds(state.capabilities);
    return state.entries.filter((entry) => {
      if (claimed.has(entry.id)) return false;
      // A capability-marked row is either a claimed Built-in row (above) or
      // nothing at all — without its supported capability backing (missing /
      // unsupported / failed probe), a plain install would deliver only the
      // wiring layer. Never offer it on the plain shelf.
      if (entry.capabilityId !== undefined) return false;
      return true;
    });
  });
  const officialEntries = computed(() =>
    catalogEntries.value.filter((e) => e.tier === 'official'),
  );
  const thirdPartyEntries = computed(() =>
    catalogEntries.value.filter((e) => e.tier !== 'official'),
  );

  /** Installed plugins the catalog does not carry (local-path side loads).
   *  Filters against the VISIBLE catalog rows — a capability-wiring row
   *  suppressed for a capabilities-less server must not also hide the
   *  installed plugin (its Switch/remove live here). */
  const installedOnly = computed(() => {
    // Only SUPPORTED capabilities claim rows here: an installed wiring plugin
    // whose capability is unsupported on this platform has no Built-in row
    // and no catalog row — Installed is the only place to manage it.
    const claimed = claimedIds(state.capabilities.filter((c) => c.supported));
    const visibleCatalogIds = new Set(catalogEntries.value.map((entry) => entry.id));
    return state.installed.filter(
      (plugin) => !claimed.has(plugin.id) && !visibleCatalogIds.has(plugin.id),
    );
  });

  return {
    state,
    probeSupport,
    /** Clear pinned row errors — called when the panel mounts (errors are
     *  one-view feedback; a fresh open starts clean). */
    clearRowErrors: () => {
      state.rowErrors = {};
    },
    capabilityRows,
    officialEntries,
    thirdPartyEntries,
    installedOnly,
    refresh,
    /** Catalog install / update (same call — the server upserts to latest). */
    install: async (entry: AppPluginMarketplaceEntry) => {
      await run(entry.id, 'install', async () => {
        applyInstalledLocally(await getKimiWebApi().installPlugin(entry.source));
      });
    },
    /** Direct install from a user-supplied source (zip URL / GitHub / path). */
    installSource: async (source: string) => {
      await run(CUSTOM_INSTALL_ROW_ID, 'install', async () => {
        applyInstalledLocally(await getKimiWebApi().installPlugin(source));
      });
    },
    /** Capability setup / update: binary runtime + wiring, with live progress. */
    setupCapability: async (id: string) => {
      await run(id, 'install', async () => {
        try {
          await getKimiWebApi().installCapability(id);
        } catch (error) {
          // Another client is already installing this capability — follow it
          // to settlement instead of pinning an error.
          if (!(isDaemonApiError(error) && error.code === 40924)) throw error;
        }
        const settled = await awaitCapabilitySettle(id);
        if (settled === undefined) return; // still running / readback failed — events converge it
        // Settle state applies in every outcome — including a partial
        // failure that already installed the wiring plugin.
        await applySettled(id, settled);
        // The backend's own reason, verbatim — never a generic client guess.
        if (settled.install.error !== undefined) throw new Error(settled.install.error);
      });
    },
    dismissExtensionHint: () => {
      state.extensionHint = false;
    },
    /** Remove a plugin by id. Capability runtimes (KimiCU.app / WebBridge
     *  daemon) are deliberately kept — removal just returns the row to its
     *  plain install face. */
    remove: async (id: string) => {
      // Optimistic: the row flips to its not-installed face immediately;
      // a failure restores the prior state.
      const revert = applyRemoveLocally(id);
      // Removing a capability's wiring plugin leaves it not-ready by
      // definition — flip locally so the row offers Install without
      // waiting for the re-detect.
      const capability = state.capabilities.find(
        (c) => c.id === id || c.pluginId === id,
      );
      const prevState = capability?.state;
      if (capability !== undefined && prevState === 'ready') {
        capability.state = 'partial';
      }
      await run(id, 'remove', async () => {
        try {
          await getKimiWebApi().removePlugin(id);
        } catch (error) {
          // Already gone server-side — that IS the desired end state.
          if (isPluginNotFound(error)) return;
          revert();
          if (capability !== undefined && prevState !== undefined) {
            capability.state = prevState;
          }
          throw error;
        }
      });
    },
    setEnabled: async (id: string, enabled: boolean) => {
      // Optimistic: the switch follows the click at once, not the round trip.
      const revert = applyEnabledLocally(id, enabled);
      await run(
        id,
        'toggle',
        async () => {
          try {
            await getKimiWebApi().setPluginEnabled(id, enabled);
          } catch (error) {
            // Stale local view (the plugin is gone server-side): converge the
            // row to its not-installed face instead of pinning an error, and
            // fully re-sync in the background.
            if (isPluginNotFound(error)) {
              applyRemoveLocally(id);
              // A capability row whose wiring vanished is not ready — flip
              // locally so it keeps offering Install until the re-sync lands.
              const capability = state.capabilities.find(
                (c) => c.id === id || c.pluginId === id,
              );
              if (capability?.state === 'ready') capability.state = 'partial';
              void refresh(true);
              return;
            }
            revert();
            throw error;
          }
        },
        { fullRefresh: false },
      );
    },
    busyKey,
  };
}
