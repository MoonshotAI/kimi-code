<!-- Desktop-only "Plugins" settings tab. Four sections, all daemon REST:
     - Built-in: capability rows (kimi-cu, kimi-webbridge) reading as plain
       install / installed like the TUI shelf (no readiness step detail on
       the row), with live install progress and the wiring plugin's
       enable/remove actions.
     - Official / Third-party: the marketplace catalog as an installable shelf
       (server merges live install state; updateAvailable → Update button).
     - Installed: plugins the catalog does not carry (local side loads), with
       a source + contribution-counts line.
     A collapsible row above the sections installs from an arbitrary source
     (zip URL / GitHub repo / local path). State lives in usePlugins. Rows for
     capability wiring plugins are claimed by the Built-in section; installing
     them auto-completes the runtime via the server's shelf-install hook, and
     a replaced user-source skill surfaces as an inline migration note. The
     tab hides on older servers without the routes (state.unsupported, handled
     by SettingsDialog). Visual language mirrors ProvidersPanel: grouped
     hairline rows, status as dot + quiet text, no filled badges. -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, EmptyState, Icon, IconButton, Input, Link, Spinner, Switch } from '@moonshot-ai/app-ui';
import type { AppPluginMarketplaceEntry, AppPluginSummary } from '@moonshot-ai/app-core';
import { CUSTOM_INSTALL_ROW_ID, capabilityRowShowsInstall, usePlugins, type CapabilityRow } from '../../composables/usePlugins';
import { connectEventsIfNeeded } from '@moonshot-ai/app-client/client';

const { t } = useI18n();
const {
  state,
  capabilityRows,
  officialEntries,
  thirdPartyEntries,
  installedOnly,
  refresh,
  install,
  installSource,
  setupCapability,
  remove,
  setEnabled,
  clearRowErrors,
  dismissExtensionHint,
  busyKey,
} = usePlugins();

onMounted(() => {
  // Force: the plugin set can change while the dialog is closed (CLI, another
  // window) — a remount must re-sync, not serve the singleton's stale view.
  clearRowErrors();
  // Settings can open before any session sync ran — make sure the lifecycle
  // event stream (plugin/capability fan-out) is actually connected.
  connectEventsIfNeeded();
  void refresh(true);
});

const installedById = computed(() => new Map(state.installed.map((p) => [p.id, p])));

const isEmpty = computed(
  () =>
    capabilityRows.value.length === 0 &&
    officialEntries.value.length === 0 &&
    thirdPartyEntries.value.length === 0 &&
    installedOnly.value.length === 0,
);

function isBusy(id: string, action: 'install' | 'remove' | 'toggle'): boolean {
  return state.busy[busyKey(id, action)] === true;
}
function rowBusy(id: string, pluginId?: string): boolean {
  return (
    isBusy(id, 'install') ||
    isBusy(pluginId ?? id, 'remove') ||
    isBusy(pluginId ?? id, 'toggle')
  );
}

// --- custom source install ----------------------------------------------------

const CHROME_EXTENSION_URL =
  'https://chromewebstore.google.com/detail/kimi-webbridge/fldmhceldgbpfpkbgopacenieobmligc';
const EDGE_EXTENSION_URL =
  'https://microsoftedge.microsoft.com/addons/detail/kimi-webbridge/bnlffdbcfnanfbknnlaflhlhkocccckg';
const EXTENSION_GUIDE_URL =
  'https://www.kimi.com/code/docs/kimi-code-cli/customization/plugins.html#install-the-browser-extension';

function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener');
}

const customOpen = ref(false);
const customSource = ref('');
const customInput = ref<HTMLInputElement | null>(null);

async function toggleCustom(): Promise<void> {
  customOpen.value = !customOpen.value;
  if (customOpen.value) {
    await nextTick();
    customInput.value?.focus();
  }
}

const customBusy = computed(() => isBusy(CUSTOM_INSTALL_ROW_ID, 'install'));
const customError = computed(() => state.rowErrors[CUSTOM_INSTALL_ROW_ID]);

async function submitCustom(): Promise<void> {
  const source = customSource.value.trim();
  if (source === '' || customBusy.value) return;
  await installSource(source);
  if (state.rowErrors[CUSTOM_INSTALL_ROW_ID] === undefined) {
    customSource.value = '';
    customOpen.value = false;
  }
}

// --- capability rows ---------------------------------------------------------

/** Install affordance — the decision lives in the composable (unit-tested
 *  there); see capabilityRowShowsInstall. */
const showInstall = capabilityRowShowsInstall;

