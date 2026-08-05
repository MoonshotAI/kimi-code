<!-- ChatDock.vue -->
<!-- Bottom dock that belongs to the chat tab: work pills (goal, running -->
<!-- tasks, todos), pending question/approval cards, and the composer. Only -->
<!-- rendered inside a chat-pane group so it never leaks into -->
<!-- files/tasks/preview/btw panes. -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ActivationBadges, ApprovalBlock, ConversationStatus, FilePreviewRequest, PermissionMode, QueuedPromptView, TaskItem, TodoView, UIQuestion } from '../../types';
import type { AppGoal, AppModel, AppSkill, QuestionResponse, ThinkingLevel } from '../../api/types';
import type { FileItem } from './MentionMenu.vue';
import type { ManagedMembership, PromptAttachment } from '../../composables/useKimiWebClient';
import Composer from './Composer.vue';
import GoalPanel from './GoalPanel.vue';
import QuestionCard from './QuestionCard.vue';
import ApprovalCard from './ApprovalCard.vue';
import TasksPane from './TasksPane.vue';
import TodoCard from './TodoCard.vue';
import { Button, Icon, Pill } from '@moonshot-ai/web-ui';
import { useConfirmDialog } from '../../composables/useConfirmDialog';
import { formatTokens } from '../../lib/formatTokens';
import { formatDuration } from '../chatTurnRendering';

const props = defineProps<{
  sessionId?: string;
  running?: boolean;
  /** Main turn in flight — forwarded to the Composer Stop button. */
  working?: boolean;
  /** True while the empty-composer first prompt is being created + submitted.
   *  Covers the gap where draft-session creation already selected the new
   *  session (empty state → dock) before the first prompt is submitted. */
  starting?: boolean;
  queued?: QueuedPromptView[];
  searchFiles?: (q: string) => Promise<FileItem[]>;
  uploadImage?: (file: Blob, name?: string) => Promise<{ fileId: string; name: string; mediaType: string } | null>;
  status: ConversationStatus;
  thinking?: ThinkingLevel;
  planMode?: boolean;
  swarmMode?: boolean;
  goalMode?: boolean;
  activationBadges?: ActivationBadges;
  models?: AppModel[];
  /** Daemon auth/provider readiness (GET /auth ready) — forwarded to the
      Composer for its sign-in affordance. */
  authReady?: boolean;
  /** Managed-account sign-in state — forwarded to the Composer (a signed-in
      account never gets the sign-in entry). */
  managedSignedIn?: boolean;
  /** Membership of the signed-in managed account — forwarded to the Composer
      ('free' swaps the model pill for the upgrade entry). */
  managedMembership?: ManagedMembership;
  starredIds?: string[];
  skills?: AppSkill[];
  goal?: AppGoal | null;
  dockPanel: 'bash' | 'subagent' | 'todos' | 'goal' | null;
  bashTasks: TaskItem[];
  subagentTasks: TaskItem[];
  bashRunning: number;
  subagentRunning: number;
  todoDoneCount: number;
  hasDockWork: boolean;
  todos?: TodoView[];
  pendingQuestion?: UIQuestion;
  /** Action kind in flight for the visible question (drives loading state). */
  questionBusyKind?: 'answer' | 'dismiss';
  pendingApproval?: { approvalId: string; block: ApprovalBlock; agentName?: string };
  /** True while the visible approval has a respond in flight. */
  approvalBusy?: boolean;
  /** Open a file in the right-side preview panel (plan path, markdown paths). */
  openFile?: (target: FilePreviewRequest) => void;
  mobile?: boolean;
}>();

