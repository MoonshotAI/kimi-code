<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Badge, Icon, IconButton, Link, Spinner } from '@moonshot-ai/app-ui';
import {
  isKimiCuMacCapability,
  isKimiCuPermissionMissing,
  isWebBridgeExtensionDisconnected,
  pluginUsesInstalledCapabilities,
  readKimiCuPermissions,
  usePlugins,
  useMcpAuthorization,
  type PluginViewModel,
} from '@moonshot-ai/app-client/composables';
import type { AppPluginCapabilities } from '@moonshot-ai/app-core/api';
import PluginActions from './PluginActions.vue';
import PluginCapabilities from './PluginCapabilities.vue';
import PluginIcon from './PluginIcon.vue';
import PluginStatus from './PluginStatus.vue';

const props = withDefaults(defineProps<{
  row: PluginViewModel;
  sourceView: 'marketplace' | 'installed';
  cuPermissionWaiting?: boolean;
}>(), {
  cuPermissionWaiting: false,
});
const emit = defineEmits<{
  back: [];
  installed: [row: PluginViewModel];
  openWebbridgeGuide: [];
  requestCuPermissions: [];
}>();
const { t, locale } = useI18n();
const { loadPluginCapabilities } = usePlugins({ locale });

const originLabel = computed(() => {
  if (props.sourceView === 'installed' && props.row.installedPlugin?.origin === 'custom') {
    return t('settings.plugins.custom');
  }
  if (props.row.official) return t('settings.plugins.official');
  if (props.row.catalogEntry !== undefined) return t('settings.plugins.curated');
  if (props.row.installedPlugin?.origin === 'marketplace') {
    return t('settings.plugins.marketplaceGroup');
  }
  return t('settings.plugins.custom');
});
const breadcrumbParent = computed(() =>
  props.sourceView === 'installed'
    ? t('settings.plugins.myPlugins')
    : t('settings.plugins.marketplaceGroup'),
);
const officialBadge = computed(() => originLabel.value === t('settings.plugins.official'));
const showWebBridgeBadge = computed(() => isWebBridgeExtensionDisconnected(props.row));
const showCuWaitingBadge = computed(() =>
  props.cuPermissionWaiting &&
  isKimiCuMacCapability(props.row) &&
  props.row.installedPlugin?.enabled === true &&
  !readKimiCuPermissions(props.row).granted,
);
const showCuPermissionBadge = computed(() =>
  !showCuWaitingBadge.value && isKimiCuPermissionMissing(props.row),
);

const capabilities = ref<AppPluginCapabilities>();
const capabilitiesLoading = ref(false);
const capabilitiesError = ref<string>();
let capabilitiesGeneration = 0;
const capabilitiesKey = computed(() =>
  [
    props.row.id,
    props.row.installedPlugin?.id ?? '',
    props.row.installedPlugin?.version ?? '',
    props.row.catalogEntry?.version ?? '',
    props.sourceView,
    locale.value,
  ].join(':'),
);

async function loadCapabilities(): Promise<void> {
  const generation = ++capabilitiesGeneration;
  capabilitiesLoading.value = true;
  capabilitiesError.value = undefined;
  capabilities.value = undefined;
  try {
    const result = await loadPluginCapabilities(props.row, props.sourceView);
    if (generation === capabilitiesGeneration) capabilities.value = result;
  } catch (error) {
    if (generation !== capabilitiesGeneration) return;
    capabilitiesError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (generation === capabilitiesGeneration) capabilitiesLoading.value = false;
  }
}

watch(capabilitiesKey, loadCapabilities, { immediate: true });

const {
  states: authorization,
  refresh: refreshAuthorization,
  authorize,
  cancel,
  reset,
} = useMcpAuthorization();
const pluginId = computed(() =>
  pluginUsesInstalledCapabilities(props.row, props.sourceView)
    ? props.row.installedPlugin!.id
    : undefined,
);
const authorizationRefreshError = ref<string>();
const authorizationError = computed(() =>
  authorizationRefreshError.value ??
  (pluginId.value === undefined ? undefined : authorization[pluginId.value]?.discoveryError),
);

async function refreshAuthorizationStatuses(): Promise<void> {
  authorizationRefreshError.value = undefined;
  if (pluginId.value === undefined) return;
  try {
    await refreshAuthorization(pluginId.value);
  } catch (error) {
    authorizationRefreshError.value = error instanceof Error ? error.message : String(error);
  }
}

watch([pluginId, () => props.row.installedPlugin?.version], () => {
  void refreshAuthorizationStatuses();
}, { immediate: true });
</script>

