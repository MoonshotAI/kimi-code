<script setup lang="ts">
import './settings-row-label.css';
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { getKimiWebApi, toast } from '@moonshot-ai/app-client/client';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import { configStore } from '@moonshot-ai/app-client/stores';
import type { AppToolCatalogEntry, AppToolsConfig } from '@moonshot-ai/app-core/api';
import { isDefaultToolEnabled, setDefaultToolEnabled } from '@moonshot-ai/app-core/lib';
import { Button, Icon, Spinner, Switch } from '@moonshot-ai/app-ui';
import SettingsSubpage from './SettingsSubpage.vue';
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

const groups: ReadonlyArray<{ id: string; labelKey: string; names: readonly string[] }> = [
  { id: 'file', labelKey: 'settings.defaultToolsGroupFile', names: ['Read', 'ReadMediaFile', 'Write', 'Edit', 'Glob', 'Grep'] },
  { id: 'system', labelKey: 'settings.defaultToolsGroupSystem', names: ['Bash'] },
  { id: 'agent', labelKey: 'settings.defaultToolsGroupAgent', names: ['Agent', 'AgentSwarm', 'AskUserQuestion'] },
  { id: 'web', labelKey: 'settings.defaultToolsGroupWeb', names: ['FetchURL', 'WebSearch'] },
  { id: 'goal', labelKey: 'settings.defaultToolsGroupGoal', names: ['CreateGoal', 'GetGoal', 'SetGoalBudget', 'UpdateGoal'] },
  { id: 'tower', labelKey: 'settings.defaultToolsGroupTower', names: ['TowerInit', 'TowerPlan', 'TowerSpawn', 'TowerMerge', 'TowerRebase', 'TowerTeardown', 'TowerComplete', 'TowerSend', 'TowerInbox', 'TowerFinding', 'TowerReview', 'TowerMission', 'TowerStatus'] },
  { id: 'task', labelKey: 'settings.defaultToolsGroupTask', names: [] },
];

const groupedTools = computed(() => {
  const grouped = new Map<string, AppToolCatalogEntry[]>();
  for (const group of groups) grouped.set(group.id, []);
  for (const tool of tools.value) {
    const group = groups.find((candidate) => candidate.id !== 'task' && candidate.names.includes(tool.name)) ?? groups.at(-1)!;
    grouped.get(group.id)!.push(tool);
  }
  return groups
    .map((group) => ({ ...group, tools: grouped.get(group.id) ?? [] }))
    .filter((group) => group.tools.length > 0);
});

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

function resetDraft(config: AppToolsConfig | undefined): void {
  savedConfig.value = cloneConfig(config);
  draftConfig.value = cloneConfig(config);
}

watch(
  () => configStore().config,
  (config) => {
    if (config === null || config === undefined) return;
    if (!dirty.value && !saving.value) resetDraft(config.tools);
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
    :parent-title="t('settings.tabs.agent')"
    :title="t('settings.defaultTools')"
    :description="t('settings.defaultToolsHint')"
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
                  <span>{{ toolLabel(tool.name) }}</span>
                  <span class="dt-name">{{ tool.name }}</span>
                </span>
              </span>
              <Switch
                :model-value="enabledFor(tool.name)"
                :disabled="saving"
                :label="toolLabel(tool.name)"
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
.dt-list { padding-bottom: var(--space-3); }
.dt-section { margin-bottom: var(--space-4); }
.dt-group-title {
  margin: 0 0 var(--space-2);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--color-text-muted);
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
  color: var(--color-text);
}
.dt-name {
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
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
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: var(--space-6);
  margin-top: auto;
  padding: var(--space-3) 0 var(--space-1);
  border-top: var(--p-hairline) solid var(--color-line);
  background: var(--color-bg);
}
.dt-dirty {
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
</style>
