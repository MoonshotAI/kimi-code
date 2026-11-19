<script setup lang="ts">
import { computed, inject } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, IconButton } from '@moonshot-ai/app-ui';
import { OpenWithDefaultAppKey } from '@moonshot-ai/app-client/contracts';
import { useWarningsStore, workspacesStore } from '@moonshot-ai/app-client/stores';
import { OpenHtmlFileInPanelKey } from '@moonshot-ai/app-core/contracts';

const props = defineProps<{ path: string }>();

const { t } = useI18n();

const HTML_EXTENSION = /\.html?$/i;

const openWithDefaultApp = inject(OpenWithDefaultAppKey, undefined);
const resolveOpenInPanel = inject(OpenHtmlFileInPanelKey, undefined);
const warningsStore = useWarningsStore();
const localWorkspace = computed(() => workspacesStore().isLocalWorkspace);

const isHtmlPath = computed(() => HTML_EXTENSION.test(props.path));
const panelOpener = computed(() => (isHtmlPath.value && localWorkspace.value ? resolveOpenInPanel?.() : undefined));

async function openInSystemBrowser(): Promise<void> {
  if (props.path === '' || openWithDefaultApp === undefined) return;
  try {
    const ok = await openWithDefaultApp(props.path);
    if (!ok) warningsStore.pushWarning({ severity: 'error', title: t('filePreview.openFailed') });
  } catch {
    warningsStore.pushWarning({ severity: 'error', title: t('filePreview.openFailed') });
  }
}

function openInPanelBrowser(): void {
  const open = panelOpener.value;
  if (open === undefined || props.path === '') return;
  open({ path: props.path });
}
</script>

<template>
  <IconButton
    v-if="openWithDefaultApp && isHtmlPath && localWorkspace"
    size="sm"
    :label="t('filePreview.openInSystemBrowser')"
    :tooltip="t('filePreview.openInSystemBrowser')"
    @click="openInSystemBrowser"
  >
    <Icon name="external-link" size="md" />
  </IconButton>
  <IconButton
    v-if="panelOpener"
    size="sm"
    :label="t('filePreview.openInPanelBrowser')"
    :tooltip="t('filePreview.openInPanelBrowser')"
    @click="openInPanelBrowser"
  >
    <Icon name="browser" size="md" />
  </IconButton>
</template>
