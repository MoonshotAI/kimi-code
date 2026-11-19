<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Dialog, Icon } from '@moonshot-ai/app-ui';
import type { ModelSwitchAction } from '@moonshot-ai/app-core/lib';

defineProps<{
  open: boolean;
  hint?: string;
}>();

const emit = defineEmits<{
  select: [action: ModelSwitchAction];
}>();

const { t } = useI18n();

const OPTIONS: readonly { action: ModelSwitchAction; titleKey: string; descriptionKey: string }[] = [
  { action: 'new', titleKey: 'model.switchConfirmNew', descriptionKey: 'model.switchConfirmNewDesc' },
  { action: 'compact', titleKey: 'model.switchConfirmCompact', descriptionKey: 'model.switchConfirmCompactDesc' },
  { action: 'continue', titleKey: 'model.switchConfirmContinue', descriptionKey: 'model.switchConfirmContinueDesc' },
];

function choose(action: ModelSwitchAction): void {
  emit('select', action);
}
</script>

<template>
  <Dialog :open="open" :title="t('model.switchConfirmTitle')" height="auto" :padded="false" @close="choose('cancel')">
    <div class="model-switch-confirm">
      <p v-if="hint" class="model-switch-confirm__hint">{{ hint }}</p>
      <div class="model-switch-confirm__options">
        <button
          v-for="option in OPTIONS"
          :key="option.action"
          class="model-switch-confirm__option"
          type="button"
          @click="choose(option.action)"
        >
          <span class="model-switch-confirm__option-copy">
            <span class="model-switch-confirm__option-title">{{ t(option.titleKey) }}</span>
            <span class="model-switch-confirm__option-desc">{{ t(option.descriptionKey) }}</span>
          </span>
          <Icon name="chevron-right" size="md" class="model-switch-confirm__option-chevron" />
        </button>
        <div class="model-switch-confirm__separator" role="separator" />
        <button class="model-switch-confirm__option" type="button" @click="choose('cancel')">
          <span class="model-switch-confirm__option-copy">
            <span class="model-switch-confirm__option-title">{{ t('model.switchConfirmCancel') }}</span>
            <span class="model-switch-confirm__option-desc">{{ t('model.switchConfirmCancelDesc') }}</span>
          </span>
          <Icon name="chevron-right" size="md" class="model-switch-confirm__option-chevron" />
        </button>
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
.model-switch-confirm {
  display: flex;
  flex-direction: column;
}
.model-switch-confirm__hint {
  margin: 0 var(--dialog-pad-x) var(--space-2);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
  white-space: pre-line;
  overflow-wrap: anywhere;
}
.model-switch-confirm__options {
  padding: 0 var(--space-3) var(--space-3);
}
.model-switch-confirm__option {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  width: 100%;
  padding: calc(var(--space-2) + var(--space-05));
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.model-switch-confirm__option + .model-switch-confirm__option {
  border-top: var(--p-hairline) solid var(--color-line);
}
.model-switch-confirm__option:hover {
  background: var(--color-hover);
}
.model-switch-confirm__option-copy {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-05);
  min-width: 0;
}
.model-switch-confirm__option-title {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  line-height: var(--leading-caption);
  color: var(--color-text);
}
.model-switch-confirm__option-desc {
  font-size: var(--text-sm);
  line-height: var(--leading-caption);
  color: var(--color-text-muted);
}
.model-switch-confirm__option-chevron {
  flex: none;
  margin-top: var(--space-05);
  color: var(--color-text-faint);
}
.model-switch-confirm__option:hover .model-switch-confirm__option-chevron {
  color: var(--color-text);
}
.model-switch-confirm__separator {
  height: var(--p-hairline);
  margin: 0 calc(var(--space-2) + var(--space-05));
  background: var(--color-line);
}
</style>
