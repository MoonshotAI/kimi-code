<!-- apps/kimi-web/src/components/dialogs/SearchSessionsDialog.vue -->
<!-- Spotlight-style session search: type to filter by title + last prompt, each
     hit shows its workspace, the session title, and a snippet of the matched
     content with the query highlighted. ↑/↓ to move, ↵ to open, Esc to close. -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session } from '../../types';
import { highlightHtml, snippet } from '../../lib/searchHighlight';
import Dialog from '../ui/Dialog.vue';
import Icon from '../ui/Icon.vue';

const { t } = useI18n();

const props = defineProps<{
  sessions: Session[];
  activeId: string;
}>();

const emit = defineEmits<{
  select: [id: string];
  close: [];
}>();

// The parent controls visibility with `v-if`, so the dialog is open whenever
// this component is mounted. Dialog owns focus trap, Esc/overlay close, and the
// close button; we forward its `close` event to the parent.
const open = ref(true);

const query = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
const listRef = ref<HTMLElement | null>(null);

interface Hit {
  session: Session;
  /** Title matched the query (controls title highlighting). */
  inTitle: boolean;
  /** Workspace name matched the query (controls workspace highlighting). */
  inWorkspace: boolean;
  /** Snippet of lastPrompt to preview under the title (empty when absent). */
  snippetText: string;
}

const RESULT_CAP = 200;

const results = computed<Hit[]>(() => {
  const q = query.value.trim().toLowerCase();
  const out: Hit[] = [];
  for (const s of props.sessions) {
    const title = s.title ?? '';
    const last = s.lastPrompt ?? '';
    const ws = s.workspaceName ?? '';
    const inTitle = q.length > 0 && title.toLowerCase().includes(q);
    const inLast = q.length > 0 && last.toLowerCase().includes(q);
    const inWorkspace = q.length > 0 && ws.toLowerCase().includes(q);
    // Empty query → show the full (recent) list; otherwise require a hit.
    if (q.length > 0 && !inTitle && !inLast && !inWorkspace) continue;
    out.push({
      session: s,
      inTitle,
      inWorkspace,
      // Preview the last prompt whenever available; when searching, anchor the
      // snippet on the match (no-ops to the head when the title matched only).
      snippetText: last ? snippet(last, query.value) : '',
    });
    if (out.length >= RESULT_CAP) break;
  }
  return out;
});

const selectedIndex = ref(0);

watch(query, () => {
  selectedIndex.value = 0;
});

function clampIndex(i: number): number {
  const len = results.value.length;
  if (len === 0) return 0;
  return Math.max(0, Math.min(len - 1, i));
}

async function scrollSelectedIntoView(): Promise<void> {
  await nextTick();
  const el = listRef.value?.querySelector<HTMLElement>('[aria-selected="true"]');
  el?.scrollIntoView({ block: 'nearest' });
}

function move(delta: number): void {
  selectedIndex.value = clampIndex(selectedIndex.value + delta);
  void scrollSelectedIntoView();
}

function openHit(id: string): void {
  emit('select', id);
  emit('close');
}

function openSelected(): void {
  const hit = results.value[selectedIndex.value];
  if (hit) openHit(hit.session.id);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    move(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    move(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    openSelected();
  }
  // Escape is intentionally left to bubble so Dialog closes the modal.
}

onMounted(() => {
  // Dialog also auto-focuses the first focusable element; this is a belt-and-
  // suspenders guarantee for the rare timing where it runs before mount.
  inputRef.value?.focus();
});
</script>

<template>
  <Dialog v-model:open="open" size="lg" height="fixed" :padded="false" @close="emit('close')">
    <template #head>
      <div class="sd-head">
        <Icon class="sd-search-icon" name="search" size="md" />
        <input
          ref="inputRef"
          v-model="query"
          class="sd-input"
          type="text"
          :placeholder="t('sidebar.searchPlaceholder')"
          :aria-label="t('sidebar.searchPlaceholder')"
          autocomplete="off"
          spellcheck="false"
          @keydown="onKeydown"
        />
      </div>
    </template>

    <div ref="listRef" class="sd-list" role="listbox">
      <template v-if="results.length > 0">
        <button
          v-for="(hit, i) in results"
          :key="hit.session.id"
          class="sd-row"
          :class="{ on: i === selectedIndex, active: hit.session.id === activeId }"
          role="option"
          :aria-selected="i === selectedIndex"
          @click="openHit(hit.session.id)"
          @mousemove="selectedIndex = i"
        >
          <span class="sd-meta">
            <Icon class="sd-folder" name="folder-closed" size="sm" />
            <!-- eslint-disable-next-line vue/no-v-html -- highlightHtml escapes the source before injecting <mark>. -->
            <span
              class="sd-ws"
              v-html="highlightHtml(hit.session.workspaceName ?? hit.session.workspaceId ?? '', hit.inWorkspace ? query : '')"
            ></span>
            <span class="sd-time">{{ hit.session.time }}</span>
          </span>
          <!-- eslint-disable-next-line vue/no-v-html -- highlightHtml escapes the source before injecting <mark>. -->
          <span class="sd-title" v-html="highlightHtml(hit.session.title, hit.inTitle ? query : '')"></span>
          <!-- eslint-disable-next-line vue/no-v-html -- highlightHtml escapes the source before injecting <mark>. -->
          <span
            v-if="hit.snippetText"
            class="sd-snippet"
            v-html="highlightHtml(hit.snippetText, query)"
          ></span>
        </button>
      </template>
      <div v-else class="sd-empty">{{ t('sidebar.searchNoResults') }}</div>
    </div>

    <template #foot>
      <span class="sd-hint">{{ t('sidebar.searchHint') }}</span>
    </template>
  </Dialog>
</template>

<style scoped>
.sd-head {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.sd-search-icon {
  flex: none;
  color: var(--color-text-muted);
}
.sd-input {
  flex: 1;
  min-width: 0;
  font-family: var(--font-ui);
  font-size: var(--text-lg);
  color: var(--color-text);
  background: none;
  border: none;
  outline: none;
  padding: var(--space-1) 0;
}
.sd-input::placeholder {
  color: var(--color-text-muted);
}

.sd-list {
  height: 420px;
  overflow-y: auto;
  padding: var(--space-1) var(--space-2);
}
.sd-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-md);
  background: none;
  cursor: pointer;
  text-align: left;
  font-family: var(--font-ui);
  color: var(--color-text);
}
.sd-row:hover,
.sd-row.on {
  background: var(--color-surface-sunken);
}
.sd-row.active .sd-title {
  color: var(--color-accent-hover);
}

.sd-meta {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.sd-folder {
  flex: none;
  color: var(--color-text-muted);
}
.sd-ws {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sd-time {
  flex: none;
  font-family: var(--font-mono);
  color: var(--color-text-faint);
}

.sd-title {
  font-size: var(--text-base);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sd-snippet {
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* v-html content is outside the scoped tree, so :deep is required to style the
   injected <mark>. */
.sd-title :deep(mark),
.sd-snippet :deep(mark) {
  background: var(--color-accent);
  color: var(--color-bg);
  font-weight: 600;
  border-radius: var(--radius-xs);
  padding: 0 2px;
}

.sd-empty {
  padding: var(--space-6) var(--space-4);
  text-align: center;
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
.sd-hint {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
</style>
