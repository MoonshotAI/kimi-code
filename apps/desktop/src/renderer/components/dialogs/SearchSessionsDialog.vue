<!-- Spotlight-style search: type to filter workspaces (by name + path) and
     sessions (by title + last prompt + workspace). Workspaces land in their own
     section above the session hits (section heads carry counts); the empty
     query shows a few top workspaces plus the recent sessions. A workspace row
     is one line (icon + name, path right-aligned), a session hit is two
     (title + time, then workspace · snippet) with the query highlighted.
     Rows follow the sidebar's alignment contract: one icon gutter, one shared
     left edge for primary text, one shared right edge for trailing meta.
     ↑/↓ to move, ↵ to open, Esc to close. -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session, WorkspaceView } from '../../types';
import { highlightHtml, snippet } from '@moonshot-ai/app-core/lib';
import { Dialog, EmptyState, Icon, Input, Kbd, Tooltip, useImeComposition } from '@moonshot-ai/app-ui';

const { t } = useI18n();

const props = defineProps<{
  sessions: Session[];
  /** Registered workspaces in sidebar display order — searched by name and
   *  (home-shortened) path. */
  workspaces: WorkspaceView[];
  activeId: string;
}>();

const emit = defineEmits<{
  select: [id: string];
  /** A workspace row was picked: the Sidebar locates (and opens) it. */
  selectWorkspace: [id: string];
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

interface WorkspaceHit {
  workspace: WorkspaceView;
  /** Name matched the query (controls name highlighting). */
  inName: boolean;
  /** Path matched the query (controls path highlighting). */
  inPath: boolean;
}

interface SectionHead {
  label: string;
  /** Number of hits in the section, rendered next to the label. */
  count: number;
}

/** One selectable row. `section` is set on the first row of each kind, but only
 *  when BOTH kinds have hits — a lone kind renders label-free, exactly like the
 *  pre-sections dialog. */
type Item =
  | { kind: 'workspace'; key: string; section?: SectionHead; hit: WorkspaceHit }
  | { kind: 'session'; key: string; section?: SectionHead; hit: Hit };

const RESULT_CAP = 200;
/** Empty query: this many workspaces (in sidebar order) head the list as quick
 *  picks — a taste of the workspace search without pushing sessions below the
 *  fold. Typing searches across ALL workspaces. */
const EMPTY_QUERY_WORKSPACE_CAP = 3;

const items = computed<Item[]>(() => {
  const q = query.value.trim().toLowerCase();
  const workspaces: Item[] = [];
  if (q.length === 0) {
    for (const w of props.workspaces.slice(0, EMPTY_QUERY_WORKSPACE_CAP)) {
      workspaces.push({ kind: 'workspace', key: `ws:${w.id}`, hit: { workspace: w, inName: false, inPath: false } });
    }
  } else {
    for (const w of props.workspaces) {
      const inName = w.name.toLowerCase().includes(q);
      const inPath = w.shortPath.toLowerCase().includes(q);
      if (!inName && !inPath) continue;
      workspaces.push({ kind: 'workspace', key: `ws:${w.id}`, hit: { workspace: w, inName, inPath } });
    }
  }
  const sessions: Item[] = [];
  for (const s of props.sessions) {
    const title = s.title ?? '';
    const last = s.lastPrompt ?? '';
    const ws = s.workspaceName ?? '';
    const inTitle = q.length > 0 && title.toLowerCase().includes(q);
    const inLast = q.length > 0 && last.toLowerCase().includes(q);
    const inWorkspace = q.length > 0 && ws.toLowerCase().includes(q);
    // Empty query → show the full (recent) list; otherwise require a hit.
    if (q.length > 0 && !inTitle && !inLast && !inWorkspace) continue;
    sessions.push({
      kind: 'session',
      key: `s:${s.id}`,
      hit: {
        session: s,
        inTitle,
        inWorkspace,
        // Preview the last prompt whenever available; when searching, anchor the
        // snippet on the match (no-ops to the head when the title matched only).
        snippetText: last ? snippet(last, query.value) : '',
      },
    });
    if (sessions.length >= RESULT_CAP) break;
  }
  if (workspaces.length > 0 && sessions.length > 0) {
    workspaces[0]!.section = { label: t('sidebar.workspaces'), count: workspaces.length };
    sessions[0]!.section = { label: t('sidebar.sessionsHeader'), count: sessions.length };
  }
  return [...workspaces, ...sessions];
});

const selectedIndex = ref(0);

watch(query, () => {
  selectedIndex.value = 0;
});

function clampIndex(i: number): number {
  const len = items.value.length;
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

function openWorkspaceHit(id: string): void {
  emit('selectWorkspace', id);
  emit('close');
}

function clearQuery(): void {
  query.value = '';
  inputRef.value?.focus();
}

function openSelected(): void {
  const item = items.value[selectedIndex.value];
  if (!item) return;
  if (item.kind === 'workspace') openWorkspaceHit(item.hit.workspace.id);
  else openHit(item.hit.session.id);
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
        <template v-if="items.length > 0">
          <template v-for="(item, i) in items" :key="item.key">
            <div v-if="item.section" class="sd-section" aria-hidden="true">
              <span>{{ item.section.label }}</span>
              <span class="sd-section-count">{{ item.section.count }}</span>
            </div>
            <!-- Workspace hit: one line — folder icon, name (primary), then the
                 home-shortened path inline in quiet faint text. -->
            <button
              v-if="item.kind === 'workspace'"
              class="sd-row sd-row-ws"
              :class="{ on: i === selectedIndex }"
              role="option"
              :aria-selected="i === selectedIndex"
              @click="openWorkspaceHit(item.hit.workspace.id)"
              @mousemove="selectedIndex = i"
            >
              <Icon class="sd-folder" name="folder-closed" size="sm" />
              <!-- eslint-disable-next-line vue/no-v-html -- highlightHtml escapes the source before injecting <mark>. -->
              <span
                class="sd-ws-name"
                v-html="highlightHtml(item.hit.workspace.name, item.hit.inName ? query : '')"
              ></span>
              <!-- eslint-disable-next-line vue/no-v-html -- highlightHtml escapes the source before injecting <mark>. -->
              <span
                class="sd-ws-path"
                v-html="highlightHtml(item.hit.workspace.shortPath, item.hit.inPath ? query : '')"
              ></span>
            </button>
            <!-- Session hit: two lines — title + trailing time, then one quiet
                 meta line (workspace · snippet). -->
            <button
              v-else
              class="sd-row"
              :class="{ on: i === selectedIndex, active: item.hit.session.id === activeId }"
              role="option"
              :aria-selected="i === selectedIndex"
              @click="openHit(item.hit.session.id)"
              @mousemove="selectedIndex = i"
            >
              <span class="sd-line1">
                <!-- eslint-disable-next-line vue/no-v-html -- highlightHtml escapes the source before injecting <mark>. -->
                <span class="sd-title" v-html="highlightHtml(item.hit.session.title, item.hit.inTitle ? query : '')"></span>
                <span class="sd-time">{{ item.hit.session.time }}</span>
              </span>
              <span class="sd-line2">
                <!-- eslint-disable-next-line vue/no-v-html -- highlightHtml escapes the source before injecting <mark>. -->
                <span
                  class="sd-meta-ws"
                  v-html="highlightHtml(item.hit.session.workspaceName ?? item.hit.session.workspaceId ?? '', item.hit.inWorkspace ? query : '')"
                ></span>
                <template v-if="item.hit.snippetText">
                  <span class="sd-meta-sep" aria-hidden="true">·</span>
                  <!-- eslint-disable-next-line vue/no-v-html -- highlightHtml escapes the source before injecting <mark>. -->
                  <span class="sd-meta-snippet" v-html="highlightHtml(item.hit.snippetText, query)"></span>
                </template>
              </span>
            </button>
          </template>
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
  /* The sidebar's alignment contract, mirrored for the dialog rows: a leading
     icon gutter (the md icon-size token, same 16px slot as the sidebar's
     --sb-gutter) + 8px gap, so every primary text (workspace name, session
     title, meta line) shares one left edge; the trailing meta (path, time)
     shares the right edge set by the row padding. */
  --sd-gutter: var(--p-ic-md);
  --sd-gap: var(--space-2);
}
/* Section heads (workspaces / sessions, with match counts) — rendered only
   when both kinds have hits; the same quiet uppercase label language as the
   sidebar's own captions. The second head separates from the rows above with
   a hairline so the groups read as two lists, not one long one. */
.sd-section {
  display: flex;
  align-items: baseline;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3) var(--space-1);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-section-label);
  text-transform: uppercase;
  color: var(--color-text-faint);
  user-select: none;
}
.sd-section-count { font-weight: var(--weight-regular); }
.sd-section:first-child { padding-top: var(--space-1); }
.sd-section:not(:first-child) {
  margin-top: var(--space-1);
  border-top: var(--p-hairline) solid var(--color-line);
}