const emit = defineEmits<{
  submit: [payload: { text: string; attachments: PromptAttachment[] }];
  steer: [payload: { text: string; attachments: PromptAttachment[] }];
  command: [cmd: string];
  interrupt: [];
  setPermission: [mode: PermissionMode];
  setThinking: [level: ThinkingLevel];
  togglePlan: [];
  toggleSwarm: [];
  toggleGoal: [];
  openBtw: [];
  createGoal: [objective: string];
  controlGoal: [action: 'pause' | 'resume' | 'cancel'];
  focusGoal: [];
  focusSwarm: [];
  compact: [];
  pickModel: [];
  selectModel: [modelId: string];
  /** Composer sign-in entry (no usable model): opened the login dialog. */
  login: [];
  answer: [questionId: string, response: QuestionResponse];
  dismiss: [questionId: string];
  approval: [approvalId: string, response: { decision: 'approved' | 'rejected' | 'cancelled'; scope?: 'session'; feedback?: string; selectedLabel?: string }];
  cancelTask: [taskId: string];
  'toggle-dock-panel': [panel: 'bash' | 'subagent' | 'todos' | 'goal'];
  'close-dock-panel': [];
  /** A background subagent chip was clicked — open its live detail panel. */
  openAgent: [taskId: string];
}>();

const { t } = useI18n();
const { confirm } = useConfirmDialog();

// The goal rides the dock as one more workbar pill; the label it carries (and
// the panel head's) is its live status.
const goalStatusLabel = computed(() => {
  switch (props.goal?.status) {
    case 'active': return t('status.goalStatusActive');
    case 'paused': return t('status.goalStatusPaused');
    case 'blocked': return t('status.goalStatusBlocked');
    case 'complete': return t('status.goalStatusComplete');
    default: return '';
  }
});

// Goal panel chrome: the actions ride the panel head, the budget percentage
// feeds the footer's stats row.
const goalTokenPct = computed(() => {
  const budget = props.goal?.budget.tokenBudget;
  if (!props.goal || !budget || budget <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((props.goal.tokensUsed / budget) * 100)));
});

/** Wall-clock stat in the goal footer ('' hides a sub-second span). */
const goalWallClockLabel = computed(() => (props.goal ? formatDuration(props.goal.wallClockMs) : ''));

async function onGoalCancel(): Promise<void> {
  const confirmed = await confirm({
    title: t('status.goalCancel'),
    message: t('status.goalCancelConfirm'),
    confirmLabel: t('status.goalCancelConfirmYes'),
    cancelLabel: t('status.goalCancelConfirmNo'),
    variant: 'danger',
  });
  if (confirmed) emit('controlGoal', 'cancel');
}
const composerRef = ref<{
  loadForEdit: (value: string) => boolean;
  loadAttachmentsForEdit: (atts: { fileId?: string; kind: 'image' | 'video' | 'file'; url: string; name?: string }[]) => void;
  focus: () => void;
  anyPopupOpen?: boolean;
  isEmpty?: () => boolean;
} | null>(null);
const anyPopupOpen = computed(() => composerRef.value?.anyPopupOpen === true);
const workPanelRef = ref<HTMLElement | null>(null);
const dockRef = ref<HTMLElement | null>(null);

function loadForEdit(value: string): boolean {
  // The nested Composer is only rendered in ChatDock's v-else — when a pending
  // question or approval is shown it is unmounted, so report unavailability so
  // the caller doesn't dequeue a prompt it can't actually load.
  if (!composerRef.value) return false;
  composerRef.value.loadForEdit(value);
  return true;
}

function loadAttachmentsForEdit(atts: { fileId?: string; kind: 'image' | 'video' | 'file'; url: string; name?: string }[]): void {
  composerRef.value?.loadAttachmentsForEdit(atts);
}

function focus(): void {
  composerRef.value?.focus();
}

// Composer unmounted (question/approval card showing) = unsafe, not empty.
const isEmpty = () => composerRef.value?.isEmpty?.() ?? false;

function onDocumentMouseDown(event: MouseEvent): void {
  if (!props.dockPanel) return;
  const target = event.target as Node | null;
  if (!target) return;
  if (workPanelRef.value?.contains(target)) return;
  // Only the pills themselves are exempt (their toggle owns the click) —
  // blank workbar space dismisses like anywhere else.
  if (target instanceof Element && target.closest('.ui-pill')) return;
  emit('close-dock-panel');
}

