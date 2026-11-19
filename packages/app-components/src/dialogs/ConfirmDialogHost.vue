<script setup lang="ts">
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import ConfirmDialog from './ConfirmDialog.vue';

const { current, busy, settle, runAction } = useConfirmDialog();

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
    :loading="busy"
    @confirm="onConfirm"
    @cancel="settle(false)"
  />
</template>
