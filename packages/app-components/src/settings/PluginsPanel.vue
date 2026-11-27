<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  Button,
  Dialog,
  EmptyState,
  Icon,
  Input,
  SegmentedControl,
  Spinner,
} from '@moonshot-ai/app-ui';
import {
  CUSTOM_INSTALL_ROW_ID,
  usePlugins,
  type PluginViewModel,
} from '@moonshot-ai/app-client/composables';
import { connectEventsIfNeeded } from '@moonshot-ai/app-client/client';
import { hostsStore } from '@moonshot-ai/app-client/stores';
import PluginDetails from './PluginDetails.vue';
import PluginRow from './PluginRow.vue';
import { pluginErrorMessage } from './pluginErrorMessage';

const { t, locale } = useI18n();
const {
  state,
  marketplaceRows,
  officialRows,
  curatedRows,
  installedRows,
  installedGroups,
  refresh,
  installSource,
  clearRowErrors,
  busyKey,
} = usePlugins({ locale });

onMounted(() => {
  clearRowErrors();
  connectEventsIfNeeded();
  void refresh(true);
});

type PluginView = 'marketplace' | 'installed';

const activeView = ref<PluginView>('marketplace');
const selectedRowId = ref<string | null>(null);
const search = ref('');
const customOpen = ref(false);
const customSource = ref('');
const panelRef = ref<HTMLElement | null>(null);
let detailsReturnRowId: string | null = null;

function selectionId(row: PluginViewModel, view: PluginView): string {
  return view === 'installed' ? (row.installedPlugin?.id ?? row.id) : row.id;
}

const selectedRow = computed(() =>
  selectedRowId.value === null
    ? undefined
    : (activeView.value === 'installed' ? installedRows.value : marketplaceRows.value)
      .find((row) => selectionId(row, activeView.value) === selectedRowId.value),
);

watch(selectedRow, () => {
  if (selectedRowId.value !== null && selectedRow.value === undefined) {
    void closeDetails();
  }
});

const viewOptions = computed(() => [
  { value: 'marketplace', label: t('settings.plugins.marketplace') },
  { value: 'installed', label: t('settings.plugins.myPlugins') },
]);

function selectView(value: string): void {
  activeView.value = value === 'installed' ? 'installed' : 'marketplace';
}

function matchesSearch(row: PluginViewModel): boolean {
  const query = search.value.trim().toLocaleLowerCase();
  if (query === '') return true;
  return [row.displayName, row.shortDescription ?? '']
    .some((value) => value.toLocaleLowerCase().includes(query));
}

const visibleOfficialRows = computed(() => officialRows.value.filter(matchesSearch));
const visibleCuratedRows = computed(() => curatedRows.value.filter(matchesSearch));
const marketplaceSections = computed(() => [
  { key: 'official', title: t('settings.plugins.official'), rows: visibleOfficialRows.value },
  { key: 'curated', title: t('settings.plugins.curated'), rows: visibleCuratedRows.value },
]);
const installedSections = computed(() => [
  { key: 'custom', title: t('settings.plugins.custom'), rows: installedGroups.value.custom },
  { key: 'marketplace', title: t('settings.plugins.marketplaceGroup'), rows: installedGroups.value.marketplace },
]);

const customBusy = computed(() => state.busy[busyKey(CUSTOM_INSTALL_ROW_ID, 'install')] === true);
const customError = computed(() => pluginErrorMessage(state.rowErrors[CUSTOM_INSTALL_ROW_ID], t));

async function submitCustom(): Promise<void> {
  const source = customSource.value.trim();
  if (source === '' || customBusy.value) return;
  await installSource(source);
  if (state.rowErrors[CUSTOM_INSTALL_ROW_ID] === undefined) {
    customSource.value = '';
    customOpen.value = false;
    activeView.value = 'installed';
    selectedRowId.value = null;
  }
}

async function openDetails(row: PluginViewModel): Promise<void> {
  detailsReturnRowId = row.id;
  customOpen.value = false;
  selectedRowId.value = selectionId(row, activeView.value);
  await nextTick();
  panelRef.value
    ?.querySelector<HTMLButtonElement>('.plugin-details__header .ui-icon-button')
    ?.focus();
}

async function closeDetails(): Promise<void> {
  selectedRowId.value = null;
  await nextTick();
  const rowButton = [
    ...(panelRef.value?.querySelectorAll<HTMLButtonElement>('[data-plugin-row]') ?? []),
  ].find((button) => button.dataset.pluginRow === detailsReturnRowId);
  const selectedTab = panelRef.value?.querySelector<HTMLButtonElement>(
    '[role="tab"][aria-selected="true"]',
  );
  (rowButton ?? selectedTab)?.focus();
  detailsReturnRowId = null;
}

</script>

