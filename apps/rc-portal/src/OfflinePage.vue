<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { Button } from '@moonshot-ai/app-ui';
import logoDarkText from './assets/kimi-code-logo-dark-text.svg';
import logoLightText from './assets/kimi-code-logo-light-text.svg';

const { t } = useI18n();
const router = useRouter();

function backHome(): void {
  void router.replace({ name: 'home' });
}
</script>

<template>
  <section class="offline-page" aria-labelledby="offline-title">
    <img class="offline-logo brand-logo-dark-text" :src="logoDarkText" alt="Kimi Code" />
    <img class="offline-logo brand-logo-light-text" :src="logoLightText" alt="" aria-hidden="true" />
    <h1 id="offline-title" class="offline-title">{{ t('devices.offlineTitle') }}</h1>
    <Button variant="primary" class="home-btn" @click="backHome">{{ t('devices.backHome') }}</Button>
  </section>
</template>

<style scoped>
.offline-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-6);
  padding: var(--space-4) 0 var(--space-2);
  text-align: center;
}
.offline-logo { width: auto; height: 32px; display: block; }
.brand-logo-light-text { display: none; }
html[data-color-scheme="dark"] .brand-logo-dark-text { display: none; }
html[data-color-scheme="dark"] .brand-logo-light-text { display: block; }
@media (prefers-color-scheme: dark) {
  html[data-color-scheme="system"] .brand-logo-dark-text { display: none; }
  html[data-color-scheme="system"] .brand-logo-light-text { display: block; }
}
.offline-title {
  margin: 0;
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  line-height: var(--leading-normal);
}
.home-btn { width: 100%; }
</style>
