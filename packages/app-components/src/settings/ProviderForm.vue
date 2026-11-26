<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppProvider } from '@moonshot-ai/app-core/api';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import {
  adaptBaseUrlForType,
  buildAddProviderInput,
  buildUpdateProviderInput,
  catalogModelToRow,
  emptyModelRow,
  fetchedModelToRow,
  fetchProviderModels,
  isManagedOAuthProvider,
  kimiCodingProviderFor,
  matchProviderPreset,
  presetCatalogEntry,
  presetCatalogId,
  presetDisplayName,
  presetProviderId,
  PROVIDER_PRESETS,
  PROVIDER_TYPES,
  providerDisplayName,
  providerModelRows,
  validateProviderForm,
  type ProviderFormState,
  type ProviderPreset,
} from '@moonshot-ai/app-core/lib';
import { Badge, Banner, Button, Icon, IconButton, Input, Select, Spinner } from '@moonshot-ai/app-ui';
import ProviderBrandIcon from './ProviderBrandIcon.vue';
import ProviderModelTable from './ProviderModelTable.vue';

const props = defineProps<{
  mode: 'preset' | 'edit' | 'add';
  presetKey?: string;
  provider?: AppProvider;
}>();

const emit = defineEmits<{
  added: [id: string];
  saved: [id: string];
  deleting: [];
  deleted: [id: string];
  cancel: [];
}>();

const { t } = useI18n();
const client = useKimiWebClient();

const managed = computed(
  () => props.provider !== undefined && isManagedOAuthProvider(props.provider),
);

/* ================= preset 元信息（新建预填 + 页头） ================= */

const catalogItems = computed(() => client.presetCatalogProviders.value);
const catalogState = computed(() => client.presetCatalogState.value);

async function loadCatalog(): Promise<void> {
  await client.loadPresetCatalog();
}

const editPresetMatch = computed(() => {
  if (props.mode !== 'edit' || props.provider === undefined) return null;
  return matchProviderPreset(props.provider.id, catalogItems.value);
});

const preset = computed<ProviderPreset | undefined>(() => {
  if (props.mode === 'preset') {
    return PROVIDER_PRESETS.find((p) => p.key === props.presetKey);
  }
  return editPresetMatch.value?.preset;
});

const catalogEntry = computed(() =>
  preset.value === undefined ? undefined : presetCatalogEntry(preset.value, catalogItems.value),
);

const presetName = computed(() =>
  preset.value === undefined
    ? ''
    : presetDisplayName(preset.value, catalogEntry.value, t(preset.value.nameKey)),
);

/* ================= 表单状态（全模式统一） ================= */

const form = reactive<ProviderFormState>({
  id: '',
  type: 'openai',
  apiKey: '',
  baseUrl: '',
  models: [emptyModelRow()],
});

const contentTouched = ref(false);

const typeOptions = computed(() =>
  PROVIDER_TYPES.map((type) => ({ value: type, label: t(`providers.types.${type}`) })),
);

function fill(): void {
  if (props.mode === 'preset') {
    const p = preset.value;
    if (p === undefined) return;
    const override = kimiCodingProviderFor(p.catalogId);
    const entry = catalogEntry.value;
    form.id = presetProviderId(p, entry);
    form.type = override?.type ?? entry?.wireType ?? 'openai';
    form.baseUrl = override?.baseUrl ?? entry?.baseUrl ?? '';
    form.apiKey = '';
    form.models = entry !== undefined && entry.models.length > 0
      ? entry.models.map(catalogModelToRow)
      : [emptyModelRow()];
  } else if (props.mode === 'edit' && props.provider !== undefined) {
    const p = props.provider;
    form.id = p.id;
    form.type = p.type;
    form.apiKey = '';
    form.baseUrl = p.baseUrl ?? '';
    const rows = providerModelRows(p, client.config.value?.models);
    form.models = rows.length > 0 ? rows : [emptyModelRow()];
  } else {
    form.id = '';
    form.type = 'openai';
    form.apiKey = '';
    form.baseUrl = '';
    form.models = [emptyModelRow()];
  }
  contentTouched.value = false;
}

watch(
  () => props.presetKey,
  () => {
    if (props.mode === 'preset') fill();
  },
);

watch(catalogEntry, (entry, prev) => {
  if (entry === undefined || entry === prev || props.mode !== 'preset' || contentTouched.value) return;
  const p = preset.value;
  if (p === undefined) return;
  const override = kimiCodingProviderFor(p.catalogId);
  if (form.id === p.catalogId) form.id = presetProviderId(p, entry);
  form.type = override?.type ?? entry.wireType ?? 'openai';
  form.baseUrl = override?.baseUrl ?? entry.baseUrl ?? '';
  form.models = entry.models.length > 0 ? entry.models.map(catalogModelToRow) : [emptyModelRow()];
});

