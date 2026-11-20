<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import { panelRegistry } from '@moonshot-ai/app-client/panel';
import type { PanelTab } from '@moonshot-ai/app-client/composables';
import type { PanelLauncherType } from '@moonshot-ai/app-client/panel';
import type { PanelLauncherItem } from '../../lib/panelLauncher';

const props = withDefaults(defineProps<{
  tabs: PanelTab[];
  available: PanelLauncherItem[];
  browserOnly?: boolean;
}>(), {
  browserOnly: false,
});

const emit = defineEmits<{
  activate: [id: string];
  open: [type: PanelLauncherType];
  showTabs: [];
}>();

const { t } = useI18n();
const visibleTabs = computed(() => props.tabs.slice(0, 5));
const availableItems = computed(() => props.available.filter(item =>
  props.browserOnly ? item.type === 'browser' : item.type !== 'diff' && item.type !== 'inspector',
));
</script>

<template>
  <div class="sit">
    <section v-if="tabs.length > 0" class="sit-section">
      <div class="sit-label">{{ t('header.sessionInfoOpenedTabs') }}</div>
      <button
        v-for="tab in visibleTabs"
        :key="tab.id"
        type="button"
        class="sit-link sit-opened"
        @click="emit('activate', tab.id)"
      >
        <Icon :name="panelRegistry[tab.type].icon" size="md" />
        <span class="sit-name">{{ tab.presentation?.title ?? tab.title }}</span>
      </button>
      <button
        v-if="tabs.length > 5"
        type="button"
        class="sit-link sit-more"
        @click="emit('showTabs')"
      >
        <span class="sit-name">{{ t('header.sessionInfoMore', { count: `${tabs.length}+` }) }}</span>
      </button>
    </section>

    <section v-if="availableItems.length > 0" class="sit-section">
      <div class="sit-label">{{ t('header.sessionInfoAvailableTabs') }}</div>
      <button
        v-for="item in availableItems"
        :key="item.type"
        type="button"
        class="sit-link sit-available"
        :disabled="item.disabled"
        @click="emit('open', item.type)"
      >
        <Icon :name="item.icon" size="md" />
        <span class="sit-name">{{ item.label }}</span>
      </button>
    </section>
  </div>
</template>

<style scoped>
.sit { min-width: 0; }
.sit-section { position: relative; display: grid; gap: 0; padding: var(--space-3) var(--space-4) var(--space-4); }
.sit-section + .sit-section::before { content: ""; position: absolute; top: 0; right: var(--space-4); left: var(--space-4); height: var(--p-hairline); background: var(--color-line); }
.sit-label { min-height: 32px; display: flex; align-items: center; gap: var(--space-2); color: var(--color-text); font-size: var(--text-xs); font-weight: var(--weight-regular); }
.sit-link {
  width: calc(100% + var(--space-4));
  min-width: 0;
  min-height: 28px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-05) calc(-1 * var(--space-2));
  padding: 0 var(--space-2);
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-muted);
  text-align: left;
  font-size: var(--text-xs);
  cursor: pointer;
}
.sit-link:hover:not(:disabled) { background: var(--color-hover); }
.sit-link:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
.sit-link:disabled { color: var(--color-text-faint); cursor: default; }
.sit-link > .kw-icon { flex: none; color: var(--color-text-faint); }
.sit-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sit-more { color: var(--color-text-faint); font-size: var(--text-xs); }
</style>
