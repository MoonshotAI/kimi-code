<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { IconButton, Icon, Input, Pill, Select, StatusDot } from '@moonshot-ai/app-ui';
import {
  clearTrace,
  downloadTraceLog,
  formatTraceTime,
  traceEntries,
  traceHttpExchange,
  tracePaused,
  traceRawJson,
  traceVersion,
  type HttpExchange,
  type TraceEntry,
} from '@moonshot-ai/app-client/trace';
import InspectorHttpDetail from './InspectorHttpDetail.vue';
import InspectorJson from './InspectorJson.vue';

type SourceFilter = 'all' | TraceEntry['source'];
type TypeMode = 'include' | 'exclude' | 'none';

interface SelectedEntry {
  entry: TraceEntry;
  json: string;
  pending: boolean;
  http?: HttpExchange;
}

const HEARTBEAT_STALE_MS = 20_000;
const KEY_FAILURE_EVENT = /:(error|failed|unhandled-rejection)$/;
const DEFAULT_HIDDEN_TYPES: ReadonlySet<string> = new Set(['item.delta', 'ping', 'pong']);

const { t } = useI18n();

const sourceFilter = ref<SourceFilter>('all');
const sessionFilter = ref('');
const agentFilter = ref('');
const textFilter = ref('');
const errorsOnly = ref(false);
const follow = ref(true);
const typeModes = ref<ReadonlyMap<string, TypeMode>>(new Map());
const selected = ref<SelectedEntry | null>(null);
const httpTab = ref('headers');
const copied = ref(false);
const listEl = ref<HTMLElement | null>(null);

const all = computed<readonly TraceEntry[]>(() => {
  void traceVersion.value;
  return [...traceEntries()];
});

function entryType(e: TraceEntry): string {
  return e.eventType ?? e.kind;
}

function isError(e: TraceEntry): boolean {
  return e.kind === 'rest:error' || e.kind === 'client:error' || (e.code !== undefined && e.code !== 0)
    || e.eventType === 'error' || e.eventType === 'parse-error'
    || (e.kind === 'client:key' && KEY_FAILURE_EVENT.test(e.label));
}

function distinct(values: Iterable<string | undefined>): string[] {
  const set = new Set<string>();
  for (const value of values) if (value) set.add(value);
  return [...set].sort();
}

const sessionIds = computed(() => distinct(all.value.map((e) => e.sessionId)));
const agentIds = computed(() => distinct(all.value.map((e) => e.agentId)));
const types = computed(() => distinct(all.value.map(entryType)));

const sourceOptions = computed(() => [
  { value: 'all', label: t('panel.inspector.allSources') },
  { value: 'rest', label: 'REST' },
  { value: 'ws', label: 'WebSocket' },
  { value: 'client', label: t('panel.inspector.sourceClient') },
]);
const sessionOptions = computed(() => [
  { value: '', label: t('panel.inspector.allSessions') },
  ...sessionIds.value.map((id) => ({ value: id, label: id })),
]);
const agentOptions = computed(() => [
  { value: '', label: t('panel.inspector.allAgents') },
  ...agentIds.value.map((id) => ({ value: id, label: id })),
]);
function typeMode(type: string): TypeMode {
  return typeModes.value.get(type) ?? (DEFAULT_HIDDEN_TYPES.has(type) ? 'exclude' : 'none');
}

function cycleType(type: string): void {
  const mode = typeMode(type);
  const next = new Map(typeModes.value);
  next.set(type, mode === 'none' ? 'include' : mode === 'include' ? 'exclude' : 'none');
  typeModes.value = next;
}