function onTypeChange(type: string): void {
  form.type = type;
  contentTouched.value = true;
  if (form.baseUrl.trim() !== '') {
    form.baseUrl = adaptBaseUrlForType(form.baseUrl.trim(), type);
  }
}

/* ================= apiKey 载入（edit） ================= */

const keyLoaded = ref(false);
async function loadApiKey(): Promise<void> {
  const p = props.provider;
  if (props.mode !== 'edit' || p === undefined || managed.value || p.hasApiKey !== true) return;
  try {
    const detail = await client.getProvider(p.id);
    if (detail.apiKey !== undefined && detail.apiKey !== '') {
      form.apiKey = detail.apiKey;
      keyLoaded.value = true;
    }
  } catch {
    // keep the "set — enter to replace" placeholder; saving preserves the stored key
  }
}

onMounted(() => {
  fill();
  if (props.mode === 'preset' && catalogState.value === 'idle') void loadCatalog();
  void loadApiKey();
});

const FETCH_MODELS_CONTEXT_SIZE = '256000';

const fetchingModels = ref(false);
let fetchSeq = 0;
let fetchDisposed = false;

const canFetchModels = computed(
  () =>
    !managed.value &&
    form.type !== 'vertexai' &&
    form.baseUrl.trim() !== '' &&
    !fetchingModels.value,
);

watch(
  () => [form.type, form.baseUrl, form.apiKey],
  () => {
    fetchSeq += 1;
    fetchingModels.value = false;
  },
);

onUnmounted(() => {
  fetchDisposed = true;
  fetchSeq += 1;
  fetchingModels.value = false;
});

async function runFetchModels(): Promise<void> {
  if (!canFetchModels.value) return;
  if (props.mode === 'edit' && form.apiKey.trim() === '' && !keyLoaded.value) {
    await loadApiKey();
    if (fetchDisposed) return;
  }
  const seq = ++fetchSeq;
  fetchingModels.value = true;
  try {
    const result = await fetchProviderModels({
      type: form.type,
      baseUrl: form.baseUrl,
      apiKey: form.apiKey,
    });
    if (seq !== fetchSeq) return;
    if (!result.ok) {
      client.notify({
        severity: 'error',
        title:
          result.kind === 'http'
            ? t('providers.fetchModels.error.http', { status: result.status ?? 0 })
            : t(`providers.fetchModels.error.${result.kind}`),
      });
      return;
    }
    if (result.models.length === 0) {
      client.notify({ severity: 'info', title: t('providers.fetchModels.empty') });
      return;
    }
    const existing = new Set(
      form.models.map((row) => row.model.trim()).filter((id) => id !== ''),
    );
    const adding = result.models.filter((m) => !existing.has(m.id));
    if (adding.length === 0) {
      client.notify({ severity: 'info', title: t('providers.fetchModels.noNew') });
      return;
    }
    const kept = form.models.filter(
      (row) =>
        row.model.trim() !== '' ||
        row.maxContextSize.trim() !== '' ||
        row.displayName.trim() !== '',
    );
    form.models = [
      ...kept,
      ...adding.map((m) => fetchedModelToRow(m, FETCH_MODELS_CONTEXT_SIZE)),
    ];
    contentTouched.value = true;
    client.notify({
      severity: 'success',
      title: t('providers.fetchModels.done', { count: adding.length }),
    });
  } finally {
    if (seq === fetchSeq) fetchingModels.value = false;
  }
}

/* ================= 提交 / 删除 ================= */

const error = ref('');
const submitting = ref(false);
const confirmingDelete = ref(false);
const deleting = ref(false);
const showApiKey = ref(false);

