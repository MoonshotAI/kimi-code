<script setup lang="ts">
import { onUnmounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import { registerBrowserOverlayDialog } from '../../lib/browserOverlayDialog';

const props = defineProps<{ active: boolean }>();
const { t } = useI18n();
const { current, busy, settle, runAction, setCheckboxChecked } = useConfirmDialog();

const dialog = registerBrowserOverlayDialog({
  id: 'global-confirm',
  onConfirm: (_value, checked) => {
    if (checked !== undefined) setCheckboxChecked(checked);
    void runAction();
  },
  onCancel: () => settle(false),
});

watch(
  () => [props.active, current.value, busy.value] as const,
  ([active, request, loading]) => {
    if (!active || request === null) {
      dialog.close();
      return;
    }
    dialog.show({
      title: request.title,
      message: request.message,
      confirmLabel: request.confirmLabel ?? t('common.confirm'),
      cancelLabel: request.cancelLabel ?? t('common.cancel'),
      closeLabel: t('common.close'),
      variant: request.variant ?? 'danger',
      loading,
      checkbox: request.checkbox === undefined
        ? undefined
        : { label: request.checkbox.label, checked: request.checkbox.checked },
      ...(request.initialFocus === undefined ? {} : { initialFocus: request.initialFocus }),
    }, String(request.seq));
  },
  { immediate: true },
);

onUnmounted(() => dialog.dispose());
</script>

<template></template>