/** Row-level failure: local action errors (keyed by capability id OR wiring
 *  plugin id) plus a server-settled install failure, verbatim. */
function capabilityError(row: CapabilityRow): string | undefined {
  return (
    state.rowErrors[row.status.id] ??
    state.rowErrors[row.pluginId] ??
    row.status.install.error
  );
}

function installLabel(row: CapabilityRow): string {
  return row.status.state === 'ready'
    ? t('settings.plugins.update')
    : t('settings.plugins.install');
}

// --- installed-only rows ------------------------------------------------------

function metaLine(plugin: AppPluginSummary): string {
  const parts: string[] = [t(`settings.plugins.source.${plugin.source}`)];
  if (plugin.skillCount > 0) parts.push(t('settings.plugins.counts.skill', plugin.skillCount));
  if (plugin.mcpServerCount > 0)
    parts.push(
      t('settings.plugins.counts.mcp', plugin.mcpServerCount) +
        (plugin.enabledMcpServerCount < plugin.mcpServerCount
          ? ` (${t('settings.plugins.counts.mcpEnabled', plugin.enabledMcpServerCount)})`
          : ''),
    );
  if (plugin.hookCount > 0) parts.push(t('settings.plugins.counts.hook', plugin.hookCount));
  if (plugin.commandCount > 0) parts.push(t('settings.plugins.counts.command', plugin.commandCount));
  return parts.join(' · ');
}
</script>

