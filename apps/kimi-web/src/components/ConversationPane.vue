<!-- apps/kimi-web/src/components/ConversationPane.vue -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ActivityState, ApprovalBlock, ChatTurn, ConnectionState, ContentAlign, ConversationStatus, DiffViewLine, PaneKey, PermissionMode, TaskItem, UIQuestion } from '../types';
import type { AppModel, ApprovalDecision, FsEntry, QuestionResponse, ThinkingLevel } from '../api/types';
import type { FileItem } from './MentionMenu.vue';
import type { FileData } from './FilePreview.vue';
import TabBar from './TabBar.vue';
import ChatPane from './ChatPane.vue';
import DiffView from './DiffView.vue';
import ChangedTree from './ChangedTree.vue';
import TasksPane from './TasksPane.vue';
import FileTree from './FileTree.vue';
import FilePreview from './FilePreview.vue';
import Composer from './Composer.vue';
import QuestionCard from './QuestionCard.vue';

const props = defineProps<{
  turns: ChatTurn[];
  approvals?: { approvalId: string; block: ApprovalBlock; agentName?: string }[];
  changes?: { path: string; status: string }[];
  gitInfo?: { branch: string; ahead: number; behind: number } | null;
  // ~/diff line-by-line view
  fileDiff?: DiffViewLine[];
  selectedDiffPath?: string | null;
  fileDiffLoading?: boolean;
  loadFileDiff?: (path: string) => Promise<void> | void;
  clearFileDiff?: () => void;
  tasks: TaskItem[];
  status: ConversationStatus;
  thinking?: ThinkingLevel;
  planMode?: boolean;
  questions?: UIQuestion[];
  running?: boolean;
  queued?: string[];
  searchFiles?: (q: string) => Promise<FileItem[]>;
  uploadImage?: (file: Blob, name?: string) => Promise<{ fileId: string; name: string; mediaType: string } | null>;
  connection?: ConnectionState;
  activity?: ActivityState;
  sending?: boolean;
  // File browser props
  loadDir?: (path: string) => Promise<FsEntry[]>;
  readFile?: (path: string) => Promise<FileData | null>;
  changesByPath?: Record<string, string>;
  fileReloadKey?: string | number;
  /** Mobile shell: compact chrome + give the TabBar bigger taps. */
  mobile?: boolean;
  /** Modern theme: render chat bubbles at all widths (desktop included). */
  modern?: boolean;
  /** True while switching sessions and the turns array is not yet loaded. */
  sessionLoading?: boolean;
  /** Available models for the quick-switch dropdown in the composer toolbar. */
  models?: AppModel[];
}>();

const emit = defineEmits<{
  submit: [payload: { text: string; attachments: { fileId: string }[] }];
  approval: [approvalId: string, response: { decision: 'approved' | 'rejected' | 'cancelled'; scope?: 'session'; feedback?: string }];
  cancelTask: [taskId: string];
  answer: [questionId: string, response: QuestionResponse];
  dismiss: [questionId: string];
  command: [cmd: string];
  interrupt: [];
  unqueue: [index: number];
  editQueued: [index: number];
  setPermission: [mode: PermissionMode];
  setThinking: [level: ThinkingLevel];
  togglePlan: [];
  compact: [];
  pickModel: [];
  selectModel: [modelId: string];
}>();

const { t } = useI18n();

// ---------------------------------------------------------------------------
// Content alignment (left vs centered) + max reading width. Persisted so the
// reading layout sticks across reloads. The max-width applies in both modes.
// ---------------------------------------------------------------------------
const CONTENT_ALIGN_KEY = 'kimi-web.content-align';

function loadAlignFromStorage(): ContentAlign {
  try {
    const v = localStorage.getItem(CONTENT_ALIGN_KEY);
    if (v === 'left' || v === 'center') return v;
  } catch {
    // localStorage unavailable — fall back to default
  }
  return 'center';
}

const contentAlign = ref<ContentAlign>(loadAlignFromStorage());

function setAlign(align: ContentAlign): void {
  contentAlign.value = align;
  try {
    localStorage.setItem(CONTENT_ALIGN_KEY, align);
  } catch {
    // ignore
  }
}

// expose a way for App.vue to imperatively switch to tasks tab
const active = ref<PaneKey>('chat');

/** Called by App.vue via command routing to switch to a specific tab */
function switchTab(tab: PaneKey): void {
  active.value = tab;
}
defineExpose({ switchTab });

