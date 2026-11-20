<script setup lang="ts">
import { computed, inject, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { track } from '@moonshot-ai/app-client/contracts';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import { Icon, IconButton } from '@moonshot-ai/app-ui';
import { useNativeTerminal } from '../../composables/useNativeTerminal';
import { shortcutTooltip } from '../../composables/useShortcuts';

const { t } = useI18n();

const client = useKimiWebClient();
const workspaceRoot = computed(() => client.activeMainDirectory.value || client.status.value.cwd);

const terminalStore = useNativeTerminal();

const terminalToggleLabel = computed(() =>
  terminalStore.open.value ? t('terminal.close') : t('terminal.open'),
);

const terminalTooltip = computed(() => shortcutTooltip(terminalToggleLabel.value, 'toggleTerminal'));

function toggleTerminalPanel(): void {
  terminalStore.toggle(workspaceRoot.value);
}

const panelApi = inject(panelApiKey);
const panelOpen = computed(() => panelApi?.isVisible() ?? false);

function toggleRightPanel(): void {
  track('session_menu_action', { action: 'togglePanel' });
  panelApi?.togglePanel();
  void nextTick(() => {
    document.querySelector<HTMLElement>('.ptb-hide')?.focus();
  });
}
</script>

<template>
  <div class="ch-toggles">
    <IconButton
      v-if="terminalStore.available"
      class="ch-terminal"
      :class="{ open: terminalStore.open.value }"
      :label="terminalToggleLabel"
      :tooltip="terminalTooltip.text"
      :keys="terminalTooltip.keys"
      @click="toggleTerminalPanel"
    >
      <Icon name="terminal" size="sm" />
    </IconButton>
    <IconButton
      v-if="panelApi && !panelOpen"
      class="ch-panel"
      :label="t('panel.openPanel')"
      :tooltip="t('panel.openPanel')"
      @click="toggleRightPanel"
    >
      <Icon name="panel-expand-right" size="sm" />
    </IconButton>
  </div>
</template>

<style scoped>
.ch-toggles {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.ch-toggles button { -webkit-app-region: no-drag; }
.ch-toggles .ch-terminal { width: var(--icon-button-sm); height: var(--icon-button-sm); border-radius: var(--radius-sm); }
.ch-toggles .ch-terminal :deep(svg) { width: var(--p-ic-md); height: var(--p-ic-md); }
.ch-terminal.open { background: var(--color-well); color: var(--color-text); }
.ch-toggles .ch-panel { width: var(--icon-button-sm); height: var(--icon-button-sm); border-radius: var(--radius-sm); }
.ch-toggles .ch-panel :deep(svg) { width: var(--p-ic-md); height: var(--p-ic-md); }
</style>
