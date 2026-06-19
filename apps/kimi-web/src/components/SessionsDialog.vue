<!-- apps/kimi-web/src/components/SessionsDialog.vue -->
<!-- Session browser popup: lists ALL client-side sessions, searchable by title, -->
<!-- click to switch. Reuses the composable's sessions / workspaceGroups / -->
<!-- attentionBySession view data — no daemon call. -->
<!-- Light only, monospace-forward, Kimi blue #1565C0, no emoji. -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session, WorkspaceGroup } from '../types';

const { t } = useI18n();

const props = defineProps<{
  /** Every session the client knows about (flat, already view-mapped). */
  sessions: Session[];
  /** Workspace groups — used only to label each row with its workspace name. */
  workspaceGroups: WorkspaceGroup[];
  /** Per-session pending-attention count (approvals + questions). */
  attentionBySession: Record<string, number>;
  /** The currently-active session id, highlighted in the list. */
  activeId?: string;
}>();

const emit = defineEmits<{
  select: [id: string];
  close: [];
}>();

// ---------------------------------------------------------------------------
// session id -> workspace name lookup, derived from the groups
// ---------------------------------------------------------------------------
const workspaceNameBySession = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {};
  for (const group of props.workspaceGroups) {
    for (const s of group.sessions) {
      out[s.id] = group.workspace.name;
    }
  }
  return out;
});

// ---------------------------------------------------------------------------
// Search (filters by title, case-insensitive)
// ---------------------------------------------------------------------------
const query = ref('');
const searchRef = ref<HTMLInputElement | null>(null);

const filtered = computed<Session[]>(() => {
  const q = query.value.toLowerCase().trim();
  if (!q) return props.sessions;
  return props.sessions.filter((s) => s.title.toLowerCase().includes(q));
});

const selectedIdx = ref(0);
watch(query, () => { selectedIdx.value = 0; });

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
function choose(id: string): void {
  emit('select', id);
}

function attentionFor(id: string): number {
  return props.attentionBySession[id] ?? 0;
}

/** Status dot colour: amber when something needs the user (pending items or an
    awaiting status), green while busy, red for an interrupted session, else grey. */
function dotClass(s: Session): 'run' | 'attn' | 'aborted' | 'idle' {
  if (attentionFor(s.id) > 0 || s.status === 'awaitingApproval' || s.status === 'awaitingQuestion') return 'attn';
  if (s.busy) return 'run';
  if (s.status === 'aborted') return 'aborted';
  return 'idle';
}

