<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { usePlugins, type PluginViewModel } from '@moonshot-ai/app-client/composables';
import { pluginErrorMessage } from './pluginErrorMessage';

const props = defineProps<{ row: PluginViewModel }>();
const { t } = useI18n();
const { state } = usePlugins();

const error = computed(() => pluginErrorMessage(
  state.rowErrors[props.row.installId] ??
  (props.row.installedPlugin === undefined
    ? undefined
    : state.rowErrors[props.row.installedPlugin.id]) ??
  props.row.capability?.install.error,
  t,
));
</script>

<template>
  <div
    v-if="
      row.capabilityUnavailable ||
      row.cloudOnly ||
      row.capability?.supported === false ||
      error
    "
    class="plugin-status"
  >
    <p v-if="row.capabilityUnavailable" class="plugin-status__notice">
      {{ t('settings.plugins.capabilityUnavailable') }}
    </p>
    <p v-else-if="row.capability?.supported === false" class="plugin-status__notice">
      {{ t('settings.plugins.unsupported') }}
    </p>
    <p v-if="row.cloudOnly" class="plugin-status__notice">
      {{ t('settings.plugins.cloudOnly') }}
    </p>
    <p v-if="error" class="plugin-status__error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.plugin-status {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 0 var(--space-4) var(--space-3) 52px;
  font-size: var(--text-xs);
}

.plugin-status__error,
.plugin-status__notice {
  margin: 0;
  line-height: var(--leading-relaxed);
}

.plugin-status__error {
  color: var(--color-danger);
}

.plugin-status__notice {
  color: var(--color-text-muted);
}
</style>
