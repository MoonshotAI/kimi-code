<script setup lang="ts">
import './settings-row-label.css';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { getKimiWebApi, toast } from '@moonshot-ai/app-client/client';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import { configStore, hostsStore } from '@moonshot-ai/app-client/stores';
import type { AppToolCatalogEntry, AppToolsConfig } from '@moonshot-ai/app-core/api';
import { isDefaultToolEnabled, rebaseDefaultToolsConfig, setDefaultToolEnabled } from '@moonshot-ai/app-core/lib';
import { Button, Icon, Spinner, Switch } from '@moonshot-ai/app-ui';
import SettingsSubpage from './SettingsSubpage.vue';
import { defaultToolLabelKey, groupDefaultTools } from './defaultToolsCatalog';
import { toolIconName, toolLabel } from '../lib/toolMeta';

const emit = defineEmits<{ back: [] }>();
const { t } = useI18n();
const { confirm } = useConfirmDialog();
const tools = ref<AppToolCatalogEntry[]>([]);
const loading = ref(true);
const loadFailed = ref(false);
const saving = ref(false);
const saveFailed = ref(false);
const savedConfig = ref<AppToolsConfig>({});
const draftConfig = ref<AppToolsConfig>({});
const groupedTools = computed(() => groupDefaultTools(tools.value));

function cloneConfig(config: AppToolsConfig | undefined): AppToolsConfig {
  return {
    enabled: config?.enabled === undefined ? undefined : [...config.enabled],
    disabled: config?.disabled === undefined ? undefined : [...config.disabled],
  };
}

function configKey(config: AppToolsConfig): string {
  return JSON.stringify({
    enabled: config.enabled === undefined ? null : [...config.enabled].toSorted(),
    disabled: config.disabled === undefined ? null : [...config.disabled].toSorted(),
  });
}

const dirty = computed(() => configKey(savedConfig.value) !== configKey(draftConfig.value));
const hasConfig = computed(() => configStore().config !== null && configStore().config !== undefined);
const hasRemoteHosts = computed(() => hostsStore().hosts.length > 0);

function resetDraft(config: AppToolsConfig | undefined): void {
  savedConfig.value = cloneConfig(config);
  draftConfig.value = cloneConfig(config);
}

watch(
  () => configStore().config,
  (config) => {
    if (config === null || config === undefined || saving.value) return;
    if (!dirty.value) {
      resetDraft(config.tools);
      return;
    }
    draftConfig.value = rebaseDefaultToolsConfig(savedConfig.value, draftConfig.value, config.tools);
    savedConfig.value = cloneConfig(config.tools);
    saveFailed.value = false;
  },
  { immediate: true },
);

async function load(): Promise<void> {
  loading.value = true;
  loadFailed.value = false;
  try {
    const [catalog] = await Promise.all([
      getKimiWebApi().listToolCatalog(),
      configStore().loadConfig(),
    ]);
    if (!hasConfig.value) {
      loadFailed.value = true;
      return;
    }
    tools.value = catalog;
  } catch {
    loadFailed.value = true;
  } finally {
    loading.value = false;
  }
}

function enabledFor(name: string): boolean {
  return isDefaultToolEnabled(draftConfig.value, name);
}

function displayLabel(name: string): string {
  const key = defaultToolLabelKey(name);
  return key === undefined ? toolLabel(name) : t(key);
}

function setEnabled(name: string, enabled: boolean): void {
  if (saving.value || !hasConfig.value) return;
  draftConfig.value = setDefaultToolEnabled(draftConfig.value, name, enabled);
  saveFailed.value = false;
}

async function save(): Promise<void> {
  if (!dirty.value || saving.value || !hasConfig.value) return;
  saving.value = true;
  saveFailed.value = false;
  const next = cloneConfig(draftConfig.value);
  const saved = await configStore().updateConfig({ tools: next });
  saving.value = false;
  if (saved) {
    resetDraft(next);
    toast({ layout: 'bar', mode: 'replace', variant: 'success', title: t('settings.defaultToolsSaved') });
  } else {
    saveFailed.value = true;
  }
}

