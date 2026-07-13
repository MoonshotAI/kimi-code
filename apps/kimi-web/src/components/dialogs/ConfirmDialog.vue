<!-- apps/kimi-web/src/components/dialogs/ConfirmDialog.vue -->
<!-- Design-system §03 modal confirmation: a thin wrapper over the canonical
     Dialog (height auto, right-aligned footer). The single confirmation surface
     for user actions — driven app-wide by useConfirmDialog(). -->
<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';

const confirmButtonRef = ref<InstanceType<typeof Button> | null>(null);

function confirmButtonElement(): HTMLElement | null {
  const el = confirmButtonRef.value?.$el;
  return el instanceof HTMLElement ? el : null;
}

const props = withDefaults(defineProps<{
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

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || !props.open || props.loading) return;
  // Preserve native Enter semantics for interactive controls (buttons, links,
  // form fields) so tabbing to Cancel / Close and pressing Enter does not
  // accidentally confirm the dialog. Only treat Enter as confirm when focus is
  // on a non-interactive part of the dialog.
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
    :initial-focus="confirmButtonElement"
    @update:open="emit('update:open', $event)"
    @close="onCancel"
  >
    <p v-if="message" class="confirm-dialog__message">{{ message }}</p>
    <template #foot>
      <Button variant="secondary" :disabled="loading" @click="onCancel">
        {{ cancelLabel ?? t('common.cancel') }}
      </Button>
      <Button
        ref="confirmButtonRef"
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
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
}
</style>
