<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Icon, Input, Select } from '@moonshot-ai/app-ui';
import { BROWSER_SITE_PERMISSIONS, isBrowserSiteSetting, type BrowserSiteInfo, type BrowserSitePermission } from '../../../shared/browser-sites';
import { isBrowserSiteAutoplay } from '../../../shared/browser-autoplay';
import { isBrowserSiteSound } from '../../../shared/browser-sound';
import { getNativeBrowserBridge } from '../../lib/nativeBrowser';

const { t } = useI18n();
const bridge = getNativeBrowserBridge();
const sites = ref<BrowserSiteInfo[]>([]);
const selected = ref<BrowserSiteInfo | null>(null);
const query = ref('');
const busy = ref(false);
const error = ref('');
const confirmingDelete = ref(false);
const options = computed(() => ['ask', 'allow', 'block'].map((value) => ({ value, label: t(`browser.sites.states.${value}`) })));
const autoplayOptions = computed(() => ['default', 'allow', 'block'].map((value) => ({ value, label: t(`browser.sites.autoplayStates.${value}`) })));
const soundOptions = computed(() => ['default', 'on', 'muted'].map((value) => ({ value, label: t(`browser.sites.soundStates.${value}`) })));
const visibleSites = computed(() => sites.value.filter((site) => site.origin.toLowerCase().includes(query.value.trim().toLowerCase())).sort((a, b) => a.origin.localeCompare(b.origin)));

async function refresh(): Promise<void> {
  if (bridge === null) return;
  busy.value = true;
  try { sites.value = await bridge.browserGetSites(); error.value = ''; }
  catch { error.value = t('browser.sites.failed'); }
  finally { busy.value = false; }
}

async function setPermission(permission: BrowserSitePermission, value: string): Promise<void> {
  if (bridge === null || selected.value === null || !isBrowserSiteSetting(value)) return;
  busy.value = true;
  try {
    const updated = await bridge.browserSetSitePermission(selected.value.origin, permission, value);
    selected.value = updated;
    sites.value = sites.value.map((site) => site.origin === updated.origin ? updated : site);
    error.value = '';
  } catch { error.value = t('browser.sites.failed'); }
  finally { busy.value = false; }
}

async function setAutoplay(value: string): Promise<void> {
  if (bridge === null || selected.value === null || !isBrowserSiteAutoplay(value)) return;
  busy.value = true;
  try {
    const updated = await bridge.browserSetSiteAutoplay(selected.value.origin, value);
    selected.value = updated;
    sites.value = sites.value.map((site) => site.origin === updated.origin ? updated : site);
    error.value = '';
  } catch { error.value = t('browser.sites.failed'); }
  finally { busy.value = false; }
}

async function setSound(value: string): Promise<void> {
  if (bridge === null || selected.value === null || !isBrowserSiteSound(value)) return;
  busy.value = true;
  try {
    const updated = await bridge.browserSetSiteSound(selected.value.origin, value);
    selected.value = updated;
    sites.value = sites.value.map((site) => site.origin === updated.origin ? updated : site);
    error.value = '';
  } catch { error.value = t('browser.sites.failed'); }
  finally { busy.value = false; }
}

async function clearData(): Promise<void> {
  if (bridge === null || selected.value === null) return;
  busy.value = true;
  try {
    const updated = await bridge.browserClearSiteData(selected.value.origin);
    selected.value = updated;
    sites.value = sites.value.map((site) => site.origin === updated.origin ? updated : site);
    confirmingDelete.value = false;
    error.value = '';
  } catch { error.value = t('browser.sites.failed'); }
  finally { busy.value = false; }
}

onMounted(() => void refresh());
</script>

<template>
  <section class="browser-sites">
    <p v-if="error" class="browser-sites-error" role="status">{{ error }}</p>
    <template v-if="selected">
      <header class="browser-sites-navigation">
        <Button variant="secondary" size="sm" :disabled="busy" @click="selected = null; confirmingDelete = false"><Icon name="arrow-left" size="sm" />{{ t('browser.sites.backToList') }}</Button>
        <h3 class="sec-title browser-sites-origin">{{ selected.origin }}</h3>
      </header>
      <div class="settings-group">
        <div class="row">
          <span class="rlabel">{{ t('browser.sites.autoplay') }}</span>
          <div class="select-wrap">
            <Select size="sm" :disabled="busy" :model-value="selected.autoplay ?? 'default'" :options="autoplayOptions" :aria-label="t('browser.sites.autoplay')" @update:model-value="setAutoplay" />
          </div>
        </div>
        <div class="row">
          <span class="rlabel">{{ t('browser.sites.sound') }}</span>
          <div class="select-wrap">
            <Select size="sm" :disabled="busy" :model-value="selected.sound ?? 'default'" :options="soundOptions" :aria-label="t('browser.sites.sound')" @update:model-value="setSound" />
          </div>
        </div>
        <div v-for="permission in BROWSER_SITE_PERMISSIONS" :key="permission" class="row">
          <span class="rlabel">{{ t(`browser.sites.permissions.${permission}`) }}</span>
          <div class="select-wrap">
            <Select size="sm" :disabled="busy" :model-value="selected.permissions[permission] ?? 'ask'" :options="options" :aria-label="t(`browser.sites.permissions.${permission}`)" @update:model-value="(value) => setPermission(permission, value)" />
          </div>
        </div>
      </div>
      <p>{{ t('browser.sites.cookies', { count: selected.cookieCount }) }}</p>
      <template v-if="confirmingDelete">
        <p>{{ t('browser.sites.clearMessage', { origin: selected.origin }) }}</p>
        <div class="browser-sites-actions">
          <Button size="sm" variant="secondary" :disabled="busy" @click="confirmingDelete = false">{{ t('common.cancel') }}</Button>
          <Button size="sm" variant="danger" :loading="busy" @click="clearData">{{ t('browser.sites.deleteData') }}</Button>
        </div>
      </template>
      <Button v-else size="sm" variant="secondary" :disabled="busy" @click="confirmingDelete = true">{{ t('browser.sites.deleteData') }}</Button>
    </template>
    <template v-else>
      <Input v-model="query" type="search" size="sm" :aria-label="t('browser.sites.search')" :placeholder="t('browser.sites.search')" />
      <p v-if="!busy && visibleSites.length === 0">{{ t('browser.sites.empty') }}</p>
      <div class="settings-group">
        <button v-for="site in visibleSites" :key="site.origin" type="button" class="row" :disabled="busy" @click="selected = site">
          <span class="rlabel browser-sites-origin">{{ site.origin }}</span>
          <span class="rvalue-wrap">
            <span class="rvalue">{{ t('browser.sites.cookies', { count: site.cookieCount }) }}</span>
            <Icon name="chevron-right" size="sm" />
          </span>
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped src="@moonshot-ai/app-components/settings-common.css"></style>

<style scoped>
.browser-sites { min-width: 0; display: flex; flex-direction: column; align-items: stretch; gap: var(--space-3); }
.browser-sites .sec-title, .browser-sites p { margin: 0; }
.browser-sites p { font-size: var(--ui-b2); color: var(--color-text-muted); }
.browser-sites .browser-sites-error { color: var(--color-danger); }
.browser-sites-origin { flex: 1; overflow-wrap: anywhere; text-align: start; min-width: 0; }
.browser-sites-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
.browser-sites-navigation { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-3); }
.browser-sites .row > .rlabel { flex: 1; min-width: 0; }
.browser-sites .select-wrap { min-width: min(220px, 50%); max-width: 50%; }
</style>