// Bubble chat layout: always on mobile, and on desktop under the Modern theme.
const bubble = computed(() => props.mobile === true || props.modern === true);

const runningTasks = computed(() => props.tasks.filter((t) => t.state === 'run').length);
const changesCount = computed(() => props.changes?.length ?? 0);

// The first pending question (if any)
const pendingQuestion = computed<UIQuestion | undefined>(() =>
  props.questions && props.questions.length > 0 ? props.questions[0] : undefined,
);

function handleApprovalDecide(
  approvalId: string,
  response: { decision: ApprovalDecision; scope?: 'session'; feedback?: string },
): void {
  emit('approval', approvalId, response);
}

// ---------------------------------------------------------------------------
// File browser state (local to this pane, lives here so re-mounting the pane
// doesn't reset it unless the session changes)
// ---------------------------------------------------------------------------

const selectedFile = ref<FileData | null>(null);
const previewLoading = ref(false);
// Mobile drill-down: false = showing the tree, true = showing the preview with a
// Back affordance. Desktop ignores this (the split shows both at once).
const filesShowPreview = ref(false);

async function handleFileSelect(entry: FsEntry): Promise<void> {
  if (!props.readFile) return;
  // On mobile, drill into the preview view immediately (even while loading).
  if (props.mobile) filesShowPreview.value = true;
  previewLoading.value = true;
  selectedFile.value = null;
  try {
    const result = await props.readFile(entry.path);
    if (result) {
      selectedFile.value = result;
    }
  } finally {
    previewLoading.value = false;
  }
}

// ---------------------------------------------------------------------------
// Merged ~/files tab: a navigator (left/full-width) with a Changed|All toggle,
// and an adaptive content pane (right/drill-down) — a changed file shows its
// line-by-line diff, an unchanged file shows its content preview.
// ---------------------------------------------------------------------------
const changedView = ref<'changed' | 'all'>('changed');

// The "Changed" navigator can show a flat list or a directory tree (persisted).
const CHANGED_LAYOUT_KEY = 'kimi-web.changed-layout';
function loadChangedLayout(): 'list' | 'tree' {
  try {
    const v = localStorage.getItem(CHANGED_LAYOUT_KEY);
    if (v === 'tree' || v === 'list') return v;
  } catch {
    // ignore
  }
  return 'tree';
}
const changedLayout = ref<'list' | 'tree'>(loadChangedLayout());
function toggleChangedLayout(): void {
  changedLayout.value = changedLayout.value === 'tree' ? 'list' : 'tree';
  try {
    localStorage.setItem(CHANGED_LAYOUT_KEY, changedLayout.value);
  } catch {
    // ignore
  }
}

function isChanged(path: string): boolean {
  return props.changesByPath?.[path] !== undefined;
}

/** Pick a changed file → show its diff. Clears any file-content preview first. */
function pickChanged(path: string): void {
  selectedFile.value = null;
  if (props.mobile) filesShowPreview.value = true;
  void props.loadFileDiff?.(path);
}

/** Pick a tree entry → diff if it's a changed file, else its content preview. */
async function pickEntry(entry: FsEntry): Promise<void> {
  if (entry.kind === 'directory') return;
  if (isChanged(entry.path)) {
    pickChanged(entry.path);
    return;
  }
  props.clearFileDiff?.();
  await handleFileSelect(entry);
}

/** Mobile: return from the content pane back to the navigator; clear selections. */
function handleFilesBack(): void {
  filesShowPreview.value = false;
  props.clearFileDiff?.();
  selectedFile.value = null;
}

// No-op loadDir fallback so FileTree never receives undefined
function defaultLoadDir(): Promise<FsEntry[]> {
  return Promise.resolve([]);
}

// ---------------------------------------------------------------------------
// Auto-scroll + "new messages" pill (chat tab only)
// ---------------------------------------------------------------------------

const panesRef = ref<HTMLElement | null>(null);
const atBottom = ref(true);
const showPill = ref(false);

/** Within this many pixels from the bottom counts as "at the bottom". */
const BOTTOM_THRESHOLD = 80;

function checkAtBottom(): boolean {
  const el = panesRef.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD;
}

function onPanesScroll(): void {
  atBottom.value = checkAtBottom();
  if (atBottom.value) showPill.value = false;
}

function scrollToBottom(smooth = false): void {
  const el = panesRef.value;
  if (!el) return;
  // Guard: el.scrollTo may be absent in jsdom/test environments
  if (typeof el.scrollTo === 'function') {
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  } else {
    el.scrollTop = el.scrollHeight;
  }
  atBottom.value = true;
  showPill.value = false;
}

