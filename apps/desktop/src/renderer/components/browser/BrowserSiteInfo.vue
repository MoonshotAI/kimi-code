<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, IconButton } from '@moonshot-ai/app-ui';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import { BROWSER_SITE_PERMISSIONS, browserSiteOrigin, isBrowserSitePermission, isBrowserSiteSetting, type BrowserSiteInfo, type BrowserSitePermission } from '../../../shared/browser-sites';
import { isBrowserSiteAutoplay } from '../../../shared/browser-autoplay';
import { isBrowserSiteSound } from '../../../shared/browser-sound';
import { getNativeBrowserBridge } from '../../lib/nativeBrowser';
import { registerBrowserOverlayMenu } from '../../lib/browserOverlayMenu';

const props = defineProps<{ url: string }>();
const emit = defineEmits<{ openSettings: [] }>();
const { t } = useI18n();
const { confirm } = useConfirmDialog();
const bridge = getNativeBrowserBridge();
const button = ref<InstanceType<typeof IconButton>>();
const site = ref<BrowserSiteInfo | null>(null);
const systemDenied = ref<BrowserSitePermission[]>([]);
const busy = ref(false);
const error = ref('');
const origin = computed(() => browserSiteOrigin(props.url));
let revision = 0;
const permissionIcons = { location: 'map-pin', camera: 'camera', microphone: 'microphone', notifications: 'bell', clipboard: 'copy', clipboardWrite: 'copy', fullscreen: 'expand', midi: 'music', midiSysex: 'music' } as const;

const menu = registerBrowserOverlayMenu({
  id: `browser.site.${crypto.randomUUID()}`,
  width: 180,
  autoWidth: true,
  placement: 'bottom-start',
  items: () => site.value === null ? [] : [
    { kind: 'section', id: 'origin', label: site.value.origin },
    {
      kind: 'choices' as const,
      id: 'autoplay',
      icon: 'music',
      label: t('browser.sites.autoplay'),
      value: `autoplay.${site.value.autoplay ?? 'default'}`,
      options: ['default', 'allow', 'block'].map((setting) => ({ id: `autoplay.${setting}`, label: t(`browser.sites.autoplayStates.${setting}`) })),
    },
    {
      kind: 'choices' as const,
      id: 'sound',
      icon: 'volume',
      label: t('browser.sites.sound'),
      value: `sound.${site.value.sound ?? 'default'}`,
      options: ['default', 'on', 'muted'].map((setting) => ({ id: `sound.${setting}`, label: t(`browser.sites.soundStates.${setting}`) })),
    },
    ...BROWSER_SITE_PERMISSIONS.map((permission) => ({
      kind: 'choices' as const,
      id: permission,
      icon: permissionIcons[permission],
      label: t(`browser.sites.permissions.${permission}`),
      value: `${permission}.${site.value!.permissions[permission] ?? 'ask'}`,
      options: ['ask', 'allow', 'block'].map((setting) => ({ id: `${permission}.${setting}`, label: t(`browser.sites.states.${setting}`) })),
      ...(systemDenied.value.includes(permission)
        ? { disabled: true, notice: { message: t('browser.sites.systemPermissionDenied'), linkLabel: t('browser.sites.openSystemSettings'), action: `${permission}.system-settings` } }
        : {}),
    })),
    { kind: 'separator' },
    { kind: 'note', id: 'cookies', label: t('browser.sites.cookies', { count: site.value.cookieCount }) },
    ...(error.value ? [{ kind: 'note' as const, id: 'error', label: error.value }] : []),
    { kind: 'item', id: 'clear', label: t('browser.sites.deleteData'), icon: 'trash', danger: true },
    { kind: 'item', id: 'settings', label: t('browser.sites.title'), icon: 'settings' },
  ],
  onSelect: (id) => { void select(id); },
});

async function toggle(): Promise<void> {
  if (menu.open.value) { menu.close({ refocus: true }); return; }
  if (bridge === null || origin.value === null || busy.value) return;
  const request = ++revision;
  busy.value = true;
  try {
    const targetOrigin = origin.value;
    const result = await menu.request(() => Promise.all([bridge.browserGetSite(targetOrigin), bridge.browserGetSystemPermissionStates()]));
    if (result === undefined || request !== revision || !button.value?.el?.getClientRects().length) return;
    site.value = result[0];
    systemDenied.value = result[1];
    error.value = '';
    if (button.value?.el) menu.show(button.value.el);
  } catch { error.value = t('browser.sites.failed'); }
  finally { if (request === revision) busy.value = false; }
}

async function select(id: string): Promise<void> {
  if (bridge === null || site.value === null) return;
  const targetOrigin = site.value.origin;
  if (id === 'settings') { emit('openSettings'); return; }
  if (id.endsWith('.system-settings')) {
    const permission = id.slice(0, -'.system-settings'.length);
    if (isBrowserSitePermission(permission)) {
      try { await bridge.browserOpenSystemPermissionSettings(permission); }
      catch { error.value = t('browser.sites.failed'); menu.refresh(); }
    }
    return;
  }
  if (id === 'clear') {
    let cleared: BrowserSiteInfo | undefined;
    try {
      await confirm({ title: t('browser.sites.deleteData'), message: t('browser.sites.clearMessage', { origin: targetOrigin }), confirmLabel: t('browser.sites.deleteData'), cancelLabel: t('common.cancel'), variant: 'danger', action: async () => { cleared = await bridge.browserClearSiteData(targetOrigin); } });
    } catch {
      if (origin.value !== targetOrigin) return;
      error.value = t('browser.sites.failed');
      if (menu.open.value) menu.refresh();
      else if (button.value?.el?.getClientRects().length) menu.show(button.value.el);
      return;
    }
    if (cleared === undefined || origin.value !== targetOrigin) return;
    site.value = cleared;
    error.value = '';
    menu.refresh();
    return;
  }
  const [permission, setting] = id.split('.');
  if (permission === 'autoplay' && isBrowserSiteAutoplay(setting)) {
    try {
      const result = await bridge.browserSetSiteAutoplay(targetOrigin, setting);
      if (origin.value !== targetOrigin) return;
      site.value = result;
      error.value = '';
    } catch { error.value = t('browser.sites.failed'); }
    menu.refresh();
    return;
  }
  if (permission === 'sound' && isBrowserSiteSound(setting)) {
    try {
      const result = await bridge.browserSetSiteSound(targetOrigin, setting);
      if (origin.value !== targetOrigin) return;
      site.value = result;
      error.value = '';
    } catch { error.value = t('browser.sites.failed'); }
    menu.refresh();
    return;
  }
  if (!isBrowserSitePermission(permission) || !isBrowserSiteSetting(setting)) return;
  try {
    const result = await bridge.browserSetSitePermission(targetOrigin, permission, setting);
    if (origin.value !== targetOrigin) return;
    site.value = result;
    error.value = '';
  } catch { error.value = t('browser.sites.failed'); }
  menu.refresh();
}

watch(origin, () => { revision += 1; busy.value = false; menu.close(); site.value = null; systemDenied.value = []; });
onUnmounted(() => { revision += 1; menu.dispose(); });
</script>

<template>
  <IconButton ref="button" size="sm" :label="t('browser.sites.info')" :tooltip="t('browser.sites.info')" :disabled="origin === null || busy" :pressed="menu.open.value" @click="toggle"><Icon name="info" size="sm" /></IconButton>
</template>
