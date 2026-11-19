<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { Dialog, Kbd } from '@moonshot-ai/app-ui';

const props = defineProps<{
  open: boolean;
  busy?: boolean;
}>();

const emit = defineEmits<{
  trust: [];
  reject: [];
}>();

const { t } = useI18n();

function onKeydown(event: KeyboardEvent): void {
  if (!props.open || props.busy) return;
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    emit('trust');
  }
}

function onDialogClose(): void {
  if (!props.busy) emit('reject');
}

onMounted(() => document.addEventListener('keydown', onKeydown));
onUnmounted(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Dialog
    :open="open"
    size="md"
    :padded="false"
    hide-close
    :focus-on-open="false"
    :aria-label="t('workspace.trust.title')"
    @close="onDialogClose"
  >
    <div class="trust-text">
      <div class="trust-title">{{ t('workspace.trust.title') }}</div>
      <div class="trust-desc">{{ t('workspace.trust.desc') }}</div>
    </div>
    <div class="trust-options">
      <button type="button" class="trust-opt primary" :disabled="busy" @click="emit('trust')">
        <span class="opt-key">A.</span>
        <span class="opt-label">{{ t('workspace.trust.trustAction') }}</span>
        <Kbd class="opt-shortcut" :keys="['mod', 'enter']" />
      </button>
      <button type="button" class="trust-opt" :disabled="busy" @click="emit('reject')">
        <span class="opt-key">B.</span>
        <span class="opt-label">{{ t('workspace.trust.rejectAction') }}</span>
      </button>
    </div>
  </Dialog>
</template>

<style scoped>
.trust-text {
  padding: var(--space-5) var(--space-6) var(--space-4);
}

.trust-title {
  font-size: var(--text-lg);
  font-weight: var(--weight-ui-strong);
  color: var(--color-text);
}

.trust-desc {
  margin-top: var(--space-2);
  font-size: var(--text-base);
  line-height: 1.6;
  color: var(--color-text-muted);
}

.trust-options {
  display: flex;
  flex-direction: column;
  gap: var(--space-05);
  padding: var(--space-1-5);
  border-top: var(--p-hairline) solid var(--color-subtle);
}

.trust-opt {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  border: none;
  background: transparent;
  border-radius: var(--radius-lg);
  padding: var(--space-2) var(--space-3);
  font-family: var(--font-ui);
  font-size: var(--ui-b2);
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
}

.trust-opt:hover:not(:disabled) {
  background: var(--color-hover);
}

.trust-opt.primary {
  background: var(--color-fill-2);
}

.trust-opt.primary:hover:not(:disabled) {
  background: var(--color-selected-hover);
}

.trust-opt:disabled {
  opacity: 0.5;
  cursor: default;
}

.opt-key {
  flex: none;
  width: var(--space-4);
  font-size: var(--ui-b2);
  color: var(--color-text-faint);
}

.opt-label {
  flex: 1;
  min-width: 0;
}

.opt-shortcut {
  flex: none;
  color: var(--color-text-faint);
}
</style>
