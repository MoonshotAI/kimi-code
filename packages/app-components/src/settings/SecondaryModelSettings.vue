<script setup lang="ts">
import './settings-common.css';
import './settings-row-label.css';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Checkbox, Input, SegmentedControl, Select, Textarea } from '@moonshot-ai/app-ui';
import type { AppConfig } from '@moonshot-ai/app-core/api';
import {
  buildAllModelsSecondaryConfig,
  buildFixedSecondaryModelConfig,
  buildSelectedModelsSecondaryConfig,
  effortLabel,
  providerDisplayName,
  readSecondaryModelEntry,
  resolveSecondaryModelAutoScope,
  resolveSecondaryModelMode,
  segmentsFor,
  type ModelThinkingInfo,
  type SecondaryModelAutoScope,
  type SecondaryModelMode,
  type SecondaryModelRulePreset,
} from '@moonshot-ai/app-core/lib';
import SecondaryModelPicker, { type SecondaryModelGroup } from './SecondaryModelPicker.vue';

const props = withDefaults(defineProps<{
  config: AppConfig['secondaryModel'];
  defaultModel?: string;
  groups: SecondaryModelGroup[];
  modelInfoById: Record<string, ModelThinkingInfo>;
  localOnly?: boolean;
}>(), {
  localOnly: false,
});

const emit = defineEmits<{
  update: [value: AppConfig['secondaryModel']];
}>();

const { t } = useI18n();

const TEXT_DEBOUNCE_MS = 300;

interface EntryDraft {
  description: string;
  effort: string;
}

const mode = ref<SecondaryModelMode>('follow');
const fixedModel = ref('');
const fixedEffort = ref('');
const autoScope = ref<SecondaryModelAutoScope>('all');
const rule = ref('');
const explicitCustomRule = ref(false);
const selectedEntries = ref<Record<string, EntryDraft>>({});
const poolDefaultModel = ref('');
const ruleTextareaRef = ref<InstanceType<typeof Textarea> | null>(null);

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastEmittedSignature: string | null = null;

const flatModels = computed(() => props.groups.flatMap((group) => group.options));
const flatModelIds = computed(() => flatModels.value.map((option) => option.id));

const costRuleText = computed(() => t('settings.secondaryModelRuleTextCost'));
const speedRuleText = computed(() => t('settings.secondaryModelRuleTextSpeed'));

const modeOptions = computed(() => [
  { value: 'follow', label: t('settings.secondaryModelModeFollow') },
  { value: 'fixed', label: t('settings.secondaryModelModeFixed') },
  { value: 'auto', label: t('settings.secondaryModelModeAuto') },
]);

const rulePresetOptions = computed(() => [
  { value: 'cost', label: t('settings.secondaryModelRulePresetCost') },
  { value: 'speed', label: t('settings.secondaryModelRulePresetSpeed') },
  { value: 'custom', label: t('settings.secondaryModelRulePresetCustom') },
]);

const scopeOptions = computed(() => [
  { value: 'all', label: t('settings.secondaryModelScopeAll') },
  { value: 'selected', label: t('settings.secondaryModelScopeSelected') },
]);

const activeRulePreset = computed<SecondaryModelRulePreset>(() => {
  if (explicitCustomRule.value) return 'custom';
  const trimmed = rule.value.trim();
  if (trimmed === costRuleText.value) return 'cost';
  if (trimmed === speedRuleText.value) return 'speed';
  return 'custom';
});

const selectedAliases = computed(() => Object.keys(selectedEntries.value));
const selectedCount = computed(() => selectedAliases.value.length);

const showEmptyHintsTip = computed(() => {
  if (mode.value !== 'auto' || autoScope.value !== 'selected' || selectedCount.value < 2) {
    return false;
  }
  return selectedAliases.value.every(
    (alias) => (selectedEntries.value[alias]?.description ?? '').trim().length === 0,
  );
});

const summaryText = computed(() => {
  if (mode.value === 'follow') return t('settings.secondaryModelSummaryFollow');
  if (mode.value === 'fixed') return t('settings.secondaryModelSummaryFixed');
  if (autoScope.value === 'all') return t('settings.secondaryModelSummaryAutoAll');
  if (selectedCount.value === 0) return t('settings.secondaryModelSummaryAutoSelectedEmpty');
  return t('settings.secondaryModelSummaryAutoSelected', { count: selectedCount.value });
});