// Scroll key: reacts to new turns AND to ANY streaming content on the last turn —
// thinking deltas, text deltas, and tool output all grow the view, so all must
// trigger the follow-to-bottom (previously only text was tracked, so the view
// stopped following during the thinking phase).
const scrollKey = computed(() => {
  if (active.value !== 'chat') return '';
  // Include approvals so the view scrolls when a new approval card appears
  // (e.g. a tool call waiting for user confirmation at the end of the stream).
  const approvalIds = (props.approvals ?? []).map((a) => a.approvalId).join(',');
  const t = props.turns;
  if (t.length === 0) return `0|${approvalIds}`;
  const last = t[t.length - 1]!;
  const thinkingLen = last.thinking?.length ?? 0;
  const toolsLen =
    last.tools?.reduce(
      (n, tool) => n + tool.name.length + (tool.arg?.length ?? 0) + (tool.output?.join('').length ?? 0),
      0,
    ) ?? 0;
  return `${t.length}:${last.text.length}:${thinkingLen}:${toolsLen}|${approvalIds}`;
});

// Stick-to-bottom window: after a session's messages load, markstream/shiki keep
// growing the content for a short while (code highlighting, images), so a single
// scrollToBottom lands short of the end. While the window is open we force-follow
// the bottom on every content change; a user scroll (wheel/touch) cancels it.
const STICK_WINDOW_MS = 1200;
let stickBottom = false;
let stickTimer: ReturnType<typeof setTimeout> | undefined;
function stickToBottomFor(ms: number): void {
  stickBottom = true;
  if (stickTimer) clearTimeout(stickTimer);
  stickTimer = setTimeout(() => {
    stickBottom = false;
  }, ms);
}
function cancelStick(): void {
  stickBottom = false;
}

watch(scrollKey, async () => {
  if (active.value !== 'chat') return;
  await nextTick();
  if (stickBottom) {
    scrollToBottom(false);
    return;
  }
  if (atBottom.value) {
    scrollToBottom(false);
  } else {
    showPill.value = true;
  }
});

// When switching to the chat tab, scroll to bottom immediately. Leaving the
// files tab resets the mobile drill-down back to the tree so re-entering it
// never lands on a stale preview.
watch(active, async (tab) => {
  if (tab !== 'files') filesShowPreview.value = false;
  if (tab !== 'chat') {
    cancelStick(); // leaving chat: drop any stale stick window so it can't lock the pill on return
    return;
  }
  await nextTick();
  scrollToBottom(false);
});

// New session (reload key changes): reset the mobile files drill-down + clear
// any previously-opened preview, and scroll chat to bottom so the user lands
// at the end of the newly-selected historical session.
watch(
  () => props.fileReloadKey,
  async () => {
    filesShowPreview.value = false;
    selectedFile.value = null;
    // Arm the stick window on every session switch (fires synchronously here).
    // This survives rapid A->B->C switching, where overlapping async loads can
    // collapse sessionLoading's true->false edge into a single transition (the
    // watch below would then only fire once and later sessions land short).
    stickToBottomFor(STICK_WINDOW_MS);
    await nextTick();
    scrollToBottom(false);
  },
);

// Land at the bottom of a freshly-opened historical session. The fileReloadKey
// watch above fires the instant activeSessionId changes — BEFORE the messages
// finish their async REST load — so it scrolls an empty view, and the markdown
// then renders tall (markstream/shiki) which the atBottom-gated watchers won't
// follow. `sessionLoading` brackets the async load in selectSession (true ->
// load -> false); on its true->false edge the turns have rendered, so we scroll
// AND open a stick window to keep following until the tall markdown settles.
watch(
  () => props.sessionLoading,
  async (loading, was) => {
    if (loading || !was) return; // only on the load-finished (true -> false) edge
    if (active.value !== 'chat') return;
    stickToBottomFor(STICK_WINDOW_MS);
    await nextTick();
    scrollToBottom(false);
  },
);

// Robust follow-to-bottom: a MutationObserver catches EVERY content change in
// the chat area — streaming text, thinking deltas (even while collapsed), tool
// output, markdown, images — and follows the bottom when the user is already
// there. The scrollKey watch above only sees Vue-tracked content; this catches
// the rest (this is what fixes "no auto-scroll during the thinking phase").
let contentObserver: MutationObserver | null = null;
let scrollRaf = 0;

