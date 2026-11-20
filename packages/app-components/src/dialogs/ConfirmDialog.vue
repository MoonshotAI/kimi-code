<script setup lang="ts">
import { onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Dialog, Icon, Spinner } from '@moonshot-ai/app-ui';
import type { ConfirmDialogCancelSource, ConfirmDialogRow } from './confirmDialogRow';

const props = withDefaults(defineProps<{
  open: boolean;
  title: string;
  message?: string;
  rows?: readonly ConfirmDialogRow[];
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'primary' | 'danger' | 'secondary';
  loading?: boolean;
  hideCancel?: boolean;
  initialFocus?: 'confirm' | 'cancel';
}>(), {
  variant: 'danger',
  initialFocus: 'confirm',
});

const emit = defineEmits<{
  'update:open': [value: boolean];
  confirm: [];
  cancel: [source: ConfirmDialogCancelSource];
}>();

const { t } = useI18n();

function cancel(source: ConfirmDialogCancelSource): void {
  if (props.loading) return;
  emit('update:open', false);
  emit('cancel', source);
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
    :initial-focus="initialFocus === 'cancel' && !hideCancel ? '.confirm-dialog__cancel' : '.confirm-dialog__confirm'"
    :close-on-esc="!loading"
    :close-on-overlay="!loading"
    @update:open="emit('update:open', $event)"
    @close="cancel('dismiss')"
  >
    <p v-if="message" class="confirm-dialog__message">{{ message }}</p>
    <div v-if="rows && rows.length > 0" class="confirm-dialog__rows">
      <template v-for="(row, index) in rows" :key="row.key ?? index">
        <div class="confirm-dialog__row" :class="`confirm-dialog__row--${row.tone ?? 'muted'}`">
          <span class="confirm-dialog__row-icon">
            <Spinner v-if="row.spinning" size="sm" />
            <Icon v-else :name="row.icon" size="md" />
          </span>
          <span class="confirm-dialog__row-text">{{ row.text }}</span>
          <span v-if="row.trailing" class="confirm-dialog__row-trailing">{{ row.trailing }}</span>
        </div>
        <slot name="after-row" :row="row" :index="index" />
      </template>
    </div>
    <slot />
    <template #foot>
      <Button
        v-if="!hideCancel"
        class="confirm-dialog__cancel"
        variant="secondary"
        :disabled="loading"
        @click="cancel('button')"
      >
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
.confirm-dialog__rows {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.confirm-dialog__message + .confirm-dialog__rows { margin-top: var(--space-3); }
.confirm-dialog__row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  color: var(--color-text-muted);
}
.confirm-dialog__row-icon {
  display: inline-flex;
  align-items: center;
  flex: none;
  height: calc(var(--text-base) * var(--leading-normal));
  color: var(--color-text-faint);
}
.confirm-dialog__row--warning .confirm-dialog__row-icon { color: var(--color-warning); }
.confirm-dialog__row--danger .confirm-dialog__row-icon { color: var(--color-danger); }
.confirm-dialog__row--success .confirm-dialog__row-icon { color: var(--color-success); }
.confirm-dialog__row-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.confirm-dialog__row-trailing {
  flex: none;
  color: var(--color-text-faint);
  font-size: var(--text-sm);
  font-variant-numeric: tabular-nums;
}
</style>
