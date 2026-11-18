<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge, Button, Icon } from '@moonshot-ai/app-ui';
import type { SessionInfo } from './session';
import UserAvatar from './UserAvatar.vue';
import LogoutConfirmDialog from './LogoutConfirmDialog.vue';

const props = defineProps<{
  userInfo: SessionInfo;
  loggingOut: boolean;
  logoutFailed: boolean;
}>();

const emit = defineEmits<{
  logout: [];
}>();

const { t } = useI18n();
const nickname = computed(() => props.userInfo.nickname || t('sidebar.defaultUserName'));
const accountLevel = computed(() => props.userInfo.userLevelName.trim());
const confirmOpen = ref(false);
</script>

<template>
  <div class="account-page">
    <div class="profile-card">
      <UserAvatar :src="userInfo.avatar" class="profile-avatar" />
      <div class="account-name-row">
        <span class="profile-name">{{ nickname }}</span>
        <Badge v-if="accountLevel" variant="neutral" size="sm">{{ accountLevel }}</Badge>
      </div>
    </div>
    <Button variant="danger" @click="confirmOpen = true">
      <Icon name="log-out" size="sm" />
      {{ t('account.signOut') }}
    </Button>
    <p v-if="logoutFailed && !confirmOpen" class="logout-error">{{ t('account.signOutFailed') }}</p>
  </div>
  <LogoutConfirmDialog
    v-model:open="confirmOpen"
    :logging-out="loggingOut"
    :logout-failed="logoutFailed"
    @confirm="emit('logout')"
  />
</template>

<style scoped>
.account-page { display: flex; flex-direction: column; gap: var(--space-4); }
.profile-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
  background: var(--color-surface-raised);
}
.profile-avatar { width: 52px; height: 52px; }
.account-name-row { min-width: 0; display: flex; align-items: center; gap: var(--space-1-5); }
.profile-name { overflow: hidden; font-size: 15px; font-weight: var(--weight-semibold); text-overflow: ellipsis; white-space: nowrap; }
.logout-error { margin: calc(-1 * var(--space-2)) 0 0; color: var(--color-danger); font-size: var(--text-sm); text-align: center; }
</style>