// Scroll-linked edge fades on the work panel (the session list's vocabulary):
// the pinned head — and the goal footer — cast a soft ramp only while more
// content exists beyond that edge.
const workBodyRef = ref<HTMLElement | null>(null);
const bodyScrolledUp = ref(false);
const bodyScrolledDown = ref(false);

function updateWorkBodyScrollState(): void {
  const el = workBodyRef.value;
  if (!el) {
    bodyScrolledUp.value = false;
    bodyScrolledDown.value = false;
    return;
  }
  bodyScrolledUp.value = el.scrollTop > 0;
  bodyScrolledDown.value = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
}

function onWorkBodyScroll(e: Event): void {
  const el = e.target as HTMLElement;
  bodyScrolledUp.value = el.scrollTop > 0;
  bodyScrolledDown.value = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
}

let workBodyResizeObserver: ResizeObserver | null = null;

watch(
  () => props.dockPanel,
  async (panel) => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('mousedown', onDocumentMouseDown, true);
      if (panel) document.addEventListener('mousedown', onDocumentMouseDown, true);
    }
    workBodyResizeObserver?.disconnect();
    workBodyResizeObserver = null;
    if (panel) {
      await nextTick();
      updateWorkBodyScrollState();
      if (typeof ResizeObserver === 'function' && workBodyRef.value) {
        workBodyResizeObserver = new ResizeObserver(updateWorkBodyScrollState);
        workBodyResizeObserver.observe(workBodyRef.value);
      }
    } else {
      bodyScrolledUp.value = false;
      bodyScrolledDown.value = false;
    }
  },
  { immediate: true },
);

let dockResizeObserver: ResizeObserver | null = null;

function publishDockHeight(): void {
  // Border-box height of the dock, exposed so fixed overlays (e.g. toasts) can
  // anchor just above the composer. offsetHeight includes the dock's own
  // safe-area padding, so consumers don't need to add safe-bottom again.
  const height = dockRef.value?.offsetHeight ?? 0;
  document.documentElement.style.setProperty('--dock-h', `${height}px`);
}

onMounted(() => {
  if (typeof ResizeObserver !== 'function' || !dockRef.value) return;
  dockResizeObserver = new ResizeObserver(publishDockHeight);
  dockResizeObserver.observe(dockRef.value);
  publishDockHeight();
});

onUnmounted(() => {
  if (typeof document !== 'undefined') {
    document.removeEventListener('mousedown', onDocumentMouseDown, true);
  }
  dockResizeObserver?.disconnect();
  dockResizeObserver = null;
  workBodyResizeObserver?.disconnect();
  workBodyResizeObserver = null;
});

defineExpose({ loadForEdit, loadAttachmentsForEdit, focus, anyPopupOpen, isEmpty });
</script>

