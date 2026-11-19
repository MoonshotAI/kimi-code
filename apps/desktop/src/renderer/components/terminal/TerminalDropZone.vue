<script setup lang="ts">
import { onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import { useNativeTerminal } from '../../composables/useNativeTerminal';
import { bottomPanelDropTargets, pointInsideElement } from '../../lib/terminalTabDropTarget';

const store = useNativeTerminal();
const { t } = useI18n();
const rootEl = ref<HTMLElement | null>(null);
const revealed = ref(false);
const over = ref(false);

onUnmounted(bottomPanelDropTargets.register({
  hover(x, y) {
    revealed.value = !store.open.value;
    over.value = revealed.value && pointInsideElement(rootEl.value, x, y);
    return over.value ? store.tabs.value.length : null;
  },
  clear() {
    revealed.value = false;
    over.value = false;
  },
}));
</script>

<template>
  <div v-if="revealed" ref="rootEl" class="terminal-drop-zone" :class="{ over }" aria-hidden="true">
    <Icon name="terminal" size="sm" />
    {{ t('terminal.dropToOpen') }}
  </div>
</template>

<style scoped>
.terminal-drop-zone {
  grid-column: 3;
  grid-row: 1;
  align-self: end;
  z-index: var(--z-sticky);
  height: calc(var(--space-8) * 1.5);
  margin: var(--space-2);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border: 1px dashed var(--color-line-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-md);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  pointer-events: none;
}
.terminal-drop-zone.over {
  border-style: solid;
  border-color: var(--color-accent);
  background: linear-gradient(var(--color-accent-soft), var(--color-accent-soft)), var(--color-surface-raised);
  box-shadow: var(--p-focus-ring), var(--shadow-md);
  color: var(--color-accent);
}
</style>
