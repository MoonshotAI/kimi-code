<!-- apps/kimi-web/src/components/chat/AgentDetailPanel.vue -->
<!-- A subagent's full detail in the right-side panel (App's shared slot — opening
     this replaces a thinking/compaction/file view and vice versa). Mirrors the
     thinking panel: the content is reactive, so a still-running subagent keeps
     streaming its progress here, and the progress list follows the bottom as long
     as the user hasn't scrolled up. -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AgentMember } from '../../types';
import Badge from '../ui/Badge.vue';
import PanelHeader from '../ui/PanelHeader.vue';

const props = defineProps<{ member: AgentMember }>();

const emit = defineEmits<{
  close: [];
}>();

const { t } = useI18n();

const progressLines = computed(() =>
  (props.member.outputLines ?? [])
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0),
);

// The subagent's concatenated live output (assistant deltas). Trim trailing
// whitespace for display; grows in real time as deltas stream in.
const liveText = computed(() => (props.member.text ?? '').trimEnd());

interface ProgressGroup {
  key: string;
  /** The "Calling …" tool-call line, or '' for output with no preceding call. */
  call: string;
  output: string[];
}

/** Group flat progress lines into tool-call groups: a "Calling …" line starts a
 *  group and subsequent non-call lines are its output. */
function groupProgress(lines: string[]): ProgressGroup[] {
  const groups: ProgressGroup[] = [];
  let current: ProgressGroup | null = null;
  let idx = 0;
  for (const line of lines) {
    if (line.startsWith('Calling ')) {
      current = { key: `g${idx++}`, call: line, output: [] };
      groups.push(current);
    } else if (current) {
      current.output.push(line);
    } else {
      current = { key: `g${idx++}`, call: '', output: [line] };
      groups.push(current);
    }
  }
  return groups;
}

const progressGroups = computed(() => groupProgress(progressLines.value));

/** Group keys whose folded output is expanded. */
const expandedGroups = ref<Set<string>>(new Set());

const OUTPUT_FOLD_THRESHOLD = 8;
const OUTPUT_HEAD = 5;
const OUTPUT_TAIL = 2;

function isExpanded(key: string): boolean {
  return expandedGroups.value.has(key);
}
function toggleGroup(key: string): void {
  const next = new Set(expandedGroups.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedGroups.value = next;
}
function foldCount(group: ProgressGroup): number {
  return group.output.length - OUTPUT_HEAD - OUTPUT_TAIL;
}

function phaseLabel(phase: AgentMember['phase']): string {
  switch (phase) {
    case 'queued': return 'Queued';
    case 'working': return 'Working';
    case 'suspended': return 'Suspended';
    case 'completed': return 'Completed';
    case 'failed': return 'Failed';
  }
}

const bodyEl = ref<HTMLElement | null>(null);
watch(
  // Follow the bottom as either the tool progress or the live text grows, as
  // long as the user hasn't scrolled up.
  () => progressLines.value.length + liveText.value.length,
  () => {
    const el = bodyEl.value;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (!atBottom) return;
    void nextTick(() => {
      if (bodyEl.value) bodyEl.value.scrollTop = bodyEl.value.scrollHeight;
    });
  },
  { immediate: true },
);
</script>

<template>
  <div class="ap">
    <PanelHeader
      :title="t('common.preview')"
      :subtitle="member.name"
      :close-label="t('thinking.close')"
      @close="emit('close')"
    >
      <Badge variant="neutral" size="sm" class="ap-phase">{{ phaseLabel(member.phase) }}</Badge>
    </PanelHeader>
    <div ref="bodyEl" class="ap-body">
      <div v-if="member.subagentType" class="ap-type">{{ member.subagentType }}</div>
      <div v-if="member.suspendedReason" class="ap-reason">{{ member.suspendedReason }}</div>
      <div v-if="member.prompt" class="ap-field">
        <span class="ap-field-label">Task</span>
        <div class="ap-field-body">{{ member.prompt }}</div>
      </div>
      <div v-if="liveText" class="ap-field">
        <span class="ap-field-label">Output</span>
        <div class="ap-field-body ap-live">{{ liveText }}</div>
      </div>
      <div v-if="progressGroups.length > 0" class="ap-field">
        <span class="ap-field-label">Progress</span>
        <div class="ap-field-body ap-progress">
          <div v-for="group in progressGroups" :key="group.key" class="ap-group">
            <div v-if="group.call" class="ap-call">
              <span class="ap-glyph" aria-hidden="true">▶</span>
              {{ group.call }}
            </div>
            <div v-if="group.output.length > 0" class="ap-output">
              <template v-if="group.output.length <= OUTPUT_FOLD_THRESHOLD || isExpanded(group.key)">
                <div v-for="(line, li) in group.output" :key="li" class="ap-out-line">{{ line }}</div>
              </template>
              <template v-else>
                <div v-for="(line, li) in group.output.slice(0, OUTPUT_HEAD)" :key="li" class="ap-out-line">{{ line }}</div>
                <button type="button" class="ap-fold" @click="toggleGroup(group.key)">
                  … ({{ foldCount(group) }} more)
                </button>
                <div v-for="(line, li) in group.output.slice(-OUTPUT_TAIL)" :key="'t' + li" class="ap-out-line">{{ line }}</div>
              </template>
            </div>
          </div>
        </div>
      </div>
      <div v-if="member.summary" class="ap-field">
        <span class="ap-field-label">Result</span>
        <div class="ap-field-body">{{ member.summary }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ap {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--color-bg);
}
.ap-phase { flex: none; }

.ap-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
  color: var(--color-text-muted);
}
.ap-type {
  font: var(--text-xs) var(--font-mono);
  color: var(--color-text-muted);
  margin-bottom: 8px;
}
.ap-reason {
  color: var(--color-warning);
  margin-bottom: 8px;
}
.ap-field + .ap-field {
  margin-top: 12px;
}
.ap-field-label {
  display: block;
  color: var(--color-text-muted);
  font: var(--text-xs) var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 4px;
}
.ap-field-body {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.ap-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font: var(--text-base)/var(--leading-relaxed) var(--font-mono);
  color: var(--color-text);
  min-width: 0;
}
.ap-live {
  font: var(--text-base)/var(--leading-relaxed) var(--font-mono);
  color: var(--color-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.ap-group {
  min-width: 0;
}
.ap-call {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  font-weight: var(--weight-medium);
  color: var(--color-text);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.ap-glyph {
  flex: none;
  color: var(--color-accent);
  font-size: 0.85em;
}
.ap-output {
  margin: 2px 0 0 16px;
  padding-left: 8px;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  border-left: 2px solid var(--color-line);
  min-width: 0;
}
.ap-out-line {
  min-width: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.ap-fold {
  display: inline-block;
  margin: 2px 0;
  padding: 0;
  background: none;
  border: none;
  color: var(--color-accent);
  font: inherit;
  cursor: pointer;
}
.ap-fold:hover {
  text-decoration: underline;
}
.ap-fold:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}
</style>
