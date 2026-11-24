<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { openUpgrade } from '@moonshot-ai/app-core/lib';
import { Button } from '@moonshot-ai/app-ui';

const { t } = useI18n();
</script>

<template>
  <section class="sec">
    <h3 class="sec-title">{{ t('settings.planUsage.title') }}</h3>
    <div class="pu-group">
      <div class="pu-row">
        <span class="pu-main">
          <span class="pu-label">{{ t('settings.planUsage.freeTitle') }}</span>
          <span class="pu-hint">{{ t('settings.planUsage.freeHint') }}</span>
        </span>
        <Button variant="primary" size="sm" @click="openUpgrade()">{{ t('login.upgradeNow') }}</Button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.sec {
  margin-bottom: var(--space-5);
}
.sec-title {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  margin: 0 0 var(--space-3);
}
.pu-group {
  overflow: hidden;
  border-radius: var(--radius-xl);
  background: var(--color-surface);
}
.pu-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 52px;
  padding: var(--space-3) var(--space-4);
}
.pu-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.pu-label {
  font-size: var(--text-sm);
  color: var(--color-text);
}
.pu-hint {
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
</style>
