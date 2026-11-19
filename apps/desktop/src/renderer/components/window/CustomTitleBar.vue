<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, IconButton } from '@moonshot-ai/app-ui';
import { useCanaryChannel } from '@moonshot-ai/app-client/composables';
import { shortcutTooltip } from '../../composables/useShortcuts';
import { focusLeavesMenu, StandaloneAltTracker } from '../../lib/menuAccess';
import BrandLogo from '../onboarding/BrandLogo.vue';
import UpdateIndicator from '../UpdateIndicator.vue';

type MenuId = 'file' | 'edit' | 'view' | 'help';

const props = defineProps<{ sidebarCollapsed: boolean; fullscreen: boolean }>();
const emit = defineEmits<{ toggleSidebar: [] }>();

const { t } = useI18n();
const canary = useCanaryChannel();
const sidebarToggleTooltip = computed(() =>
  shortcutTooltip(
    props.sidebarCollapsed ? t('sidebar.expandSidebar') : t('sidebar.collapseSidebar'),
    'toggleSidebar',
  ),
);
const openMenu = ref<MenuId | null>(null);
const triggers = ref<Partial<Record<MenuId, HTMLButtonElement>>>({});
const menus: MenuId[] = ['file', 'edit', 'view', 'help'];
let popupRequest = 0;
let menuAccessOrigin: HTMLElement | null = null;
const standaloneAlt = new StandaloneAltTracker();
const labels = computed<Record<MenuId, string>>(() => ({
  file: t('app.menuFile'),
  edit: t('app.menuEdit'),
  view: t('app.menuView'),
  help: t('app.menuHelp'),
}));

function bridge(): {
  popupWindowsMenu?: (request: {
    id: MenuId;
    x: number;
    y: number;
  }) => Promise<{ opened: boolean }>;
} | undefined {
  return (window as typeof window & { kimiDesktop?: ReturnType<typeof bridge> }).kimiDesktop;
}

async function popup(id: MenuId): Promise<void> {
  const button = triggers.value[id];
  const popupMenu = bridge()?.popupWindowsMenu;
  if (!button || !popupMenu) return;
  const rect = button.getBoundingClientRect();
  const request = ++popupRequest;
  openMenu.value = id;
  try {
    await popupMenu({ id, x: rect.left, y: rect.bottom });
  } finally {
    if (request === popupRequest) {
      openMenu.value = null;
    }
  }
}

function setTrigger(id: MenuId, element: unknown): void {
  if (element instanceof HTMLButtonElement) triggers.value[id] = element;
}

function isMenuTrigger(element: unknown): element is HTMLButtonElement {
  return element instanceof HTMLButtonElement && Object.values(triggers.value).includes(element);
}

function rememberMenuAccessOrigin(element: unknown = document.activeElement): void {
  if (element instanceof HTMLElement && !isMenuTrigger(element)) {
    menuAccessOrigin = element;
  }
}

function restoreMenuAccessOrigin(): void {
  const origin = menuAccessOrigin;
  menuAccessOrigin = null;
  if (origin?.isConnected) origin.focus({ preventScroll: true });
}

function onTriggerFocus(event: FocusEvent): void {
  rememberMenuAccessOrigin(event.relatedTarget);
}

function onMenuFocusout(event: FocusEvent): void {
  if (focusLeavesMenu(event.relatedTarget, Object.values(triggers.value))) {
    menuAccessOrigin = null;
  }
}

function onKeydown(event: KeyboardEvent, id: MenuId): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    restoreMenuAccessOrigin();
    return;
  }
  const index = menus.indexOf(id);
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    const delta = event.key === 'ArrowLeft' ? -1 : 1;
    const next = menus[(index + delta + menus.length) % menus.length];
    if (next) triggers.value[next]?.focus();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    restoreMenuAccessOrigin();
    void popup(id);
  }
}

function onWindowKeydown(event: KeyboardEvent): void {
  standaloneAlt.keydown(event);
  if (event.defaultPrevented) return;
  if (event.key === 'Alt') {
    if (!event.ctrlKey && !event.metaKey && !event.shiftKey) event.preventDefault();
    return;
  }
  if (event.key === 'Escape' && (menuAccessOrigin || isMenuTrigger(document.activeElement))) {
    event.preventDefault();
    restoreMenuAccessOrigin();
    return;
  }
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const id = ({ f: 'file', e: 'edit', v: 'view', h: 'help' } as const)[event.key.toLowerCase() as 'f'];
  if (id) {
    event.preventDefault();
    restoreMenuAccessOrigin();
    void popup(id);
  }
}

