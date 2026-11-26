import { computed, reactive, toValue, type MaybeRefOrGetter } from 'vue';
import { getKimiWebApi } from '../client/deps';
import { DaemonNetworkError, isDaemonApiError, isDaemonNetworkError } from '@moonshot-ai/app-core/api';
import { isMacosDesktop } from '@moonshot-ai/app-core/lib';
import type {
  AppCapabilityInstallProgress,
  AppCapabilityStatus,
  AppPluginCapabilities,
  AppPluginMarketplaceEntry,
  AppPluginSummary,
} from '@moonshot-ai/app-core/api';

export type PluginRowAction = 'install' | 'remove' | 'toggle';

export type PluginInstallResult = 'installed' | 'failed' | 'cancelled';

export const CUSTOM_INSTALL_ROW_ID = '__custom__';

export interface PluginViewModel {
  id: string;
  installId: string;
  catalogEntry?: AppPluginMarketplaceEntry;
  installedPlugin?: AppPluginSummary;
  capability?: AppCapabilityStatus;
  capabilityRequired: boolean;
  capabilityUnavailable: boolean;
  cloudOnly: boolean;
  official: boolean;
  displayName: string;
  shortDescription?: string;
  longDescription?: string;
  iconUrl?: string;
  updateAvailable: boolean;
}

export interface PluginInstalledGroups {
  custom: PluginViewModel[];
  marketplace: PluginViewModel[];
}