<template>
  <section class="sec plugins-panel">
    <!-- Install from an arbitrary source -->
    <div class="pp-group pp-custom" :class="{ open: customOpen }">
      <button type="button" class="pp-custom-row" @click="toggleCustom">
        <Icon name="plus" size="md" />
        <span class="pp-custom-label">{{ t('settings.plugins.customInstall') }}</span>
        <span class="pp-chev" :class="{ open: customOpen }">
          <Icon name="chevron-right" size="sm" />
        </span>
      </button>
      <div v-if="customOpen" class="pp-custom-body">
        <form class="pp-custom-form" @submit.prevent="submitCustom">
          <Input
            ref="customInput"
            v-model="customSource"
            class="pp-custom-input"
            :placeholder="t('settings.plugins.customInstallPlaceholder')"
            :aria-label="t('settings.plugins.customInstall')"
          />
          <Button size="sm" variant="primary" type="submit" :loading="customBusy" :disabled="customSource.trim() === ''">
            {{ t('settings.plugins.install') }}
          </Button>
        </form>
        <p class="pp-custom-hint">{{ t('settings.plugins.customInstallHint') }}</p>
        <p v-if="customError" class="pp-error" role="alert">{{ customError }}</p>
      </div>
    </div>

    <p v-if="state.catalogError" class="pp-catalog-error" role="status">
      {{ t('settings.plugins.catalogUnavailable') }}
    </p>

    <div v-if="state.loading && !state.loaded" class="pp-loading">
      <Spinner size="sm" />
      <span>{{ t('common.loading') }}</span>
    </div>

    <div v-else-if="state.error" class="pp-load-error" role="alert">
      <span class="pp-load-error-text">{{ state.error }}</span>
      <Button size="sm" variant="secondary" @click="refresh(true)">
        {{ t('settings.plugins.retry') }}
      </Button>
    </div>

    <EmptyState v-else-if="isEmpty" :title="t('settings.plugins.empty')" />

    <template v-else>
      <!-- Built-in capabilities -->
      <section v-if="capabilityRows.length > 0" class="pp-section">
        <h3 class="pp-sec-title">{{ t('settings.plugins.builtIn') }}</h3>
        <div class="pp-group">
          <article v-for="row in capabilityRows" :key="row.status.id" class="pp-row">
            <div class="pp-main">
              <div class="pp-title">
                <span class="pp-name">{{ row.status.displayName }}</span>
                <span v-if="row.status.version" class="pp-version">{{ row.status.version }}</span>
              </div>
              <p class="pp-desc">{{ row.status.description }}</p>
              <p v-if="capabilityError(row)" class="pp-error" role="alert">
                {{ capabilityError(row) }}
              </p>
            </div>
            <div class="pp-actions">
              <template v-if="row.plugin">
                <Switch
                  :model-value="row.plugin.enabled"
                  :disabled="rowBusy(row.status.id, row.pluginId) || row.status.install.running"
                  :aria-label="t('settings.plugins.enabled')"
                  @update:model-value="setEnabled(row.pluginId, $event)"
                />
                <IconButton
                  size="sm"
                  :label="t('settings.plugins.remove')"
                  :tooltip="t('settings.plugins.remove')"
                  :loading="isBusy(row.pluginId, 'remove')"
                  :disabled="rowBusy(row.status.id, row.pluginId) || row.status.install.running"
                  @click="remove(row.pluginId)"
                >
                  <Icon name="trash" size="md" />
                </IconButton>
              </template>
              <Button
                v-if="showInstall(row)"
                size="sm"
                :variant="row.status.state === 'ready' ? 'secondary' : 'primary'"
                :loading="isBusy(row.status.id, 'install') || row.status.install.running"
                :disabled="rowBusy(row.status.id, row.pluginId) || row.status.install.running"
                @click="setupCapability(row.status.id)"
              >
                {{ installLabel(row) }}
              </Button>
            </div>
          </article>
          <div v-if="state.extensionHint" class="pp-ext-hint" role="status">
            <Icon name="globe" size="md" class="pp-ext-icon" />
            <span class="pp-ext-title">{{ t('settings.plugins.extensionHintTitle') }}</span>
            <div class="pp-ext-actions">
              <Button size="sm" variant="secondary" @click="openExternal(CHROME_EXTENSION_URL)">
                Chrome
                <Icon name="external-link" size="sm" />
              </Button>
              <Button size="sm" variant="secondary" @click="openExternal(EDGE_EXTENSION_URL)">
                Edge
                <Icon name="external-link" size="sm" />
              </Button>
              <Link :href="EXTENSION_GUIDE_URL" external variant="muted" class="pp-ext-guide">
                {{ t('settings.plugins.extensionGuide') }}
              </Link>
            </div>
            <IconButton
              size="sm"
              class="pp-ext-close"
              :label="t('settings.plugins.dismissHint')"
              :tooltip="t('settings.plugins.dismissHint')"
              @click="dismissExtensionHint"
            >
              <Icon name="close" size="md" />
            </IconButton>
          </div>
        </div>
      </section>

      <!-- Marketplace sections -->
      <section
        v-for="section in [
          { key: 'official', title: t('settings.plugins.official'), entries: officialEntries },
          { key: 'third-party', title: t('settings.plugins.thirdParty'), entries: thirdPartyEntries },
        ]"
        :key="section.key"
        v-show="section.entries.length > 0"
        class="pp-section"
      >
        <h3 class="pp-sec-title">{{ section.title }}</h3>
        <div class="pp-group">
          <article v-for="entry in section.entries" :key="entry.id" class="pp-row">
            <div class="pp-main">
              <div class="pp-title">
                <span class="pp-name">{{ entry.displayName }}</span>
                <span v-if="entry.installed?.version" class="pp-version">
                  {{ entry.installed.version }}
                </span>
                <span v-else-if="entry.version" class="pp-version pp-version--muted">
                  {{ entry.version }}
                </span>
                <span
                  v-if="installedById.get(entry.id)?.hasErrors === true"
                  class="pp-error"
                  >{{ t('settings.plugins.hasErrors') }}</span
                >
                <a
                  v-if="entry.homepage"
                  class="pp-homepage"
                  :href="entry.homepage"
                  target="_blank"
                  rel="noopener noreferrer"
                  :aria-label="t('settings.plugins.homepage')"
                >
                  <Icon name="external-link" size="sm" />
                </a>
              </div>
              <p v-if="entry.description" class="pp-desc">{{ entry.description }}</p>
              <p v-if="installedById.get(entry.id)" class="pp-desc">
                {{ metaLine(installedById.get(entry.id)!) }}
              </p>
              <p v-if="state.rowErrors[entry.id]" class="pp-error" role="alert">
                {{ state.rowErrors[entry.id] }}
              </p>
            </div>
            <div class="pp-actions">
              <template v-if="entry.installed">
                <Button
                  v-if="entry.updateAvailable === true"
                  size="sm"
                  variant="primary"
                  :loading="isBusy(entry.id, 'install')"
                  :disabled="rowBusy(entry.id)"
                  @click="install(entry)"
                >
                  {{ t('settings.plugins.update') }}
                </Button>
                <Switch
                  :model-value="entry.installed.enabled"
                  :disabled="rowBusy(entry.id)"
                  :aria-label="t('settings.plugins.enabled')"
                  @update:model-value="setEnabled(entry.id, $event)"
                />
                <IconButton
                  size="sm"
                  :label="t('settings.plugins.remove')"
                  :tooltip="t('settings.plugins.remove')"
                  :loading="isBusy(entry.id, 'remove')"
                  :disabled="rowBusy(entry.id)"
                  @click="remove(entry.id)"
                >
                  <Icon name="trash" size="md" />
                </IconButton>
              </template>
              <Button
                v-else
                size="sm"
                variant="secondary"
                :loading="isBusy(entry.id, 'install')"
                :disabled="rowBusy(entry.id)"
                @click="install(entry)"
              >
                {{ t('settings.plugins.install') }}
              </Button>
            </div>
          </article>
        </div>
      </section>

      <!-- Installed plugins the catalog does not carry -->
      <section v-if="installedOnly.length > 0" class="pp-section">
        <h3 class="pp-sec-title">{{ t('settings.plugins.installed') }}</h3>
        <div class="pp-group">
          <article v-for="plugin in installedOnly" :key="plugin.id" class="pp-row">
            <div class="pp-main">
              <div class="pp-title">
                <span class="pp-name">{{ plugin.displayName }}</span>
                <span v-if="plugin.version" class="pp-version">{{ plugin.version }}</span>
                <span v-if="plugin.hasErrors" class="pp-error">{{ t('settings.plugins.hasErrors') }}</span>
              </div>
              <p class="pp-desc">{{ metaLine(plugin) }}</p>
              <p v-if="state.rowErrors[plugin.id]" class="pp-error" role="alert">
                {{ state.rowErrors[plugin.id] }}
              </p>
            </div>
            <div class="pp-actions">
              <Switch
                :model-value="plugin.enabled"
                :disabled="rowBusy(plugin.id)"
                :aria-label="t('settings.plugins.enabled')"
                @update:model-value="setEnabled(plugin.id, $event)"
              />
              <IconButton
                size="sm"
                :label="t('settings.plugins.remove')"
                :tooltip="t('settings.plugins.remove')"
                :loading="isBusy(plugin.id, 'remove')"
                :disabled="rowBusy(plugin.id)"
                @click="remove(plugin.id)"
              >
                <Icon name="trash" size="md" />
              </IconButton>
            </div>
          </article>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.plugins-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

