<!-- apps/kimi-web/src/components/ui/CommandBar.vue -->
<!-- Design-system §03 Command Bar: primary action + mono command + copy. -->
<script setup lang="ts">
import { useKimiI18n } from '@moonshot-ai/web-i18n';
import IconButton from './IconButton.vue';
import Icon from './Icon.vue';

const props = defineProps<{ command: string }>();

const { t } = useKimiI18n();

async function copy() {
  try {
    await navigator.clipboard.writeText(props.command);
  } catch {
    /* ignore */
  }
}
</script>

<template>
  <div class="ui-cmdbar">
    <span class="ui-cmdbar__action"><slot /></span>
    <span class="ui-cmdbar__cmd">
      <code class="ui-cmdbar__text">{{ command }}</code>
      <IconButton size="sm" :label="t('common.copy')" :tooltip="t('common.copy')" @click="copy">
        <Icon name="copy" size="md" />
      </IconButton>
    </span>
  </div>
</template>

<style scoped>
.ui-cmdbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ui-cmdbar__cmd {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex: 1;
  min-width: 0;
  height: 38px;
  padding: 0 10px 0 14px;
  background: var(--color-surface-sunken);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-md);
}
.ui-cmdbar__text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}
</style>
