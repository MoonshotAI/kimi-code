<script setup lang="ts">
import { computed, inject } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@moonshot-ai/app-ui';
import { DesktopFeedbackKey, type TurnFeedbackTarget } from '../../composables/useDesktopFeedback';

const props = defineProps<{ target: TurnFeedbackTarget | undefined }>();
const feedback = inject(DesktopFeedbackKey);
const { t } = useI18n();
const status = computed(() => {
  const saved = feedback?.state(props.target);
  return saved?.kind === 'recorded' ? saved.record.status : undefined;
});
</script>

<template>
  <span v-if="status !== undefined" class="feedback-status" role="status">
    <Icon name="check" size="sm" />
    {{ t('feedback.rated') }}
  </span>
</template>

<style scoped>
.feedback-status {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: light-dark(rgb(0 0 0 / 45%), rgb(255 255 255 / 42%));
  font-size: var(--ui-c1);
  line-height: 1.5;
}
.feedback-status :deep(svg) { width: 14px; height: 14px; }
</style>