/* Rows share the §09 picker anatomy: 8px 12px padding, --radius-md, hover and
   keyboard-selected fills. */
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

/* Workspace row: single line — folder icon in the gutter, the name as the
   primary, and the path right-aligned at the shared trailing edge in quiet
   faint text (the path truncates first, then the name). */
.sd-row-ws {
  flex-direction: row;
  align-items: center;
  gap: var(--sd-gap);
}
.sd-folder {
  flex: none;
  width: var(--sd-gutter);
  color: var(--color-text-muted);
}
.sd-ws-name {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-base);
  color: var(--color-text);
}
.sd-ws-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}

/* Session rows carry no leading icon (same as the sidebar's icon-less rows):
   both lines indent past the gutter so the title and the meta line start on
   the same left edge as the workspace names above. */
.sd-line1,
.sd-line2 {
  padding-left: calc(var(--sd-gutter) + var(--sd-gap));
}
/* Session row, line 1: title (primary) + trailing recency in mono. */
.sd-line1 {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}
.sd-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-base);
  color: var(--color-text);
}
.sd-time {
  flex: none;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}
/* Session row, line 2: one quiet meta line — workspace · snippet. The
   workspace name caps at 40% so long names can't starve the snippet. */
.sd-line2 {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.sd-meta-ws {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sd-meta-sep { color: var(--color-text-faint); }
.sd-meta-snippet {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Quiet highlight: a soft accent wash + weight instead of a solid accent
   block with inverted text. Meta/snippet marks additionally lift to the body
   text color so matches stay legible at the smaller size. v-html lives
   outside the scoped tree, so :deep is required to style the injected <mark>. */
.sd-title :deep(mark),
.sd-ws-name :deep(mark) {
  background: var(--color-accent-soft);
  color: inherit;
  font-weight: var(--weight-semibold);
  border-radius: var(--radius-xs);
  padding: 0 1px;
}
.sd-line2 :deep(mark),
.sd-ws-path :deep(mark) {
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
