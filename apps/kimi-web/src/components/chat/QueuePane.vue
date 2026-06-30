<!-- apps/kimi-web/src/components/chat/QueuePane.vue -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { QueuedPromptView } from '../../types';
import Icon from '../ui/Icon.vue';
import Tooltip from '../ui/Tooltip.vue';

const props = defineProps<{
  queued: QueuedPromptView[];
  running?: boolean;
  /** Render as plain dock content (no header / card borders), like TasksPane and TodoCard. */
  inline?: boolean;
}>();

const emit = defineEmits<{
  steer: [];
  unqueue: [index: number];
  editQueued: [index: number];
}>();

const { t } = useI18n();

function editQueued(index: number, msg: QueuedPromptView): void {
  if (msg.attachmentCount > 0) return;
  emit('editQueued', index);
}
</script>

<template>
  <div class="queue-pane" :class="{ 'tab-mode': inline }">
    <div v-if="!inline" class="queue-head">
      <span class="queue-label">{{ t('composer.queueLabel') }} · {{ queued.length }}</span>
      <!-- Steer the whole queue into the running turn right now (TUI ctrl+s) -->
      <Tooltip :text="t('composer.steerTitle')">
        <button
          v-if="running"
          class="queue-steer"
          type="button"
          @click="emit('steer')"
        >{{ t('composer.steerNow') }}</button>
      </Tooltip>
    </div>
    <div class="queue-list">
      <div
        v-for="(msg, i) in queued"
        :key="i"
        class="queue-item"
      >
        <Tooltip :text="msg.attachmentCount > 0 ? t('composer.queuedHasImage', { n: msg.attachmentCount }) : t('composer.editQueued')">
          <button
            class="queue-text"
            type="button"
            :disabled="msg.attachmentCount > 0"
            @click="editQueued(i, msg)"
          >
            <Icon v-if="msg.attachmentCount > 0" class="queue-img" name="image" size="sm" />
            <span class="queue-text-inner" :class="{ placeholder: !msg.text }">{{ msg.text || t('composer.queuedImageOnly', { n: msg.attachmentCount }) }}</span>
          </button>
        </Tooltip>
        <Tooltip :text="t('composer.remove')">
          <button class="queue-rm" @click="emit('unqueue', i)">
            <Icon name="close" size="sm" />
          </button>
        </Tooltip>
      </div>
    </div>
  </div>
</template>

<style scoped>
.queue-pane {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* Tab mode: plain dock content, matching TasksPane and TodoCard. */
.queue-pane.tab-mode {
  gap: 2px;
}
.queue-pane.tab-mode .queue-head {
  display: none;
}
.queue-pane.tab-mode .queue-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.queue-pane.tab-mode .queue-item {
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 4px 0;
  font-size: var(--text-base);
}
.queue-pane.tab-mode .queue-text:hover:not(:disabled) {
  color: var(--color-accent);
}
.queue-pane.tab-mode .queue-rm {
  opacity: 0;
  transition: opacity 0.12s;
}
.queue-pane.tab-mode .queue-item:hover .queue-rm {
  opacity: 1;
}

.queue-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.queue-label {
  font-size: var(--ui-font-size-xs);
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  margin-right: 2px;
}

.queue-item {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 6px 8px;
  font-size: var(--ui-font-size);
  color: var(--color-text);
  min-width: 0;
}

/* "Steer now" — inject the queue into the running turn (TUI ctrl+s) */
.queue-steer {
  margin-left: auto;
  background: none;
  border: 1px solid var(--color-accent-bd);
  border-radius: var(--radius-xs);
  padding: 2px 8px;
  font-family: var(--mono);
  font-size: var(--text-base);
  color: var(--color-accent-hover);
  cursor: pointer;
  white-space: nowrap;
}
.queue-steer:hover {
  background: var(--color-accent-soft);
}

.queue-text {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  font-size: var(--ui-font-size);
  color: var(--color-text);
  cursor: pointer;
  text-align: left;
}
.queue-text:hover:not(:disabled) {
  color: var(--color-accent);
}
.queue-text:disabled {
  cursor: default;
}
.queue-img { flex: none; color: var(--muted); }
.queue-text-inner {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.queue-text-inner.placeholder { color: var(--muted); }

.queue-rm {
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  padding: 1px;
  cursor: pointer;
  color: var(--muted);
  flex-shrink: 0;
}

.queue-rm:hover {
  color: var(--color-danger);
}

.queue-item,
.queue-text { font-family: var(--sans); }
</style>
