<!-- apps/web/src/components/settings/AddProviderFlow.vue -->
<!-- The add-provider expand area of the Providers tab: a source switch
     (models.dev directory vs. manual) on top of the shared ProviderForm. The
     directory view browses the server-proxied catalog (search, greyed-out
     rejected entries) and turns a picked entry into a short import form
     (name / API key / base URL only when the entry needs one); manual is the
     existing full form. Servers that predate the catalog routes hide the
     switch and fall back to manual-only. Dirty/guard events mirror
     ProviderForm's contract so the parent accordion treats both sources the
     same. -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppCatalogProvider } from '../../api/types';
import { useKimiWebClient } from '../../composables/useKimiWebClient';
import { PROVIDER_ID_PATTERN } from '../../lib/providerForm';
import ProviderForm from './ProviderForm.vue';
import {
  Badge,
  Banner,
  Button,
  Icon,
  IconButton,
  Input,
  SegmentedControl,
  Spinner,
} from '@moonshot-ai/app-ui';

defineProps<{
  /** Show the unsaved-changes guard bar at the top (shared by both sources). */
  guard?: boolean;
}>();

const emit = defineEmits<{
  dirtyChange: [dirty: boolean];
  guardStay: [];
  guardDiscard: [];
  added: [id: string];
  cancel: [];
}>();

const { t, te } = useI18n();
const client = useKimiWebClient();

const source = ref<'catalog' | 'registry' | 'manual'>('catalog');
const sourceOptions = computed(() => [
  { value: 'catalog', label: t('providers.catalog.sourceCatalog') },
  { value: 'registry', label: t('providers.catalog.sourceRegistry') },
  { value: 'manual', label: t('providers.catalog.sourceManual') },
]);

// ---------------------------------------------------------------------------
// Directory loading (three-way: ready / error-retryable / unsupported server)
// ---------------------------------------------------------------------------

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
    // Only pull the user out of the catalog view — a slow directory answer
    // must not yank them away from the registry/manual form mid-input.
    if (source.value === 'catalog') source.value = 'manual';
  } else {
    catalogState.value = 'error';
  }
}

onMounted(loadCatalog);

// ---------------------------------------------------------------------------
// Directory browsing (browsing/searching is never dirty — only form input is)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Import form (one picked entry)
// ---------------------------------------------------------------------------

const selected = ref<AppCatalogProvider | null>(null);
const importForm = ref({ id: '', apiKey: '', baseUrl: '' });
const showApiKey = ref(false);
const importing = ref(false);
const importError = ref('');

function selectEntry(entry: AppCatalogProvider): void {
  selected.value = entry;
  importForm.value = { id: entry.id, apiKey: '', baseUrl: '' };
  importError.value = '';
  showApiKey.value = false;
}

function backToList(): void {
  // The form is discarded on purpose; clear the dirty flag it may have raised.
  selected.value = null;
  importError.value = '';
  emit('dirtyChange', false);
}

function markDirty(): void {
  emit('dirtyChange', true);
}

/** Importing an id that already exists is a server-side refresh — warn. */
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
    client.notify({ severity: 'success', title: t('providers.added') });
    emit('dirtyChange', false);
    emit('added', id);
  } finally {
    importing.value = false;
  }
}

// ---------------------------------------------------------------------------
// Registry source (api.json URL + optional Bearer key)
// ---------------------------------------------------------------------------

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
    emit('dirtyChange', false);
    const first = result.providers[0];
    // A registry can list several providers; expand the first, same landing
    // as the other add paths. (The server rejects empty registries, so this
    // fallback is only a type guard.)
    if (first !== undefined) emit('added', first.id);
    else emit('cancel');
  } finally {
    importingRegistry.value = false;
  }
}
</script>

