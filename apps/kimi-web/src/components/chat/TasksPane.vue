<!-- apps/kimi-web/src/components/chat/TasksPane.vue -->
<!-- TUI-inspired todo list: clean rows with status glyphs, strikethrough done,
     compact output, minimal chrome. Matches the terminal todo-panel style. -->
<script setup lang="ts">
import { reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TaskItem } from '../../types';
import { copyTextToClipboard } from '../../lib/clipboard';
import Badge from '../ui/Badge.vue';
import Icon from '../ui/Icon.vue';
import StatusGlyph, { type StatusGlyphStatus } from './StatusGlyph.vue';

defineProps<{ tasks: TaskItem[] }>();

const emit = defineEmits<{
  cancel: [taskId: string];
  /** A subagent row was clicked — open its live detail in the side panel. */
  open: [taskId: string];
}>();

const { t } = useI18n();

// Which task rows are expanded (showing their output/detail). Click a row to
// toggle. Persisted only for the component's lifetime.
const expandedIds = reactive(new Set<string>());
const copiedCommandIds = reactive(new Set<string>());
const copiedOutputIds = reactive(new Set<string>());

function hasDetail(task: TaskItem): boolean {
  return Boolean((task.output && task.output.length > 0) || task.meta);
}

function handleClick(task: TaskItem): void {
  // Subagents open their live detail in the right-side panel instead of
  // expanding inline — the dock only lists background subagents, and their
  // streaming progress belongs in the side panel.
  if (task.kind === 'subagent') {
    emit('open', task.id);
    return;
  }
  if (!hasDetail(task)) return;
  if (expandedIds.has(task.id)) expandedIds.delete(task.id);
  else expandedIds.add(task.id);
}

function isClickable(task: TaskItem): boolean {
  return task.kind === 'subagent' || hasDetail(task);
}

function glyphStatus(state: string): StatusGlyphStatus {
  if (state === 'run' || state === 'done' || state === 'fail') return state;
  return 'pending';
}

async function copyToClipboard(text: string, taskId: string, set: Set<string>): Promise<void> {
  const ok = await copyTextToClipboard(text);
  if (!ok) return;
  set.add(taskId);
  setTimeout(() => set.delete(taskId), 1500);
}

async function copyTaskCommand(task: TaskItem): Promise<void> {
  if (!task.meta) return;
  await copyToClipboard(task.meta, task.id, copiedCommandIds);
}

async function copyTaskOutput(task: TaskItem): Promise<void> {
  const text = task.output?.join('\n') ?? '';
  if (!text) return;
  await copyToClipboard(text, task.id, copiedOutputIds);
}
</script>