function onContentMutated(): void {
  if (active.value !== 'chat') return;
  if (scrollRaf) return;
  const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 16) as unknown as number;
  scrollRaf = schedule(() => {
    scrollRaf = 0;
    if (stickBottom) {
      scrollToBottom(false);
      return;
    }
    if (atBottom.value) scrollToBottom(false);
    else showPill.value = true;
  }) as unknown as number;
}

onMounted(() => {
  // Initial scroll to bottom on first load.
  nextTick(() => {
    scrollToBottom(false);
    if (panesRef.value && typeof MutationObserver === 'function') {
      contentObserver = new MutationObserver(onContentMutated);
      contentObserver.observe(panesRef.value, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
    // A real user scroll cancels the stick-to-bottom window so we never fight
    // someone who scrolls up right after opening a session.
    if (panesRef.value) {
      panesRef.value.addEventListener('wheel', cancelStick, { passive: true });
      panesRef.value.addEventListener('touchstart', cancelStick, { passive: true });
    }
  });
});

onUnmounted(() => {
  if (contentObserver) contentObserver.disconnect();
  if (scrollRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scrollRaf);
  if (stickTimer) clearTimeout(stickTimer);
  if (panesRef.value) {
    panesRef.value.removeEventListener('wheel', cancelStick);
    panesRef.value.removeEventListener('touchstart', cancelStick);
  }
});
</script>

<template>
  <section class="con" :class="{ mobile }">
    <TabBar
      :active="active"
      :running-tasks="runningTasks"
      :changes-count="changesCount"
      :align="contentAlign"
      :mobile="mobile"
      @select="active = $event"
      @set-align="setAlign"
    />
    <div
      ref="panesRef"
      class="panes"
      :class="{ 'files-layout': active === 'files' }"
      @scroll.passive="onPanesScroll"
    >
      <!-- Chat reading column: constrained to a comfortable max width and
           aligned left or centered within the pane. -->
      <div v-if="active === 'chat'" class="content-wrap" :class="[mobile ? 'align-mobile' : `align-${contentAlign}`]">
        <ChatPane
          :key="fileReloadKey ?? 'no-session'"
          :turns="turns"
          :approvals="approvals"
          :bubble="bubble"
          :mobile="mobile"
          :running="running"
          :sending="sending"
          :session-loading="sessionLoading"
          @approval-decide="handleApprovalDecide"
        />
      </div>
      <TasksPane
        v-else-if="active === 'tasks'"
        :tasks="tasks"
        @cancel="emit('cancelTask', $event)"
      />

      <!-- Merged ~/files tab: a navigator (Changed-first list / full tree via the
           Changed|All toggle) on the left, an adaptive content pane on the right
           (diff for changed files, content preview for unchanged ones). Desktop =
           side-by-side split; mobile = single-column drill-down (v-show gates which
           half is visible; the divider only exists on desktop). -->
      <template v-else-if="active === 'files'">
        <div v-show="!mobile || !filesShowPreview" class="files-nav">
          <div class="nav-seg">
            <div class="seg-group" role="group" :aria-label="t('fileTree.segLabel')">
              <button
                type="button"
                class="seg-btn"
                :class="{ on: changedView === 'changed' }"
                :aria-pressed="changedView === 'changed'"
                @click="changedView = 'changed'"
              >
                {{ t('fileTree.changed') }}
                <span v-if="(changesCount ?? 0) > 0" class="seg-n">{{ changesCount }}</span>
              </button>
              <button
                type="button"
                class="seg-btn"
                :class="{ on: changedView === 'all' }"
                :aria-pressed="changedView === 'all'"
                @click="changedView = 'all'"
              >{{ t('fileTree.all') }}</button>
            </div>
          </div>
          <!-- list/tree layout toggle for the Changed view -->
          <div v-if="changedView === 'changed'" class="nav-tools">
            <button
              type="button"
              class="layout-toggle"
              :title="changedLayout === 'tree' ? t('fileTree.listView') : t('fileTree.treeView')"
              :aria-label="changedLayout === 'tree' ? t('fileTree.listView') : t('fileTree.treeView')"
              @click="toggleChangedLayout"
            >
              <svg v-if="changedLayout === 'list'" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 4h2M3 8h2M3 12h2"/><path d="M7.5 4l1.5 1.5L7.5 7"/><path d="M9 5.5h4M9 9.5h3.5M9 12.5h3"/></svg>
              <svg v-else viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h10"/></svg>
            </button>
          </div>
          <div class="files-nav-body">
            <template v-if="changedView === 'changed'">
              <DiffView
                v-if="changedLayout === 'list'"
                mode="list"
                :changes="changes ?? []"
                :git-info="null"
                @open="pickChanged"
              />
              <ChangedTree v-else :changes="changes ?? []" @open="pickChanged" />
            </template>
            <FileTree
              v-else
              :load-dir="loadDir ?? defaultLoadDir"
              :changes-by-path="changesByPath ?? {}"
              :reload-key="fileReloadKey"
              @select="pickEntry"
            />
          </div>
        </div>

        <div v-if="!mobile" class="files-divider" aria-hidden="true"></div>

        <div v-show="!mobile || filesShowPreview" class="files-content">
          <button v-if="mobile" type="button" class="files-back" @click="handleFilesBack">
            <span aria-hidden="true">&#8592;</span>
            <span class="files-back-label">{{ t('fileTree.backToTree') }}</span>
          </button>
          <DiffView
            v-if="selectedDiffPath"
            mode="detail"
            :hide-back="true"
            :changes="changes ?? []"
            :git-info="gitInfo ?? null"
            :file-diff="fileDiff ?? []"
            :selected-diff-path="selectedDiffPath ?? null"
            :file-diff-loading="fileDiffLoading ?? false"
          />
          <FilePreview
            v-else-if="selectedFile || previewLoading"
            :file="selectedFile"
            :loading="previewLoading"
          />
          <div v-else class="files-empty">
            {{ changedView === 'changed' ? t('fileTree.selectChanged') : t('fileTree.selectFile') }}
          </div>
        </div>
      </template>
    </div>

    <!-- "New messages" pill — only visible on chat tab when the user has
         scrolled up and new content has arrived. -->
    <Transition name="pill">
      <button
        v-if="showPill && active === 'chat'"
        class="newmsg-pill"
        @click="scrollToBottom(true)"
        :aria-label="t('conversation.jumpToLatestAria')"
      >
        <svg
          class="pill-chevron"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="4,6 8,10 12,6" />
        </svg>
        {{ t('conversation.newMessages') }}
      </button>
    </Transition>

    <!-- Bottom dock. Capped to the chat reading column so it doesn't stretch
         edge-to-edge on wide screens. The composer/input sits on top; the status
         line is a quiet footer BELOW it (model/thinking/plan/permission left,
         ctx far right). -->
    <div class="dock" :class="[mobile ? 'align-mobile' : `align-${contentAlign}`]">
      <!-- QuestionCard replaces Composer while a question is pending -->
      <QuestionCard
        v-if="pendingQuestion"
        :question="pendingQuestion"
        @answer="(qid, resp) => emit('answer', qid, resp)"
        @dismiss="(qid) => emit('dismiss', qid)"
      />
      <Composer
        v-else
        :running="running"
        :queued="queued"
        :search-files="searchFiles"
        :upload-image="uploadImage"
        :status="status"
        :thinking="thinking"
        :plan-mode="planMode"
        :models="models"
        @submit="emit('submit', $event)"
        @command="emit('command', $event)"
        @interrupt="emit('interrupt')"
        @unqueue="emit('unqueue', $event)"
        @edit-queued="emit('editQueued', $event)"
        @set-permission="emit('setPermission', $event)"
        @set-thinking="emit('setThinking', $event)"
        @toggle-plan="emit('togglePlan')"
        @compact="emit('compact')"
        @pick-model="emit('pickModel')"
        @select-model="emit('selectModel', $event)"
      />
    </div>
  </section>
</template>

<style scoped>
.con {
  --read-max: 760px;
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100%;
  position: relative;
}
.panes { flex: 1; min-height: 0; overflow-y: auto; }

/* Chat reading column max-width + alignment. The max-width applies in both
   modes; align-left hugs the left gutter, align-center centers in the pane. */
.content-wrap {
  max-width: var(--read-max);
  /* Fill the scroll viewport so an empty conversation can vertically center its
     hint (ChatPane grows via flex:1). With messages it grows past 100% and the
     .panes scrolls as usual. */
  min-height: 100%;
  display: flex;
  flex-direction: column;
}
.content-wrap.align-center { margin-left: auto; margin-right: auto; }
.content-wrap.align-left { margin-left: 0; margin-right: auto; }
/* Mobile: bubbles span the full pane width; no reading-column constraint. */
.content-wrap.align-mobile { max-width: none; }

/* Bottom dock (status line + composer): capped to the same reading column as
   the chat and aligned the same way, so it doesn't stretch the full pane width
   on wide screens. Full-width on mobile. */
.dock {
  flex: none;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: var(--read-max);
}
.dock.align-center { margin-left: auto; margin-right: auto; }
.dock.align-left { margin-left: 0; margin-right: auto; }
.dock.align-mobile { max-width: none; }

/* Capped desktop dock (center/left): the fused composer card is the visual
   anchor. No panel border, no hard dividers — the dock blends into the (white)
   chat surface and the rounded composer card defines the area. Mobile keeps its
   own flat full-width bar. */
.dock:not(.align-mobile) :deep(.composer) {
  border-top: none;
  background: transparent;
  padding-bottom: 4px;
}

/* Merged files pane: horizontal split (navigator | divider | content), no outer scroll */
.panes.files-layout {
  display: flex;
  flex-direction: row;
  overflow: hidden;
}

/* Left navigator: the Changed|All toggle + (changed list / full tree). */
.files-nav {
  width: 38%;
  min-width: 180px;
  max-width: 340px;
  flex: none;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.files-nav-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* Changed | All segmented toggle (+ list/tree layout toggle on the right). */
.nav-seg {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.seg-group {
  flex: 1;
  display: flex;
  min-width: 0;
}
.layout-toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 24px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--bg);
  color: var(--muted);
  cursor: pointer;
}
.layout-toggle:hover { color: var(--blue); border-color: var(--bd); }
.seg-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
  padding: 4px 8px;
  cursor: pointer;
  transition: background 0.14s, color 0.14s;
}
.seg-btn:first-child { border-radius: 6px 0 0 6px; border-right: none; }
.seg-btn:last-child { border-radius: 0 6px 6px 0; }
.seg-btn:hover { color: var(--ink); }
.seg-btn.on {
  background: var(--soft);
  color: var(--blue2);
  font-weight: 600;
  border-color: var(--bd);
}
.seg-n {
  font-size: 9.5px;
  background: var(--blue);
  color: #fff;
  border-radius: 8px;
  padding: 0 5px;
  line-height: 1.5;
}
.seg-btn.on .seg-n { background: var(--blue); }

/* Layout toggle bar (tree/list) sits on its own row below the Changed|All toggle. */
.nav-tools {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 4px 10px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}

.files-divider {
  width: 1px;
  background: var(--line);
  flex: none;
  align-self: stretch;
}

/* Right content: adaptive (diff detail / file preview / empty). */
.files-content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.files-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 24px;
  color: var(--muted);
  font-size: 12.5px;
  text-align: center;
}

