<!-- Renders the single global ConfirmDialog driven by useConfirmDialog(). Mount
     once at the app root; callers elsewhere just `await confirm(...)`. -->
<script setup lang="ts">
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import ConfirmDialog from './ConfirmDialog.vue';

const { current, busy, settle, runAction } = useConfirmDialog();

// runAction never rejects (a failing action rejects the confirm() promise
// instead), so the floating promise is safe to drop here.
function onConfirm(): void {
  void runAction();
}
</script>

<template>
  <!-- Mount on demand, not once at startup: sibling Dialog overlays all sit
       at --z-modal and tie-break by DOM order, and a Teleport's slot in <body>
       is reserved when the component mounts. A startup-mounted host would land
       before every later-opened dialog (Settings…) and paint underneath; a
       confirm mounts last, so it always lands on top. While a modal confirm
       is up, no other dialog can be opened (dispatcher overlay gating). -->
  <ConfirmDialog
    v-if="current !== null"
    :open="true"
    :title="current.title"
    :message="current.message"
    :confirm-label="current.confirmLabel"
    :cancel-label="current.cancelLabel"
    :variant="current.variant"
    :loading="busy"
    @confirm="onConfirm"
    @cancel="settle(false)"
  />
</template>
