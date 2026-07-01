<!-- apps/kimi-web/src/components/dialogs/ConfirmDialog.vue -->
<!-- Design-system §03 modal confirmation: a thin wrapper over the canonical
     Dialog (height auto, right-aligned footer). The single confirmation surface
     for user actions — driven app-wide by useConfirmDialog(). -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';

withDefaults(defineProps<{
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** primary = confirm/neutral action; danger = destructive (default). */
  variant?: 'primary' | 'danger';
  loading?: boolean;
}>(), {
  variant: 'danger',
});

const emit = defineEmits<{
  'update:open': [value: boolean];
  confirm: [];
  cancel: [];
}>();

const { t } = useI18n();

function onCancel(): void {
  emit('update:open', false);
  emit('cancel');
}
</script>

<template>
  <Dialog
    :open="open"
    :title="title"
    height="auto"
    @update:open="emit('update:open', $event)"
    @close="onCancel"
  >
    <p v-if="message" class="confirm-dialog__message">{{ message }}</p>
    <template #foot>
      <Button variant="secondary" :disabled="loading" @click="onCancel">
        {{ cancelLabel ?? t('common.cancel') }}
      </Button>
      <Button :variant="variant" :loading="loading" @click="emit('confirm')">
        {{ confirmLabel ?? t('common.confirm') }}
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
.confirm-dialog__message {
  margin: 0;
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
}
</style>