<template>
  <section class="plugin-details">
    <header class="plugin-details__header">
      <IconButton
        size="sm"
        :label="t('settings.plugins.back')"
        :tooltip="t('settings.plugins.back')"
        @click="emit('back')"
      >
        <Icon name="arrow-left" size="md" />
      </IconButton>
      <h3 class="plugin-details__title">{{ breadcrumbParent }} / {{ row.displayName }}</h3>
    </header>

    <div class="plugin-details__hero">
      <PluginIcon :src="row.iconUrl" size="lg" />
      <div class="plugin-details__identity">
        <div class="plugin-details__name-line">
          <h4 class="plugin-details__name">{{ row.displayName }}</h4>
          <Badge size="sm" variant="neutral" :class="{ 'plugin-details__badge--official': officialBadge }">
            {{ originLabel }}
          </Badge>
          <button
            v-if="showWebBridgeBadge"
            type="button"
            class="plugin-details__status-badge"
            @click="emit('openWebbridgeGuide')"
          >
            <Badge size="sm" variant="warning">
              {{ t('settings.plugins.webbridgeDisconnected') }}
            </Badge>
          </button>
          <Badge
            v-else-if="showCuWaitingBadge"
            size="sm"
            variant="warning"
            class="plugin-details__status-waiting"
          >
            <Spinner size="sm" />
            {{ t('settings.plugins.cuPermissionWaiting') }}
          </Badge>
          <button
            v-else-if="showCuPermissionBadge"
            type="button"
            class="plugin-details__status-badge"
            @click="emit('requestCuPermissions')"
          >
            <Badge size="sm" variant="warning">
              {{ t('settings.plugins.cuPermissionMissing') }}
            </Badge>
          </button>
        </div>
        <p v-if="row.shortDescription" class="plugin-details__tagline">{{ row.shortDescription }}</p>
      </div>
      <PluginActions :row="row" @installed="emit('installed', $event)" />
    </div>

    <PluginStatus :row="row" />

    <div class="plugin-details__content">
      <section v-if="row.longDescription || row.catalogEntry?.homepage" class="plugin-details__section">
        <h4 class="plugin-details__section-title">{{ t('settings.plugins.introduction') }}</h4>
        <p v-if="row.longDescription" class="plugin-details__description">{{ row.longDescription }}</p>
        <Link
          v-if="row.catalogEntry?.homepage"
          :href="row.catalogEntry.homepage"
          external
          variant="muted"
          class="plugin-details__homepage"
        >
          {{ t('settings.plugins.homepage') }}
          <Icon name="external-link" size="sm" />
        </Link>
      </section>
      <PluginCapabilities
        :capabilities="capabilities"
        :loading="capabilitiesLoading"
        :error="capabilitiesError"
        :plugin-id="pluginId"
        :authorization="authorization"
        :authorization-error="authorizationError"
        @authorize="authorize"
        @cancel="cancel"
        @reset="reset"
        @retry="refreshAuthorizationStatuses"
        @retry-capabilities="loadCapabilities"
      />
    </div>
  </section>
</template>

<style scoped>
.plugin-details {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  -webkit-user-select: text;
  user-select: text;
}

.plugin-details__header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.plugin-details__title,
.plugin-details__name,
.plugin-details__description,
.plugin-details__section-title {
  margin: 0;
}

.plugin-details__title {
  color: var(--color-text-muted);
  font-size: var(--text-base);
  font-weight: var(--weight-regular);
}

.plugin-details__hero {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.plugin-details__hero > :deep(.plugin-actions) {
  flex: none;
  padding: 0;
}

.plugin-details__identity {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
}

.plugin-details__name-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.plugin-details__name {
  color: var(--color-text);
  font-size: var(--text-lg);
  font-weight: var(--weight-medium);
}

.plugin-details__badge--official {
  background: var(--color-text);
  color: var(--color-surface);
}

.plugin-details__status-badge {
  display: inline-flex;
  padding: 0;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  cursor: pointer;
}

.plugin-details__status-badge:hover :deep(.ui-badge) {
  border-color: var(--color-warning);
}

.plugin-details__status-badge:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}

.plugin-details__status-waiting {
  gap: var(--space-1);
}

.plugin-details__tagline {
  max-width: 760px;
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  overflow-wrap: anywhere;
}

.plugin-details__content,
.plugin-details__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.plugin-details__section-title {
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}

.plugin-details__description {
  color: var(--color-text);
  font-size: var(--text-sm);
  line-height: var(--leading-relaxed);
  white-space: pre-wrap;
}

.plugin-details__homepage {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: var(--space-1);
}

.plugin-details > :deep(.plugin-status) {
  padding: 0 0 var(--space-4);
}
</style>