const isSummaryWarning = computed(
  () => mode.value === 'auto' && autoScope.value === 'selected' && selectedCount.value === 0,
);

function signatureOf(value: AppConfig['secondaryModel']): string {
  return JSON.stringify(value ?? null);
}

function clearPendingDebounce(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function defaultCandidateModel(): string {
  if (props.defaultModel && flatModelIds.value.includes(props.defaultModel)) {
    return props.defaultModel;
  }
  return flatModelIds.value[0] ?? '';
}

function syncFromConfig(next: AppConfig['secondaryModel']): void {
  const sig = signatureOf(next);
  if (lastEmittedSignature !== null && sig === lastEmittedSignature) {
    lastEmittedSignature = null;
    return;
  }
  lastEmittedSignature = null;
  clearPendingDebounce();

  const resolvedMode = resolveSecondaryModelMode(next);
  mode.value = resolvedMode;
  if (!next) return;

  if (resolvedMode === 'fixed') {
    fixedModel.value = next.defaultModel ?? next.model ?? '';
    fixedEffort.value = next.defaultEffort ?? '';
    return;
  }

  autoScope.value = resolveSecondaryModelAutoScope(next);
  rule.value = next.rule ?? '';
  explicitCustomRule.value = false;
  if (next.models !== undefined) {
    const entries: Record<string, EntryDraft> = {};
    for (const [alias, raw] of Object.entries(next.models)) {
      const parsed = readSecondaryModelEntry(raw);
      entries[alias] = { description: parsed.description, effort: parsed.effort };
    }
    selectedEntries.value = entries;
    poolDefaultModel.value = next.defaultModel ?? Object.keys(entries)[0] ?? '';
  }
}

watch(() => props.config, syncFromConfig, { immediate: true, deep: true });

function emitConfig(next: AppConfig['secondaryModel']): void {
  clearPendingDebounce();
  const sig = signatureOf(next);
  if (sig === signatureOf(props.config)) return;
  lastEmittedSignature = sig;
  emit('update', next);
}

function buildCurrentAutoPayload(): AppConfig['secondaryModel'] | undefined {
  if (autoScope.value === 'all') {
    return buildAllModelsSecondaryConfig(rule.value);
  }
  const built = buildSelectedModelsSecondaryConfig({
    defaultModel: poolDefaultModel.value || undefined,
    entries: selectedEntries.value,
    rule: rule.value,
  });
  return built === null ? undefined : built;
}

function emitCurrentAutoNow(): void {
  if (mode.value !== 'auto') return;
  const payload = buildCurrentAutoPayload();
  if (payload !== undefined) emitConfig(payload);
}

function scheduleAutoEmit(): void {
  clearPendingDebounce();
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    emitCurrentAutoNow();
  }, TEXT_DEBOUNCE_MS);
}

function flushAutoEmit(): void {
  if (debounceTimer !== null) {
    clearPendingDebounce();
    emitCurrentAutoNow();
  }
}

onBeforeUnmount(() => {
  flushAutoEmit();
});

function onModeChange(next: string): void {
  const target = next as SecondaryModelMode;
  if (target === mode.value) return;
  flushAutoEmit();
  mode.value = target;

  if (target === 'follow') {
    emitConfig(null);
    return;
  }

  if (target === 'fixed') {
    if (!fixedModel.value || !flatModelIds.value.includes(fixedModel.value)) {
      fixedModel.value = defaultCandidateModel();
      fixedEffort.value = '';
    }
    if (fixedModel.value) {
      emitConfig(
        buildFixedSecondaryModelConfig({
          model: fixedModel.value,
          effort: fixedEffort.value || undefined,
        }),
      );
    }
    return;
  }

  if (rule.value.trim().length === 0) {
    rule.value = costRuleText.value;
    explicitCustomRule.value = false;
  }
  if (autoScope.value === 'selected' && selectedCount.value === 0) {
    const initial = defaultCandidateModel();
    if (initial) {
      selectedEntries.value = { [initial]: { description: '', effort: '' } };
      poolDefaultModel.value = initial;
    }
  }
  emitCurrentAutoNow();
}

function onFixedSelect(choice: { model: string | null; effort?: string }): void {
  if (choice.model === null) {
    onModeChange('follow');
    return;
  }
  fixedModel.value = choice.model;
  fixedEffort.value = choice.effort ?? '';
  emitConfig(buildFixedSecondaryModelConfig({ model: choice.model, effort: choice.effort }));
}