<template>
  <div
    ref="dockRef"
    class="chat-dock"
    :class="[
      mobile ? 'align-mobile' : 'align-center',
      { 'has-popup': anyPopupOpen, 'has-approval': !!pendingApproval && !pendingQuestion },
    ]"
    @click.stop
  >
    <Transition name="dock-panel">
      <div
        ref="workPanelRef"
        v-if="dockPanel"
        class="dock-work-panel"
        :class="{ 'body-scrolled-up': bodyScrolledUp, 'body-scrolled-down': bodyScrolledDown }"
        @click.stop
      >
        <div class="dock-work-head">
          <span
            v-if="dockPanel === 'bash'"
            class="dock-work-tab static"
          >
            {{ t('tasks.dockBash') }} · {{ bashRunning }} {{ t('tasks.running') }}
          </span>
          <span
            v-else-if="dockPanel === 'subagent'"
            class="dock-work-tab static"
          >
            {{ t('tasks.dockSubagent') }} · {{ subagentRunning }} {{ t('tasks.running') }}
          </span>
          <span
            v-else-if="dockPanel === 'todos'"
            class="dock-work-tab static"
          >
            {{ t('tasks.dockTodos') }} · {{ todoDoneCount }}/{{ todos?.length ?? 0 }}
          </span>
          <span
            v-else-if="dockPanel === 'goal'"
            class="dock-work-tab static"
          >
            {{ t('status.goalLabel') }} · {{ goalStatusLabel }}
          </span>
          <!-- The goal's controls ride the panel head — the decision cards'
               action vocabulary: exactly one accent primary (resume while
               paused), the rest quiet semantic variants. -->
          <span v-if="dockPanel === 'goal' && goal" class="dock-work-head-actions">
            <Button
              v-if="goal.status === 'active'"
              size="sm"
              variant="secondary"
              class="dock-goal-action"
              @click.stop="emit('controlGoal', 'pause')"
            >
              <Icon name="pause" size="md" />
              <span>{{ t('status.goalPause') }}</span>
            </Button>
            <Button
              v-if="goal.status === 'paused' || goal.status === 'blocked'"
              size="sm"
              variant="primary"
              class="dock-goal-action"
              @click.stop="emit('controlGoal', 'resume')"
            >
              <Icon name="play" size="md" />
              <span>{{ t('status.goalResume') }}</span>
            </Button>
            <Button
              size="sm"
              variant="danger-soft"
              class="dock-goal-action"
              @click.stop="onGoalCancel"
            >
              <Icon name="close" size="md" />
              <span>{{ t('status.goalCancel') }}</span>
            </Button>
          </span>
        </div>
        <div ref="workBodyRef" class="dock-work-body" @scroll="onWorkBodyScroll">
          <TasksPane
            v-if="dockPanel === 'bash'"
            :tasks="bashTasks"
            @cancel="emit('cancelTask', $event)"
          />
          <TasksPane
            v-else-if="dockPanel === 'subagent'"
            :tasks="subagentTasks"
            @cancel="emit('cancelTask', $event)"
            @open="emit('openAgent', $event)"
          />
          <TodoCard
            v-else-if="dockPanel === 'todos'"
            :todos="todos ?? []"
          />
          <GoalPanel
            v-else-if="dockPanel === 'goal' && goal"
            :goal="goal"
          />
        </div>
        <!-- Goal-only footer: the stats row (turns / tokens / wall time /
             budget) at the panel's bottom-left. -->
        <div v-if="dockPanel === 'goal' && goal" class="dock-work-foot">
          <span>{{ goal.turnsUsed }} turns</span>
          <span>{{ formatTokens(goal.tokensUsed) }} tokens</span>
          <span v-if="goalWallClockLabel">{{ goalWallClockLabel }}</span>
          <span v-if="goal.budget.tokenBudget !== null">{{ goalTokenPct }}% token budget</span>
        </div>
      </div>
    </Transition>

    <div v-if="hasDockWork" class="dock-workbar">
      <Pill
        v-if="goal"
        :active="dockPanel === 'goal'"
        :aria-pressed="dockPanel === 'goal'"
        @click="emit('toggle-dock-panel', 'goal')"
      >
        <Icon name="target" size="md" />
        <span>{{ t('status.goalLabel') }}</span>
        <span class="dw-goal-status" :class="`dw-goal-status--${goal.status}`">{{ goalStatusLabel }}</span>
      </Pill>
      <Pill
        v-if="bashTasks.length > 0"
        :active="dockPanel === 'bash'"
        :aria-pressed="dockPanel === 'bash'"
        @click="emit('toggle-dock-panel', 'bash')"
      >
        <Icon name="clock" size="md" />
        <span>{{ t('tasks.dockBash') }}</span>
        <span class="dw-count">(<b>{{ bashTasks.length }}</b>)</span>
      </Pill>
      <Pill
        v-if="subagentTasks.length > 0"
        :active="dockPanel === 'subagent'"
        :aria-pressed="dockPanel === 'subagent'"
        @click="emit('toggle-dock-panel', 'subagent')"
      >
        <Icon name="sparkles" size="md" />
        <span>{{ t('tasks.dockSubagent') }}</span>
        <span class="dw-count">(<b>{{ subagentTasks.length }}</b>)</span>
      </Pill>
      <Pill
        v-if="(todos?.length ?? 0) > 0"
        :active="dockPanel === 'todos'"
        :aria-pressed="dockPanel === 'todos'"
        @click="emit('toggle-dock-panel', 'todos')"
      >
        <Icon name="check-list" size="md" />
        <span>{{ t('tasks.dockTodos') }}</span>
        <span class="dw-count">(<b>{{ todoDoneCount }}/{{ todos?.length ?? 0 }}</b>)</span>
      </Pill>
    </div>
    <QuestionCard
      v-if="pendingQuestion"
      :key="pendingQuestion.questionId"
      :question="pendingQuestion"
      :busy-kind="questionBusyKind"
      @answer="(qid, resp) => emit('answer', qid, resp)"
      @dismiss="emit('dismiss', $event)"
    />
    <ApprovalCard
      v-else-if="pendingApproval"
      :key="pendingApproval.approvalId"
      class="dock-approval"
      :block="pendingApproval.block"
      :agent-name="pendingApproval.agentName"
      :busy="approvalBusy"
      :open-file="openFile"
      @decide="emit('approval', pendingApproval!.approvalId, $event)"
    />
    <Composer
      v-else
      ref="composerRef"
      :session-id="sessionId"
      :running="running"
      :working="working"
      :queued="queued"
      :search-files="searchFiles"
      :upload-image="uploadImage"
      :status="status"
      :thinking="thinking"
      :plan-mode="planMode"
      :swarm-mode="swarmMode"
      :goal-mode="goalMode"
      :goal="goal"
      :activation-badges="activationBadges"
      :models="models"
      :auth-ready="authReady"
      :managed-signed-in="managedSignedIn"
      :managed-membership="managedMembership"
      :starred-ids="starredIds"
      :skills="skills"
      :starting="starting"
      @submit="emit('submit', $event)"
      @steer="emit('steer', $event)"
      @command="emit('command', $event)"
      @interrupt="emit('interrupt')"
      @set-permission="emit('setPermission', $event)"
      @set-thinking="emit('setThinking', $event)"
      @toggle-plan="emit('togglePlan')"
      @toggle-swarm="emit('toggleSwarm')"
      @toggle-goal="emit('toggleGoal')"
      @open-btw="emit('openBtw')"
      @create-goal="emit('createGoal', $event)"
      @control-goal="emit('controlGoal', $event)"
      @focus-goal="emit('focusGoal')"
      @focus-swarm="emit('focusSwarm')"
      @compact="emit('compact')"
      @pick-model="emit('pickModel')"
      @select-model="emit('selectModel', $event)"
      @login="emit('login')"
    />
  </div>
