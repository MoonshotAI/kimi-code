<!-- apps/kimi-web/src/components/AsyncErrorFallback.vue -->
<!-- Shared error fallback for defineAsyncComponent. Shown when a lazy-loaded
     chunk fails to load. The retry button reloads the page — the most
     reliable way to recover from a failed chunk fetch. -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
const retry = () => window.location.reload();
</script>

<template>
  <div class="async-load-error">
    <span class="async-load-error__text">{{ t('common.loadErrorTitle') }}</span>
    <button class="async-load-error__retry" @click="retry">{{ t('common.loadErrorRetry') }}</button>
  </div>
</template>
