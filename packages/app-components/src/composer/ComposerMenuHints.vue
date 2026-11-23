<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Kbd } from '@moonshot-ai/app-ui';

const { t } = useI18n();
</script>

<template>
  <div class="composer-menu-hints" aria-hidden="true">
    <span class="cmh-hint"><Kbd :keys="['arrowup', 'arrowdown']" />{{ t('composer.menuHintNavigate') }}</span>
    <span class="cmh-hint"><Kbd :keys="['enter']" />{{ t('composer.menuHintSelect') }}</span>
    <span class="cmh-hint"><Kbd :keys="['tab']" />{{ t('composer.menuHintComplete') }}</span>
    <span class="cmh-hint"><Kbd :keys="['escape']" />{{ t('composer.menuHintClose') }}</span>
  </div>
</template>

<style scoped>
.composer-menu-hints {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-3);
  margin: var(--space-1-5) calc(-1 * var(--space-3)) 0;
  padding: var(--space-1-5) var(--space-3) 0;
  border-top: var(--p-hairline) solid var(--color-line);
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
}
.cmh-hint {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
</style>
