<script setup lang="ts">
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import ConfirmDialog from './ConfirmDialog.vue';

const { current, busy, settle, runAction, setCheckboxChecked } = useConfirmDialog();

function onConfirm(): void {
  void runAction();
}
</script>

<template>
  <ConfirmDialog
    v-if="current !== null"
    :key="current.seq"
    :open="true"
    :title="current.title"
    :message="current.message"
    :confirm-label="current.confirmLabel"
    :cancel-label="current.cancelLabel"
    :variant="current.variant"
    :initial-focus="current.initialFocus"
    :checkbox-label="current.checkbox?.label"
    :checked="current.checkbox?.checked"
    :loading="busy"
    @confirm="onConfirm"
    @cancel="settle(false)"
    @update:checked="setCheckboxChecked"
  />
</template>
