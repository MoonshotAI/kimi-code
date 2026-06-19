<!-- apps/kimi-web/src/debug/KapDebugView.vue
     The KAP debug panel CONTENT — mounted into a popped-out browser window by
     DebugPanel.vue (so it shares the live trace buffer with the main app). The
     ✕ button asks the controller to close the window.
     Dev tooling: labels are intentionally not localized. -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  clearTrace,
  downloadTraceLog,
  tracePaused,
  traceEntries,
  traceVersion,
  type TraceEntry,
} from './trace';

const emit = defineEmits<{ close: [] }>();

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------
const sourceFilter = ref<'all' | 'rest' | 'ws' | 'client'>('all');
const textFilter = ref('');
const sessionFilter = ref<string>('');
const errorsOnly = ref(false);
const view = ref<'timeline' | 'aggregate'>('timeline');

const all = computed<readonly TraceEntry[]>(() => {
  void traceVersion.value; // re-read the buffer on every push
  return [...traceEntries()];
});

const sessionIds = computed<string[]>(() => {
  const ids = new Set<string>();
  for (const e of all.value) if (e.sessionId) ids.add(e.sessionId);
  return [...ids].sort();
});

function isError(e: TraceEntry): boolean {
  return e.kind === 'rest:error' || (e.code !== undefined && e.code !== 0)
    || e.eventType === 'error' || e.eventType === 'parse-error';
}

