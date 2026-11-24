<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Skeleton } from '@moonshot-ai/app-ui';
import type { OpenMediaRequest } from '@moonshot-ai/app-core/client/types';
import { useBrowserReceipt } from '../browserReceipts';
import type { BrowserMark } from '../browserToolView';
import BrowserShot from './BrowserShot.vue';

const props = defineProps<{ sessionId?: string; receiptId: string }>();
const emit = defineEmits<{ openMedia: [payload: OpenMediaRequest] }>();
const { t } = useI18n();
const root = ref<HTMLElement | null>(null);
const { state, receipt } = useBrowserReceipt(() => ({ sessionId: props.sessionId, receiptId: props.receiptId }), root);

const media = computed(() => receipt.value ? { kind: 'image' as const, url: receipt.value.url, mimeType: 'image/jpeg' } : undefined);

const marks = computed<BrowserMark[]>(() => {
  const current = receipt.value;
  if (!current) return [];
  const { width, height, box, point } = current;
  return [
    ...(box ? [{ type: 'box' as const, tone: 'primary' as const, x: box.x * width, y: box.y * height, width: box.width * width, height: box.height * height }] : []),
    ...(point ? [{ type: 'point' as const, x: point.x * width, y: point.y * height }] : []),
  ];
});
</script>

<template>
  <div ref="root" class="brv">
    <BrowserShot
      v-if="state === 'ready' && receipt && media"
      :media="media"
      :width="receipt.width"
      :height="receipt.height"
      :marks="marks"
      @open-media="emit('openMedia', $event)"
    />
    <span v-else-if="state === 'idle' || state === 'loading'" class="brv-pending"><Skeleton width="100%" height="100%" /></span>
    <div v-else class="brv-note">{{ t(state === 'unsupported' ? 'tools.browser.detail.receiptDesktopOnly' : 'tools.browser.detail.receiptMissing') }}</div>
  </div>
</template>

<style scoped>
.brv {
  min-width: 0;
}
.brv-pending {
  display: block;
  width: min(100%, var(--browser-receipt-pending-width));
  aspect-ratio: 8 / 5;
}
.brv-note {
  color: var(--color-text-muted);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
}
</style>
