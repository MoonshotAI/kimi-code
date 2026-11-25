<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppModel } from '@moonshot-ai/app-core/api';
import { providerDisplayName } from '@moonshot-ai/app-core/lib';
import { modelCapabilityItems } from '@moonshot-ai/app-client/lib';
import { Icon } from '@moonshot-ai/app-ui';

const props = defineProps<{
  model: AppModel;
}>();

const { t } = useI18n();
const modelName = computed(() => props.model.displayName ?? props.model.model);
const providerName = computed(() => providerDisplayName(props.model.provider, t));
const capabilities = computed(() => modelCapabilityItems(props.model));

function capabilityText(item: ReturnType<typeof modelCapabilityItems>[number]): string {
  switch (item.kind) {
    case 'context':
      return t('model.capabilityContext', { size: item.size });
    case 'image':
      return t('model.capabilityImageInput');
    case 'tool':
      return t('model.capabilityToolUse');
    case 'thinking':
      return t('model.capabilityThinking');
    case 'always-thinking':
      return t('model.capabilityAlwaysThinking');
  }
}
</script>

<template>
  <div class="model-cap-info">
    <div class="model-cap-info__names">
      <p class="model-cap-info__model" :title="modelName">{{ modelName }}</p>
      <p class="model-cap-info__provider" :title="providerName">{{ providerName }}</p>
    </div>
    <div v-if="capabilities.length > 0" class="model-cap-info__divider" />
    <ul v-if="capabilities.length > 0" class="model-cap-info__list">
      <li v-for="item in capabilities" :key="item.kind" class="model-cap-info__item">
        <Icon name="circle-check" size="sm" class="model-cap-info__icon" />
        <span>{{ capabilityText(item) }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.model-cap-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.model-cap-info__names {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
  line-height: 18px;
}
.model-cap-info__model {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  color: var(--color-text);
  font-weight: var(--weight-medium);
  overflow-wrap: anywhere;
}
.model-cap-info__provider {
  margin: 0;
  overflow: hidden;
  color: var(--color-text-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-cap-info__divider {
  width: 100%;
  height: var(--p-hairline);
  background: var(--color-line);
}
.model-cap-info__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.model-cap-info__item {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--color-text-muted);
  font-size: 13px;
  line-height: 18px;
}
.model-cap-info__icon {
  flex: none;
  color: var(--color-text-muted);
}
</style>
