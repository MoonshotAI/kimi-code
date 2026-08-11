<!-- apps/web/src/components/dialogs/SearchSessionsDialog.vue -->
<!-- Spotlight-style session search: type to filter by title + last prompt, each
     hit shows its workspace, the session title, and a snippet of the matched
     content with the query highlighted. ↑/↓ to move, ↵ to open, Esc to close. -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session } from '../../types';
import { highlightHtml, snippet } from '../../lib/searchHighlight';
import { Dialog, EmptyState, Icon, Input, Kbd, Tooltip, useImeComposition } from '@moonshot-ai/web-ui';

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
const inputRef = ref<InstanceType<typeof Input> | null>(null);
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

function clearQuery(): void {
  query.value = '';
  inputRef.value?.focus();
}

function openSelected(): void {
  const hit = results.value[selectedIndex.value];
  if (hit) openHit(hit.session.id);
}

function focusInput(): HTMLElement | null {
  return inputRef.value?.el ?? null;
}

// IME guard: keys that only drive the composition (Enter confirming a
// candidate, arrows moving inside the candidate window) must not act on the list.
const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();

function onKeydown(e: KeyboardEvent): void {
  if (isComposingKeyEvent(e)) {
    // Escape while composing only cancels the candidate — keep it from
    // bubbling to Dialog's window-level closeOnEsc handler. No preventDefault:
    // the browser's candidate-cancel is the default action and must still run.
    if (e.key === 'Escape') e.stopPropagation();
    return;
  }
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
  // Dialog also focuses `initialFocus`; this is a belt-and-suspenders guarantee
  // for the rare timing where it runs before mount.
  inputRef.value?.focus();
});
</script>

<template>
  <Dialog
    v-model:open="open"
    :title="t('sidebar.searchPlaceholder')"
    size="lg"
    height="fixed"
    :padded="false"
    :initial-focus="focusInput"
    @close="emit('close')"
  >
    <div class="sd-body">
      <div class="sd-search">
        <Input
          ref="inputRef"
          v-model="query"
          :placeholder="t('sidebar.searchPlaceholder')"
          autocomplete="off"
          spellcheck="false"
          @keydown="onKeydown"
          @compositionstart="handleCompositionStart"
          @compositionend="handleCompositionEnd"
        />
        <Tooltip :text="t('sidebar.searchClear')">
          <button
            type="button"
            class="search-clear"
            :class="{ 'is-on': query.length > 0 }"
            tabindex="-1"
            :aria-label="t('sidebar.searchClear')"
            @click="clearQuery"
          >
            <Icon name="close" size="sm" />
          </button>
        </Tooltip>
      </div>

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
        <div v-else class="sd-empty">
          <EmptyState :title="query.trim() ? t('sidebar.searchNoResults') : t('sidebar.searchEmpty')">
            <template #icon>
              <Icon name="search" size="lg" />
            </template>
          </EmptyState>
        </div>
      </div>

      <div class="sd-foot" aria-hidden="true">
        <span class="sd-hint"><Kbd :keys="['↑', '↓']" />{{ t('sidebar.searchHintSelect') }}</span>
        <span class="sd-dot">·</span>
        <span class="sd-hint"><Kbd :keys="['Enter']" />{{ t('sidebar.searchHintOpen') }}</span>
        <span class="sd-dot">·</span>
        <span class="sd-hint"><Kbd :keys="['Esc']" />{{ t('sidebar.searchHintClose') }}</span>
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
/* Note: Dialog renders through a Teleport, so its internal elements only
   carry Dialog's own scope id — scoped :deep() overrides from here can never
   match them. Styling must live on the slot content (`.sd-*`), which does
   carry this component's scope id. */

/* Search row aligns with the Dialog head padding (title sits at 22px) —
   same anatomy as ModelPicker's search zone. */
.sd-search {
  position: relative;
  margin: 0 22px;
  padding-bottom: var(--space-1);
}
/* Room for the clear affordance so long queries never run beneath it. */
.sd-search :deep(.ui-input) { padding-right: 30px; }

/* Clear query: quiet circled × at the input's trailing edge — same look and
   behavior as ModelPicker's .search-clear (keep the two in sync). */
.search-clear {
  position: absolute;
  top: 0;
  bottom: var(--space-1);
  right: var(--space-2);
  margin-block: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: var(--radius-full);
  background: var(--color-hover);
  color: var(--color-text-faint);
  cursor: pointer;
  visibility: hidden;
  opacity: 0;
  transition: opacity var(--duration-fast) var(--ease-out), visibility var(--duration-fast),
    background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
}
.search-clear.is-on { visibility: visible; opacity: 1; }
.search-clear:hover { background: var(--color-selected); color: var(--color-text-muted); }
.search-clear:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
@media (prefers-reduced-motion: reduce) {
  .search-clear { transition: none; }
}

.sd-body {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: 4px;
}
.sd-list {
  flex: 1;
  min-height: 0;
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
.sd-row:hover {
  background: var(--color-hover);
}
.sd-row.on {
  background: var(--color-selected);
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
  min-width: 0;
  font-size: var(--text-base);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sd-snippet {
  min-width: 0;
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Quiet highlight: a soft accent wash + weight instead of a solid accent
   block with inverted text. Meta/snippet marks additionally lift to the body
   text color so matches stay legible at the smaller size. v-html lives
   outside the scoped tree, so :deep is required to style the injected <mark>. */
.sd-title :deep(mark) {
  background: var(--color-accent-soft);
  color: inherit;
  font-weight: var(--weight-semibold);
  border-radius: var(--radius-xs);
  padding: 0 1px;
}
.sd-meta :deep(mark),
.sd-snippet :deep(mark) {
  background: var(--color-accent-soft);
  color: var(--color-text);
  font-weight: var(--weight-medium);
  border-radius: var(--radius-xs);
  padding: 0 1px;
}

.sd-empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sd-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-4);
  border-top: 0.5px solid var(--color-line);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
.sd-hint {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.sd-dot { margin: 0 var(--space-1); }
</style>
