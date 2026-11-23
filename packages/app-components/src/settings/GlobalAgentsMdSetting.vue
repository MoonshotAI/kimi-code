<script setup lang="ts">
import './settings-row-label.css';
import { computed, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import { Button, Icon, Spinner, Textarea } from '@moonshot-ai/app-ui';
import SettingsSubpage from './SettingsSubpage.vue';
import { useSettingsSubpage } from './useSettingsSubpage';

const emit = defineEmits<{
  openChange: [open: boolean];
  dirtyChange: [dirty: boolean];
}>();

const { t } = useI18n();
const client = useKimiWebClient();
const { confirm } = useConfirmDialog();
const page = useSettingsSubpage<'globalAgentsMd'>();
const open = computed(() => page.page.value !== null);
const draft = ref('');
const savedContent = ref('');
const filePath = ref('');
const fileExists = ref(false);
const loading = ref(false);
const saving = ref(false);
const loadError = ref('');
const saveError = ref('');
let operationGeneration = 0;

const dirty = computed(() => !loading.value && loadError.value === '' && draft.value !== savedContent.value);
const statusText = computed(() => {
  if (dirty.value) return t('settings.globalAgentsMdUnsaved');
  if (!fileExists.value && !loading.value && loadError.value === '') return t('settings.globalAgentsMdCreateHint');
  return '';
});

watch(open, (value) => emit('openChange', value), { immediate: true });
watch(dirty, (value) => emit('dirtyChange', value), { immediate: true });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function confirmDiscard(): Promise<boolean> {
  if (!dirty.value) return true;
  return await confirm({
    title: t('settings.globalAgentsMdDiscardTitle'),
    message: t('settings.globalAgentsMdDiscardMessage'),
    confirmLabel: t('settings.globalAgentsMdDiscardConfirm'),
    cancelLabel: t('common.cancel'),
    variant: 'danger',
  });
}

function reset(): void {
  operationGeneration++;
  page.reset();
  draft.value = '';
  savedContent.value = '';
  filePath.value = '';
  fileExists.value = false;
  loading.value = false;
  saving.value = false;
  loadError.value = '';
  saveError.value = '';
}

async function load(): Promise<void> {
  const generation = ++operationGeneration;
  loading.value = true;
  saving.value = false;
  loadError.value = '';
  saveError.value = '';
  try {
    const result = await client.getGlobalAgentsMd();
    if (generation !== operationGeneration) return;
    draft.value = result.content;
    savedContent.value = result.content;
    filePath.value = result.path;
    fileExists.value = result.exists;
  } catch (error) {
    if (generation === operationGeneration) loadError.value = errorMessage(error);
  } finally {
    if (generation === operationGeneration) loading.value = false;
  }
}

function openPage(origin?: EventTarget | null): void {
  page.open('globalAgentsMd', origin);
  void load();
}

async function onBack(): Promise<void> {
  if (saving.value || !(await confirmDiscard())) return;
  operationGeneration++;
  page.back();
  draft.value = '';
  savedContent.value = '';
}

function onDraftChange(value: string): void {
  draft.value = value;
  saveError.value = '';
}

async function onSave(): Promise<void> {
  if (!dirty.value || saving.value) return;
  const generation = operationGeneration;
  const content = draft.value;
  saving.value = true;
  saveError.value = '';
  try {
    const result = await client.writeGlobalAgentsMd(content);
    if (generation !== operationGeneration) return;
    savedContent.value = result.content;
    filePath.value = result.path;
    fileExists.value = result.exists;
    if (draft.value === content) {
      draft.value = result.content;
      client.notify({ severity: 'success', title: t('settings.globalAgentsMdSaved') });
    }
  } catch (error) {
    if (generation === operationGeneration) saveError.value = errorMessage(error);
  } finally {
    if (generation === operationGeneration) saving.value = false;
  }
}

onUnmounted(() => {
  operationGeneration++;
  emit('openChange', false);
  emit('dirtyChange', false);
});

defineExpose({ confirmDiscard, reset });
</script>

<template>
  <section v-if="!open" class="global-agents-md-section">
    <h3 class="global-agents-md-section-title">{{ t('settings.customInstructionsSection') }}</h3>
    <div class="global-agents-md-group">
      <button
        type="button"
        class="global-agents-md-row"
        data-settings-subpage-origin="globalAgentsMd"
        @click="openPage($event.currentTarget)"
      >
        <span class="settings-row-label">
          {{ t('settings.globalAgentsMdTitle') }}
          <span class="global-agents-md-hint">{{ t('settings.globalAgentsMdHint') }}</span>
        </span>
        <Icon name="chevron-right" size="md" />
      </button>
    </div>
  </section>

  <SettingsSubpage
    v-else
    :parent-title="t('settings.tabs.agent')"
    :title="t('settings.globalAgentsMdTitle')"
    :description="t('settings.globalAgentsMdDescription')"
    @back="onBack"
  >
    <div class="global-agents-md-path">
      <span class="global-agents-md-path-label">{{ t('settings.globalAgentsMdFilePath') }}</span>
      <code v-if="filePath" :title="filePath" dir="ltr">{{ filePath }}</code>
    </div>

    <div v-if="loading" class="global-agents-md-loading" role="status">
      <Spinner size="sm" />
      <span>{{ t('settings.globalAgentsMdLoading') }}</span>
    </div>
    <div v-else-if="loadError" class="global-agents-md-load-error">
      <div>
        <p role="alert">{{ t('settings.globalAgentsMdLoadFailed') }}</p>
        <p class="global-agents-md-error-detail">{{ loadError }}</p>
      </div>
      <Button variant="secondary" size="sm" @click="load">{{ t('settings.globalAgentsMdRetry') }}</Button>
    </div>
    <template v-else>
      <Textarea
        :model-value="draft"
        class="global-agents-md-editor"
        :rows="10"
        :aria-label="t('settings.globalAgentsMdTitle')"
        :placeholder="t('settings.globalAgentsMdPlaceholder')"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        @update:model-value="onDraftChange"
      />
      <div v-if="saveError" class="global-agents-md-save-error">
        <p role="alert">{{ t('settings.globalAgentsMdSaveFailed') }}</p>
        <p class="global-agents-md-error-detail">{{ saveError }}</p>
      </div>
      <div class="global-agents-md-footer">
        <span class="global-agents-md-status" role="status">{{ statusText }}</span>
        <Button variant="primary" size="sm" :disabled="!dirty || saving" @click="onSave">
          {{ t('settings.globalAgentsMdSave') }}
        </Button>
      </div>
    </template>
  </SettingsSubpage>
</template>

<style scoped>
.global-agents-md-section { padding: var(--space-4) 0; }
.global-agents-md-section-title {
  margin: 0 0 var(--space-3);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  letter-spacing: 0;
}
.global-agents-md-group {
  overflow: hidden;
  border-radius: var(--radius-xl);
  background: var(--color-surface);
}
.global-agents-md-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: 100%;
  min-height: 52px;
  padding: var(--space-4);
  border: none;
  background: transparent;
  color: var(--color-text);
  text-align: start;
  cursor: pointer;
}
.global-agents-md-row:hover { background: var(--color-hover); }
.global-agents-md-row:focus-visible { outline: none; box-shadow: inset var(--p-focus-ring); }
.global-agents-md-hint {
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  font-weight: var(--weight-regular);
  line-height: var(--leading-tight);
}
.global-agents-md-path {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
  margin-bottom: var(--space-3);
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
}
.global-agents-md-path-label { flex: none; }
.global-agents-md-path code {
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.global-agents-md-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 240px;
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
}
.global-agents-md-load-error {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-4);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}
.global-agents-md-load-error p,
.global-agents-md-save-error p {
  margin: 0;
  color: var(--color-danger);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}
.global-agents-md-load-error p.global-agents-md-error-detail,
.global-agents-md-save-error p.global-agents-md-error-detail { margin-top: var(--space-1); }
.global-agents-md-editor {
  min-height: 240px;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  tab-size: 2;
}
.global-agents-md-save-error { margin-top: var(--space-2); }
.global-agents-md-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: var(--space-6);
  margin-top: var(--space-3);
}
.global-agents-md-status {
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
}
@media (max-width: 640px) {
  .global-agents-md-row {
    align-items: flex-start;
  }
  .global-agents-md-editor { min-height: 200px; }
}
</style>