<template>
  <div class="taskspane">
    <!-- TUI-style header: border line + title -->
    <div class="tp-head">
      <span class="tp-title">{{ t('tasks.tag') }}</span>
      <span class="tp-count">{{ tasks.length }}</span>
    </div>

    <div class="tp-list">
      <div v-if="tasks.length === 0" class="tp-empty">{{ t('tasks.emptyTasks') }}</div>

      <template v-else>
        <div
          v-for="task in tasks"
          :key="task.id"
          class="tp-row"
          :class="{ done: task.state === 'done', fail: task.state === 'fail', expandable: isClickable(task) }"
        >
          <div class="tp-main" :role="isClickable(task) ? 'button' : undefined" @click="handleClick(task)">
            <StatusGlyph :status="glyphStatus(task.state)" />
            <span class="tp-name">{{ task.name }}</span>
            <Badge variant="neutral" size="sm">{{ task.kind }}</Badge>
            <span class="tp-time">{{ task.timing }}</span>
            <button
              v-if="task.state === 'run'"
              class="tp-stop"
              @click.stop="emit('cancel', task.id)"
            >{{ t('tasks.stop') }}</button>
            <Icon v-if="task.kind === 'subagent'" class="tp-chevron" name="chevron-right" size="sm" />
            <Icon v-else-if="hasDetail(task)" class="tp-chevron" :class="{ open: expandedIds.has(task.id) }" name="chevron-right" size="sm" />
          </div>
          <div
            v-if="expandedIds.has(task.id) && hasDetail(task)"
            class="tp-detail"
          >
            <div v-if="task.meta" class="tp-codebox">
              <button
                class="tp-copy"
                :class="{ copied: copiedCommandIds.has(task.id) }"
                @click.stop="copyTaskCommand(task)"
              >
                {{ copiedCommandIds.has(task.id) ? '已复制' : '复制' }}
              </button>
              <pre class="tp-pre"><code><span class="tp-cmd">{{ task.meta }}</span></code></pre>
            </div>
            <div v-if="task.output && task.output.length > 0" class="tp-codebox">
              <button
                class="tp-copy"
                :class="{ copied: copiedOutputIds.has(task.id) }"
                @click.stop="copyTaskOutput(task)"
              >
                {{ copiedOutputIds.has(task.id) ? '已复制' : '复制' }}
              </button>
              <pre class="tp-pre"><code>
                <span v-for="(line, i) in task.output" :key="i" class="tp-line">{{ line }}</span>
              </code></pre>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.taskspane {
  padding: 14px 18px 10px;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* TUI-style header: top border + bold title */
.tp-head {
  border-top: 1px solid var(--line);
  padding-top: 10px;
  margin-bottom: 8px;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.tp-title {
  color: var(--color-accent-hover);
  font-weight: 500;
  font-size: var(--text-base);
  text-transform: capitalize;
}
.tp-count {
  color: var(--muted);
  font-size: var(--text-base);
}

/* List: no cards, just clean rows. Shows ALL tasks and scrolls internally once
   they overflow the pane (no "+N more" cap) so nothing is silently hidden. */
.tp-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tp-row {
  padding: 4px 0;
}
.tp-row.done .tp-name {
  color: var(--muted);
  text-decoration: line-through;
}
.tp-row.fail .tp-name {
  color: var(--color-danger);
}

.tp-main {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--text-base);
}
.tp-row.expandable > .tp-main {
  cursor: pointer;
  border-radius: 4px;
}
.tp-row.expandable > .tp-main:hover {
  background: var(--panel2);
}
.tp-chevron {
  flex: none;
  color: var(--muted);
  transition: transform 0.12s;
}
.tp-chevron.open {
  transform: rotate(90deg);
}

.tp-name {
  color: var(--color-text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp-time {
  flex: none;
  font-size: var(--text-base);
  color: var(--muted);
}

.tp-stop {
  flex: none;
  background: none;
  border: 1px solid color-mix(in srgb, var(--color-danger) 22%, var(--bg));
  border-radius: var(--radius-xs);
  color: var(--color-danger);
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
  padding: 1px 8px;
  cursor: pointer;
  font-family: var(--mono);
}
.tp-stop:hover { background: var(--panel); }

/* Expanded detail: separate code boxes for command and terminal output */
.tp-detail {
  margin: 4px 0 0 23px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tp-codebox {
  position: relative;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
}

.tp-copy {
  position: absolute;
  top: 4px;
  right: 6px;
  z-index: 1;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.12s ease, visibility 0.12s ease;
  background: var(--panel2);
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
  color: var(--dim);
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
  padding: 1px 7px;
  cursor: pointer;
  font-family: var(--sans);
}
.tp-codebox:hover .tp-copy,
.tp-copy:focus-visible {
  opacity: 1;
  visibility: visible;
}
.tp-copy:hover {
  background: var(--panel);
}
.tp-copy.copied {
  color: var(--color-success);
  border-color: color-mix(in srgb, var(--color-success) 30%, var(--line));
}

.tp-pre {
  margin: 0;
  padding: 6px 10px;
  max-height: 320px;
  overflow: auto;
  contain: layout paint;
}
.tp-pre code {
  display: block;
  font-family: var(--mono);
  font-size: var(--text-base);
  line-height: 1.55;
  color: var(--dim);
  white-space: pre-wrap;
  word-break: break-word;
}
.tp-cmd {
  display: block;
  color: var(--muted);
}
.tp-line {
  display: block;
}

.tp-empty {
  padding: 24px 0;
  text-align: center;
  color: var(--faint);
  font-size: var(--ui-font-size-sm);
}

/* Mobile */
@media (max-width: 640px) {
  .taskspane { padding: 14px 14px 16px; }
  .tp-main { flex-wrap: wrap; row-gap: 4px; }
  .tp-name { font-size: var(--ui-font-size-sm); }
  .tp-stop {
    min-height: 32px;
    display: inline-flex;
    align-items: center;
    padding: 4px 12px;
    border-radius: 6px;
    font-size: var(--ui-font-size-xs);
  }
  .tp-detail { margin-left: 0; }
  .tp-pre { font-size: var(--ui-font-size-xs); }
}

.tp-stop { border-radius: var(--radius-md); font-family: var(--sans); }
</style>
