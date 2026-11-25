<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, IconButton } from '@moonshot-ai/app-ui';
import { shortcutTooltip } from '../../composables/useShortcuts';

const emit = defineEmits<{ navigate: [direction: 'back' | 'forward'] }>();

const { t } = useI18n();
const navigation = typeof window === 'undefined' ? undefined : window.navigation;
const canGoBack = ref(navigation?.canGoBack ?? false);
const canGoForward = ref(navigation?.canGoForward ?? false);

function syncHistoryState(): void {
  canGoBack.value = navigation?.canGoBack ?? false;
  canGoForward.value = navigation?.canGoForward ?? false;
}

navigation?.addEventListener('currententrychange', syncHistoryState);
onBeforeUnmount(() => navigation?.removeEventListener('currententrychange', syncHistoryState));

const backTooltip = computed(() => shortcutTooltip(t('shortcuts.actions.navigateBack.label'), 'navigateBack'));
const forwardTooltip = computed(() => shortcutTooltip(t('shortcuts.actions.navigateForward.label'), 'navigateForward'));
</script>

<template>
  <div class="history-nav">
    <IconButton
      size="sm"
      :label="backTooltip.text"
      :tooltip="backTooltip.text"
      :keys="backTooltip.keys"
      :disabled="!canGoBack"
      @click="emit('navigate', 'back')"
    >
      <Icon name="arrow-left" />
    </IconButton>
    <IconButton
      size="sm"
      :label="forwardTooltip.text"
      :tooltip="forwardTooltip.text"
      :keys="forwardTooltip.keys"
      :disabled="!canGoForward"
      @click="emit('navigate', 'forward')"
    >
      <Icon name="arrow-right" />
    </IconButton>
  </div>
</template>

<style scoped>
.history-nav {
  display: flex;
  align-items: center;
  -webkit-app-region: no-drag;
}
</style>