</template>

<style scoped>
.chat-dock {
  --dock-inline-left: 16px;
  --dock-inline-right: 16px;
  box-sizing: border-box;
  width: 100%;
  max-width: calc(var(--read-max) + var(--panes-scrollbar-width, 0px));
  padding-right: var(--panes-scrollbar-width, 0px);
  flex: none;
  position: absolute;
  inset: auto 0 0;
  background: transparent;
  z-index: var(--z-sticky);
}
.chat-dock.has-popup { z-index: var(--z-dropdown); }
.chat-dock.align-center { margin-left: auto; margin-right: auto; }
.chat-dock.align-left { margin-left: 0; margin-right: auto; }
.chat-dock.align-mobile { max-width: none; }

/* Bottom veil — the dock floats over the scrolling transcript, so without a
   backdrop the text underneath bleeds through around the composer card, the
   toolbar, and the workbar pills. The layer extends --fade
   above the dock (its top edge is anchored there) and reaches full opacity
   --veil below its own top edge — deliberately past the dock's top edge, so
   the ramp stays long and soft instead of snapping to solid at the content
   boundary; from there down everything sits on an opaque veil. The fade is a
   plain eased opacity ramp, deliberately WITHOUT a live backdrop blur: one
   re-samples the scrolling transcript every frame, which flickers and janks
   in Chromium mid-scroll — and where the veil is fully opaque the blur would
   be painted over and invisible anyway.
   Keep --fade in sync with DOCK_VEIL_FADE_PX in ConversationPane.vue, which
   reserves this band in the transcript's scroll padding. */
