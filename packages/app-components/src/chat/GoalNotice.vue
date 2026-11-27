<script setup lang="ts">
import { computed, inject, nextTick, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon, IconButton } from '@moonshot-ai/app-ui';
import { PinScrollKey } from '@moonshot-ai/app-core/contracts';
import MessageTime from './MessageTime.vue';
import { useHistoryState } from './historyState';

const props = defineProps<{
  text: string;
  turnId?: string;
  createdAt?: string;
}>();

const { t } = useI18n();

const expanded = useHistoryState('goal:prompt:open', false);
const pinScroll = inject(PinScrollKey, () => {});
const rowEl = ref<HTMLElement | null>(null);
const toggleLabel = computed(() =>
  t(expanded.value ? 'conversation.goal.hidePrompt' : 'conversation.goal.showPrompt'),
);

function toggle(): void {
  expanded.value = !expanded.value;
  const el = rowEl.value;
  if (el) nextTick(() => pinScroll(el));
}
</script>

<template>
  <div
    class="gn goal-notice"
    :class="{ 'turn-anchor': !!turnId }"
    :data-turn-id="turnId"
    role="status"
  >
    <div class="gn-head">
      <Icon name="target" size="sm" class="gn-head-ico" aria-hidden="true" />
      <span class="gn-head-text">{{ t('conversation.goal.continuation') }}</span>
    </div>
    <div class="gn-bubble">
      <div ref="rowEl" class="gn-row">
        <IconButton
          v-if="props.text"
          class="gn-eye"
          size="sm"
          :label="toggleLabel"
          :tooltip="toggleLabel"
          :aria-expanded="expanded"
          @click="toggle"
        >
          <Icon :name="expanded ? 'eye-off' : 'eye'" size="sm" aria-hidden="true" />
        </IconButton>
        <span class="gn-text">{{ t('conversation.goal.bubble') }}</span>
      </div>
      <blockquote v-if="expanded && props.text" class="gn-quote">
        <span class="gn-quote-text">{{ props.text }}</span>
      </blockquote>
    </div>
    <div v-if="createdAt" class="gn-meta">
      <MessageTime :time="createdAt" />
    </div>
  </div>
</template>

<style scoped>
.gn {
  margin: 0;
  margin-inline-start: auto;
  align-self: flex-end;
  width: fit-content;
  max-width: 78%;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.gn-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
  padding: 0 var(--space-1);
  color: var(--color-text-faint);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
  overflow-wrap: anywhere;
}
.gn-head-ico {
  flex: none;
}

.gn-bubble {
  box-sizing: border-box;
  max-width: 100%;
  padding: var(--space-2) var(--space-3);
  background: var(--color-user-bubble-bg);
  border-radius: var(--radius-lg);
  color: var(--color-text);
  font-size: var(--content-font-size);
  line-height: var(--leading-normal);
}

.gn-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.gn-text {
  font-weight: var(--weight-section-label);
  color: var(--color-text-faint);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.gn-eye {
  margin-inline: calc(-1 * var(--space-1));
}

.gn-quote {
  margin: var(--space-1) 0 0;
  padding: 0 0 0 var(--space-3);
  border-left: 2px solid var(--color-line);
}
.gn-quote-text {
  display: block;
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text-faint);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.gn-meta {
  margin-top: var(--space-1);
  padding: 0 var(--space-1);
  color: var(--color-text-faint);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
}
</style>
