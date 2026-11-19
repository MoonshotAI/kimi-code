<script setup lang="ts">
import { onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Dialog } from '@moonshot-ai/app-ui';

const props = withDefaults(defineProps<{
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'primary' | 'danger';
  loading?: boolean;
  initialFocus?: 'confirm' | 'cancel';
}>(), {
  variant: 'danger',
  initialFocus: 'confirm',
});

const emit = defineEmits<{
  'update:open': [value: boolean];
  confirm: [];
  cancel: [];
}>();

const { t } = useI18n();

function onCancel(): void {
  if (props.loading) return;
  emit('update:open', false);
  emit('cancel');
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || !props.open || props.loading) return;
  const target = event.target as HTMLElement | null;
  if (
    target instanceof HTMLButtonElement ||
    target instanceof HTMLAnchorElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLInputElement
  ) {
    return;
  }
  event.preventDefault();
  emit('confirm');
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onKeydown);
}
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <Dialog
    :open="open"
    :title="title"
    height="auto"
    :initial-focus="initialFocus === 'cancel' ? '.confirm-dialog__cancel' : '.confirm-dialog__confirm'"
    :close-on-esc="!loading"
    :close-on-overlay="!loading"
    @update:open="emit('update:open', $event)"
    @close="onCancel"
  >
    <p v-if="message" class="confirm-dialog__message">{{ message }}</p>
    <template #foot>
      <Button class="confirm-dialog__cancel" variant="secondary" :disabled="loading" @click="onCancel">
        {{ cancelLabel ?? t('common.cancel') }}
      </Button>
      <Button
        class="confirm-dialog__confirm"
        :variant="variant"
        :loading="loading"
        @click="emit('confirm')"
      >
        {{ confirmLabel ?? t('common.confirm') }}
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
.confirm-dialog__message {
  margin: 0;
  white-space: pre-line;
  overflow-wrap: anywhere;
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
}
</style>