function onWindowKeyup(event: KeyboardEvent): void {
  const enterMenuAccess = standaloneAlt.keyup(event);
  if (!enterMenuAccess || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey) return;
  event.preventDefault();
  if (menuAccessOrigin || isMenuTrigger(document.activeElement)) {
    restoreMenuAccessOrigin();
  } else {
    rememberMenuAccessOrigin();
    triggers.value.file?.focus();
  }
}

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown);
  window.addEventListener('keyup', onWindowKeyup);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown);
  window.removeEventListener('keyup', onWindowKeyup);
});
</script>

<template>
  <header class="custom-titlebar" :class="{ 'is-fullscreen': fullscreen }" aria-label="Kimi Code">
    <div class="custom-titlebar-safe">
      <div class="custom-titlebar-brand">
        <BrandLogo :size="24" variant="theme" :canary="canary.isCanaryBuild.value" />
        <span>Kimi Code</span>
      </div>
      <IconButton
        class="custom-sidebar-toggle"
        size="sm"
        :label="sidebarCollapsed ? t('sidebar.expandSidebar') : t('sidebar.collapseSidebar')"
        :tooltip="sidebarToggleTooltip.text"
        :keys="sidebarToggleTooltip.keys"
        @click="emit('toggleSidebar')"
      >
        <Icon :name="sidebarCollapsed ? 'panel-expand' : 'panel-collapse'" />
      </IconButton>
      <nav class="custom-menubar" :aria-label="t('app.applicationMenu')" @focusout="onMenuFocusout">
        <button
          v-for="id in menus"
          :key="id"
          :ref="(element) => setTrigger(id, element)"
          type="button"
          aria-haspopup="menu"
          :aria-expanded="openMenu === id"
          @mousedown.prevent
          @click="popup(id)"
          @mouseenter="openMenu !== null && openMenu !== id && popup(id)"
          @focus="onTriggerFocus"
          @keydown="onKeydown($event, id)"
        >
          {{ labels[id] }}
        </button>
      </nav>
      <UpdateIndicator class="custom-update" />
    </div>
  </header>
</template>

<style scoped>
.custom-titlebar {
  position: absolute;
  inset: 0 0 auto;
  z-index: var(--z-sticky);
  height: var(--titlebar-height);
  background: var(--color-sidebar-bg);
  border-bottom: var(--p-hairline) solid var(--color-line);
  -webkit-app-region: drag;
  user-select: none;
}
.custom-titlebar-safe {
  width: env(titlebar-area-width, 100%);
  height: env(titlebar-area-height, var(--titlebar-height));
  margin-left: env(titlebar-area-x, 0px);
  display: flex;
  align-items: center;
  min-width: 0;
  padding-left: var(--space-3);
  box-sizing: border-box;
}
.custom-titlebar.is-fullscreen .custom-titlebar-safe {
  width: 100%;
  height: 100%;
  margin-left: 0;
}
.custom-titlebar-brand {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
  color: var(--color-text);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  -webkit-app-region: no-drag;
}
.custom-titlebar-brand :deep(.brand-logo) {
  cursor: default;
}
.custom-sidebar-toggle {
  flex: none;
  margin-left: var(--space-2);
  -webkit-app-region: no-drag;
}
.custom-menubar {
  display: flex;
  align-items: center;
  height: 100%;
  margin-left: var(--space-2);
  -webkit-app-region: no-drag;
}
.custom-update {
  margin-left: var(--space-2);
  -webkit-app-region: no-drag;
}
.custom-menubar button {
  height: calc(var(--titlebar-height) - 2 * var(--space-1));
  padding: 0 var(--space-3);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font: inherit;
  font-size: var(--text-sm);
  cursor: pointer;
}
.custom-menubar button:hover,
.custom-menubar button[aria-expanded='true'] {
  background: var(--color-hover);
  color: var(--color-text);
}
.custom-menubar button:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
@media (forced-colors: active) {
  .custom-menubar button:hover,
  .custom-menubar button[aria-expanded='true'] {
    outline: medium solid Highlight;
  }
}
</style>