/* Custom-source install — the collapsible add-row pattern from ProvidersPanel. */
.pp-custom {
  flex: none;
}

.pp-custom-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 40px;
  padding: var(--space-2) var(--space-4);
  border: none;
  background: transparent;
  font-family: var(--font-ui);
  font-size: var(--text-base);
  color: var(--color-text-muted);
  text-align: left;
  cursor: pointer;
  transition:
    background var(--duration-fast) var(--ease-out),
    color var(--duration-fast) var(--ease-out);
}

.pp-custom-row:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

.pp-custom-label {
  flex: 1;
}

.pp-chev {
  display: inline-flex;
  color: var(--color-text-faint);
  transition: transform var(--duration-fast) var(--ease-out);
}

.pp-chev.open {
  transform: rotate(90deg);
}

.pp-custom-body {
  padding: 0 var(--space-4) var(--space-3);
  border-top: 0.5px solid var(--color-line);
}

.pp-custom-form {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-top: var(--space-3);
}

.pp-custom-input {
  flex: 1;
}

.pp-custom-hint {
  margin: var(--space-2) 0 0;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}

.pp-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-6) 0;
  color: var(--color-text-muted);
  font-size: var(--text-base);
}

.pp-catalog-error {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}

.pp-load-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-xl);
  background: var(--color-surface-raised);
}

.pp-load-error-text {
  font-size: var(--text-sm);
  color: var(--color-danger);
}

.pp-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.pp-sec-title {
  margin: 0;
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--color-text-faint);
}

/* Group language mirrors ProvidersPanel's .pp-group. */
.pp-group {
  overflow: hidden;
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-xl);
  background: var(--color-surface-raised);
}

.pp-group > * + * {
  border-top: 0.5px solid var(--color-line);
}

.pp-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 52px;
  padding: var(--space-3) var(--space-4);
}

.pp-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.pp-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.pp-name {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pp-version {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  font-variant-numeric: tabular-nums;
}

.pp-version--muted {
  opacity: 0.7;
}

.pp-homepage {
  display: inline-flex;
  color: var(--color-text-faint);
  transition: color var(--duration-fast) var(--ease-out);
}

.pp-homepage:hover {
  color: var(--color-text);
}

.pp-desc {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  line-height: var(--leading-relaxed);
}

.pp-error {
  margin: 0;
  font-size: var(--text-xs);
  color: var(--color-danger);
}

.pp-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}

.pp-ext-hint {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}

.pp-ext-icon {
  flex: none;
  color: var(--color-text-faint);
}

/* One line, always: the title yields (ellipsis) before the actions wrap. */
.pp-ext-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pp-ext-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}

.pp-ext-guide {
  flex: none;
}

.pp-ext-close {
  flex: none;
}
</style>
