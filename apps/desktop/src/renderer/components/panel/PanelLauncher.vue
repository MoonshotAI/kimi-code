<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, Kbd, MenuItem } from '@moonshot-ai/app-ui';
import type { PanelLauncherType } from '@moonshot-ai/app-client/panel';
import { useIsMobile } from '@moonshot-ai/app-client/composables';
import { panelLauncherItems } from '../../lib/panelLauncher';

const props = defineProps<{
  canOpenDiff: boolean;
  canOpenFiles: boolean;
  canOpenTerm: boolean;
  canOpenBrowser: boolean;
  canOpenBtw: boolean;
}>();

const emit = defineEmits<{
  open: [type: PanelLauncherType];
}>();

const { t } = useI18n();
const isMobile = useIsMobile();

const items = computed(() =>
  panelLauncherItems(
    {
      diff: props.canOpenDiff,
      files: props.canOpenFiles,
      browser: props.canOpenBrowser,
      term: props.canOpenTerm,
      btw: props.canOpenBtw,
    },
    t,
  ),
);
</script>

<template>
  <div class="pl" role="group" :aria-label="t('panel.launcherAria')">
    <MenuItem
      v-for="item in items"
      :key="item.type"
      role="button"
      :size="isMobile ? 'lg' : 'md'"
      :disabled="item.disabled"
      @click="emit('open', item.type)"
    >
      <Icon :name="item.icon" size="sm" />
      {{ item.label }}
      <Kbd v-if="item.keys.length > 0" class="pl-kbd" :keys="item.keys" />
    </MenuItem>
  </div>
</template>

<style scoped>
.pl {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--space-3);
  height: 100%;
  box-sizing: border-box;
  width: min(var(--panel-launcher-w), 100%);
  margin-inline: auto;
  padding: var(--space-2) 0;
}
.pl-kbd {
  margin-left: auto;
}
</style>
