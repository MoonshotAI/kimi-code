<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppCatalogProvider } from '@moonshot-ai/app-core/api';
import {
  buildAddProviderInput,
  catalogModelToRow,
  catalogNameToProviderId,
  kimiCodingProviderFor,
  presetCatalogEntry,
  presetDisplayName,
  PROVIDER_ID_PATTERN,
  PROVIDER_PRESETS,
  type ModelRow,
} from '@moonshot-ai/app-core/lib';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import { Badge, Banner, Button, Icon, IconButton, Input, Spinner } from '@moonshot-ai/app-ui';
import ProviderBrandIcon from './ProviderBrandIcon.vue';
import ProviderForm from './ProviderForm.vue';
import ProviderModelTable from './ProviderModelTable.vue';

const emit = defineEmits<{
  added: [id: string];
  cancel: [];
}>();

type Source = 'preset' | 'catalog' | 'registry' | 'manual';

const { t, te } = useI18n();
const client = useKimiWebClient();

const source = ref<Source>('preset');
const presetKey = ref<string>(PROVIDER_PRESETS[0]?.key ?? '');

function selectSource(next: Source): void {
  source.value = next;
}

function selectPreset(key: string): void {
  presetKey.value = key;
  source.value = 'preset';
}

const presetCatalogItems = computed(() => client.presetCatalogProviders.value);
const presetCatalogState = computed(() => client.presetCatalogState.value);
const visiblePresets = computed(() => {
  if (presetCatalogState.value !== 'ready') return PROVIDER_PRESETS;
  return PROVIDER_PRESETS.filter(
    (p) => presetCatalogEntry(p, presetCatalogItems.value) !== undefined,
  );
});

watch(visiblePresets, (presets) => {
  if (presets.some((p) => p.key === presetKey.value)) return;
  if (presets.length > 0) selectPreset(presets[0]!.key);
  else selectSource('manual');
});

function presetChipName(p: (typeof PROVIDER_PRESETS)[number]): string {
  return presetDisplayName(p, presetCatalogEntry(p, presetCatalogItems.value), t(p.nameKey));
}

/* ================= catalog ================= */

const catalogState = ref<'loading' | 'ready' | 'error' | 'unsupported'>('loading');
const catalogItems = ref<AppCatalogProvider[]>([]);

async function loadCatalog(): Promise<void> {
  catalogState.value = 'loading';
  const result = await client.loadCatalogProviders();
  if (result.kind === 'ok') {
    catalogItems.value = result.items;
    catalogState.value = 'ready';
  } else if (result.kind === 'unsupported') {
    catalogState.value = 'unsupported';
  } else {
    catalogState.value = 'error';
  }
}

onMounted(loadCatalog);

const search = ref('');
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (q === '') return catalogItems.value;
  return catalogItems.value.filter(
    (entry) => entry.name.toLowerCase().includes(q) || entry.id.toLowerCase().includes(q),
  );
});

function rejectReasonText(entry: AppCatalogProvider): string {
  const reason = entry.rejectReason;
  if (reason !== null && te(`providers.catalog.rejectReason.${reason}`)) {
    return t(`providers.catalog.rejectReason.${reason}`);
  }
  return t('providers.catalog.rejected');
}

function entryDisplayType(entry: AppCatalogProvider): string | null {
  return kimiCodingProviderFor(entry.id)?.type ?? entry.wireType;
}

const selected = ref<AppCatalogProvider | null>(null);
const importForm = ref({ id: '', apiKey: '', baseUrl: '', models: [] as ModelRow[] });
const tableTouched = ref(false);
const showApiKey = ref(false);
const importing = ref(false);
const importError = ref('');

function selectEntry(entry: AppCatalogProvider): void {
  selected.value = entry;
  importForm.value = {
    id: catalogNameToProviderId(entry.name, entry.id),
    apiKey: '',
    baseUrl: kimiCodingProviderFor(entry.id)?.baseUrl ?? entry.baseUrl ?? '',
    models: entry.models.map(catalogModelToRow),
  };
  tableTouched.value = false;
  importError.value = '';
  showApiKey.value = false;
}

function backToCatalogList(): void {
  selected.value = null;
  importError.value = '';
}

const overwrite = computed(() => {
  const entry = selected.value;
  if (entry === null) return false;
  const id = importForm.value.id.trim();
  return id !== '' && client.providers.value.some((p) => p.id === id);
});

const importErrorBox = ref<HTMLElement>();
function showImportError(message: string): void {
  importError.value = message;
  void nextTick(() =>
    importErrorBox.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
  );
}

