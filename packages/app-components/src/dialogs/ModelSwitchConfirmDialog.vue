<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Button, Dialog } from '@moonshot-ai/app-ui';
import type { ModelSwitchAction } from '@moonshot-ai/app-core/lib';

const props = defineProps<{
  open: boolean;
  sessionType: 'old' | 'new';
  kind?: 'model' | 'effort';
  toModel?: string;
  fromEffort?: string;
  toEffort?: string;
  hint?: string;
  warning?: string;
}>();

const emit = defineEmits<{
  select: [action: ModelSwitchAction];
}>();

const { t } = useI18n();

const OLD_SESSION_OPTIONS: readonly { action: ModelSwitchAction; titleKey: string; descriptionKey: string }[] = [
  { action: 'compact', titleKey: 'model.switchConfirmCompact', descriptionKey: 'model.switchConfirmCompactDesc' },
  { action: 'continue', titleKey: 'model.switchConfirmContinue', descriptionKey: 'model.switchConfirmContinueDesc' },
];

function choose(action: ModelSwitchAction): void {
  emit('select', action);
}
</script>

<template>
  <Dialog
    :open="open"
    size="sm"
    :title="props.kind === 'effort'
      ? t('model.switchEffortConfirmTitle', { from: props.fromEffort, to: props.toEffort })
      : t('model.switchConfirmTitle')"
    height="auto"
    panel-class="model-switch-confirm-dialog"
    :initial-focus="props.kind === 'effort' || props.sessionType === 'new' ? '.model-switch-confirm__confirm' : '.model-switch-confirm__cancel'"
    @close="choose('cancel')"
  >
    <div class="model-switch-confirm">
      <p v-if="props.kind !== 'effort' && props.sessionType === 'old' && props.toModel" class="model-switch-confirm__prompt">
        {{ t('model.switchConfirmPrompt', { model: props.toModel }) }}
      </p>
      <p v-if="hint" class="model-switch-confirm__hint">{{ hint }}</p>
      <p v-if="warning" class="model-switch-confirm__warning">{{ warning }}</p>
      <div v-if="props.kind !== 'effort' && props.sessionType === 'old'" class="model-switch-confirm__options">
        <button
          v-for="option in OLD_SESSION_OPTIONS"
          :key="option.action"
          class="model-switch-confirm__option"
          type="button"
          @click="choose(option.action)"
        >
          <span class="model-switch-confirm__option-title">{{ t(option.titleKey) }}</span>
          <span class="model-switch-confirm__option-desc">{{ t(option.descriptionKey) }}</span>
        </button>
      </div>
    </div>
    <template #foot>
      <div class="model-switch-confirm__foot">
        <Button
          variant="secondary"
          :class="props.kind === 'effort' || props.sessionType === 'new' ? undefined : 'model-switch-confirm__cancel'"
          @click="choose('cancel')"
        >
          {{ t('model.switchConfirmCancel') }}
        </Button>
        <Button
          v-if="props.kind === 'effort' || props.sessionType === 'new'"
          class="model-switch-confirm__confirm"
          variant="primary"
          @click="choose('continue')"
        >
          {{ t('model.switchConfirmConfirm') }}
        </Button>
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
:global(.model-switch-confirm-dialog) {
  border-radius: 16px;
}
:global(.model-switch-confirm-dialog .ui-dialog__head) {
  padding: 24px 24px 0;
}
:global(.model-switch-confirm-dialog .ui-dialog__body) {
  padding: 16px 24px 0;
}
:global(.model-switch-confirm-dialog .ui-dialog__foot) {
  padding: 16px 24px 24px;
  border-top: none;
}
.model-switch-confirm {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.model-switch-confirm__prompt,
.model-switch-confirm__hint,
.model-switch-confirm__warning {
  margin: 0;
  font-size: var(--text-base);
  line-height: calc(20px + var(--ui-shift));
  white-space: pre-line;
  overflow-wrap: anywhere;
}
.model-switch-confirm__prompt {
  color: var(--color-text);
}
.model-switch-confirm__hint {
  color: var(--color-text-muted);
}
.model-switch-confirm__warning {
  color: var(--color-warning);
  font-weight: var(--weight-medium);
}
.model-switch-confirm__prompt + .model-switch-confirm__hint,
.model-switch-confirm__prompt + .model-switch-confirm__warning {
  margin-top: -8px;
}
.model-switch-confirm__options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.model-switch-confirm__option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: 10px 12px;
  border: var(--p-hairline) solid var(--color-line-strong);
  border-radius: 8px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.model-switch-confirm__option:hover {
  background: var(--color-hover);
}
.model-switch-confirm__option-title {
  font-size: var(--text-base);
  font-weight: var(--weight-regular);
  line-height: calc(20px + var(--ui-shift));
  color: var(--color-text);
}
.model-switch-confirm__option-desc {
  font-size: var(--text-xs);
  line-height: calc(18px + var(--ui-shift));
  color: var(--color-text-faint);
}
.model-switch-confirm__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  width: 100%;
}
</style>