function onRulePresetChange(next: string): void {
  const preset = next as SecondaryModelRulePreset;
  if (preset === 'cost') {
    explicitCustomRule.value = false;
    rule.value = costRuleText.value;
    emitCurrentAutoNow();
    return;
  }
  if (preset === 'speed') {
    explicitCustomRule.value = false;
    rule.value = speedRuleText.value;
    emitCurrentAutoNow();
    return;
  }
  explicitCustomRule.value = true;
  void nextTick(() => {
    const el = ruleTextareaRef.value?.$el?.querySelector?.('textarea') as HTMLTextAreaElement | null | undefined;
    el?.focus();
  });
}

function onRuleInput(value: string): void {
  rule.value = value;
  const trimmed = value.trim();
  if (trimmed === costRuleText.value || trimmed === speedRuleText.value) {
    explicitCustomRule.value = false;
  } else {
    explicitCustomRule.value = true;
  }
  scheduleAutoEmit();
}

function onScopeChange(next: string): void {
  const target = next as SecondaryModelAutoScope;
  if (target === autoScope.value) return;
  flushAutoEmit();
  autoScope.value = target;
  if (target === 'selected' && selectedCount.value === 0) {
    const initial = defaultCandidateModel();
    if (initial) {
      selectedEntries.value = { [initial]: { description: '', effort: '' } };
      poolDefaultModel.value = initial;
    }
  }
  emitCurrentAutoNow();
}

function isModelSelected(alias: string): boolean {
  return Object.hasOwn(selectedEntries.value, alias);
}

function effortOptionsFor(alias: string): Array<{ value: string; label: string }> {
  const segments = segmentsFor(props.modelInfoById[alias]);
  if (segments.length <= 1) return [];
  const options = [
    { value: '', label: t('settings.secondaryModelEffortAuto') },
    ...segments.map((segment) => ({ value: segment, label: effortLabel(segment) })),
  ];
  const current = selectedEntries.value[alias]?.effort ?? '';
  if (current && !segments.includes(current)) {
    options.push({ value: current, label: effortLabel(current) });
  }
  return options;
}

function onModelToggle(alias: string, checked: boolean): void {
  const next = { ...selectedEntries.value };
  if (checked) {
    next[alias] = next[alias] ?? { description: '', effort: '' };
    if (!poolDefaultModel.value || !Object.hasOwn(next, poolDefaultModel.value)) {
      poolDefaultModel.value = alias;
    }
  } else {
    delete next[alias];
    if (poolDefaultModel.value === alias) {
      poolDefaultModel.value = Object.keys(next)[0] ?? '';
    }
  }
  selectedEntries.value = next;
  emitCurrentAutoNow();
}

function onEntryEffortChange(alias: string, effort: string): void {
  const current = selectedEntries.value[alias];
  if (!current || current.effort === effort) return;
  selectedEntries.value = {
    ...selectedEntries.value,
    [alias]: { ...current, effort },
  };
  emitCurrentAutoNow();
}

function onEntryDescriptionInput(alias: string, description: string): void {
  const current = selectedEntries.value[alias];
  if (!current) return;
  selectedEntries.value = {
    ...selectedEntries.value,
    [alias]: { ...current, description },
  };
  scheduleAutoEmit();
}
</script>