const filtered = computed<TraceEntry[]>(() => {
  const text = textFilter.value.trim().toLowerCase();
  return all.value.filter((e) => {
    if (sourceFilter.value !== 'all' && e.source !== sourceFilter.value) return false;
    if (sessionFilter.value && e.sessionId !== sessionFilter.value) return false;
    if (errorsOnly.value && !isError(e)) return false;
    if (text) {
      const hay = `${e.label} ${e.kind} ${e.eventType ?? ''} ${e.sessionId ?? ''} ${e.requestId ?? ''}`.toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  });
});

// ---------------------------------------------------------------------------
// Aggregate: WS events by session/type, REST by method+path
// ---------------------------------------------------------------------------
interface WsAggRow { key: string; sessionId: string; eventType: string; dir: string; count: number; lastSeq?: number }
interface RestAggRow { key: string; count: number; errors: number; avgMs: number }

const wsAgg = computed<WsAggRow[]>(() => {
  const map = new Map<string, WsAggRow>();
  for (const e of filtered.value) {
    if (e.kind !== 'ws:in' && e.kind !== 'ws:out') continue;
    const dir = e.kind === 'ws:in' ? '←' : '→';
    const key = `${dir} ${e.eventType ?? '?'} @ ${e.sessionId ?? '-'}`;
    const row = map.get(key) ?? { key, sessionId: e.sessionId ?? '-', eventType: e.eventType ?? '?', dir, count: 0 };
    row.count++;
    if (e.seq !== undefined) row.lastSeq = e.seq;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
});

const restAgg = computed<RestAggRow[]>(() => {
  const map = new Map<string, { count: number; errors: number; totalMs: number; timed: number }>();
  for (const e of filtered.value) {
    if (e.source !== 'rest' || e.kind === 'rest:request') continue;
    const key = `${e.method ?? '?'} ${e.path ?? '?'}`;
    const row = map.get(key) ?? { count: 0, errors: 0, totalMs: 0, timed: 0 };
    row.count++;
    if (isError(e)) row.errors++;
    if (e.durationMs !== undefined) { row.totalMs += e.durationMs; row.timed++; }
    map.set(key, row);
  }
  return [...map.entries()]
    .map(([key, r]) => ({ key, count: r.count, errors: r.errors, avgMs: r.timed > 0 ? Math.round(r.totalMs / r.timed) : 0 }))
    .sort((a, b) => b.count - a.count);
});

// ---------------------------------------------------------------------------
// Timeline: detail expansion, follow-bottom, copy, export
// ---------------------------------------------------------------------------
const expandedId = ref<number | null>(null);
const follow = ref(true);
const listRef = ref<HTMLElement | null>(null);
const copiedId = ref<number | null>(null);

watch(() => filtered.value.length, async () => {
  if (!follow.value || view.value !== 'timeline') return;
  await nextTick();
  const el = listRef.value;
  if (el) el.scrollTop = el.scrollHeight;
});

function toggleDetail(id: number): void {
  expandedId.value = expandedId.value === id ? null : id;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function entryJson(e: TraceEntry): string {
  return JSON.stringify(e, null, 2);
}

async function copyEntry(e: TraceEntry): Promise<void> {
  try {
    await navigator.clipboard.writeText(entryJson(e));
    copiedId.value = e.id;
    setTimeout(() => { if (copiedId.value === e.id) copiedId.value = null; }, 1500);
  } catch {
    // clipboard unavailable
  }
}

function exportJsonl(): void {
  downloadTraceLog(filtered.value);
}

function badgeClass(e: TraceEntry): string {
  if (isError(e)) return 'b-err';
  if (e.source === 'client') return 'b-err';
  if (e.source === 'rest') return 'b-rest';
  if (e.kind === 'ws:lifecycle') return 'b-life';
  return e.kind === 'ws:out' ? 'b-out' : 'b-in';
}

function badgeLabel(e: TraceEntry): string {
  if (e.source === 'rest') return 'REST';
  if (e.source === 'client') return 'APP';
  return 'WS';
}
</script>

<template>
  <section class="kap-root">
    <header class="kap-head">
      <strong>KAP debug</strong>
      <span class="kap-count">{{ filtered.length }}/{{ all.length }}</span>
      <div class="kap-head-actions">
        <button type="button" :class="{ on: tracePaused }" @click="tracePaused = !tracePaused">
          {{ tracePaused ? 'resume' : 'pause' }}
        </button>
        <button type="button" @click="clearTrace()">clear</button>
        <button type="button" @click="exportJsonl()">export jsonl</button>
        <button type="button" title="Close window" @click="emit('close')">✕</button>
      </div>
    </header>

    <div class="kap-filters">
      <select v-model="sourceFilter" aria-label="Source filter">
        <option value="all">rest + ws + app</option>
        <option value="rest">rest</option>
        <option value="ws">ws</option>
        <option value="client">app errors</option>
      </select>
      <select v-model="sessionFilter" aria-label="Session filter">
        <option value="">all sessions</option>
        <option v-for="sid in sessionIds" :key="sid" :value="sid">{{ sid }}</option>
      </select>
      <input v-model="textFilter" type="text" placeholder="filter (type / path / id)" aria-label="Text filter" />
      <label class="kap-check"><input v-model="errorsOnly" type="checkbox" /> errors</label>
      <label class="kap-check"><input v-model="follow" type="checkbox" /> follow</label>
      <div class="kap-view-toggle" role="group">
        <button type="button" :class="{ on: view === 'timeline' }" @click="view = 'timeline'">timeline</button>
        <button type="button" :class="{ on: view === 'aggregate' }" @click="view = 'aggregate'">aggregate</button>
      </div>
    </div>

    <div v-if="view === 'timeline'" ref="listRef" class="kap-list">
      <div v-if="filtered.length === 0" class="kap-empty">
        No trace entries yet. REST calls and WS frames will appear here.
      </div>
      <div v-for="e in filtered" :key="e.id" class="kap-row-wrap">
        <button type="button" class="kap-row" :class="{ expanded: expandedId === e.id }" @click="toggleDetail(e.id)">
          <span class="kap-ts">{{ fmtTime(e.ts) }}</span>
          <span class="kap-badge" :class="badgeClass(e)">{{ badgeLabel(e) }}</span>
          <span class="kap-label">{{ e.label }}</span>
        </button>
        <div v-if="expandedId === e.id" class="kap-detail">
          <div class="kap-detail-actions">
            <button type="button" @click="copyEntry(e)">{{ copiedId === e.id ? 'copied ✓' : 'copy json' }}</button>
          </div>
          <pre>{{ entryJson(e) }}</pre>
        </div>
      </div>
    </div>

    <div v-else class="kap-agg">
      <h4>WS frames by session / type</h4>
      <table>
        <thead><tr><th>dir</th><th>type</th><th>session</th><th>count</th><th>last seq</th></tr></thead>
        <tbody>
          <tr v-for="r in wsAgg" :key="r.key">
            <td>{{ r.dir }}</td>
            <td class="mono">{{ r.eventType }}</td>
            <td class="mono">{{ r.sessionId }}</td>
            <td class="num">{{ r.count }}</td>
            <td class="num">{{ r.lastSeq ?? '—' }}</td>
          </tr>
          <tr v-if="wsAgg.length === 0"><td colspan="5" class="kap-empty">no ws frames</td></tr>
        </tbody>
      </table>
      <h4>REST by endpoint</h4>
      <table>
        <thead><tr><th>endpoint</th><th>count</th><th>errors</th><th>avg ms</th></tr></thead>
        <tbody>
          <tr v-for="r in restAgg" :key="r.key">
            <td class="mono">{{ r.key }}</td>
            <td class="num">{{ r.count }}</td>
            <td class="num" :class="{ err: r.errors > 0 }">{{ r.errors }}</td>
            <td class="num">{{ r.avgMs }}</td>
          </tr>
          <tr v-if="restAgg.length === 0"><td colspan="4" class="kap-empty">no rest calls</td></tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
/* Fills the popped-out window. */
.kap-root {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 2.5px);
  color: var(--ink);
}

.kap-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.kap-count { color: var(--muted); }
.kap-head-actions { margin-left: auto; display: flex; gap: 6px; }
.kap-head-actions button,
.kap-view-toggle button {
  padding: 3px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg);
  color: var(--muted);
  font: inherit;
  cursor: pointer;
}
.kap-head-actions button:hover,
.kap-view-toggle button:hover { color: var(--ink); }
.kap-head-actions button.on,
.kap-view-toggle button.on { color: var(--blue2); border-color: var(--bd); background: var(--soft); }

.kap-filters {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--line);
}
.kap-filters select,
.kap-filters input[type='text'] {
  padding: 3px 6px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg);
  color: var(--ink);
  font: inherit;
  min-width: 0;
}
.kap-filters input[type='text'] { flex: 1; min-width: 120px; }
.kap-check { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); white-space: nowrap; }
.kap-view-toggle { display: flex; gap: 0; }
.kap-view-toggle button:first-child { border-radius: 6px 0 0 6px; border-right: none; }
.kap-view-toggle button:last-child { border-radius: 0 6px 6px 0; }

