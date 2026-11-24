<script setup lang="ts">
import { ref, watch } from 'vue';
import { Favicon, Icon, Tooltip } from '@moonshot-ai/app-ui';
import type { PanelTabPresentation } from '@moonshot-ai/app-client/composables';

const props = defineProps<{ title: string; icon: string; presentation?: PanelTabPresentation }>();
const faviconFailed = ref(false);
watch(() => props.presentation?.favicon, () => { faviconFailed.value = false; });
</script>
<template>
  <Favicon v-if="presentation?.favicon && !faviconFailed" class="panel-tab-favicon" :src="presentation.favicon" draggable="false" @error="faviconFailed = true" />
  <Icon v-else :name="presentation?.icon ?? icon" size="sm" />
  <span class="panel-tab-title">{{ presentation?.title ?? title }}</span>
  <Tooltip v-if="presentation?.status" :text="presentation.status.label">
    <span class="panel-tab-status" role="img" :aria-label="presentation.status.label">
      <Icon :name="presentation.status.icon" size="sm" aria-hidden="true" />
    </span>
  </Tooltip>
</template>
<style scoped>
.panel-tab-favicon {
  width: var(--p-ic-sm);
  height: var(--p-ic-sm);
  flex: none;
  object-fit: contain;
}
.panel-tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
}
.panel-tab-status {
  display: inline-flex;
  align-items: center;
  flex: none;
  color: var(--color-text-muted);
}
</style>