export interface PluginsShelfState {
  entries: AppPluginMarketplaceEntry[];
  installed: AppPluginSummary[];
  capabilities: AppCapabilityStatus[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  catalogError: string | null;
  unsupported: boolean;
  capabilitiesUnsupported: boolean;
  capabilitiesLoadFailed: boolean;
  extensionHint: boolean;
  busy: Record<string, true | undefined>;
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

const settleListeners = new Set<(capabilityId: string) => void>();
const capabilityReconcileErrors = new Set<string>();
const EXTENSION_HINT_DISMISSED_KEY = 'kimi-web.plugins.extension-hint-dismissed';

function loadExtensionHintDismissed(): boolean {
  try {
    return globalThis.localStorage.getItem(EXTENSION_HINT_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function setExtensionHintDismissed(dismissed: boolean): void {
  extensionHintDismissed = dismissed;
  try {
    if (dismissed) globalThis.localStorage.setItem(EXTENSION_HINT_DISMISSED_KEY, '1');
    else globalThis.localStorage.removeItem(EXTENSION_HINT_DISMISSED_KEY);
  } catch {
    return;
  }
}

let settleTimeoutMs = 180_000;
let settleReadSliceMs = 5_000;
let extensionHintDismissed = loadExtensionHintDismissed();
let pendingForceRefresh = false;
let installedReadGeneration = 0;
const capabilityReadGenerations = new Map<string, number>();

export function __setSettleTimersForTests(input: { timeoutMs: number; sliceMs: number }): void {
  settleTimeoutMs = input.timeoutMs;
  settleReadSliceMs = input.sliceMs;
}

export function __resetPluginsForTests(): void {
  settleListeners.clear();
  capabilityReconcileErrors.clear();
  settleTimeoutMs = 180_000;
  settleReadSliceMs = 5_000;
  setExtensionHintDismissed(false);
  pendingForceRefresh = false;
  installedReadGeneration += 1;
  capabilityReadGenerations.clear();
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

async function settleFromServerEvent(id: string): Promise<void> {
  const status = await getKimiWebApi()
    .getCapability(id)
    .catch(() => undefined);
  if (status !== undefined) await applySettled(id, status);
}

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
  if (state.loading) pendingForceRefresh = true;
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
    const details = typeof error.details === 'string' ? error.details : undefined;
    if (details !== undefined && details.length > 0 && !error.message.includes(details)) {
      return `${error.message} — ${details}`;
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function installedCatalogId(plugin: AppPluginSummary): string | undefined {
  return plugin.catalogId ?? (plugin.origin === 'unknown' ? plugin.id : undefined);
}

function installedPluginForCatalogEntry(
  entryId: string,
  installedByCatalogId: ReadonlyMap<string, AppPluginSummary>,
  installedById: ReadonlyMap<string, AppPluginSummary>,
): AppPluginSummary | undefined {
  const installed = installedByCatalogId.get(entryId) ?? installedById.get(entryId);
  return installed?.origin === 'unknown' || installed?.catalogId === entryId
    ? installed
    : undefined;
}

function reconcileCatalogVersions(opts?: { requeueCatalogOnDivergence?: boolean }): void {
  let versionsDiverged = false;
  for (const entry of state.entries) {
    const record = state.installed.find((plugin) => installedCatalogId(plugin) === entry.id);
    if (record?.version === undefined || entry.version === undefined) continue;
    if (record.version === entry.version) {
      entry.updateAvailable = undefined;
    } else if (entry.updateAvailable !== true) {
      versionsDiverged = true;
    }
  }
  if (versionsDiverged && opts?.requeueCatalogOnDivergence === true) void refresh(true);
}

function isPluginNotFound(error: unknown): boolean {
  return isDaemonApiError(error) && error.code === 40419;
}

function isPluginCatalogChanged(error: unknown): boolean {
  return isDaemonApiError(error) && error.code === 40934;
}

function isMissingRoute(error: unknown): boolean {
  if (error instanceof DaemonNetworkError) return error.status === 404;
  return isDaemonApiError(error) && error.code === 404;
}

function syncExtensionHint(): void {
  const webbridge = state.capabilities.find((capability) => capability.id === 'kimi-webbridge');
  const extension = webbridge?.steps?.find((step) => step.id === 'extension');
  if (extension?.state === 'ok') {
    state.extensionHint = false;
    return;
  }
  state.extensionHint =
    webbridge?.state === 'ready' &&
    webbridge.install.error === undefined &&
    extension !== undefined &&
    !extensionHintDismissed;
}

async function refresh(force = false): Promise<void> {
  if (state.loading) {
    if (force) pendingForceRefresh = true;
    return;
  }
  if (state.loaded && !force) return;
  installedReadGeneration += 1;
  state.loading = true;
  state.error = null;
  try {
    const api = getKimiWebApi();
    const [marketplaceResult, installedResult, capabilitiesResult] =
      await Promise.allSettled([
        api.listPluginMarketplace(),
        api.listPlugins(),
        api.listCapabilities(),
      ]);

    if (pendingForceRefresh) return;

    if (marketplaceResult.status === 'rejected') {
      state.entries = [];
      state.catalogError = errorMessage(marketplaceResult.reason);
    }

    if (installedResult.status === 'rejected') {
      state.entries = [];
      state.unsupported = isMissingRoute(installedResult.reason);
      state.error = state.unsupported ? null : errorMessage(installedResult.reason);
      if (state.unsupported) state.installed = [];
    } else {
      state.installed = installedResult.value;
      state.unsupported = false;
      if (marketplaceResult.status === 'fulfilled') {
        state.entries = marketplaceResult.value;
        state.catalogError = null;
      }
      reconcileCatalogVersions();
      state.error = null;
    }

    if (capabilitiesResult.status === 'fulfilled') {
      state.capabilities = capabilitiesResult.value;
      state.capabilitiesUnsupported = false;
      state.capabilitiesLoadFailed = false;
    } else {
      state.capabilities = [];
      state.capabilitiesUnsupported = isMissingRoute(capabilitiesResult.reason);
      state.capabilitiesLoadFailed = !state.capabilitiesUnsupported;
    }
    syncExtensionHint();

    if (installedResult.status === 'fulfilled') {
      for (const capability of state.capabilities) {
        if (capability.install.running) void followAndSettle(capability.id);
      }
      clearResolvedCapabilityReconcileErrors();
      const missingCapability = state.capabilities.find((capability) => {
        if (capability.state !== 'ready') return false;
        const pluginId = capability.pluginId ?? capability.id;
        return !state.installed.some((plugin) => plugin.id === pluginId);
      });
      if (missingCapability !== undefined) {
        void reconcilePlugins({ markStale: false, errorId: missingCapability.id });
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

function clearCapabilityReconcileError(id: string): void {
  if (!capabilityReconcileErrors.delete(id)) return;
  state.rowErrors[id] = undefined;
}

function clearResolvedCapabilityReconcileErrors(): void {
  const installedIds = new Set(state.installed.map((plugin) => plugin.id));
  for (const capability of state.capabilities) {
    if (installedIds.has(capability.pluginId ?? capability.id)) {
      clearCapabilityReconcileError(capability.id);
    }
  }
}

async function applySettled(id: string, settled: AppCapabilityStatus): Promise<void> {
  applyCapabilityStatus(settled);
  await reconcilePlugins({ errorId: id });
  syncExtensionHint();
}

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
): Promise<boolean> {
  const key = busyKey(id, action);
  if (state.busy[key]) return false;
  state.busy[key] = true;
  capabilityReconcileErrors.delete(id);
  state.rowErrors[id] = undefined;
  let failed = false;
  try {
    await task();
  } catch (error) {
    failed = true;
    state.rowErrors[id] = errorMessage(error);
    if (isPluginCatalogChanged(error)) await refresh(true);
  } finally {
    state.busy[key] = undefined;
  }
  if (failed) return false;
  if (opts?.fullRefresh === false) {
    void reconcilePlugins();
  } else {
    void refresh(true);
  }
  return true;
}

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
      state.unsupported = false;
    }
  }
}

async function reconcilePlugins(opts?: { markStale?: boolean; errorId?: string }): Promise<void> {
  if ((opts?.markStale ?? true) && state.loading) pendingForceRefresh = true;
  const generation = ++installedReadGeneration;
  try {
    const installed = await getKimiWebApi().listPlugins();
    if (generation !== installedReadGeneration) return;
    state.installed = installed;
    if (opts?.errorId !== undefined) clearCapabilityReconcileError(opts.errorId);
    clearResolvedCapabilityReconcileErrors();
    reconcileCatalogVersions({ requeueCatalogOnDivergence: true });
  } catch (error) {
    if (generation !== installedReadGeneration || opts?.errorId === undefined) return;
    capabilityReconcileErrors.add(opts.errorId);
    state.rowErrors[opts.errorId] = errorMessage(error);
  }
}

async function reconcileCapabilities(): Promise<void> {
  if (state.capabilitiesUnsupported) return;
  try {
    state.capabilities = await getKimiWebApi().listCapabilities();
    state.capabilitiesLoadFailed = false;
    syncExtensionHint();
  } catch {
    return;
  }
}

function applyCapabilityStatus(status: AppCapabilityStatus): void {
  const index = state.capabilities.findIndex((capability) => capability.id === status.id);
  if (index >= 0) state.capabilities[index] = status;
  else state.capabilities.push(status);
}

function applyInstalledLocally(summary: AppPluginSummary): void {
  const index = state.installed.findIndex((plugin) => plugin.id === summary.id);
  if (index >= 0) state.installed[index] = summary;
  else state.installed.push(summary);
  const entry = state.entries.find((candidate) => candidate.id === installedCatalogId(summary));
  if (
    entry !== undefined &&
    summary.version !== undefined &&
    summary.version === entry.version
  ) {
    entry.updateAvailable = undefined;
  }
}

function applyEnabledLocally(id: string, enabled: boolean): () => void {
  const plugin = state.installed.find((candidate) => candidate.id === id);
  const previous = plugin?.enabled;
  if (plugin !== undefined) plugin.enabled = enabled;
  return () => {
    if (plugin !== undefined && previous !== undefined) plugin.enabled = previous;
  };
}

function applyRemoveLocally(id: string): void {
  const index = state.installed.findIndex((plugin) => plugin.id === id);
  if (index >= 0) state.installed.splice(index, 1);
}

export function pluginRowShowsInstall(row: PluginViewModel): boolean {
  if (row.cloudOnly || row.catalogEntry === undefined) return false;
  if (row.capabilityRequired) {
    const capability = row.capability;
    if (capability === undefined || !capability.supported) return false;
    if (capability.install.running) return true;
    return row.installedPlugin === undefined ||
      (row.updateAvailable && (capability.id === 'kimi-webbridge' || capability.state === 'ready'));
  }
  return row.installedPlugin === undefined || row.updateAvailable;
}

function capabilityStepOk(row: PluginViewModel, stepId: string): boolean {
  return row.capability?.steps.some((step) => step.id === stepId && step.state === 'ok') === true;
}

function rowInstallInProgress(row: PluginViewModel): boolean {
  return row.capability?.install.running === true ||
    state.busy[busyKey(row.installId, 'install')] === true;
}

export function isWebBridgeExtensionDisconnected(row: PluginViewModel): boolean {
  const capability = row.capability;
  if (capability?.id !== 'kimi-webbridge' || !capability.supported) return false;
  if (row.installedPlugin === undefined || !row.installedPlugin.enabled) return false;
  if (rowInstallInProgress(row)) return false;
  if (!capabilityStepOk(row, 'daemon') || !capabilityStepOk(row, 'skill')) return false;
  return capability.steps.find((step) => step.id === 'extension')?.state !== 'ok';
}

export function isKimiCuMacCapability(row: PluginViewModel): boolean {
  const capability = row.capability;
  return isMacosDesktop &&
    capability?.id === 'kimi-cu' &&
    capability.pluginId !== 'kimi-cu-win' &&
    capability.supported;
}

export interface KimiCuPermissionSnapshot {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
  readonly granted: boolean;
}

export function readKimiCuPermissions(row: PluginViewModel): KimiCuPermissionSnapshot {
  const steps = row.capability?.steps ?? [];
  const accessibility = steps.some((step) => step.id === 'permissions.accessibility' && step.state === 'ok');
  const screenRecording = steps.some((step) => step.id === 'permissions.screenRecording' && step.state === 'ok');
  return { accessibility, screenRecording, granted: accessibility && screenRecording };
}

export function isKimiCuPermissionMissing(row: PluginViewModel): boolean {
  if (!isKimiCuMacCapability(row)) return false;
  if (row.installedPlugin === undefined || !row.installedPlugin.enabled) return false;
  if (rowInstallInProgress(row)) return false;
  if (!capabilityStepOk(row, 'app') || !capabilityStepOk(row, 'service')) return false;
  return !readKimiCuPermissions(row).granted;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function normalizedLocale(value: string): string {
  return value.replaceAll('_', '-').toLowerCase();
}

function findLocaleBlock(
  entry: AppPluginMarketplaceEntry,
  locale: string | undefined,
): Record<string, unknown> | undefined {
  if (locale === undefined || locale === '' || entry.locale === undefined) return undefined;
  const normalized = normalizedLocale(locale);
  const base = normalized.split('-')[0];
  if (
    base === normalized &&
    entry.defaultLocale !== undefined &&
    normalizedLocale(entry.defaultLocale) !== normalized &&
    sameLocale(locale, entry.defaultLocale)
  ) {
    const defaultBlock = findLocaleBlock(entry, entry.defaultLocale);
    if (defaultBlock !== undefined) return defaultBlock;
  }
  const candidates = base === normalized ? [normalized] : [normalized, base];
  for (const candidate of candidates) {
    for (const [key, value] of Object.entries(entry.locale)) {
      const normalizedKey = normalizedLocale(key);
      if (normalizedKey !== candidate && normalizedKey.split('-')[0] !== candidate) continue;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    }
  }
  return undefined;
}

function sameLocale(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const normalizedA = normalizedLocale(a);
  const normalizedB = normalizedLocale(b);
  return normalizedA === normalizedB || normalizedA.split('-')[0] === normalizedB.split('-')[0];
}

function localizedDescription(
  entry: AppPluginMarketplaceEntry,
  locale: string,
  field: 'shortDescription' | 'longDescription',
): string | undefined {
  const block = findLocaleBlock(entry, locale);
  const localizedValue = nonEmptyString(block?.[field]);
  if (localizedValue !== undefined) return localizedValue;
  const topLevelValue = field === 'shortDescription'
    ? entry.shortDescription
    : (entry.longDescription ?? entry.description);
  if (entry.locale === undefined || sameLocale(locale, entry.defaultLocale)) {
    return nonEmptyString(topLevelValue) ?? nonEmptyString(block?.[field]);
  }
  const defaultBlock = findLocaleBlock(entry, entry.defaultLocale);
  const defaultValue = nonEmptyString(defaultBlock?.[field]);
  if (defaultValue !== undefined) return defaultValue;
  return nonEmptyString(topLevelValue);
}

function shortDescription(
  entry: AppPluginMarketplaceEntry | undefined,
  locale: string,
): string | undefined {
  if (entry === undefined) return undefined;
  return localizedDescription(entry, locale, 'shortDescription') ?? '-';
}

function longDescription(
  entry: AppPluginMarketplaceEntry | undefined,
  locale: string,
): string | undefined {
  if (entry === undefined) return undefined;
  return localizedDescription(entry, locale, 'longDescription');
}

function localizedDisplayName(
  entry: AppPluginMarketplaceEntry,
  locale: string,
): string {
  const block = findLocaleBlock(entry, locale);
  const localizedValue = nonEmptyString(block?.['displayName']);
  if (localizedValue !== undefined) return localizedValue;
  if (entry.locale === undefined || sameLocale(locale, entry.defaultLocale)) {
    return entry.displayName;
  }
  const defaultBlock = findLocaleBlock(entry, entry.defaultLocale);
  return nonEmptyString(defaultBlock?.['displayName']) ?? entry.displayName;
}

function isOfficial(entry: AppPluginMarketplaceEntry): boolean {
  if (entry.distribution?.category !== undefined) {
    return entry.distribution.category === 'official';
  }
  return entry.tier === 'official';
}

function makeRow(
  parts: {
    catalogEntry?: AppPluginMarketplaceEntry;
    installedPlugin?: AppPluginSummary;
    capability?: AppCapabilityStatus;
  },
  locale: string,
): PluginViewModel {
  const { catalogEntry, installedPlugin, capability } = parts;
  const capabilityRequired = catalogEntry?.capabilityId !== undefined || capability !== undefined;
  const id = catalogEntry?.id ?? capability?.id ?? installedPlugin?.id;
  if (id === undefined) throw new Error('Plugin row requires an entry, installation, or capability');
  const sameVersion =
    installedPlugin?.version !== undefined &&
    catalogEntry?.version !== undefined &&
    installedPlugin.version === catalogEntry.version;
  return {
    id,
    installId: catalogEntry?.capabilityId ?? capability?.id ?? catalogEntry?.id ?? installedPlugin?.id ?? id,
    catalogEntry,
    installedPlugin,
    capability,
    capabilityRequired,
    capabilityUnavailable: capabilityRequired && capability === undefined,
    cloudOnly:
      catalogEntry?.platforms !== undefined &&
      catalogEntry.platforms.length > 0 &&
      catalogEntry.platforms.every((platform) => platform === 'cloud'),
    official: catalogEntry === undefined ? capability !== undefined : isOfficial(catalogEntry),
    displayName:
      catalogEntry === undefined
        ? (capability?.displayName ?? installedPlugin?.displayName ?? id)
        : localizedDisplayName(catalogEntry, locale),
    shortDescription:
      shortDescription(catalogEntry, locale) ?? nonEmptyString(installedPlugin?.shortDescription) ?? '-',
    longDescription:
      longDescription(catalogEntry, locale) ??
      nonEmptyString(installedPlugin?.longDescription) ??
      nonEmptyString(installedPlugin?.description) ??
      nonEmptyString(capability?.description),
    iconUrl: catalogEntry?.iconUrl,
    updateAvailable:
      installedPlugin !== undefined && catalogEntry?.updateAvailable === true && !sameVersion,
  };
}

function installedPluginForCapability(
  capability: AppCapabilityStatus,
  installedById: ReadonlyMap<string, AppPluginSummary>,
): AppPluginSummary | undefined {
  const current = installedById.get(capability.pluginId ?? capability.id);
  if (current !== undefined && current.origin !== 'custom') return current;
  if (capability.id !== 'kimi-webbridge') return undefined;
  const legacy = installedById.get('kimi-webbridge');
  return legacy?.origin === 'custom' ? undefined : legacy;
}

function installedTimestamp(row: PluginViewModel): number | undefined {
  const value = row.installedPlugin?.installedAt;
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function originRank(origin: keyof PluginInstalledGroups): number {
  return origin === 'marketplace' ? 0 : 1;
}

function installedGroup(row: PluginViewModel): keyof PluginInstalledGroups {
  const origin = row.installedPlugin?.origin ?? 'unknown';
  if (origin === 'marketplace' || origin === 'custom') return origin;
  if (state.loaded && state.error === null && state.catalogError === null) {
    return row.catalogEntry === undefined ? 'custom' : 'marketplace';
  }
  return 'custom';
}

function compareInstalledRows(a: PluginViewModel, b: PluginViewModel): number {
  const originDifference = originRank(installedGroup(a)) - originRank(installedGroup(b));
  if (originDifference !== 0) return originDifference;
  const aTime = installedTimestamp(a);
  const bTime = installedTimestamp(b);
  if (aTime !== undefined && bTime !== undefined && aTime !== bTime) return bTime - aTime;
  if (aTime !== undefined && bTime === undefined) return -1;
  if (aTime === undefined && bTime !== undefined) return 1;
  const aId = a.installedPlugin?.id ?? a.id;
  const bId = b.installedPlugin?.id ?? b.id;
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

export function pluginUsesInstalledCapabilities(
  row: PluginViewModel,
  sourceView: 'marketplace' | 'installed',
): boolean {
  if (row.installedPlugin === undefined) return false;
  if (sourceView !== 'marketplace' || row.catalogEntry === undefined) return true;
  const version = row.catalogEntry.version;
  return version !== undefined && version === row.installedPlugin.version;
}

async function loadPluginCapabilities(
  row: PluginViewModel,
  sourceView: 'marketplace' | 'installed',
  locale: string,
): Promise<AppPluginCapabilities> {
  if (!pluginUsesInstalledCapabilities(row, sourceView) && row.catalogEntry !== undefined) {
    return getKimiWebApi().previewPlugin({
      marketplaceId: row.catalogEntry.id,
      expectedVersion: row.catalogEntry.version,
      expectedSha256: row.catalogEntry.sha256sum,
      locale,
    });
  }
  if (row.installedPlugin !== undefined) {
    return getKimiWebApi().getPluginInfo(row.installedPlugin.id, locale);
  }
  if (row.catalogEntry !== undefined) {
    return getKimiWebApi().previewPlugin({
      marketplaceId: row.catalogEntry.id,
      expectedVersion: row.catalogEntry.version,
      expectedSha256: row.catalogEntry.sha256sum,
      locale,
    });
  }
  return { skills: [], mcpServers: [] };
}

interface PluginInstallOptions {
  confirmStopProcesses?: () => Promise<boolean>;
}

async function installEntry(
  entry: AppPluginMarketplaceEntry,
  options?: PluginInstallOptions,
): Promise<PluginInstallResult> {
  const currentEntry = state.entries.find((candidate) => candidate.id === entry.id);
  if (currentEntry === undefined) return 'failed';
  if (currentEntry.capabilityId !== undefined) {
    return setupCapability(currentEntry.capabilityId, options);
  }
  const completed = await run(currentEntry.id, 'install', async () => {
    applyInstalledLocally(
      await getKimiWebApi().installPlugin({
        marketplaceId: currentEntry.id,
        expectedVersion: currentEntry.version,
        expectedSha256: currentEntry.sha256sum,
      }),
    );
  });
  return completed ? 'installed' : 'failed';
}

async function setupCapability(
  id: string,
  options?: PluginInstallOptions,
): Promise<PluginInstallResult> {
  let result: PluginInstallResult = 'failed';
  const completed = await run(id, 'install', async () => {
    let stopRunningProcesses = false;
    for (;;) {
      try {
        await getKimiWebApi().installCapability(id, stopRunningProcesses ? { stopRunningProcesses: true } : undefined);
      } catch (error) {
        if (!(isDaemonApiError(error) && error.code === 40924)) throw error;
      }
      if (id === 'kimi-webbridge') {
        setExtensionHintDismissed(false);
        syncExtensionHint();
      }
      const settled = await awaitCapabilitySettle(id);
      if (settled === undefined) return;
      await applySettled(id, settled);
      if (settled.install.confirmationRequired === 'stop-processes') {
        if (stopRunningProcesses || !await options?.confirmStopProcesses?.()) {
          result = 'cancelled';
          return;
        }
        stopRunningProcesses = true;
        continue;
      }
      if (settled.install.error !== undefined) throw new Error(settled.install.error);
      result = 'installed';
      return;
    }
  });
  return completed ? result : 'failed';
}

async function refreshCapability(id: string): Promise<AppCapabilityStatus | undefined> {
  if (state.capabilitiesUnsupported) return undefined;
  const generation = (capabilityReadGenerations.get(id) ?? 0) + 1;
  capabilityReadGenerations.set(id, generation);
  try {
    const status = await getKimiWebApi().getCapability(id);
    if (capabilityReadGenerations.get(id) !== generation) return undefined;
    applyCapabilityStatus(status);
    syncExtensionHint();
    return status;
  } catch {
    return undefined;
  }
}

function isCapabilityPermissionInterruption(error: unknown): boolean {
  if (error instanceof Error && error.message.startsWith('command timed out after ')) return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return isDaemonNetworkError(error) && error.phase === 'fetch' && error.status === undefined;
}

async function requestCapabilityPermissions(id: string): Promise<AppCapabilityStatus | undefined> {
  state.rowErrors[id] = undefined;
  const generation = (capabilityReadGenerations.get(id) ?? 0) + 1;
  capabilityReadGenerations.set(id, generation);
  try {
    const status = await getKimiWebApi().requestCapabilityPermissions(id);
    if (capabilityReadGenerations.get(id) !== generation) return status;
    applyCapabilityStatus(status);
    syncExtensionHint();
    return status;
  } catch (error) {
    if (isCapabilityPermissionInterruption(error)) {
      return refreshCapability(id);
    }
    state.rowErrors[id] = errorMessage(error);
    return undefined;
  }
}

export function usePlugins(options: { locale?: MaybeRefOrGetter<string> } = {}) {
  const locale = () => toValue(options.locale) || 'en';
  const rows = computed<PluginViewModel[]>(() => {
    const currentLocale = locale();
    const entriesByCapability = new Map(
      state.capabilities.map((capability) => [capability.id, capability]),
    );
    const installedById = new Map(state.installed.map((plugin) => [plugin.id, plugin]));
    const installedByCatalogId = new Map(
      state.installed.flatMap((plugin) =>
        plugin.catalogId === undefined ? [] : [[plugin.catalogId, plugin] as const],
      ),
    );
    const claimedInstalled = new Set<string>();
    const claimedCapabilities = new Set<string>();
    const result: PluginViewModel[] = [];

    for (const catalogEntry of state.entries) {
      const capability = catalogEntry.capabilityId === undefined
        ? undefined
        : entriesByCapability.get(catalogEntry.capabilityId);
      const installedPlugin =
        capability === undefined
          ? installedPluginForCatalogEntry(catalogEntry.id, installedByCatalogId, installedById)
          : installedPluginForCapability(capability, installedById);
      if (installedPlugin !== undefined) claimedInstalled.add(installedPlugin.id);
      if (capability !== undefined) claimedCapabilities.add(capability.id);
      result.push(makeRow({ catalogEntry, installedPlugin, capability }, currentLocale));
    }

    const catalogIsEmpty = state.loaded && state.catalogError === null && state.entries.length === 0;
    for (const capability of state.capabilities) {
      if (catalogIsEmpty || claimedCapabilities.has(capability.id)) continue;
      const installedPlugin = installedPluginForCapability(capability, installedById);
      if (installedPlugin === undefined) continue;
      claimedInstalled.add(installedPlugin.id);
      result.push(makeRow({ installedPlugin, capability }, currentLocale));
    }

    for (const installedPlugin of state.installed) {
      if (claimedInstalled.has(installedPlugin.id)) continue;
      result.push(makeRow({ installedPlugin }, currentLocale));
    }
    return result;
  });

  const marketplaceRows = computed(() =>
    rows.value.filter((row) => row.catalogEntry !== undefined || row.capability !== undefined),
  );
  const officialRows = computed(() => marketplaceRows.value.filter((row) => row.official));
  const curatedRows = computed(() => marketplaceRows.value.filter((row) => !row.official));
  const capabilityRows = computed(() =>
    marketplaceRows.value.filter((row) => row.capabilityRequired),
  );
  const installedRows = computed(() =>
    rows.value
      .filter((row) => row.installedPlugin !== undefined)
      .slice()
      .sort(compareInstalledRows),
  );
  const installedGroups = computed<PluginInstalledGroups>(() => ({
    marketplace: installedRows.value.filter((row) => installedGroup(row) === 'marketplace'),
    custom: installedRows.value.filter((row) => installedGroup(row) === 'custom'),
  }));

  return {
    state,
    rows,
    marketplaceRows,
    officialRows,
    curatedRows,
    capabilityRows,
    installedRows,
    installedGroups,
    probeSupport,
    clearRowErrors: () => {
      capabilityReconcileErrors.clear();
      state.rowErrors = {};
    },
    refresh,
    refreshCapability,
    requestCapabilityPermissions,
    loadPluginCapabilities: (
      row: PluginViewModel,
      sourceView: 'marketplace' | 'installed',
    ) => loadPluginCapabilities(row, sourceView, locale()),
    install: installEntry,
    installRow: async (row: PluginViewModel, options?: PluginInstallOptions): Promise<PluginInstallResult> => {
      if (row.catalogEntry === undefined) return 'failed';
      return installEntry(row.catalogEntry, options);
    },
    installSource: async (source: string) => {
      await run(CUSTOM_INSTALL_ROW_ID, 'install', async () => {
        applyInstalledLocally(await getKimiWebApi().installPlugin(source));
      });
    },
    setupCapability,
    dismissExtensionHint: () => {
      setExtensionHintDismissed(true);
      state.extensionHint = false;
    },
    remove: async (id: string) => {
      const capability = state.capabilities.find(
        (candidate) => candidate.id === id || candidate.pluginId === id,
      );
      await run(id, 'remove', async () => {
        try {
          await getKimiWebApi().removePlugin(id);
        } catch (error) {
          if (!isPluginNotFound(error)) throw error;
        }
        applyRemoveLocally(id);
        if (capability?.state === 'ready') capability.state = 'partial';
      });
    },
    setEnabled: async (id: string, enabled: boolean) => {
      const revert = applyEnabledLocally(id, enabled);
      await run(
        id,
        'toggle',
        async () => {
          try {
            await getKimiWebApi().setPluginEnabled(id, enabled);
          } catch (error) {
            if (isPluginNotFound(error)) {
              applyRemoveLocally(id);
              const capability = state.capabilities.find(
                (candidate) => candidate.id === id || candidate.pluginId === id,
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