// ---------------------------------------------------------------------------
// Keyboard navigation
// ---------------------------------------------------------------------------
function handleKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    emit('close');
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedIdx.value = Math.min(selectedIdx.value + 1, filtered.value.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedIdx.value = Math.max(selectedIdx.value - 1, 0);
  } else if (e.key === 'Enter') {
    const s = filtered.value[selectedIdx.value];
    if (s) choose(s.id);
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown);
  nextTick(() => searchRef.value?.focus());
});
onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <!-- Backdrop -->
  <div class="backdrop" @click.self="emit('close')">
    <!-- Dialog -->
    <div class="dialog" role="dialog" :aria-label="t('sessions.title')">
      <!-- Header -->
      <div class="dh">
        <span class="dtitle">{{ t('sessions.title') }}</span>
        <span class="count">{{ sessions.length }}</span>
        <button class="close-btn" :aria-label="t('sessions.close')" :title="t('sessions.close')" @click="emit('close')">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">
            <line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/>
          </svg>
        </button>
      </div>

      <!-- Search -->
      <div class="search-wrap">
        <input
          ref="searchRef"
          v-model="query"
          class="search-input"
          type="text"
          :placeholder="t('sessions.searchPlaceholder')"
          autocomplete="off"
          spellcheck="false"
        />
      </div>

      <!-- Session list -->
      <div class="session-list">
        <div
          v-for="(s, i) in filtered"
          :key="s.id"
          class="session-row"
          :class="{
            'is-active': s.id === activeId,
            'is-selected': i === selectedIdx,
          }"
          role="option"
          :aria-selected="s.id === activeId"
          @click="choose(s.id)"
          @mouseenter="selectedIdx = i"
        >
          <!-- Status dot: busy=green, awaiting/attention=amber, aborted=red,
               idle=grey. -->
          <span class="dot" :class="dotClass(s)" />
          <div class="meta">
            <span class="title">{{ s.title }}</span>
            <span class="sub">
              <span class="ws">{{ workspaceNameBySession[s.id] ?? t('sessions.noWorkspace') }}</span>
              <span class="sep">·</span>
              <span class="time">{{ s.time }}</span>
            </span>
          </div>
          <span v-if="attentionFor(s.id) > 0" class="attn-badge">{{ attentionFor(s.id) }}</span>
        </div>

        <div v-if="filtered.length === 0" class="empty">
          {{ sessions.length === 0 ? t('sessions.emptyNone') : t('sessions.emptyNoMatch') }}
        </div>
      </div>

      <!-- Footer hint -->
      <div class="footer-hint">{{ t('sessions.footerHint') }}</div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(20, 23, 28, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.dialog {
  background: var(--bg);
  border: 1px solid var(--line);
  border-top: 2px solid var(--blue);
  border-radius: 4px;
  width: 540px;
  max-width: calc(100vw - 32px);
  height: 520px;
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
  font-family: var(--mono);
  box-shadow: 0 8px 32px rgba(0,0,0,0.14);
}

/* Header */
.dh {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  gap: 8px;
}
.dtitle {
  font-size: calc(var(--ui-font-size) - 1.5px);
  font-weight: 700;
  color: var(--ink);
  letter-spacing: 0.02em;
}
.count {
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
  color: var(--muted);
  background: var(--panel2);
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 0 7px;
  line-height: 1.6;
  flex: 1;
  flex-grow: 0;
}
.close-btn {
  background: none;
  border: none;
  color: var(--faint);
  cursor: pointer;
  padding: 4px;
  margin-left: auto;
  display: flex;
  align-items: center;
  justify-content: center;
}
.close-btn:hover { color: var(--ink); }

/* Search */
.search-wrap {
  padding: 8px 12px;
  border-bottom: 1px solid var(--line2);
}
.search-input {
  width: 100%;
  box-sizing: border-box;
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 1.5px);
  padding: 5px 8px;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--panel);
  color: var(--ink);
  outline: none;
}
.search-input:focus-visible {
  border-color: var(--blue);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--blue) 25%, transparent);
}


/* Session list */
.session-list {
  overflow-y: auto;
  flex: 1;
  padding: 4px 0;
  min-height: 80px;
}

.session-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 14px;
  cursor: pointer;
  color: var(--text);
}
.session-row:hover, .session-row.is-selected {
  background: var(--soft);
}
.session-row.is-active {
  background: var(--bluebg);
}

/* Status dot */
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  background: var(--faint);
}
.dot.run { background: var(--ok); }
.dot.idle { background: var(--faint); }
.dot.attn { background: var(--warn); }
.dot.aborted { background: var(--err); }

.meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}
.title {
  font-size: calc(var(--ui-font-size) - 1.5px);
  font-weight: 500;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sub {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
  color: var(--muted);
  min-width: 0;
}
.ws {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
}
.sep { color: var(--faint); flex: none; }
.time { flex: none; }

.attn-badge {
  flex: none;
  font-size: max(9px, calc(var(--ui-font-size) - 4px));
  font-weight: 700;
  color: var(--bg);
  background: var(--warn);
  border-radius: 9px;
  min-width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 5px;
}

.empty {
  padding: 24px 14px;
  text-align: center;
  color: var(--muted);
  font-size: var(--ui-font-size);
}

/* Footer */
.footer-hint {
  padding: 6px 14px;
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
  color: var(--faint);
  border-top: 1px solid var(--line2);
  background: var(--panel);
  border-radius: 0 0 4px 4px;
}

@media (max-width: 640px) {
  .backdrop {
    align-items: stretch;
    padding:
      max(12px, env(safe-area-inset-top))
      max(12px, env(safe-area-inset-right))
      max(12px, env(safe-area-inset-bottom))
      max(12px, env(safe-area-inset-left));
  }
  .dialog {
    width: 100%;
    max-width: none;
    height: auto;
    max-height: calc(100dvh - 24px);
  }
  .dh {
    min-height: 44px;
  }
  .session-row {
    min-height: 48px;
    padding: 8px 12px;
  }
  .sub {
    flex-wrap: wrap;
    row-gap: 2px;
  }
  .ws {
    max-width: 100%;
    flex: 1 1 100%;
  }
}
</style>
