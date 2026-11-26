<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Icon, IconButton, Link } from '@moonshot-ai/app-ui';
import { usePlugins, type PluginViewModel } from '@moonshot-ai/app-client/composables';
import PluginActions from './PluginActions.vue';
import PluginIcon from './PluginIcon.vue';
import PluginStatus from './PluginStatus.vue';
import { WEBBRIDGE_EXTENSION_GUIDE_URL, WEBBRIDGE_EXTENSION_LINKS } from './webBridgeExtension';

const props = defineProps<{ row: PluginViewModel }>();
const emit = defineEmits<{ details: []; installed: [row: PluginViewModel] }>();
const { t } = useI18n();
const { state, dismissExtensionHint } = usePlugins();

const version = computed(() =>
  props.row.installedPlugin?.version ?? props.row.catalogEntry?.version ?? props.row.capability?.version,
);
const showExtensionHint = computed(() =>
  state.extensionHint && props.row.capability?.id === 'kimi-webbridge',
);

function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener');
}
</script>

<template>
  <article class="plugin-row">
    <div class="plugin-row__body">
      <div class="plugin-row__summary">
        <button
          type="button"
          class="plugin-row__main"
          :data-plugin-row="row.id"
          @click="emit('details')"
        >
          <PluginIcon :src="row.iconUrl" />
          <span class="plugin-row__text">
            <span class="plugin-row__title">
              <span class="plugin-row__name">{{ row.displayName }}</span>
              <span v-if="version" class="plugin-row__version">{{ version }}</span>
            </span>
            <span
              v-if="row.shortDescription && row.shortDescription !== '-'"
              class="plugin-row__description"
            >
              {{ row.shortDescription }}
            </span>
          </span>
        </button>
        <PluginActions :row="row" install-variant="secondary" @installed="emit('installed', $event)" />
      </div>
      <PluginStatus :row="row" />
      <div v-if="showExtensionHint" class="pp-ext-hint" role="status">
        <Icon name="globe" size="md" class="pp-ext-icon" />
        <span class="pp-ext-title">{{ t('settings.plugins.extensionHintTitle') }}</span>
        <div class="pp-ext-actions">
          <Button size="sm" variant="secondary" @click="openExternal(WEBBRIDGE_EXTENSION_LINKS.chrome.url)">
            Chrome
            <Icon name="external-link" size="sm" />
          </Button>
          <Button size="sm" variant="secondary" @click="openExternal(WEBBRIDGE_EXTENSION_LINKS.edge.url)">
            Edge
            <Icon name="external-link" size="sm" />
          </Button>
          <Link :href="WEBBRIDGE_EXTENSION_GUIDE_URL" external variant="muted" class="pp-ext-guide">
            {{ t('settings.plugins.extensionGuide') }}
          </Link>
        </div>
        <IconButton
          size="sm"
          class="pp-ext-close"
          :label="t('settings.plugins.dismissHint')"
          :tooltip="t('settings.plugins.dismissHint')"
          @click="dismissExtensionHint"
        >
          <Icon name="close" size="md" />
        </IconButton>
      </div>
    </div>
  </article>
</template>

<style scoped>
.plugin-row {
  background: transparent;
}

.plugin-row__summary {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 68px;
}

.plugin-row__main {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  flex: 1;
  min-width: 0;
  align-self: stretch;
  padding: var(--space-4);
  border: none;
  background: transparent;
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
}

.plugin-row__main:hover .plugin-row__name {
  color: var(--color-accent-hover);
}

.plugin-row__main:focus-visible {
  outline: none;
  box-shadow: inset var(--p-focus-ring);
}

.plugin-row__text {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.plugin-row__title {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  min-width: 0;
  line-height: 1;
}

.plugin-row__name {
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-sm);
  font-weight: var(--weight-option-label);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plugin-row__version {
  flex: none;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
}

.plugin-row__description {
  display: -webkit-box;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  line-height: var(--leading-relaxed);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.pp-ext-hint {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: var(--p-hairline) solid var(--color-line);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}

.pp-ext-icon {
  flex: none;
  color: var(--color-text-faint);
}

.pp-ext-title {
  flex: 1;
  min-width: 180px;
}

.pp-ext-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.pp-ext-guide,
.pp-ext-close {
  flex: none;
}
</style>
