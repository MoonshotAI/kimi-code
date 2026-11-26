<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Dialog } from '@moonshot-ai/app-ui';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';

const emit = defineEmits<{
  relogin: [];
}>();

const { t } = useI18n();
const client = useKimiWebClient();
const acknowledging = ref(false);

async function onConfirm(): Promise<void> {
  if (acknowledging.value) return;
  acknowledging.value = true;
  try {
    const cleared = await client.acknowledgeBusinessMembershipRevoked();
    if (cleared) {
      emit('relogin');
    }
  } finally {
    acknowledging.value = false;
  }
}
</script>

<template>
  <Dialog
    :open="client.businessMembershipRevokedOpen.value"
    :title="t('account.membershipRevokedTitle')"
    :close-on-overlay="false"
    :close-on-esc="false"
    hide-close
    size="sm"
    @update:open="() => {}"
  >
    <p class="membership-revoked-body" @keydown.stop>
      {{ t('account.membershipRevokedBody') }}
    </p>
    <template #foot>
      <Button variant="primary" :disabled="acknowledging" @click="void onConfirm()">
        {{ t('account.membershipRevokedConfirm') }}
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
.membership-revoked-body {
  margin: 0;
  color: var(--color-text);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}
</style>