const errorBox = ref<HTMLElement>();
function showError(message: string): void {
  error.value = message;
  void nextTick(() => errorBox.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
}

const apiKeyPlaceholder = computed(() => {
  if (managed.value) return t('providers.apiKeyManaged');
  if (props.mode === 'edit' && props.provider?.hasApiKey === true) return t('providers.apiKeySet');
  return 'sk-…';
});

async function submit(): Promise<void> {
  if (submitting.value) return;
  const invalid = validateProviderForm(form, {
    requireApiKey: props.mode !== 'edit',
    requireBaseUrl: true,
  });
  if (invalid !== null) return showError(t(`providers.error.${invalid}`));

  error.value = '';
  submitting.value = true;
  try {
    if (props.mode === 'preset') {
      const p = preset.value;
      if (p === undefined) return;
      const id = form.id.trim();
      if (!contentTouched.value && kimiCodingProviderFor(p.catalogId) === null) {
        const message = await client.importCatalogProvider({
          catalogId: presetCatalogId(p, catalogItems.value),
          apiKey: form.apiKey.trim(),
          ...(id === p.catalogId ? {} : { id }),
        });
        if (message !== null) return showError(message);
      } else {
        const message = await client.addProvider(buildAddProviderInput(form));
        if (message !== null) return showError(message);
      }
      client.notify({ severity: 'success', title: t('providers.added') });
      emit('added', id);
      return;
    }
    if (props.mode === 'add') {
      const message = await client.addProvider(buildAddProviderInput(form));
      if (message !== null) return showError(message);
      client.notify({ severity: 'success', title: t('providers.added') });
      emit('added', form.id.trim());
      return;
    }
    const p = props.provider;
    if (p === undefined) return;
    const configuredDefault = client.config.value?.providers?.[p.id]?.defaultModel;
    const message = await client.updateProvider(
      p.id,
      buildUpdateProviderInput(form, p, {
        includeBlankApiKey: keyLoaded.value,
        existingDefaultModel: configuredDefault,
      }),
    );
    if (message !== null) return showError(message);
    client.notify({ severity: 'success', title: t('providers.saved') });
    emit('saved', form.id.trim());
  } finally {
    submitting.value = false;
  }
}

async function confirmDelete(): Promise<void> {
  const p = props.provider;
  if (p === undefined || deleting.value) return;
  deleting.value = true;
  emit('deleting');
  try {
    const result = await client.deleteProvider(p.id);
    if (result === null) {
      confirmingDelete.value = false;
      return;
    }
    emit('deleted', p.id);
  } finally {
    deleting.value = false;
  }
}

const persistedModelCount = computed(() => {
  const p = props.provider;
  if (p === undefined) return 0;
  return providerModelRows(p, client.config.value?.models).length;
});
</script>

<template>
  <div class="pf">
    <div v-if="error" ref="errorBox">
      <Banner variant="danger">{{ error }}</Banner>
    </div>

    <div v-if="preset !== undefined" class="pf-brand" :class="{ 'pf-head-sticky': props.mode === 'edit' }">
      <IconButton v-if="props.mode === 'edit'" class="pf-nav" size="sm" :label="t('settings.plugins.back')" @click="emit('cancel')">
        <Icon name="arrow-left" size="sm" />
      </IconButton>
      <ProviderBrandIcon :id="preset.catalogId" size="sm" />
      <span class="pf-brand-name">{{ presetName }}</span>
      <span class="pf-brand-tag">{{ t(preset.tagKey) }}</span>
    </div>
    <div v-else-if="props.mode === 'edit' && props.provider !== undefined" class="pf-brand pf-head-sticky">
      <IconButton class="pf-nav" size="sm" :label="t('settings.plugins.back')" @click="emit('cancel')">
        <Icon name="arrow-left" size="sm" />
      </IconButton>
      <ProviderBrandIcon :id="props.provider.id" :base-url="props.provider.baseUrl" size="sm" />
      <span class="pf-brand-name">{{ providerDisplayName(props.provider.id, t) }}</span>
      <Badge variant="neutral" size="sm">{{ props.provider.type }}</Badge>
    </div>

    <div class="pf-field">
      <label class="pf-label">{{ t('providers.fieldId') }}<span class="req"> *</span></label>
      <Input
        v-model="form.id"
        size="sm"
        placeholder="my-openai"
        :disabled="managed"
        autocomplete="off"
        spellcheck="false"
        @input="contentTouched = true"
      />
    </div>

    <div class="pf-field">
      <label class="pf-label">{{ t('providers.fieldType') }}<span class="req"> *</span></label>
      <Select
        :model-value="form.type"
        :options="typeOptions"
        :disabled="managed"
        size="sm"
        @update:model-value="onTypeChange"
      />
    </div>

    <div class="pf-field">
      <label class="pf-label">{{ t('providers.fieldApiKey') }}<span class="req"> *</span></label>
      <div class="pf-key-wrap">
        <Input
          v-model="form.apiKey"
          size="sm"
          :type="showApiKey ? 'text' : 'password'"
          :placeholder="apiKeyPlaceholder"
          :disabled="managed"
          autocomplete="off"
          spellcheck="false"
        />
        <IconButton
          v-if="!managed"
          class="pf-key-eye"
          size="sm"
          :label="t(showApiKey ? 'providers.hideApiKey' : 'providers.showApiKey')"
          :tooltip="t(showApiKey ? 'providers.hideApiKey' : 'providers.showApiKey')"
          @click="showApiKey = !showApiKey"
        >
          <Icon :name="showApiKey ? 'eye-off' : 'eye'" size="sm" />
        </IconButton>
      </div>
    </div>

    <div class="pf-field">
      <label class="pf-label">{{ t('providers.fieldBaseUrl') }}<span class="req"> *</span></label>
      <Input
        v-model="form.baseUrl"
        size="sm"
        :placeholder="t('providers.baseUrlPlaceholder')"
        :disabled="managed"
        autocomplete="off"
        spellcheck="false"
        @input="contentTouched = true"
      />
    </div>

    <div class="pf-field">
      <div class="pf-label">
        {{ t('providers.fieldModels') }}<span class="req"> *</span>
        <span class="pf-hint-inline">{{ t('providers.modelCount', { count: form.models.length }) }}</span>
        <span class="spacer" />
        <Button
          v-if="!managed"
          variant="ghost"
          size="sm"
          :loading="fetchingModels"
          :disabled="!canFetchModels"
          :title="form.type === 'vertexai' ? t('providers.fetchModels.unsupportedType') : undefined"
          @click="runFetchModels"
        >
          {{ t('providers.fetchModels.button') }}
        </Button>
      </div>
      <div v-if="props.mode === 'preset' && catalogState === 'loading'" class="pf-pool-state">
        <Spinner size="sm" />
      </div>
      <div v-else-if="props.mode === 'preset' && catalogState === 'error'" class="pf-pool-state">
        <Banner variant="danger">{{ t('providers.catalog.loadError') }}</Banner>
        <Button variant="secondary" size="sm" @click="loadCatalog">{{ t('providers.catalog.retry') }}</Button>
      </div>
      <ProviderModelTable v-else v-model="form.models" :managed="managed" @change="contentTouched = true" />
    </div>

    <div class="pf-foot">
      <template v-if="props.mode === 'edit' && confirmingDelete && props.provider !== undefined">
        <span class="pf-confirm-msg">
          {{ t('providers.deleteConfirm', { id: providerDisplayName(props.provider.id, t), count: persistedModelCount }) }}
        </span>
        <span class="spacer" />
        <Button variant="secondary" size="sm" :disabled="deleting" @click="confirmingDelete = false">
          {{ t('common.cancel') }}
        </Button>
        <Button variant="danger" size="sm" :disabled="deleting" @click="confirmDelete">
          {{ t('providers.deleteConfirmYes') }}
        </Button>
      </template>
      <template v-else-if="props.mode === 'edit'">
        <Button variant="danger" size="sm" @click="confirmingDelete = true">
          {{ t('providers.deleteProvider') }}
        </Button>
        <span class="spacer" />
        <Button variant="ghost" size="sm" @click="emit('cancel')">{{ t('common.cancel') }}</Button>
        <Button variant="primary" size="sm" :disabled="submitting" @click="submit">
          {{ t('providers.save') }}
        </Button>
      </template>
      <template v-else>
        <span class="spacer" />
        <Button variant="ghost" size="sm" @click="emit('cancel')">{{ t('common.cancel') }}</Button>
        <Button variant="primary" size="sm" :disabled="submitting" @click="submit">
          {{ t('providers.save') }}
        </Button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.pf { display: flex; flex-direction: column; gap: var(--space-3); }

.pf-brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.pf-nav { margin-left: calc(-1 * var(--space-2)); }
.pf-head-sticky {
  position: sticky;
  top: calc(-1 * var(--space-2));
  z-index: 5;
  margin: calc(-1 * var(--space-2)) 0 0;
  padding: var(--space-2) 0;
  background: var(--color-bg);
  border-bottom: var(--p-hairline) solid var(--color-line);
}
.pf-brand-name {
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}
.pf-brand-tag {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 7px;
  border-radius: var(--radius-full);
  background: var(--color-accent-soft);
  color: var(--color-accent-hover);
  font-size: 11px;
}

.pf-field { display: flex; flex-direction: column; gap: var(--space-1); }
.pf-label {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text-muted);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.req { color: var(--color-danger); }
.pf-hint-inline {
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  font-weight: var(--weight-regular);
}
.pf-key-wrap { position: relative; }
.pf-key-wrap :deep(.ui-input) { padding-right: calc(var(--icon-button-sm) + var(--space-2)); }
.pf-key-eye { position: absolute; right: var(--space-1); top: 50%; transform: translateY(-50%); }

.pf-pool-state {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) 0;
}

.pf-label .spacer { flex: 1; }

.pf-foot {
  position: sticky;
  bottom: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-top: var(--space-4);
  padding-bottom: var(--space-2);
  border-top: var(--p-hairline) solid var(--color-line);
  background: var(--color-bg);
  box-shadow: 0 var(--space-5) 0 var(--color-bg);
}
.pf-foot .spacer { flex: 1; }
.pf-confirm-msg {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-danger);
}
</style>