/* Make the child components (DiffView list/detail, FileTree, FilePreview) fill
   their pane and scroll internally. */
.files-nav-body :deep(.changes-pane),
.files-content :deep(.changes-pane),
.files-content :deep(.file-preview) {
  flex: 1;
  min-height: 0;
}

/* ---------------------------------------------------------------------------
   Merged files pane MOBILE drill-down: a single full-width column. The navigator
   fills the pane; picking a file swaps to a full-width content pane with its own
   Back row. v-show hides the inactive half. No side-by-side split.
   --------------------------------------------------------------------------- */
@media (max-width: 640px) {
  .panes.files-layout {
    flex-direction: column;
  }
  .files-nav,
  .files-content {
    width: 100%;
    max-width: none;
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .files-content :deep(.file-preview) { flex: 1; min-height: 0; }

  .files-back {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-height: 44px;
    padding: 8px 14px;
    background: var(--panel);
    border: none;
    border-bottom: 1px solid var(--line);
    color: var(--dim);
    font-family: var(--mono);
    font-size: 13px;
    cursor: pointer;
    text-align: left;
  }
  .files-back:active { background: var(--panel2); }
  .files-back-label { font-weight: 600; }
}

/* "New messages" floating pill */
.newmsg-pill {
  position: absolute;
  bottom: 112px; /* above the Composer toolbar */
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 14px 6px 10px;
  background: var(--blue);
  color: #fff;
  border: none;
  border-radius: 20px;
  font-size: 14px;
  font-family: var(--mono);
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.22);
  z-index: 10;
  white-space: nowrap;
}
.newmsg-pill:hover {
  background: var(--blue2);
}
.pill-chevron {
  width: 14px;
  height: 14px;
  flex: none;
}

/* Pill enter/leave transition */
.pill-enter-active,
.pill-leave-active {
  transition: opacity 0.15s, transform 0.15s;
}
.pill-enter-from,
.pill-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}
</style>
