<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { openUpgrade } from '@moonshot-ai/app-core/lib';
import { Button } from '@moonshot-ai/app-ui';

const { t } = useI18n();
</script>

<template>
  <section class="sec">
    <h3 class="sec-title">{{ t('settings.planUsage.title') }}</h3>
    <div class="settings-group settings-group-divided">
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

<style scoped src="./settings-common.css"></style>

<style scoped>
.sec {
  margin-bottom: var(--space-5);
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
