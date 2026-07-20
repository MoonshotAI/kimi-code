<!-- apps/kimi-web/src/components/dialogs/ConfirmDialog.vue -->
<!-- Design-system §03 modal confirmation: a thin wrapper over the canonical
     Dialog (height auto, right-aligned footer). The single confirmation surface
     for user actions — driven app-wide by useConfirmDialog(). -->
<script setup lang="ts">
import { onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';

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
  // While the confirm action runs (loading), every cancel path — Cancel
  // button, header close, Esc, overlay click — is inert so the dialog can't
  // be dismissed out from under the in-flight work.
  if (props.loading) return;
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
  <!-- initial-focus uses a selector, not the Button component's $el: Button
       has a template-root comment, so in dev builds it renders as a fragment
       whose $el is a text node (unfocusable) — focus would fall back to the
       header close button and Enter would cancel instead of confirm. -->
  <Dialog
    :open="open"
    :title="title"
    height="auto"
    initial-focus=".confirm-dialog__confirm"
    :close-on-esc="!loading"
    :close-on-overlay="!loading"
    @update:open="emit('update:open', $event)"
    @close="onCancel"
  >
    <p v-if="message" class="confirm-dialog__message">{{ message }}</p>
    <template #foot>
      <Button variant="secondary" :disabled="loading" @click="onCancel">
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
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
}
</style>