<template>
  <div class="af">
    <!-- Unsaved-changes guard (shared across both sources) -->
    <Banner v-if="guard" variant="warning" class="af-guard">
      <span class="msg">{{ t('providers.unsavedGuard') }}</span>
      <Button variant="secondary" size="sm" @click="emit('guardStay')">{{ t('providers.guardStay') }}</Button>
      <Button variant="danger" size="sm" @click="emit('guardDiscard')">{{ t('providers.guardDiscard') }}</Button>
    </Banner>

    <SegmentedControl
      v-if="catalogState !== 'unsupported'"
      v-model="source"
      size="sm"
      :options="sourceOptions"
    />

    <!-- Directory source (kept mounted across source switches to preserve state) -->
    <div v-if="catalogState !== 'unsupported'" v-show="source === 'catalog'" class="af-catalog">
      <div v-if="catalogState === 'loading'" class="af-center">
        <Spinner size="sm" />
        <span>{{ t('providers.catalog.loading') }}</span>
      </div>
      <div v-else-if="catalogState === 'error'" class="af-error">
        <Banner variant="danger">{{ t('providers.catalog.loadError') }}</Banner>
        <div>
          <Button variant="secondary" size="sm" @click="loadCatalog">
            {{ t('providers.catalog.retry') }}
          </Button>
        </div>
      </div>

      <template v-else-if="selected === null">
        <Input
          v-model="search"
          :placeholder="t('providers.catalog.searchPlaceholder')"
          autocomplete="off"
          spellcheck="false"
        />
        <div class="af-list">
          <button
            v-for="entry in filtered"
            :key="entry.id"
            type="button"
            class="af-entry"
            :disabled="entry.rejected"
            @click="selectEntry(entry)"
          >
            <span class="af-entry-name">{{ entry.name }}</span>
            <Badge v-if="entry.wireType !== null" variant="neutral" size="sm">{{ entry.wireType }}</Badge>
            <span class="grow" />
            <span v-if="entry.rejected" class="af-entry-reason">{{ rejectReasonText(entry) }}</span>
            <span v-else class="af-entry-count">
              {{ t('providers.modelCount', { count: entry.models.length }) }}
            </span>
          </button>
          <div v-if="filtered.length === 0" class="af-empty">{{ t('providers.catalog.empty') }}</div>
        </div>
      </template>

      <div v-else class="af-import" @input="markDirty">
        <button type="button" class="af-back" @click="backToList">
          <Icon name="arrow-left" size="sm" />
          {{ t('providers.catalog.backToList') }}
        </button>
        <div class="af-field">
          <label class="af-label">{{ t('providers.fieldId') }}<span class="req"> *</span></label>
          <Input v-model="importForm.id" autocomplete="off" spellcheck="false" />
        </div>
        <div class="af-field">
          <label class="af-label">{{ t('providers.fieldApiKey') }}<span class="req"> *</span></label>
          <div class="af-key-wrap">
            <Input
              v-model="importForm.apiKey"
              :type="showApiKey ? 'text' : 'password'"
              placeholder="sk-…"
              autocomplete="off"
              spellcheck="false"
            />
            <IconButton
              class="af-key-eye"
              size="sm"
              :label="t(showApiKey ? 'providers.hideApiKey' : 'providers.showApiKey')"
              :tooltip="t(showApiKey ? 'providers.hideApiKey' : 'providers.showApiKey')"
              @click="showApiKey = !showApiKey"
            >
              <Icon :name="showApiKey ? 'eye-off' : 'eye'" size="sm" />
            </IconButton>
          </div>
        </div>
        <div v-if="selected.needsBaseUrl" class="af-field">
          <label class="af-label">{{ t('providers.fieldBaseUrl') }}<span class="req"> *</span></label>
          <Input
            v-model="importForm.baseUrl"
            :placeholder="t('providers.baseUrlPlaceholder')"
            autocomplete="off"
            spellcheck="false"
          />
        </div>
        <Banner v-if="overwrite" variant="warning">
          {{ t('providers.catalog.overwriteWarning') }}
        </Banner>
        <div class="af-note">
          {{ t('providers.catalog.willImport', { count: selected.models.length }) }}
        </div>
        <div v-if="importError" ref="importErrorBox">
          <Banner variant="danger">{{ importError }}</Banner>
        </div>
        <div class="af-foot">
          <Button variant="secondary" size="sm" @click="emit('cancel')">
            {{ t('common.cancel') }}
          </Button>
          <Button variant="primary" size="sm" :disabled="importing" @click="submitImport">
            {{ t('providers.catalog.importAction') }}
          </Button>
        </div>
      </div>
    </div>

    <!-- Registry source -->
    <div v-show="source === 'registry'" class="af-registry" @input="markDirty">
      <div class="af-hint">{{ t('providers.catalog.registryHint') }}</div>
      <div class="af-field">
        <label class="af-label">{{ t('providers.catalog.registryUrlLabel') }}<span class="req"> *</span></label>
        <Input
          v-model="registryForm.url"
          placeholder="https://example.com/api.json"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <div class="af-field">
        <label class="af-label">{{ t('providers.fieldApiKey') }}</label>
        <div class="af-key-wrap">
          <Input
            v-model="registryForm.apiKey"
            :type="showRegistryKey ? 'text' : 'password'"
            :placeholder="t('providers.modelNamePlaceholder')"
            autocomplete="off"
            spellcheck="false"
          />
          <IconButton
            class="af-key-eye"
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
      <div class="af-foot">
        <Button variant="secondary" size="sm" @click="emit('cancel')">
          {{ t('common.cancel') }}
        </Button>
        <Button variant="primary" size="sm" :disabled="importingRegistry" @click="submitRegistry">
          {{ t('providers.catalog.importAction') }}
        </Button>
      </div>
    </div>

    <!-- Manual source -->
    <div v-show="source === 'manual'" class="af-manual">
      <ProviderForm
        mode="add"
        :guard="false"
        @dirty-change="emit('dirtyChange', $event)"
        @added="emit('added', $event)"
        @cancel="emit('cancel')"
      />
    </div>
  </div>