function validateImport(): string | null {
  const form = importForm.value;
  const id = form.id.trim();
  if (id === '') return t('providers.error.idRequired');
  if (!PROVIDER_ID_PATTERN.test(id)) return t('providers.error.idInvalid');
  if (form.apiKey.trim() === '') return t('providers.error.apiKeyRequired');
  if (selected.value?.needsBaseUrl === true && form.baseUrl.trim() === '') {
    return t('providers.error.baseUrlRequired');
  }
  if (form.models.length === 0) {
    return t('providers.error.modelRequired');
  }
  return null;
}

async function submitImport(): Promise<void> {
  const entry = selected.value;
  if (entry === null || importing.value) return;
  const invalid = validateImport();
  if (invalid !== null) {
    showImportError(invalid);
    return;
  }
  importError.value = '';
  importing.value = true;
  try {
    const form = importForm.value;
    const id = form.id.trim();
    const baseUrl = form.baseUrl.trim();
    const kimiOverride = kimiCodingProviderFor(entry.id);
    if (kimiOverride !== null) {
      if (baseUrl === '') {
        showImportError(t('providers.error.baseUrlRequired'));
        return;
      }
      const message = await client.addProvider(
        buildAddProviderInput({
          id,
          type: kimiOverride.type,
          apiKey: form.apiKey,
          baseUrl,
          models: form.models,
        }),
      );
      if (message !== null) {
        showImportError(message);
        return;
      }
      client.notify({ severity: 'success', title: t('providers.added') });
      emit('added', id);
      return;
    }
    const message = await client.importCatalogProvider({
      catalogId: entry.id,
      apiKey: form.apiKey.trim(),
      ...(baseUrl === '' ? {} : { baseUrl }),
      ...(id === entry.id ? {} : { id }),
    });
    if (message !== null) {
      showImportError(message);
      return;
    }
    if (tableTouched.value) {
      const imported = client.providers.value.find((item) => item.id === id);
      const pruneMessage = await client.updateProvider(id, {
        type: imported?.type ?? entry.wireType ?? 'openai',
        models: buildAddProviderInput({
          id,
          type: imported?.type ?? entry.wireType ?? 'openai',
          apiKey: '',
          baseUrl: '',
          models: form.models,
        }).models ?? [],
      });
      if (pruneMessage !== null) {
        showImportError(pruneMessage);
        return;
      }
    }
    client.notify({ severity: 'success', title: t('providers.added') });
    emit('added', id);
  } finally {
    importing.value = false;
  }
}

/* ================= registry ================= */

const registryForm = ref({ url: '', apiKey: '' });
const showRegistryKey = ref(false);
const importingRegistry = ref(false);
const registryError = ref('');

const registryErrorBox = ref<HTMLElement>();
function showRegistryError(message: string): void {
  registryError.value = message;
  void nextTick(() =>
    registryErrorBox.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
  );
}

async function submitRegistry(): Promise<void> {
  if (importingRegistry.value) return;
  const url = registryForm.value.url.trim();
  if (url === '') {
    showRegistryError(t('providers.error.registryUrlRequired'));
    return;
  }
  registryError.value = '';
  importingRegistry.value = true;
  try {
    const apiKey = registryForm.value.apiKey.trim();
    const result = await client.importCustomRegistry({
      url,
      ...(apiKey === '' ? {} : { apiKey }),
    });
    if (typeof result === 'string') {
      showRegistryError(result);
      return;
    }
    client.notify({
      severity: 'success',
      title: t('providers.catalog.registryImported', { count: result.providers.length }),
    });
    const first = result.providers[0];
    if (first !== undefined) emit('added', first.id);
    else emit('cancel');
  } finally {
    importingRegistry.value = false;
  }
}
</script>