.kap-list { flex: 1; min-height: 0; overflow-y: auto; }
.kap-empty { padding: 18px 12px; color: var(--muted); text-align: center; }

.kap-row {
  display: flex;
  align-items: baseline;
  gap: 7px;
  width: 100%;
  padding: 3px 10px;
  border: none;
  border-bottom: 1px solid var(--line);
  background: transparent;
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.kap-row:hover { background: var(--panel2); }
.kap-row.expanded { background: var(--soft); }
.kap-ts { flex: none; color: var(--muted); }
.kap-badge {
  flex: none;
  padding: 0 5px;
  border-radius: 5px;
  font-size: max(9px, calc(var(--ui-font-size) - 4.5px));
  font-weight: 700;
  line-height: 1.7;
}
.b-rest { background: var(--soft); color: var(--blue2); }
.b-in { background: var(--soft); color: var(--ok, #2da44e); }
.b-out { background: var(--soft); color: var(--warn); }
.b-life { background: var(--panel2); color: var(--muted); }
.b-err { background: var(--warn); color: var(--bg); }
.kap-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kap-detail {
  border-bottom: 1px solid var(--line);
  background: var(--bg);
  padding: 6px 10px 10px;
}
.kap-detail-actions { display: flex; justify-content: flex-end; margin-bottom: 4px; }
.kap-detail-actions button {
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  color: var(--muted);
  font: inherit;
  cursor: pointer;
}
.kap-detail-actions button:hover { color: var(--ink); }
.kap-detail pre {
  margin: 0;
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: calc(var(--ui-font-size) - 3px);
  line-height: 1.45;
}

.kap-agg { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 10px; }
.kap-agg h4 { margin: 8px 0 4px; font-size: calc(var(--ui-font-size) - 2.5px); color: var(--muted); }
.kap-agg table { width: 100%; border-collapse: collapse; }
.kap-agg th, .kap-agg td {
  padding: 3px 6px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
}
.kap-agg th { color: var(--muted); font-weight: 600; }
.kap-agg .num { text-align: right; }
.kap-agg .err { color: var(--warn); font-weight: 700; }
.kap-agg .mono { word-break: break-all; }
</style>
