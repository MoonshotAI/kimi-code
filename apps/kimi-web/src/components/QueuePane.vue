<!-- apps/kimi-web/src/components/QueuePane.vue -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { QueuedPromptView } from '../types';

const props = defineProps<{
  queued: QueuedPromptView[];
  running?: boolean;
  /** Render as plain dock content (no header/card borders) like TasksPane/TodoCard in tab mode. */
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
      <button
        v-if="running"
        class="queue-steer"
        type="button"
        :title="t('composer.steerTitle')"
        @click="emit('steer')"
      >{{ t('composer.steerNow') }}</button>
    </div>
    <div class="queue-list">
      <div
        v-for="(msg, i) in queued"
        :key="i"
        class="queue-item"
      >
        <button
          class="queue-text"
          type="button"
          :disabled="msg.attachmentCount > 0"
          :title="msg.attachmentCount > 0 ? t('composer.queuedHasImage', { n: msg.attachmentCount }) : t('composer.editQueued')"
          @click="editQueued(i, msg)"
        >
          <svg v-if="msg.attachmentCount > 0" class="queue-img" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><circle cx="5.5" cy="6.5" r="1.2"/><path d="M2.5 12l3.5-3.5 2.5 2.5 3-3 2 2"/></svg>
          <span class="queue-text-inner" :class="{ placeholder: !msg.text }">{{ msg.text || t('composer.queuedImageOnly', { n: msg.attachmentCount }) }}</span>
        </button>
        <button class="queue-rm" :title="t('composer.remove')" @click="emit('unqueue', i)">
          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" xmlns="http://www.w3.org/2000/svg"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
        </button>
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

/* Tab mode: plain dock content, matching TasksPane/TodoCard inline styling. */
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
  font-size: calc(var(--ui-font-size) - 1.5px);
}
.queue-pane.tab-mode .queue-text:hover:not(:disabled) {
  color: var(--blue);
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
  color: var(--text);
  min-width: 0;
}

/* "Steer now" — inject the queue into the running turn (TUI ctrl+s) */
.queue-steer {
  margin-left: auto;
  background: none;
  border: 1px solid var(--blueln);
  border-radius: 3px;
  padding: 2px 8px;
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--blue2);
  cursor: pointer;
  white-space: nowrap;
}
.queue-steer:hover {
  background: var(--bluebg);
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
  color: var(--text);
  cursor: pointer;
  text-align: left;
}
.queue-text:hover:not(:disabled) {
  color: var(--blue);
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
  color: var(--err);
}
</style>
