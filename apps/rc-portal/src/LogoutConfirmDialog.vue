<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Button, Dialog } from '@moonshot-ai/app-ui';

const props = defineProps<{
  open: boolean;
  loggingOut: boolean;
  logoutFailed: boolean;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  confirm: [];
}>();

const { t } = useI18n();

function onUpdateOpen(open: boolean): void {
  if (!props.loggingOut) emit('update:open', open);
}
</script>

<template>
  <Dialog :open="open" size="sm" :title="t('sidebar.logoutConfirmTitle')" @update:open="onUpdateOpen">
    <p class="confirm-hint">{{ t('sidebar.logoutConfirmMessage') }}</p>
    <p v-if="logoutFailed" class="dialog-error">{{ t('account.signOutFailed') }}</p>
    <template #foot>
      <Button variant="secondary" :disabled="loggingOut" @click="emit('update:open', false)">
        {{ t('common.cancel') }}
      </Button>
      <Button variant="danger" :loading="loggingOut" @click="emit('confirm')">
        {{ t('account.signOut') }}
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
.confirm-hint { margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); line-height: var(--leading-normal); }
.dialog-error { margin: var(--space-2) 0 0; color: var(--color-danger); font-size: var(--text-sm); }
</style>