<template>
  <section ref="panelRef" class="sec plugins-panel">
    <h3 class="pp-panel-title">{{ t('settings.tabs.plugins') }}</h3>
    <p v-if="hostsStore().hosts.length > 0" class="pp-scope-hint">{{ t('settings.plugins.localOnlyHint') }}</p>

    <template v-if="selectedRow === undefined">
      <div class="pp-toolbar">
        <SegmentedControl
          :model-value="activeView"
          :options="viewOptions"
          size="sm"
          @update:model-value="selectView"
        />
        <div class="pp-tools">
          <div
            class="pp-search"
            :class="{ 'pp-search--hidden': activeView !== 'marketplace' }"
            :aria-hidden="activeView !== 'marketplace'"
            :inert="activeView === 'marketplace' ? undefined : true"
          >
            <Icon name="search" size="sm" class="pp-search-icon" />
            <Input
              v-model="search"
              size="sm"
              :disabled="activeView !== 'marketplace'"
              :placeholder="t('settings.plugins.searchPlaceholder')"
              :aria-label="t('settings.plugins.searchPlaceholder')"
            />
          </div>
          <Button size="sm" variant="ghost" @click="customOpen = true">
            <Icon name="plus" size="md" />
            {{ t('settings.plugins.customInstall') }}
          </Button>
        </div>
      </div>
      <Dialog
        v-if="customOpen"
        :open="true"
        :title="t('settings.plugins.customInstall')"
        size="md"
        initial-focus="input"
        :close-on-overlay="!customBusy"
        :close-on-esc="!customBusy"
        :hide-close="customBusy"
        @close="customOpen = false"
      >
        <form id="plugin-custom-install-form" class="pp-custom-form" @submit.prevent="submitCustom">
          <Input
            v-model="customSource"
            :disabled="customBusy"
            :placeholder="t('settings.plugins.customInstallPlaceholder')"
            :aria-label="t('settings.plugins.customInstall')"
          />
          <p class="pp-custom-hint">{{ t('settings.plugins.customInstallHint') }}</p>
          <p v-if="customError" class="pp-error" role="alert">{{ customError }}</p>
        </form>
        <template #foot>
          <Button variant="secondary" :disabled="customBusy" @click="customOpen = false">
            {{ t('common.cancel') }}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="plugin-custom-install-form"
            :loading="customBusy"
            :disabled="customSource.trim() === ''"
          >
            {{ t('settings.plugins.install') }}
          </Button>
        </template>
      </Dialog>
      <div v-if="state.catalogError || state.capabilitiesLoadFailed" class="pp-notice" role="status">
        <span>{{ t('settings.plugins.catalogUnavailable') }}</span>
        <Button size="sm" variant="ghost" @click="refresh(true)">
          {{ t('settings.plugins.retry') }}
        </Button>
      </div>
    </template>

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

    <PluginDetails
      v-else-if="selectedRow"
      :row="selectedRow"
      :source-view="activeView"
      @back="closeDetails"
    />

    <template v-else>
      <div v-if="activeView === 'marketplace'" class="pp-view">
        <section
          v-for="section in marketplaceSections"
          v-show="section.rows.length > 0"
          :key="section.key"
          class="pp-section"
        >
          <h3 class="sec-title">{{ section.title }}</h3>
          <div class="settings-group settings-group-divided">
            <PluginRow
              v-for="row in section.rows"
              :key="row.id"
              :row="row"
              @details="openDetails(row)"
            />
          </div>
        </section>
        <EmptyState
          v-if="visibleOfficialRows.length === 0 && visibleCuratedRows.length === 0"
          :title="t(search.trim() ? 'settings.plugins.searchEmpty' : 'settings.plugins.empty')"
        />
      </div>

      <div v-else class="pp-view">
        <section
          v-for="section in installedSections"
          v-show="section.rows.length > 0"
          :key="section.key"
          class="pp-section pp-installed-section"
          :data-origin="section.key"
        >
          <h3 class="sec-title">{{ section.title }}</h3>
          <div class="settings-group settings-group-divided">
            <PluginRow
              v-for="row in section.rows"
              :key="row.id"
              :row="row"
              @details="openDetails(row)"
            />
          </div>
        </section>
        <EmptyState
          v-if="installedRows.length === 0"
          :title="t('settings.plugins.installedEmpty')"
        />
      </div>

    </template>
  </section>
</template>

<style scoped src="./settings-common.css"></style>

<style scoped>
.plugins-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.pp-panel-title,
.sec-title {
  margin: 0;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}

.pp-scope-hint {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}

.pp-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.pp-tools {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.pp-search {
  position: relative;
  width: 200px;
}

.pp-search--hidden {
  visibility: hidden;
}

.pp-search-icon {
  position: absolute;
  top: 50%;
  left: var(--space-3);
  z-index: 1;
  color: var(--color-text-faint);
  pointer-events: none;
  transform: translateY(-50%);
}

.pp-search :deep(.ui-input) {
  padding-left: 30px;
}

.pp-custom-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.pp-custom-hint,
.pp-error {
  margin: 0;
  font-size: var(--text-xs);
  line-height: var(--leading-relaxed);
}

.pp-custom-hint {
  color: var(--color-text-faint);
}

.pp-error {
  color: var(--color-danger);
}

.pp-notice,
.pp-load-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-xl);
  background: var(--color-surface-raised);
  font-size: var(--text-xs);
}

.pp-notice {
  color: var(--color-text-muted);
}

.pp-load-error-text {
  color: var(--color-danger);
  font-size: var(--text-sm);
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

.pp-view,
.pp-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.pp-view {
  gap: var(--space-4);
}


</style>