.chat-dock::before {
  --fade: 48px;
  --veil: 72px;
  content: "";
  position: absolute;
  top: calc(-1 * var(--fade));
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 0;
  pointer-events: none;
  background: linear-gradient(
    to bottom,
    color-mix(in srgb, var(--color-bg) 0%, transparent),
    color-mix(in srgb, var(--color-bg) 30%, transparent) 21px,
    color-mix(in srgb, var(--color-bg) 70%, transparent) 45px,
    var(--color-bg) var(--veil)
  );
}

/* Chromium can momentarily composite a negative-stacking layer above in-flow
   content mid-scroll; the veil sits at layer 0 and every direct child stays
   pinned one step above it, keeping the paint order deterministic. */
.chat-dock > * {
  position: relative;
  z-index: 1;
}

.dock-work-panel {
  position: absolute;
  left: 16px;
  right: calc(16px + var(--panes-scrollbar-width, 0px));
  bottom: 100%;
  background: var(--color-surface);
  border: 0.5px solid var(--color-line-strong);
  border-radius: var(--radius-xl);
  /* The dropdown family surface: menu-panel shadow token (Menu.vue). */
  box-shadow: var(--shadow-menu);
  margin-bottom: 7px;
  max-height: min(360px, 50vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dock-work-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: var(--space-2) var(--space-3);
  border-bottom: 0.5px solid var(--color-line);
  position: relative;
  z-index: 1;
}
.dock-work-tab {
  font-size: var(--text-base);
  font-weight: 500;
  color: var(--color-text);
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken);
  border: 0.5px solid var(--color-line);
}
.dock-work-tab.static {
  background: transparent;
  border-color: transparent;
  padding-left: 2px;
}
.dock-work-body {
  padding: var(--space-2) var(--space-3);
  overflow-y: auto;
  min-height: 0;
}
/* The goal panel's head actions and footer stats — chrome shared by no other
   panel, so it stays here next to the work-panel rules. */
.dock-work-head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}
.dock-goal-action :deep(.ui-button__content) {
  gap: var(--space-1);
}
.dock-work-foot {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-top: 0.5px solid var(--color-line);
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-option-label);
  font-variant-numeric: tabular-nums;
  position: relative;
  z-index: 1;
}
/* Scroll-linked edge fades (the session list's vocabulary): the pinned head
   — and the goal footer — cast a soft 18px ramp over the scrolling body,
   shown only while more content exists beyond that edge. */
.dock-work-head::after,
.dock-work-foot::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 18px;
  pointer-events: none;
  opacity: 0;
  transition: opacity var(--duration-slow) var(--ease-out);
}
.dock-work-head::after {
  top: 100%;
  background:
    linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 2.5%, transparent), transparent 35%),
    linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 1.75%, transparent), transparent 65%),
    linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 1.25%, transparent), transparent);
}
.dock-work-foot::before {
  bottom: 100%;
  background:
    linear-gradient(to top, color-mix(in srgb, var(--color-text) 2.5%, transparent), transparent 35%),
    linear-gradient(to top, color-mix(in srgb, var(--color-text) 1.75%, transparent), transparent 65%),
    linear-gradient(to top, color-mix(in srgb, var(--color-text) 1.25%, transparent), transparent);
}
.dock-work-panel.body-scrolled-up .dock-work-head::after,
.dock-work-panel.body-scrolled-down .dock-work-foot::before {
  opacity: 1;
}
.dock-work-body :deep(.taskspane) {
  border: none;
  background: transparent;
  padding: 0;
}
.dock-work-body :deep(.taskspane .tp-head) {
  display: none;
}