async function confirmDiscard(): Promise<boolean> {
  if (saving.value) return false;
  if (!dirty.value) return true;
  return await confirm({
    title: t('settings.defaultToolsDiscardTitle'),
    message: t('settings.defaultToolsDiscardMessage'),
    confirmLabel: t('settings.defaultToolsDiscardConfirm'),
    variant: 'danger',
    initialFocus: 'cancel',
  });
}

async function requestBack(): Promise<void> {
  if (!(await confirmDiscard())) return;
  draftConfig.value = cloneConfig(savedConfig.value);
  emit('back');
}

onMounted(() => {
  void load();
});

defineExpose({ confirmDiscard });
</script>

<template>
  <SettingsSubpage
    class="dt-subpage"
    :parent-title="t('settings.tabs.agent')"
    :title="t('settings.defaultTools')"
    :description="t(hasRemoteHosts ? 'settings.defaultToolsHintLocalOnly' : 'settings.defaultToolsHint')"
    @back="requestBack"
  >
    <div v-if="loading" class="dt-status" role="status">
      <Spinner size="sm" />
      <span>{{ t('settings.defaultToolsLoading') }}</span>
    </div>
    <div v-else-if="loadFailed || !hasConfig" class="dt-status" role="alert">
      <span>{{ t('settings.defaultToolsLoadFailed') }}</span>
      <Button variant="secondary" size="sm" @click="load">{{ t('settings.defaultToolsRetry') }}</Button>
    </div>
    <div v-else-if="tools.length === 0" class="dt-status">
      {{ t('settings.defaultToolsEmpty') }}
    </div>
    <template v-else>
      <div class="dt-list">
        <section v-for="group in groupedTools" :key="group.id" class="dt-section">
          <h4 class="dt-group-title">{{ t(group.labelKey) }}</h4>
          <div class="settings-group">
            <div v-for="tool in group.tools" :key="tool.name" class="row">
              <span class="dt-label">
                <Icon :name="toolIconName(tool.name)" size="md" />
                <span class="settings-row-label dt-text">
                  <span>{{ displayLabel(tool.name) }}</span>
                  <span class="dt-name">{{ tool.name }}</span>
                </span>
              </span>
              <Switch
                :model-value="enabledFor(tool.name)"
                :disabled="saving"
                :label="displayLabel(tool.name)"
                @update:model-value="setEnabled(tool.name, $event)"
              />
            </div>
          </div>
        </section>
      </div>
      <p v-if="saveFailed" class="dt-error" role="alert">{{ t('settings.defaultToolsSaveFailed') }}</p>
    </template>

    <div class="dt-footer">
      <span class="dt-dirty" role="status">{{ dirty ? t('settings.defaultToolsUnsaved') : '' }}</span>
      <Button variant="primary" size="sm" :disabled="!hasConfig || !dirty || saving" :loading="saving" @click="save">
        {{ saving ? t('settings.defaultToolsSaving') : t('settings.defaultToolsSave') }}
      </Button>
    </div>
  </SettingsSubpage>
</template>

<style scoped src="./settings-common.css"></style>

<style scoped>
.dt-subpage.settings-subpage { padding-bottom: 0; }
.dt-list { padding-bottom: var(--space-3); }
.dt-section { margin-bottom: var(--space-4); }
.dt-group-title {
  margin: 0 0 var(--space-2);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  font-weight: var(--weight-medium);
  color: var(--color-text-muted);
}
.settings-group > .row {
  min-height: 44px;
  padding: var(--space-2) var(--space-4);
}
.settings-group > .row:hover { background: var(--color-hover); }
.dt-label {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  color: var(--color-text-muted);
}
.dt-text {
  min-width: 0;
  line-height: var(--leading-tight);
  color: var(--color-text);
}
.dt-name {
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  font-weight: var(--weight-regular);
  color: var(--color-text-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dt-status {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 52px;
  padding: var(--space-4);
  border-radius: var(--radius-xl);
  background: var(--color-surface);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}
.dt-error {
  margin: 0 0 var(--space-3);
  color: var(--color-danger);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
}
.dt-footer {
  position: sticky;
  bottom: calc(-1 * var(--space-5));
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: var(--space-6);
  margin: auto 0 calc(-1 * var(--space-5));
  padding: var(--space-3) 0 var(--space-5);
  border-top: var(--p-hairline) solid var(--color-line);
  background: var(--color-bg);
}
.dt-dirty {
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
</style>
