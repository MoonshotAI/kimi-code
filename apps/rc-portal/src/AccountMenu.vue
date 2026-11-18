<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge, Icon, Menu, MenuItem } from '@moonshot-ai/app-ui';
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
const rootRef = ref<HTMLElement | null>(null);
const triggerRef = ref<HTMLButtonElement | null>(null);
const menuOpen = ref(false);
const confirmOpen = ref(false);

function requestLogout(): void {
  closeMenu();
  confirmOpen.value = true;
}

function closeMenu(): void {
  menuOpen.value = false;
  document.removeEventListener('mousedown', onDocMousedown);
  document.removeEventListener('keydown', onDocKeydown, true);
}

function onDocMousedown(event: MouseEvent): void {
  if (rootRef.value?.contains(event.target as Node)) return;
  closeMenu();
}

function onDocKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  event.stopPropagation();
  closeMenu();
  triggerRef.value?.focus();
}

function toggleMenu(): void {
  if (menuOpen.value) {
    closeMenu();
    return;
  }
  menuOpen.value = true;
  document.addEventListener('mousedown', onDocMousedown);
  document.addEventListener('keydown', onDocKeydown, true);
}

onBeforeUnmount(closeMenu);
</script>

<template>
  <div ref="rootRef" class="account-menu-container">
    <button
      ref="triggerRef"
      type="button"
      class="account-trigger"
      aria-haspopup="menu"
      :aria-expanded="menuOpen"
      @click="toggleMenu"
    >
      <UserAvatar :src="userInfo.avatar" size="sm" />
      <span class="account-name">{{ nickname }}</span>
      <Badge v-if="accountLevel" variant="neutral" size="sm">{{ accountLevel }}</Badge>
      <Icon name="chevron-down" size="sm" class="account-chevron" />
    </button>

    <Menu v-if="menuOpen" class="account-popover" role="menu">
      <div class="account-summary">
        <UserAvatar :src="userInfo.avatar" />
        <div class="account-name-row">
          <span class="account-summary-name">{{ nickname }}</span>
          <Badge v-if="accountLevel" variant="neutral" size="sm">{{ accountLevel }}</Badge>
        </div>
      </div>
      <MenuItem danger @click="requestLogout">
        <Icon name="log-out" size="sm" />
        {{ t('account.signOut') }}
      </MenuItem>
      <p v-if="logoutFailed && !confirmOpen" class="logout-error">{{ t('account.signOutFailed') }}</p>
    </Menu>
  </div>
  <LogoutConfirmDialog
    v-model:open="confirmOpen"
    :logging-out="loggingOut"
    :logout-failed="logoutFailed"
    @confirm="emit('logout')"
  />
</template>

<style scoped>
.account-menu-container { position: relative; flex: none; }
.account-trigger {
  min-width: 0;
  height: 40px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-2) 0 var(--space-1);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  cursor: pointer;
}
.account-trigger:hover, .account-trigger[aria-expanded="true"] { background: var(--color-hover); }
.account-trigger:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.account-name {
  max-width: 120px;
  overflow: hidden;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.account-chevron { color: var(--color-text-faint); }
.account-popover {
  position: absolute;
  top: 46px;
  right: 0;
  z-index: var(--z-dropdown);
  width: 224px;
}
.account-summary {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: 2px 2px 6px;
  padding: 8px 8px 12px;
  border-bottom: var(--p-hairline) solid var(--color-subtle);
}
.account-name-row { min-width: 0; display: flex; align-items: center; gap: var(--space-1-5); }
.account-summary-name { font-size: var(--text-base); font-weight: var(--weight-semibold); }
.logout-error { margin: var(--space-2) var(--space-2) var(--space-1); color: var(--color-danger); font-size: var(--text-xs); line-height: var(--leading-normal); }
@media (max-width: 639px) {
  .account-trigger > :deep(.ui-badge) { display: none; }
}
</style>