.dock-workbar {
  display: flex;
  align-items: center;
  /* With the goal pill aboard, narrow panes can overflow one row — wrap
     instead of clipping (pills stay reachable, the dock height observes). */
  flex-wrap: wrap;
  gap: var(--space-1) 6px;
  padding: 4px var(--dock-inline-right) 2px var(--dock-inline-left);
}
/* Work pills ride the Composer's 32px control rhythm. Their roomier inline
   padding gives icon + label + status the same visual breathing room as the
   full-round controls below, while retaining the raised fill and hairline. */
.dock-workbar :deep(.ui-pill) {
  position: relative;
  height: var(--space-8);
  padding: 0 var(--space-4);
  border: 0.5px solid var(--color-line-strong);
  border-radius: var(--radius-full);
  /* One rung above the page in BOTH schemes: --color-surface-sunken is
     degenerate in dark mode (it equals --color-bg), so the pill vanished
     there; --color-surface lifts off the page in dark and stays a quiet
     chip in light — the same material as the popover it opens. */
  background: var(--color-surface);
  /* Fill already carries its own tone — keep the label at full text
     colour (the composer toolbar pills' rung) or the pair reads washed. */
  color: var(--color-text);
}
/* The hover wash floats over the fill as its own layer so it can fade in
   and out (background gradients don't interpolate — they'd snap). */
.dock-workbar :deep(.ui-pill)::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: var(--radius-full);
  background: var(--color-hover);
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
  pointer-events: none;
}
.dock-workbar :deep(.ui-pill:hover:not(:disabled))::after {
  opacity: 1;
}
/* The base fill/color above must not swallow the open-panel state — restate
   the primitive's active styling at higher precedence. */
.dock-workbar :deep(.ui-pill.is-active) {
  background: var(--color-accent-soft);
  color: var(--color-accent);
}
.dock-workbar .dw-count { margin-left: 1px; }
.dock-workbar .dw-count b { font-weight: 500; }
/* The goal pill carries its live status (the same label the panel head
   repeats), coloured by state. */
.dock-workbar .dw-goal-status { font-weight: var(--weight-medium); }
.dock-workbar .dw-goal-status--active { color: var(--color-success); }
.dock-workbar .dw-goal-status--paused { color: var(--color-warning); }
.dock-workbar .dw-goal-status--blocked { color: var(--color-danger); }

.dock-approval {
  margin-top: 8px;
}

/* Approval showing: the dock takes over the card's height budget
   (calc(100dvh - 72px), see ApprovalCard) as a flex column, so an expanded
   card yields the work pills' height instead of pushing them past the pane's
   top edge. */
.chat-dock.has-approval {
  display: flex;
  flex-direction: column;
  max-height: calc(100dvh - 72px);
}
.chat-dock.has-approval > .dock-workbar {
  flex: none;
}
.chat-dock.has-approval > .dock-approval {
  min-height: 0;
}

@media (max-width: 640px) {
  .chat-dock {
    /* Inline (landscape) safe-area lives here only; the inner composer /
       workbar read --dock-inline-* so the inset is applied exactly once. */
    --dock-inline-left: max(12px, var(--safe-left));
    --dock-inline-right: max(12px, var(--safe-right));
  }
  .dock-work-panel {
    left: 10px;
    right: calc(10px + var(--panes-scrollbar-width, 0px));
  }
}

.chat-dock:not(.align-mobile) :deep(.composer) {
  padding-bottom: 14px;
}

.dock-panel-enter-active,
.dock-panel-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.dock-panel-enter-from,
.dock-panel-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
