<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Link, Tooltip } from '@moonshot-ai/app-ui';

defineProps<{ iconOnly?: boolean }>();
const { locale, t } = useI18n();
const href = computed(() => `https://www.kimi.com/code/docs/${locale.value.startsWith('zh') ? '' : 'en/'}kimi-code/feedback.html`);
</script>

<template>
  <Tooltip v-if="iconOnly" :text="t('feedback.guideTooltip')" arrow>
    <Link class="feedback-help" :href="href" external :aria-label="t('feedback.guideTooltip')">
      <span aria-hidden="true" />
    </Link>
  </Tooltip>
  <Link v-else :href="href" external>{{ t('feedback.learnMore') }}</Link>
</template>

<style scoped>
.feedback-help {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  color: var(--color-text-faint);
}
.feedback-help > span {
  width: 14px;
  height: 14px;
  background: currentColor;
  mask: url('./assets/help.svg') center / contain no-repeat;
}
</style>
