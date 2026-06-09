<!-- apps/kimi-web/src/components/ConversationPane.vue -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ActivityState, ApprovalBlock, ChatTurn, ConnectionState, ContentAlign, ConversationStatus, DiffViewLine, PaneKey, PermissionMode, TaskItem, UIQuestion } from '../types';
import type { ApprovalDecision, FsEntry, QuestionResponse, ThinkingLevel } from '../api/types';
import type { FileItem } from './MentionMenu.vue';
import type { FileData } from './FilePreview.vue';
import TabBar from './TabBar.vue';
import ChatPane from './ChatPane.vue';
import DiffView from './DiffView.vue';
import TasksPane from './TasksPane.vue';
import FileTree from './FileTree.vue';
import FilePreview from './FilePreview.vue';
import StatusLine from './StatusLine.vue';
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
  // File browser props
  loadDir?: (path: string) => Promise<FsEntry[]>;
  readFile?: (path: string) => Promise<FileData | null>;
  changesByPath?: Record<string, string>;
  fileReloadKey?: string | number;
  /** Mobile shell: hide the desktop StatusLine + give the TabBar bigger taps. */
  mobile?: boolean;
  /** Modern theme: render chat bubbles at all widths (desktop included). */
  modern?: boolean;
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

/** Mobile: return from the file preview back to the tree. */
function handleFilesBack(): void {
  filesShowPreview.value = false;
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
  const t = props.turns;
  if (t.length === 0) return '0';
  const last = t[t.length - 1]!;
  const thinkingLen = last.thinking?.length ?? 0;
  const toolsLen =
    last.tools?.reduce(
      (n, tool) => n + tool.name.length + (tool.arg?.length ?? 0) + (tool.output?.join('').length ?? 0),
      0,
    ) ?? 0;
  return `${t.length}:${last.text.length}:${thinkingLen}:${toolsLen}`;
});

watch(scrollKey, async () => {
  if (active.value !== 'chat') return;
  await nextTick();
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
  if (tab !== 'chat') return;
  await nextTick();
  scrollToBottom(false);
});

// New session (reload key changes): reset the mobile files drill-down + clear
// any previously-opened preview.
watch(
  () => props.fileReloadKey,
  () => {
    filesShowPreview.value = false;
    selectedFile.value = null;
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
  });
});

onUnmounted(() => {
  if (contentObserver) contentObserver.disconnect();
  if (scrollRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scrollRaf);
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
          :turns="turns"
          :approvals="approvals"
          :bubble="bubble"
          :mobile="mobile"
          :running="running"
          @approval-decide="handleApprovalDecide"
        />
      </div>
      <DiffView
        v-else-if="active === 'diff'"
        :changes="changes ?? []"
        :git-info="gitInfo ?? null"
        :file-diff="fileDiff ?? []"
        :selected-diff-path="selectedDiffPath ?? null"
        :file-diff-loading="fileDiffLoading ?? false"
        @open="(path: string) => loadFileDiff?.(path)"
        @back="() => clearFileDiff?.()"
      />
      <TasksPane
        v-else-if="active === 'tasks'"
        :tasks="tasks"
        @cancel="emit('cancelTask', $event)"
      />
      <!-- ~/files DESKTOP: horizontal split (tree | preview) -->
      <template v-else-if="active === 'files' && !mobile">
        <div class="files-tree-panel">
          <FileTree
            :load-dir="loadDir ?? defaultLoadDir"
            :changes-by-path="changesByPath ?? {}"
            :reload-key="fileReloadKey"
            @select="handleFileSelect"
          />
        </div>
        <div class="files-divider" aria-hidden="true"></div>
        <div class="files-preview-panel">
          <FilePreview :file="selectedFile" :loading="previewLoading" />
        </div>
      </template>

      <!-- ~/files MOBILE: single-column drill-down. Tapping a file in the
           full-width tree swaps to a full-width preview with a Back affordance
           (instead of the desktop side-by-side split that won't fit a phone). -->
      <template v-else-if="active === 'files' && mobile">
        <div v-show="!filesShowPreview" class="files-tree-mobile">
          <FileTree
            :load-dir="loadDir ?? defaultLoadDir"
            :changes-by-path="changesByPath ?? {}"
            :reload-key="fileReloadKey"
            @select="handleFileSelect"
          />
        </div>
        <div v-if="filesShowPreview" class="files-preview-mobile">
          <button type="button" class="files-back" @click="handleFilesBack">
            <span aria-hidden="true">&#8592;</span>
            <span class="files-back-label">{{ t('fileTree.backToTree') }}</span>
          </button>
          <FilePreview :file="selectedFile" :loading="previewLoading" />
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

    <!-- Bottom dock (status line + composer). Capped to the same reading-column
         width as the chat so it doesn't stretch edge-to-edge on wide screens. -->
    <div class="dock" :class="[mobile ? 'align-mobile' : `align-${contentAlign}`]">
      <StatusLine
        v-if="!mobile"
        :status="status"
        :connection="connection"
        :activity="activity"
        :thinking="thinking"
        :plan-mode="planMode"
        @set-permission="emit('setPermission', $event)"
        @set-thinking="emit('setThinking', $event)"
        @toggle-plan="emit('togglePlan')"
        @compact="emit('compact')"
        @interrupt="emit('interrupt')"
        @pick-model="emit('pickModel')"
      />
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
        @submit="emit('submit', $event)"
        @command="emit('command', $event)"
        @interrupt="emit('interrupt')"
        @unqueue="emit('unqueue', $event)"
        @edit-queued="emit('editQueued', $event)"
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

/* Files pane: horizontal split, no outer scroll */
.panes.files-layout {
  display: flex;
  flex-direction: row;
  overflow: hidden;
}

.files-tree-panel {
  width: 38%;
  min-width: 160px;
  max-width: 320px;
  flex: none;
  overflow: hidden;
  border-right: none;
}

.files-divider {
  width: 1px;
  background: var(--line);
  flex: none;
  align-self: stretch;
}

.files-preview-panel {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

/* ---------------------------------------------------------------------------
   Files pane MOBILE drill-down: a single full-width column. The tree fills the
   pane; selecting a file swaps to a full-width preview that has its own Back
   row. No side-by-side split (it won't fit a phone). Desktop is untouched.
   --------------------------------------------------------------------------- */
@media (max-width: 640px) {
  /* The mobile files branch lays its single child out as a full-height column. */
  .panes.files-layout {
    flex-direction: column;
  }
  .files-tree-mobile,
  .files-preview-mobile {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  /* FileTree fills + scrolls itself; bigger row taps come from FileTree's own
     mobile rules. */
  .files-tree-mobile { width: 100%; }
  /* The preview column: Back row pinned on top, FilePreview scrolls below it. */
  .files-preview-mobile :deep(.file-preview) { flex: 1; min-height: 0; }

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
  bottom: 112px; /* above StatusLine + Composer */
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
  font-size: 12px;
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
