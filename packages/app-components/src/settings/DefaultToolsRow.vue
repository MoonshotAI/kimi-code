<script setup lang="ts">
import './settings-row-label.css';
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { getKimiWebApi } from '@moonshot-ai/app-client/client';
import { configStore, hostsStore } from '@moonshot-ai/app-client/stores';
import type { AppToolCatalogEntry } from '@moonshot-ai/app-core/api';
import { isDefaultToolEnabled } from '@moonshot-ai/app-core/lib';
import { Icon } from '@moonshot-ai/app-ui';

const emit = defineEmits<{ open: [origin: HTMLElement] }>();
const { t } = useI18n();
const rowRef = ref<HTMLButtonElement>();
const tools = ref<AppToolCatalogEntry[]>([]);
const enabledCount = computed(() =>
  tools.value.filter((tool) => isDefaultToolEnabled(configStore().config?.tools, tool.name)).length,
);
const hasRemoteHosts = computed(() => hostsStore().hosts.length > 0);

onMounted(async () => {
  try {
    tools.value = await getKimiWebApi().listToolCatalog();
  } catch {
    tools.value = [];
  }
});

function open(): void {
  if (rowRef.value) emit('open', rowRef.value);
}
</script>

<template>
  <div class="settings-group">
    <button ref="rowRef" type="button" class="row dt-entry" data-settings-subpage-origin="tools" @click="open">
      <span class="settings-row-label dt-entry-label">
        {{ t('settings.defaultTools') }}
        <span class="dt-entry-hint">{{ t(hasRemoteHosts ? 'settings.defaultToolsEntryHintLocalOnly' : 'settings.defaultToolsEntryHint') }}</span>
      </span>
      <span class="dt-entry-meta">
        <span v-if="tools.length > 0 && configStore().config !== null && configStore().config !== undefined" class="dt-entry-count">{{ enabledCount }} / {{ tools.length }} {{ t('settings.defaultToolsEnabled') }}</span>
        <span class="dt-entry-chevron"><Icon name="chevron-right" size="sm" /></span>
      </span>
    </button>
  </div>
</template>

<style scoped src="./settings-common.css"></style>

<style scoped>
.dt-entry-label {
  line-height: var(--leading-normal);
  color: var(--color-text);
}
.dt-entry-hint {
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
  font-weight: var(--weight-regular);
  color: var(--color-text-faint);
}
.dt-entry-meta { display: flex; align-items: center; gap: var(--space-2); }
.dt-entry-count {
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  white-space: nowrap;
}
.dt-entry-chevron { display: flex; color: var(--color-text-faint); }
</style>
