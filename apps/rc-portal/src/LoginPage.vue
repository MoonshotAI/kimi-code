<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import { Spinner } from '@moonshot-ai/app-ui';
import { parseRedirectUri } from './helpers';
import { probeSession } from './session';
import LoginFlow from './LoginFlow.vue';

const { t } = useI18n();
const route = useRoute();

const checking = ref(true);
const redirectUri = ref<string | null>(null);

onMounted(async () => {
  redirectUri.value = parseRedirectUri(route.query.redirect_uri);
  if (redirectUri.value && (await probeSession())) {
    location.replace(redirectUri.value);
    return;
  }
  checking.value = false;
});
</script>

<template>
  <div v-if="checking" class="center-body">
    <Spinner size="md" />
    <span class="center-text">{{ t('login.rcChecking') }}</span>
  </div>
  <LoginFlow v-else :redirect-uri="redirectUri" />
</template>