const filtered = computed<TraceEntry[]>(() => {
  const text = textFilter.value.trim().toLowerCase();
  const included = types.value.filter((type) => typeMode(type) === 'include');
  return all.value.filter((e) => {
    if (sourceFilter.value !== 'all' && e.source !== sourceFilter.value) return false;
    if (sessionFilter.value && e.sessionId !== sessionFilter.value) return false;
    if (agentFilter.value && e.agentId !== agentFilter.value) return false;
    if (errorsOnly.value && !isError(e)) return false;
    const type = entryType(e);
    if (typeMode(type) === 'exclude') return false;
    if (included.length > 0 && !included.includes(type)) return false;
    if (text) {
      const hay = `${e.label} ${e.kind} ${e.eventType ?? ''} ${e.sessionId ?? ''} ${e.agentId ?? ''} ${e.requestId ?? ''}`.toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  });
});

const now = ref(Date.now());
const clock = setInterval(() => {
  now.value = Date.now();
}, 1000);
onBeforeUnmount(() => clearInterval(clock));

const pings = computed(() => all.value.filter((e) => e.kind === 'ws:in' && e.eventType === 'ping'));

const heartbeat = computed(() => {
  const last = pings.value.at(-1);
  if (last === undefined || tracePaused.value) return null;
  const ageMs = Math.max(0, now.value - last.ts);
  return { age: Math.floor(ageMs / 1000), stale: ageMs > HEARTBEAT_STALE_MS, count: pings.value.length };
});

function entrySnapshot(entry: TraceEntry): SelectedEntry {
  const raw = traceRawJson(entry.id);
  if (raw === undefined) return { entry, json: JSON.stringify(entry, null, 2), pending: false };
  const { detail: _detail, ...meta } = entry;
  return { entry, json: JSON.stringify({ ...meta, raw: JSON.parse(raw) as unknown }, null, 2), pending: false };
}

function httpSnapshot(entry: TraceEntry, requestId: string): SelectedEntry {
  const http = traceHttpExchange(requestId);
  return { entry, json: JSON.stringify(http, null, 2), pending: http.endedAt === undefined, http };
}

function snapshot(entry: TraceEntry): SelectedEntry {
  return entry.source === 'rest' && entry.requestId !== undefined
    ? httpSnapshot(entry, entry.requestId)
    : entrySnapshot(entry);
}

watch(traceVersion, () => {
  const current = selected.value;
  if (current?.pending === true) selected.value = snapshot(current.entry);
});

function selectEntry(entry: TraceEntry): void {
  copied.value = false;
  selected.value = selected.value?.entry.id === entry.id ? null : snapshot(entry);
}

async function copySelected(): Promise<void> {
  const current = selected.value;
  if (current === null || !(await copyTextToClipboard(current.json))) return;
  copied.value = true;
  setTimeout(() => {
    if (selected.value?.entry.id === current.entry.id) copied.value = false;
  }, 1500);
}

function onListScroll(): void {
  const el = listEl.value;
  if (el === null) return;
  follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}

watch([filtered, follow], async () => {
  if (!follow.value) return;
  await nextTick();
  const el = listEl.value;
  if (el !== null) el.scrollTop = el.scrollHeight;
});

function badgeClass(e: TraceEntry): string {
  if (isError(e)) return 'b-err';
  if (e.source === 'rest') return 'b-rest';
  if (e.source === 'client') return 'b-app';
  if (e.kind === 'ws:lifecycle') return 'b-life';
  return e.kind === 'ws:out' ? 'b-out' : 'b-in';
}

function badgeLabel(e: TraceEntry): string {
  if (e.source === 'rest') return 'REST';
  if (e.source === 'client') return 'APP';
  return 'WS';
}

function clearAll(): void {
  clearTrace();
  selected.value = null;
}
</script>

<template>
  <div class="insp">
    <div class="insp-toolbar">
      <span class="insp-count">{{ t('panel.inspector.count', { shown: filtered.length, total: all.length }) }}</span>
      <span
        v-if="heartbeat"
        class="insp-heartbeat"
        :class="{ stale: heartbeat.stale }"
        :title="t('panel.inspector.heartbeatHint', { count: heartbeat.count })"
      >
        <StatusDot :status="heartbeat.stale ? 'error' : 'ok'" size="sm" />
        {{ t('panel.inspector.heartbeat', { age: heartbeat.age }) }}
      </span>
      <div class="insp-actions">
        <IconButton
          size="sm"
          :pressed="tracePaused"
          :label="tracePaused ? t('panel.inspector.resume') : t('panel.inspector.pause')"
          :tooltip="tracePaused ? t('panel.inspector.resume') : t('panel.inspector.pause')"
          @click="tracePaused = !tracePaused"
        >
          <Icon :name="tracePaused ? 'play' : 'pause'" size="sm" />
        </IconButton>
        <IconButton size="sm" :label="t('panel.inspector.clear')" :tooltip="t('panel.inspector.clear')" @click="clearAll">
          <Icon name="trash" size="sm" />
        </IconButton>
        <IconButton
          size="sm"
          :label="t('panel.inspector.download')"
          :tooltip="t('panel.inspector.download')"
          @click="downloadTraceLog(filtered)"
        >
          <Icon name="download" size="sm" />
        </IconButton>
      </div>
    </div>

    <div class="insp-filters">
      <div class="insp-row">
        <Select v-model="sourceFilter" size="sm" class="insp-select" :options="sourceOptions" />
        <Select v-model="sessionFilter" size="sm" class="insp-select" :options="sessionOptions" />
        <Select v-if="agentIds.length > 0" v-model="agentFilter" size="sm" class="insp-select" :options="agentOptions" />
      </div>
      <div class="insp-row">
        <Input v-model="textFilter" size="xs" class="insp-search" :placeholder="t('panel.inspector.search')" />
        <Pill :active="errorsOnly" :aria-pressed="errorsOnly" @click="errorsOnly = !errorsOnly">
          {{ t('panel.inspector.errorsOnly') }}
        </Pill>
        <Pill :active="follow" :aria-pressed="follow" @click="follow = !follow">
          {{ t('panel.inspector.follow') }}
        </Pill>
      </div>
      <div v-if="types.length > 0" class="insp-types" :title="t('panel.inspector.typesHint')">
        <button
          v-for="type in types"
          :key="type"
          type="button"
          class="insp-type"
          :class="typeMode(type)"
          @click="cycleType(type)"
        >
          {{ type }}
        </button>
      </div>
    </div>

    <div ref="listEl" class="insp-list" @scroll="onListScroll">
      <div v-if="filtered.length === 0" class="insp-empty">
        {{ all.length === 0 ? t('panel.inspector.empty') : t('panel.inspector.emptyFiltered') }}
      </div>
      <button
        v-for="e in filtered"
        :key="e.id"
        type="button"
        class="insp-entry"
        :class="{ on: selected?.entry.id === e.id }"
        @click="selectEntry(e)"
      >
        <span class="insp-ts">{{ formatTraceTime(e.ts) }}</span>
        <span class="insp-badge" :class="badgeClass(e)">{{ badgeLabel(e) }}</span>
        <span class="insp-label">{{ e.label }}</span>
        <span v-if="e.agentId" class="insp-agent">{{ e.agentId }}</span>
      </button>
    </div>
    <div v-if="selected" class="insp-detail" :class="{ http: selected.http }">
      <div class="insp-detail-head">
        <span class="insp-badge" :class="badgeClass(selected.entry)">{{ badgeLabel(selected.entry) }}</span>
        <template v-if="selected.http">
          <span class="insp-detail-type">{{ selected.http.method }}</span>
          <span class="insp-detail-path" :title="selected.http.url ?? selected.http.path">{{ selected.http.path }}</span>
        </template>
        <span v-else class="insp-detail-type">{{ entryType(selected.entry) }}</span>
        <span class="insp-ts">{{ formatTraceTime(selected.entry.ts) }}</span>
        <div class="insp-actions">
          <IconButton size="sm" :label="copied ? t('panel.inspector.copied') : t('panel.inspector.copy')" :tooltip="copied ? t('panel.inspector.copied') : t('panel.inspector.copy')" @click="copySelected">
            <Icon :name="copied ? 'check' : 'copy'" size="sm" />
          </IconButton>
          <IconButton size="sm" :label="t('panel.inspector.closeDetail')" :tooltip="t('panel.inspector.closeDetail')" @click="selected = null">
            <Icon name="close" size="sm" />
          </IconButton>
        </div>
      </div>
      <InspectorHttpDetail v-if="selected.http" v-model:tab="httpTab" :exchange="selected.http" :now="now" />
      <div v-else class="insp-json"><InspectorJson :json="selected.json" /></div>
    </div>
  </div>
</template>

<style scoped>
.insp {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-size: var(--text-xs);
  color: var(--color-text);
}
.insp-toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--p-hairline) solid var(--color-line);
}
.insp-count {
  color: var(--color-text-faint);
  font-variant-numeric: tabular-nums;
}
.insp-heartbeat {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--color-text-faint);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.insp-heartbeat.stale {
  color: var(--color-danger);
}
.insp-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
.insp-filters {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-1-5);
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--p-hairline) solid var(--color-line);
}
.insp-row {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  min-width: 0;
}
.insp-select {
  flex: 1 1 0;
  min-width: 0;
}
.insp-search {
  flex: 1;
  min-width: 0;
}
.insp-types {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  max-height: 72px;
  overflow-y: auto;
}
.insp-type {
  padding: 0 var(--space-1-5);
  border: none;
  border-radius: var(--radius-sm);
  background: var(--color-hover);
  color: var(--color-text-muted);
  font: inherit;
  font-family: var(--font-mono);
  line-height: 18px;
  cursor: pointer;
}
.insp-type.include {
  background: var(--color-selected);
  color: var(--color-text);
  box-shadow: inset 0 0 0 1px var(--color-accent);
}
.insp-type.exclude {
  opacity: 0.45;
  text-decoration: line-through;
}
.insp-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-1) 0;
}
.insp-empty {
  padding: var(--space-4);
  text-align: center;
  color: var(--color-text-faint);
}
.insp-entry {
  display: flex;
  align-items: baseline;
  gap: var(--space-1-5);
  width: 100%;
  padding: var(--space-05) var(--space-3);
  border: none;
  background: none;
  font: inherit;
  font-family: var(--font-mono);
  color: var(--color-text-muted);
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
}
.insp-entry:hover {
  background: var(--color-hover);
}
.insp-entry.on {
  background: var(--color-selected);
  box-shadow: inset 2px 0 0 var(--color-accent);
}
.insp-ts {
  flex: none;
  color: var(--color-text-faint);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.insp-badge {
  flex: none;
  padding: 0 var(--space-1);
  border-radius: var(--radius-xs);
  font-family: var(--font-ui);
  font-weight: var(--weight-medium);
  line-height: 16px;
}
.b-rest { background: var(--color-hover); color: var(--color-info); }
.b-in { background: var(--color-hover); color: var(--color-success); }
.b-out { background: var(--color-hover); color: var(--color-orange); }
.b-life { background: var(--color-hover); color: var(--color-text-faint); }
.b-app { background: var(--color-hover); color: var(--color-text-muted); }
.b-err { background: var(--color-danger); color: var(--color-bg); }
.insp-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.insp-agent {
  flex: none;
  max-width: 30%;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--color-text-faint);
}
.insp-detail {
  flex: none;
  display: flex;
  flex-direction: column;
  max-height: 50%;
  border-top: var(--p-hairline) solid var(--color-line);
}
.insp-detail.http {
  height: 50%;
}
.insp-detail-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  padding: var(--space-1) var(--space-3);
  border-bottom: var(--p-hairline) solid var(--color-line);
}
.insp-detail-type {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-weight: var(--weight-medium);
}
.insp-detail-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  color: var(--color-text-muted);
}
.insp-json {
  flex: 1;
  min-height: 0;
  overflow: auto;
  user-select: text;
}
</style>