<template>
  <div class="ap">
    <div class="ap-top">
      <div class="ap-head">
        <button type="button" class="ap-back" @click="emit('cancel')">
          <Icon name="arrow-left" size="sm" />
        </button>
        <span class="ap-title">{{ t('providers.addProvider') }}</span>
      </div>

      <div class="ap-chips">
        <button
          v-for="p in visiblePresets"
          :key="p.key"
          type="button"
          class="ap-chip"
          :class="{ on: source === 'preset' && presetKey === p.key }"
          @click="selectPreset(p.key)"
        >
          <ProviderBrandIcon :id="p.catalogId" size="xs" />
          {{ presetChipName(p) }}
        </button>
        <button
          v-if="catalogState !== 'unsupported'"
          type="button"
          class="ap-chip"
          :class="{ on: source === 'catalog' }"
          @click="selectSource('catalog')"
        >
          <Icon name="grid-dots" size="sm" />
          {{ t('providers.catalog.sourceCatalog') }}
        </button>
        <button
          type="button"
          class="ap-chip"
          :class="{ on: source === 'registry' }"
          @click="selectSource('registry')"
        >
          <Icon name="code" size="sm" />
          api.json
        </button>
        <button
          type="button"
          class="ap-chip"
          :class="{ on: source === 'manual' }"
          @click="selectSource('manual')"
        >
          <Icon name="tool" size="sm" />
          {{ t('providers.chipManual') }}
        </button>
      </div>
    </div>

    <ProviderForm
      v-show="source === 'preset'"
      mode="preset"
      :preset-key="presetKey"
      @added="emit('added', $event)"
      @cancel="emit('cancel')"
    />

    <div v-show="source === 'catalog'" class="ap-catalog">
      <div v-if="catalogState === 'loading'" class="settings-loading">
        <Spinner size="sm" />
        <span>{{ t('providers.catalog.loading') }}</span>
      </div>
      <div v-else-if="catalogState === 'error'" class="ap-error">
        <Banner variant="danger">{{ t('providers.catalog.loadError') }}</Banner>
        <div>
          <Button variant="secondary" size="sm" @click="loadCatalog">
            {{ t('providers.catalog.retry') }}
          </Button>
        </div>
      </div>
      <template v-else>
        <Input
          v-model="search"
          :placeholder="t('providers.catalog.searchPlaceholder')"
          autocomplete="off"
          spellcheck="false"
        />
        <div class="ap-list">
          <button
            v-for="entry in filtered"
            :key="entry.id"
            type="button"
            class="ap-entry"
            :class="{ sel: selected?.id === entry.id }"
            :disabled="entry.rejected"
            @click="selectEntry(entry)"
          >
            <span class="ap-entry-name">{{ entry.name }}</span>
            <Badge v-if="entryDisplayType(entry) !== null" variant="neutral" size="sm">{{ entryDisplayType(entry) }}</Badge>
            <span class="grow" />
            <span v-if="entry.rejected" class="ap-entry-reason">{{ rejectReasonText(entry) }}</span>
            <span v-else class="ap-entry-count">
              {{ t('providers.modelCount', { count: entry.models.length }) }}
            </span>
          </button>
          <div v-if="filtered.length === 0" class="ap-empty">{{ t('providers.catalog.empty') }}</div>
        </div>

        <div v-if="selected !== null" class="ap-import">
          <div class="ap-field">
            <label class="ap-label">{{ t('providers.fieldId') }}<span class="req"> *</span></label>
            <Input v-model="importForm.id" size="sm" autocomplete="off" spellcheck="false" />
          </div>
          <div class="ap-field">
            <label class="ap-label">{{ t('providers.fieldApiKey') }}<span class="req"> *</span></label>
            <div class="ap-key-wrap">
              <Input
                v-model="importForm.apiKey"
                size="sm"
                :type="showApiKey ? 'text' : 'password'"
                placeholder="sk-…"
                autocomplete="off"
                spellcheck="false"
              />
              <IconButton
                class="ap-key-eye"
                size="sm"
                :label="t(showApiKey ? 'providers.hideApiKey' : 'providers.showApiKey')"
                :tooltip="t(showApiKey ? 'providers.hideApiKey' : 'providers.showApiKey')"
                @click="showApiKey = !showApiKey"
              >
                <Icon :name="showApiKey ? 'eye-off' : 'eye'" size="sm" />
              </IconButton>
            </div>
          </div>
          <div class="ap-field">
            <label class="ap-label">
              {{ t('providers.fieldBaseUrl') }}<span v-if="selected.needsBaseUrl" class="req"> *</span>
            </label>
            <Input
              v-model="importForm.baseUrl"
              size="sm"
              :placeholder="t('providers.baseUrlPlaceholder')"
              autocomplete="off"
              spellcheck="false"
            />
          </div>
          <Banner v-if="overwrite" variant="warning">
            {{ t('providers.catalog.overwriteWarning') }}
          </Banner>
          <div class="ap-field">
            <label class="ap-label">
              {{ t('providers.fieldModels') }}<span class="req"> *</span>
              <span class="ap-hint-inline">{{ t('providers.modelCount', { count: importForm.models.length }) }}</span>
            </label>
            <ProviderModelTable v-model="importForm.models" @change="tableTouched = true" />
          </div>
          <div v-if="importError" ref="importErrorBox">
            <Banner variant="danger">{{ importError }}</Banner>
          </div>
          <div class="ap-foot">
            <Button variant="ghost" size="sm" @click="backToCatalogList">
              {{ t('providers.catalog.backToList') }}
            </Button>
            <Button variant="primary" size="sm" :disabled="importing" @click="submitImport">
              {{ t('providers.catalog.importAction') }}
            </Button>
          </div>
        </div>
      </template>
    </div>

    <div v-show="source === 'registry'" class="ap-registry">
      <div class="ap-hint">{{ t('providers.catalog.registryHint') }}</div>
      <div class="ap-field">
        <label class="ap-label">{{ t('providers.catalog.registryUrlLabel') }}<span class="req"> *</span></label>
        <Input
          v-model="registryForm.url"
          size="sm"
          placeholder="https://example.com/api.json"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <div class="ap-field">
        <label class="ap-label">{{ t('providers.fieldApiKey') }}</label>
        <div class="ap-key-wrap">
          <Input
            v-model="registryForm.apiKey"
            size="sm"
            :type="showRegistryKey ? 'text' : 'password'"
            :placeholder="t('providers.modelNamePlaceholder')"
            autocomplete="off"
            spellcheck="false"
          />
          <IconButton
            class="ap-key-eye"
            size="sm"
            :label="t(showRegistryKey ? 'providers.hideApiKey' : 'providers.showApiKey')"
            :tooltip="t(showRegistryKey ? 'providers.hideApiKey' : 'providers.showApiKey')"
            @click="showRegistryKey = !showRegistryKey"
          >
            <Icon :name="showRegistryKey ? 'eye-off' : 'eye'" size="sm" />
          </IconButton>
        </div>
      </div>
      <div v-if="registryError" ref="registryErrorBox">
        <Banner variant="danger">{{ registryError }}</Banner>
      </div>
      <div class="ap-foot">
        <span class="spacer" />
        <Button variant="primary" size="sm" :disabled="importingRegistry" @click="submitRegistry">
          {{ t('providers.catalog.importAction') }}
        </Button>
      </div>
    </div>

    <ProviderForm
      v-show="source === 'manual'"
      mode="add"
      @added="emit('added', $event)"
      @cancel="emit('cancel')"
    />
  </div>
