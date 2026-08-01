<!-- apps/web/src/components/settings/PlanUpgradeCard.vue -->
<!-- Settings → Account: the upgrade entry shown for a free managed account in
     place of the plan-usage module — free accounts can't call usages, so
     there is nothing to meter. Rendered directly by SettingsDialog once the
     userinfo probe has confirmed the free state (402), and by PlanUsageCard
     itself when its own fetch comes back 402/403 while the probe is still in
     flight. -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { openUpgrade } from '../../lib/upgrade';
import { Button } from '@moonshot-ai/web-ui';

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
        <Button variant="primary" size="sm" @click="openUpgrade()">{{ t('sidebar.upgrade') }}</Button>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Same shell as PlanUsageCard so the entry reads as the same module. */
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