<template>
  <section class="sec">
    <div class="sec-head">
      <h3 class="sec-title">{{ t('settings.secondaryModelSection') }}</h3>
    </div>

    <div class="settings-group">
      <div class="row sm-row-wrap">
        <span class="rlabel">
          {{ t('settings.secondaryModel') }}
          <span class="hint">{{ t(localOnly ? 'settings.secondaryModelHintLocalOnly' : 'settings.secondaryModelHint') }}</span>
        </span>
        <SegmentedControl
          :model-value="mode"
          :options="modeOptions"
          :aria-label="t('settings.secondaryModel')"
          @update:model-value="onModeChange"
        />
      </div>

      <div v-if="mode === 'fixed'" class="row">
        <span class="rlabel">{{ t('settings.secondaryModelFixedLabel') }}</span>
        <div v-if="groups.length > 0" class="select-wrap">
          <SecondaryModelPicker
            :model-value="fixedModel"
            :effort="fixedEffort"
            :groups="groups"
            :model-info-by-id="modelInfoById"
            :allow-follow-default="false"
            @select="onFixedSelect"
          />
        </div>
        <span v-else class="rvalue mono">{{ fixedModel || t('settings.noSecondaryModel') }}</span>
      </div>

      <template v-if="mode === 'auto'">
        <div class="sm-block">
          <div class="sm-block-head">
            <span class="rlabel">{{ t('settings.secondaryModelRuleLabel') }}</span>
            <SegmentedControl
              :model-value="activeRulePreset"
              :options="rulePresetOptions"
              :aria-label="t('settings.secondaryModelRuleLabel')"
              @update:model-value="onRulePresetChange"
            />
          </div>
          <Textarea
            ref="ruleTextareaRef"
            :model-value="rule"
            :rows="2"
            :autosize="true"
            size="sm"
            :placeholder="t('settings.secondaryModelRulePlaceholder')"
            :aria-label="t('settings.secondaryModelRuleLabel')"
            @update:model-value="onRuleInput"
            @blur="flushAutoEmit"
          />
        </div>

        <div class="sm-block">
          <div class="sm-block-head">
            <span class="rlabel">{{ t('settings.secondaryModelScopeLabel') }}</span>
            <SegmentedControl
              :model-value="autoScope"
              :options="scopeOptions"
              :aria-label="t('settings.secondaryModelScopeLabel')"
              @update:model-value="onScopeChange"
            />
          </div>

          <div v-if="autoScope === 'selected' && groups.length > 0" class="sm-pool">
            <div v-for="group in groups" :key="group.provider" class="sm-pool-group">
              <div class="sm-pool-provider">{{ providerDisplayName(group.provider, t) }}</div>
              <div
                v-for="option in group.options"
                :key="option.id"
                class="sm-pool-item"
                :class="{ 'is-selected': isModelSelected(option.id) }"
              >
                <div class="sm-pool-item-head">
                  <Checkbox
                    :model-value="isModelSelected(option.id)"
                    @update:model-value="onModelToggle(option.id, $event)"
                  >
                    <span class="sm-pool-model-name">{{ option.label }}</span>
                  </Checkbox>
                  <div
                    v-if="isModelSelected(option.id) && effortOptionsFor(option.id).length > 0"
                    class="sm-pool-effort"
                  >
                    <Select
                      size="sm"
                      :model-value="selectedEntries[option.id]?.effort ?? ''"
                      :options="effortOptionsFor(option.id)"
                      :aria-label="`${option.label} ${t('settings.secondaryModelEffort')}`"
                      @update:model-value="onEntryEffortChange(option.id, $event)"
                    />
                  </div>
                </div>
                <div v-if="isModelSelected(option.id)" class="sm-pool-item-desc">
                  <Input
                    size="sm"
                    :model-value="selectedEntries[option.id]?.description ?? ''"
                    :placeholder="t('settings.secondaryModelEntryHintPlaceholder')"
                    :aria-label="option.label"
                    @update:model-value="onEntryDescriptionInput(option.id, $event)"
                    @blur="flushAutoEmit"
                  />
                </div>
              </div>
            </div>

            <div v-if="showEmptyHintsTip" class="sm-tip">
              {{ t('settings.secondaryModelEmptyHintsTip') }}
            </div>
          </div>
        </div>
      </template>

      <div class="sm-summary" :class="{ 'is-warning': isSummaryWarning }">
        {{ summaryText }}
      </div>
    </div>
  </section>
</template>

<style scoped>
.sm-row-wrap {
  flex-wrap: wrap;
}
.sm-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border-top: var(--p-hairline) solid var(--color-line);
}
.sm-block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.sm-pool {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.sm-pool-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.sm-pool-provider {
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--color-text-faint);
}
.sm-pool-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
  background: transparent;
  transition: border-color var(--duration-base) var(--ease-out),
    background-color var(--duration-base) var(--ease-out);
}
.sm-pool-item.is-selected {
  border-color: var(--color-line-strong);
  background: var(--color-surface-raised);
}
.sm-pool-item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 28px;
}
.sm-pool-model-name {
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-text);
}
.sm-pool-effort {
  min-width: 112px;
  max-width: 148px;
  flex: none;
}
.sm-pool-item-desc {
  padding-left: 25px;
}
.sm-tip {
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
.sm-summary {
  padding: var(--space-3) var(--space-4);
  border-top: var(--p-hairline) solid var(--color-line);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
}
.sm-summary.is-warning {
  color: var(--color-warn, var(--color-danger));
}
</style>