</template>

<style scoped>
.af {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-4) var(--space-5);
  border-top: 0.5px solid var(--color-line);
}

/* The guard bar's buttons align right inside the banner's text slot. */
.af-guard :deep(.ui-banner__text) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
}
.af-guard .msg { flex: 1; }

.af-catalog {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.af-center {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-4) 0;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-base);
}
.af-error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
}

/* Directory list: compact rows inside a fixed-height scroller — the full
   catalog is 100+ entries and must not stretch the accordion. */
.af-list {
  display: flex;
  flex-direction: column;
  max-height: 320px;
  overflow-y: auto;
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-md);
}
.af-list > * + * { border-top: 0.5px solid var(--color-line); }
.af-entry {
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
.af-entry:hover:not(:disabled) { background: var(--color-hover); }
.af-entry:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.af-entry-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}
.af-entry .grow { flex: 1; min-width: 0; }
.af-entry-count {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  white-space: nowrap;
}
.af-entry-reason {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  white-space: nowrap;
}
.af-empty {
  padding: var(--space-4);
  text-align: center;
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
}

.af-import {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.af-registry {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
.af-hint {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-text-faint);
}
.af-back {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  align-self: flex-start;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  cursor: pointer;
  transition: color var(--duration-fast) var(--ease-out);
}
.af-back:hover { color: var(--color-text); }

.af-field { display: flex; flex-direction: column; gap: 6px; }
.af-label {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text-muted);
}
.req { color: var(--color-danger); }
.af-key-wrap { position: relative; }
.af-key-wrap :deep(.ui-input) { padding-right: calc(var(--icon-button-sm) + var(--space-2)); }
.af-key-eye { position: absolute; right: var(--space-1); top: 50%; transform: translateY(-50%); }

.af-note {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-text-faint);
}

.af-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  padding-top: var(--space-4);
  border-top: 0.5px solid var(--color-line);
}

/* The manual form brings its own padding/border; strip the wrapper's share. */
.af-manual :deep(.pf-form) {
  padding: 0;
  border-top: none;
}
</style>