</template>

<style scoped src="./settings-common.css"></style>

<style scoped>
.ap { display: flex; flex-direction: column; }

.ap-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}
.ap-top {
  position: sticky;
  top: calc(-1 * var(--space-2));
  z-index: 5;
  margin: calc(-1 * var(--space-2)) 0 0;
  padding-top: var(--space-2);
  background: var(--color-bg);
  border-bottom: var(--p-hairline) solid var(--color-line);
}
.ap-back {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  margin-left: calc(-1 * var(--space-2));
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}
.ap-back:hover { background: var(--color-hover); color: var(--color-text-strong); }
.ap-title {
  font-family: var(--font-ui);
  font-size: var(--text-lg);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}

.ap-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
  margin-bottom: var(--space-4);
}
.ap-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  height: 30px;
  padding: 0 var(--space-3);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-full);
  background: transparent;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-option-label);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.ap-chip:hover { background: var(--color-hover); }
.ap-chip.on {
  background: var(--color-selected);
  color: var(--color-text);
  font-weight: var(--weight-ui-strong);
  border-color: transparent;
}

.ap-catalog { display: flex; flex-direction: column; gap: var(--space-3); }
.ap-error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
}
.ap-list {
  display: flex;
  flex-direction: column;
  max-height: 320px;
  overflow-y: auto;
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
}
.ap-list > * + * { border-top: var(--p-hairline) solid var(--color-line); }
.ap-entry {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 34px;
  padding: var(--space-1) var(--space-3);
  border: none;
  background: transparent;
  text-align: left;
  font-family: var(--font-ui);
  color: var(--color-text);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}
.ap-entry:hover:not(:disabled) { background: var(--color-hover); }
.ap-entry.sel { background: var(--color-selected); }
.ap-entry:disabled { cursor: not-allowed; opacity: 0.55; }
.ap-entry-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}
.ap-entry .grow { flex: 1; min-width: 0; }
.ap-entry-count, .ap-entry-reason {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  white-space: nowrap;
}
.ap-empty {
  padding: var(--space-4);
  text-align: center;
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
}

.ap-import {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
}
.ap-registry { display: flex; flex-direction: column; gap: var(--space-4); }
.ap-hint {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-text-faint);
}
.ap-field { display: flex; flex-direction: column; gap: var(--space-1); }
.ap-label {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text-muted);
}
.req { color: var(--color-danger); }
.ap-key-wrap { position: relative; }
.ap-key-wrap :deep(.ui-input) { padding-right: calc(var(--icon-button-sm) + var(--space-2)); }
.ap-key-eye { position: absolute; right: var(--space-1); top: 50%; transform: translateY(-50%); }
.ap-hint-inline {
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  font-weight: var(--weight-regular);
}
.ap-foot {
  position: sticky;
  bottom: 0;
  z-index: 5;
  background: var(--color-bg);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  padding-top: var(--space-3);
  padding-bottom: var(--space-2);
  box-shadow: 0 var(--space-5) 0 var(--color-bg);
  border-top: var(--p-hairline) solid var(--color-subtle);
}
.ap-foot .spacer { flex: 1; }
</style>
