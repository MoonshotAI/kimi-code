<!-- apps/kimi-web/src/components/dialogs/ConfirmDialogHost.vue -->
<!-- Renders the single global ConfirmDialog driven by useConfirmDialog(). Mount
     once at the app root; callers elsewhere just `await confirm(...)`. -->
<script setup lang="ts">
import { useConfirmDialog } from '../../composables/useConfirmDialog';
import ConfirmDialog from './ConfirmDialog.vue';

const { current, busy, settle, runAction } = useConfirmDialog();

// runAction never rejects (a failing action rejects the confirm() promise
// instead), so the floating promise is safe to drop here.
function onConfirm(): void {
  void runAction();
}
</script>

<template>
  <ConfirmDialog
    :open="current !== null"
    :title="current?.title ?? ''"
    :message="current?.message"
    :confirm-label="current?.confirmLabel"
    :cancel-label="current?.cancelLabel"
    :variant="current?.variant"
    :loading="busy"
    @confirm="onConfirm"
    @cancel="settle(false)"
  />
</template>
