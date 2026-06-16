<!-- apps/kimi-web/src/components/AgentDetailPanel.vue -->
<!-- A subagent's full detail in the right-side panel (App's shared slot — opening
     this replaces a thinking/compaction/file view and vice versa). Mirrors the
     thinking panel: the content is reactive, so a still-running subagent keeps
     streaming its progress here, and the progress list follows the bottom as long
     as the user hasn't scrolled up. -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AgentMember } from '../types';

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
  () => progressLines.value.length,
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
    <div class="ap-header">
      <span class="ap-title">{{ t('common.preview') }}</span>
      <span class="ap-sub">{{ member.name }}</span>
      <span class="ap-phase" :class="`phase-${member.phase}`">{{ phaseLabel(member.phase) }}</span>
      <button type="button" class="ap-close" :title="t('thinking.close')" :aria-label="t('thinking.close')" @click="emit('close')">
        <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
      </button>
    </div>
    <div ref="bodyEl" class="ap-body">
      <div v-if="member.subagentType" class="ap-type">{{ member.subagentType }}</div>
      <div v-if="member.suspendedReason" class="ap-reason">{{ member.suspendedReason }}</div>
      <div v-if="member.prompt" class="ap-field">
        <span class="ap-field-label">Task</span>
        <div class="ap-field-body">{{ member.prompt }}</div>
      </div>
      <div v-if="progressLines.length > 0" class="ap-field">
        <span class="ap-field-label">Progress</span>
        <div class="ap-field-body ap-progress">
          <span v-for="(line, index) in progressLines" :key="index">{{ line }}</span>
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
  background: var(--bg);
}
.ap-header {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--panel-head-h, 32px);
  padding: 0 6px 0 12px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.ap-title {
  flex: none;
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--ink);
}
.ap-sub {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  color: var(--muted);
}
.ap-phase {
  flex: none;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 1px 7px;
  color: var(--dim);
  background: var(--bg);
  font-family: var(--mono);
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
}
.ap-phase.phase-completed { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 35%, var(--bg)); }
.ap-phase.phase-failed { color: var(--err); border-color: color-mix(in srgb, var(--err) 35%, var(--bg)); }
.ap-phase.phase-suspended { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, var(--bg)); }
.ap-close {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: none;
  border: none;
  border-radius: 5px;
  color: var(--muted);
  cursor: pointer;
}
.ap-close:hover {
  background: var(--hover);
  color: var(--ink);
}
.ap-close:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: -2px;
}

.ap-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  font-size: var(--ui-font-size);
  line-height: 1.6;
  color: var(--dim);
}
.ap-type {
  font-family: var(--mono);
  font-size: var(--ui-font-size-xs);
  color: var(--muted);
  margin-bottom: 8px;
}
.ap-reason {
  color: var(--warn);
  margin-bottom: 8px;
}
.ap-field + .ap-field {
  margin-top: 12px;
}
.ap-field-label {
  display: block;
  color: var(--muted);
  font-family: var(--mono);
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
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
  gap: 3px;
  font-family: var(--mono);
  color: var(--text);
  min-width: 0;
}
.ap-progress span {
  min-width: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
</style>
