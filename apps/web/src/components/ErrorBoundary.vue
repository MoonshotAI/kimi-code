<script setup lang="ts">
// Error boundary: retryable fallback when the slot subtree throws. Reporting
// stays with app.config.errorHandler (the hook does not stop propagation).
import { onErrorCaptured, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Icon, IconButton } from '@moonshot-ai/app-ui';

const { closable = false, fullscreen = false } = defineProps<{
  closable?: boolean;
  fullscreen?: boolean;
}>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const failed = ref(false);

onErrorCaptured(() => {
  failed.value = true;
});

function retry(): void {
  failed.value = false;
}
</script>

<template>
  <slot v-if="!failed" />
  <div v-else class="error-boundary" :class="{ fullscreen }" role="alert">
    <IconButton
      v-if="closable"
      class="error-boundary-close"
      size="sm"
      :label="t('common.close')"
      :tooltip="t('common.close')"
      @click="emit('close')"
    >
      <Icon name="close" size="sm" />
    </IconButton>
    <Icon class="error-boundary-icon" name="alert-triangle" size="lg" />
    <p class="error-boundary-title">{{ t('common.errorBoundaryTitle') }}</p>
    <Button size="sm" @click="retry">{{ t('common.errorBoundaryRetry') }}</Button>
  </div>
</template>

<style scoped>
.error-boundary {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  height: 100%;
  padding: var(--space-6);
}

.error-boundary.fullscreen {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  background: var(--color-bg);
}

.error-boundary-close {
  position: absolute;
  top: var(--space-4);
  right: var(--space-4);
}

.error-boundary-icon {
  color: var(--color-warning);
}

.error-boundary-title {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
}
</style>
