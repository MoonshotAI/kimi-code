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
import GoalPanel from './dock/GoalPanel.vue';
import QuestionCard from './QuestionCard.vue';
import ApprovalCard from './ApprovalCard.vue';
import TasksPane from './dock/TasksPane.vue';
import SubagentGrid from './dock/SubagentGrid.vue';
import TodoCard from './dock/TodoCard.vue';
import WorkPill from './dock/WorkPill.vue';
import WorkPanelHead from './dock/WorkPanelHead.vue';
import FilterControl from './dock/FilterControl.vue';
import { Icon, IconButton, StatusDot } from '@moonshot-ai/app-ui';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import { installImeCompositionLatch, isImeKeyEvent } from '@moonshot-ai/app-client/lib';
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
  /** A modal/overlay layer is open above the dock (any dialog, sheet, or
      picker tracked by App's anyOverlayOpen) — it owns Escape, so the work
      panel's document capture stays quiet while it is open. */
  overlayOpen?: boolean;
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
  command: [payload: { cmd: string; attachments: PromptAttachment[] }];
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
const { confirm, isConfirmOpen } = useConfirmDialog();

// The goal rides the dock as one more workbar pill, carrying its live status.
const goalStatusLabel = computed(() => {
  switch (props.goal?.status) {
    case 'active': return t('status.goalStatusActive');
    case 'paused': return t('status.goalStatusPaused');
    case 'blocked': return t('status.goalStatusBlocked');
    case 'complete': return t('status.goalStatusComplete');
    default: return '';
  }
});

/** Wall-clock stat in the goal head ('' hides a sub-second span). */
const goalWallClockLabel = computed(() =>
  props.goal
    ? formatDuration(props.goal.wallClockMs, {
        h: t('status.timeUnitHour'),
        m: t('status.timeUnitMinute'),
        s: t('status.timeUnitSecond'),
      })
    : '',
);

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
// Task status filter for the bash and subagent panels: default "active" =
// running + the 5 most recently finished; the chips ride the panel head.
const TASK_FILTERS = [
  { id: 'active', labelKey: 'tasks.filterRecent', icon: 'clock' },
  { id: 'running', labelKey: 'tasks.filterRunning', icon: 'play' },
  { id: 'done', labelKey: 'tasks.filterDone', icon: 'circle-check' },
  { id: 'all', labelKey: 'tasks.filterAll', icon: 'list' },
] as const;
type TaskFilterId = (typeof TASK_FILTERS)[number]['id'];

/** Recency order for finished tasks: completion stamp first — an
    early-created task that just ended must not drop out of the default view.
    Falls back to creation time (an all-historical session, old daemon, never
    gets a poll merge to stamp anything, and '' would sort oldest-first);
    batched events (reconnect replay) can share the same millisecond, so ties
    break by creation stamp or genuinely newer finishes hide behind creation
    order. */
function compareFinished(a: TaskItem, b: TaskItem): number {
  return (
    (b.completedAt ?? b.createdAt ?? '').localeCompare(a.completedAt ?? a.createdAt ?? '')
    || (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
  );
}

function filterTasks(tasks: TaskItem[], mode: TaskFilterId): TaskItem[] {
  if (mode === 'all') return tasks;
  if (mode === 'running') return tasks.filter((t) => t.state === 'run');
  // Done = every terminal state (done / failed / cancelled).
  if (mode === 'done') return tasks.filter((t) => t.state !== 'run');
  // Keep the five most recently finished. The tasks array is rebuilt on every
  // running-clock tick while any task runs, so select linearly — a full
  // O(n log n) sort of all historical tasks would run once a second.
  const top: TaskItem[] = [];
  for (const t of tasks) {
    if (t.state === 'run') continue;
    let i = top.length;
    while (i > 0 && compareFinished(top[i - 1]!, t) > 0) i--;
    top.splice(i, 0, t);
    if (top.length > 5) top.length = 5;
  }
  // Running first (array order), then the five most recently finished in
  // that recency order — not the raw array order.
  return [...tasks.filter((t) => t.state === 'run'), ...top];
}

const bashFilter = ref<TaskFilterId>('active');
const subagentFilter = ref<TaskFilterId>('active');
const filteredBashTasks = computed(() => filterTasks(props.bashTasks, bashFilter.value));
const filteredSubagentTasks = computed(() => filterTasks(props.subagentTasks, subagentFilter.value));

// The filters are the design system's SegmentedControl semantics (2-5
// mutually exclusive options); v-model bridges keep the TaskFilterId type.
const filterOptions = computed(() => TASK_FILTERS.map((f) => ({ value: f.id as string, label: t(f.labelKey), icon: f.icon })));
const bashFilterModel = computed({
  get: () => bashFilter.value as string,
  set: (v: string) => { bashFilter.value = v as TaskFilterId; },
});
const subagentFilterModel = computed({
  get: () => subagentFilter.value as string,
  set: (v: string) => { subagentFilter.value = v as TaskFilterId; },
});

// Progress icon mirrors completion: the all-checked list once every task is
// done, a plain list while anything is still open.
const todoAllDone = computed(
  () => (props.todos?.length ?? 0) > 0 && props.todoDoneCount === (props.todos?.length ?? 0),
);

// A background TOOL task in the list (a genuine tool call with content, not
// a question flow — those stay in the message stream) makes the "Bash"
// title a mislabel; switch to the generic tasks label while one is present.
const hasToolTasks = computed(() => props.bashTasks.some((t) => t.kind === 'tool'));
const bashPanelLabelKey = computed(() => (hasToolTasks.value ? 'tasks.dockTasks' : 'tasks.dockBash'));

// Accessible names for the work pills — required once they collapse to
// icon-only below the 620px dock width.
const goalPillLabel = computed(() => `${t('status.goalLabel')} ${goalStatusLabel.value}`.trim());
const bashPillLabel = computed(() =>
  props.bashRunning > 0
    ? `${t(bashPanelLabelKey.value)} ${props.bashRunning} ${t('tasks.running')}`
    : t(bashPanelLabelKey.value),
);
const subagentPillLabel = computed(() =>
  props.subagentRunning > 0
    ? `${t('tasks.dockSubagent')} ${props.subagentRunning} ${t('tasks.running')}`
    : t('tasks.dockSubagent'),
);
const todosPillLabel = computed(
  () => `${t('tasks.todoProgressTitle')} ${props.todoDoneCount}/${props.todos?.length ?? 0}`,
);

const composerRef = ref<{
  loadForEdit: (value: string) => boolean;
  loadAttachmentsForEdit: (atts: { fileId?: string; kind: 'image' | 'video' | 'file'; url: string; name?: string }[]) => void;
  focus: () => void;
  anyPopupOpen?: boolean;
  isEmpty?: () => boolean;
} | null>(null);
const anyPopupOpen = computed(() => composerRef.value?.anyPopupOpen === true);
// Stacking only: the dock's own work panel must also clear the transcript's
// new-message pill (z-sticky), so it raises the dock exactly like a composer
// popup. Kept separate from the exposed anyPopupOpen — the panel consumes
// Escape on its own capture handler (see onDocumentKeydown), so
// ConversationPane's interrupt gate does not need it here.
const raisedForPanel = computed(() => anyPopupOpen.value || props.dockPanel != null);
const workPanelRef = ref<HTMLElement | null>(null);
const dockRef = ref<HTMLElement | null>(null);
// Below the design system's --p-bp-sm breakpoint the work pills collapse
// to icon-only (the threshold is read from the token at measure time).
const compactPills = ref(false);

// The work panel pops from the triggering pill (the menus' trigger-corner
// motion) — remember its x so the panel can scale from there.
const panelOriginX = ref('50%');

function onPillClick(panel: 'bash' | 'subagent' | 'todos' | 'goal', e: MouseEvent): void {
  const pillEl = e.currentTarget as HTMLElement | null;
  if (pillEl && dockRef.value) {
    const pr = pillEl.getBoundingClientRect();
    const dr = dockRef.value.getBoundingClientRect();
    panelOriginX.value = `${pr.left + pr.width / 2 - dr.left}px`;
  }
  emit('toggle-dock-panel', panel);
}

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

// The work panel owns Escape while open: close it and consume the key in the
// capture phase, so ConversationPane's interrupt/undo handler (bubble, gated
// on defaultPrevented) never fires for the same keypress. A composer popup,
// an IME candidate, or a top overlay layer (overlayOpen — any dialog, sheet,
// or picker) owns the key first — each closes on its own handler. The IME
// test is the Composer's own (shared latch + keyCode 229): some browsers
// emit a trailing Escape with isComposing === false right after a candidate
// is cancelled, and a bare isComposing check would swallow it.
function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.repeat || isImeKeyEvent(event)) return;
  // An earlier capture listener on this same element already consumed the
  // key (App's side-panel handler) — that topmost layer owns this Escape.
  if (event.defaultPrevented) return;
  // The desktop's native terminal owns Escape for its own modes (vim, less,
  // fzf) — let it reach the PTY instead of closing the panel.
  if (event.target instanceof Element && event.target.closest('.terminal-host')) return;
  if (anyPopupOpen.value || isConfirmOpen.value) return;
  if (props.overlayOpen) return;
  event.preventDefault();
  // Immediate: App's global handler listens on the SAME element, and a plain
  // stopPropagation would not keep it from also firing.
  event.stopImmediatePropagation();
  emit('close-dock-panel');
}

// Scroll-linked top mask on the work panel's body: once scrolled, content
// dissolves toward the head instead of hard-clipping at it.
const workBodyRef = ref<HTMLElement | null>(null);
const bodyScrolledUp = ref(false);

function updateWorkBodyScrollState(): void {
  const el = workBodyRef.value;
  bodyScrolledUp.value = el ? el.scrollTop > 0 : false;
}

function onWorkBodyScroll(e: Event): void {
  bodyScrolledUp.value = (e.target as HTMLElement).scrollTop > 0;
}

let workBodyResizeObserver: ResizeObserver | null = null;

watch(
  () => props.dockPanel,
  async (panel) => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('mousedown', onDocumentMouseDown, true);
      document.removeEventListener('keydown', onDocumentKeydown, true);
      if (panel) {
        document.addEventListener('mousedown', onDocumentMouseDown, true);
        document.addEventListener('keydown', onDocumentKeydown, true);
      }
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
  const bp = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--p-bp-sm'),
  );
  compactPills.value = (dockRef.value?.offsetWidth ?? 0) < (Number.isFinite(bp) ? bp : 640);
}

onMounted(() => {
  installImeCompositionLatch();
  if (typeof ResizeObserver !== 'function' || !dockRef.value) return;
  dockResizeObserver = new ResizeObserver(publishDockHeight);
  dockResizeObserver.observe(dockRef.value);
  publishDockHeight();
});

onUnmounted(() => {
  if (typeof document !== 'undefined') {
    document.removeEventListener('mousedown', onDocumentMouseDown, true);
    document.removeEventListener('keydown', onDocumentKeydown, true);
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
      { 'has-popup': raisedForPanel, 'has-approval': !!pendingApproval && !pendingQuestion, 'pills-compact': compactPills },
    ]"
    @click.stop
  >
    <Transition name="dock-panel">
      <div
        ref="workPanelRef"
        v-if="dockPanel"
        :key="dockPanel"
        class="dock-work-panel"
        :class="[`panel-${dockPanel}`, { 'body-scrolled-up': bodyScrolledUp }]"
        :style="{ transformOrigin: `${panelOriginX} 100%` }"
        @click.stop
      >
        <div class="dock-work-head">
          <WorkPanelHead
            v-if="dockPanel === 'bash'"
            icon="terminal"
            :title="t(bashPanelLabelKey)"
            :meta="`${bashRunning} ${t('tasks.running')}`"
          >
            <template #actions>
              <FilterControl v-model="bashFilterModel" :options="filterOptions" />
            </template>
          </WorkPanelHead>
          <WorkPanelHead
            v-else-if="dockPanel === 'subagent'"
            icon="sparkles"
            :title="t('tasks.dockSubagent')"
            :meta="`${subagentRunning} ${t('tasks.running')}`"
          >
            <template #actions>
              <FilterControl v-model="subagentFilterModel" :options="filterOptions" />
            </template>
          </WorkPanelHead>
          <WorkPanelHead
            v-else-if="dockPanel === 'todos'"
            :icon="todoAllDone ? 'check-list' : 'list'"
            :title="t('tasks.todoProgressTitle')"
            :meta="`${todoDoneCount}/${todos?.length ?? 0}`"
          />
          <WorkPanelHead
            v-else-if="dockPanel === 'goal'"
            icon="target"
            :title="t('status.goalLabel')"
            :meta="goalWallClockLabel"
          >
            <template #actions>
              <template v-if="goal">
                <IconButton
                  v-if="goal.status === 'active'"
                  size="sm"
                  :label="t('status.goalPause')"
                  :tooltip="t('status.goalPause')"
                  @click.stop="emit('controlGoal', 'pause')"
                >
                  <Icon name="pause" size="md" />
                </IconButton>
                <IconButton
                  v-if="goal.status === 'paused' || goal.status === 'blocked'"
                  size="sm"
                  :label="t('status.goalResume')"
                  :tooltip="t('status.goalResume')"
                  @click.stop="emit('controlGoal', 'resume')"
                >
                  <Icon name="play" size="md" />
                </IconButton>
                <IconButton
                  size="sm"
                  :label="t('status.goalCancel')"
                  :tooltip="t('status.goalCancel')"
                  @click.stop="onGoalCancel"
                >
                  <Icon name="power" size="md" />
                </IconButton>
                <IconButton
                  size="sm"
                  :label="t('tasks.closePanel')"
                  :tooltip="t('tasks.closePanel')"
                  @click.stop="emit('close-dock-panel')"
                >
                  <Icon name="close" size="md" />
                </IconButton>
              </template>
            </template>
          </WorkPanelHead>
        </div>
        <div ref="workBodyRef" class="dock-work-body" @scroll="onWorkBodyScroll">
          <TasksPane
            v-if="dockPanel === 'bash'"
            :tasks="filteredBashTasks"
            :filter="bashFilter"
            @cancel="emit('cancelTask', $event)"
            @open="emit('openAgent', $event)"
          />
          <SubagentGrid
            v-else-if="dockPanel === 'subagent'"
            :tasks="filteredSubagentTasks"
            :filter="subagentFilter"
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
            :open-file="openFile"
          />
        </div>
      </div>
    </Transition>

    <div v-if="hasDockWork" class="dock-workbar">
      <WorkPill
        v-if="goal"
        icon="target"
        :label="goalPillLabel"
        :active="dockPanel === 'goal'"
        @click="onPillClick('goal', $event)"
      >
        {{ t('status.goalLabel') }}
        <template #meta>
          <span class="dw-goal-status" :class="`dw-goal-status--${goal.status}`">{{ goalStatusLabel }}</span>
        </template>
      </WorkPill>
      <WorkPill
        v-if="bashTasks.length > 0"
        icon="terminal"
        :label="bashPillLabel"
        :active="dockPanel === 'bash'"
        @click="onPillClick('bash', $event)"
      >
        {{ t(bashPanelLabelKey) }}
        <template #meta>
          <span v-if="bashRunning > 0" class="dw-running"><StatusDot status="running" />{{ bashRunning }}</span>
        </template>
      </WorkPill>
      <WorkPill
        v-if="subagentTasks.length > 0"
        icon="sparkles"
        :label="subagentPillLabel"
        :active="dockPanel === 'subagent'"
        @click="onPillClick('subagent', $event)"
      >
        {{ t('tasks.dockSubagent') }}
        <template #meta>
          <span v-if="subagentRunning > 0" class="dw-running"><StatusDot status="running" />{{ subagentRunning }}</span>
        </template>
      </WorkPill>
      <WorkPill
        v-if="(todos?.length ?? 0) > 0"
        :icon="todoAllDone ? 'check-list' : 'list'"
        :label="todosPillLabel"
        :active="dockPanel === 'todos'"
        @click="onPillClick('todos', $event)"
      >
        {{ t('tasks.todoProgressTitle') }}
        <template #meta>
          <span class="dw-count">{{ todoDoneCount }}/{{ todos?.length ?? 0 }}</span>
        </template>
      </WorkPill>
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
      :request-id="pendingApproval.approvalId"
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

/* Bottom veil — the dock floats over the scrolling transcript, so text would
   otherwise bleed through around the composer card and workbar pills. An
   eased opacity ramp (--fade above, full opacity at --veil); deliberately no
   live backdrop blur — re-sampling the transcript mid-scroll janks in
   Chromium, and under full opacity it would be invisible anyway.
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
  /* The menu family material (Menu.vue): 70% page bg over the shared blur. */
  background: color-mix(in srgb, var(--color-bg) 70%, transparent);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-2xl);
  box-shadow: var(--shadow-menu);
  margin-bottom: var(--space-2);
  max-height: min(360px, 50vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  /* The panel is chrome (the menu family): nothing inside is selectable,
     head filter chips included. */
  user-select: none;
}
/* Todos, goal, subagent, and bash panels per the redesign: uniform 16px
   inset (the head tab carries no padding of its own — see
   dock/WorkPanelHead.vue — so its content lands exactly on it), no head
   hairline. */
.dock-work-panel.panel-todos .dock-work-head,
.dock-work-panel.panel-goal .dock-work-head,
.dock-work-panel.panel-subagent .dock-work-head,
.dock-work-panel.panel-bash .dock-work-head {
  padding: var(--space-4) var(--space-4) 0;
  border-bottom: none;
}
.dock-work-panel.panel-todos .dock-work-body,
.dock-work-panel.panel-goal .dock-work-body,
.dock-work-panel.panel-subagent .dock-work-body,
.dock-work-panel.panel-bash .dock-work-body {
  /* margin, not padding: the 12px gap below the head stays put when the
     body scrolls — top padding would scroll away with the content. */
  margin-top: var(--space-3);
  padding: 0 var(--space-4) var(--space-4);
}
/* Filtered panels change height with the filter — pin them (two card rows
   / a dozen rows plus a sliver) so the panel never resizes; the body
   scrolls inside. */
.dock-work-panel.panel-subagent,
.dock-work-panel.panel-bash {
  height: min(var(--p-dock-panel-h), 50vh);
}
.dock-work-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 0.5px solid var(--color-line);
  position: relative;
  z-index: 1;
}
.dock-work-body {
  padding: var(--space-2) var(--space-3);
  overflow-y: auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* Narrow widths: let the head wrap so the filter row never clips — a 320px
   touch viewport at a large font scale can't fit title + segmented control
   on one line. (The actions' full-row rule lives in dock/WorkPanelHead.) */
@media (max-width: 480px) {
  .dock-work-head { flex-wrap: wrap; }
}
/* Scrolled-up: the body's top dissolves through an alpha mask (the
   transcript clamp's vocabulary) instead of hard-clipping at the head. */
.dock-work-panel.body-scrolled-up .dock-work-body {
  mask-image: linear-gradient(to bottom, transparent, black var(--menu-scroll-fade));
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
  gap: var(--space-1) var(--space-1-5);
  /* The row aligns with the composer's text column, not the card edge:
     dock inline inset + the card's hairline border + .cin-wrap's --space-4
     inline padding (Composer.vue) — computed from the tokens so a token
     change cannot drift the alignment. The vertical offsets ride the same
     scale (--space-1 / --space-05). */
  padding: var(--space-1) calc(var(--dock-inline-right) + var(--space-4) + var(--p-hairline)) var(--space-05) calc(var(--dock-inline-left) + var(--space-4) + var(--p-hairline));
}
/* Work pills: a borderless neutral chip with --radius-lg corners. Height
   is font-driven — 8px block padding around the label's line box and the
   1.5em icon; height: auto lifts the Pill primitive's 28px pin. */
.dock-workbar :deep(.ui-pill) {
  position: relative;
  gap: var(--space-1-5);
  height: auto;
  /* Trailing side gets a +2px optical compensation: with a leading
     glyph, even inline padding reads tighter on the label side. */
  padding: var(--space-2) calc(var(--space-3) + var(--space-05)) var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-lg);
  /* Canonical fill: the fills ladder's --color-selected rung at rest, over
     the shared menu blur — the work panel's frosted recipe scaled to a chip,
     so transcript text never reads through the 5% fill. */
  background: var(--color-selected);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  color: var(--color-text);
  font-size: var(--text-base);
  line-height: var(--leading-normal);
}
.dock-workbar :deep(.ui-pill svg) {
  width: 1.5em;
  height: 1.5em;
  color: inherit;
}
/* The neutral hover wash layers ON TOP of the selected base (one layer —
   two identical washes would composite the tint twice). The active pill
   keeps the wash on permanently: one fills-ladder step deeper, neutral. */
.dock-workbar :deep(.ui-pill)::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: var(--radius-lg);
  background: var(--color-hover);
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
  pointer-events: none;
}
.dock-workbar :deep(.ui-pill:hover:not(:disabled))::after,
.dock-workbar :deep(.ui-pill.is-active)::after {
  opacity: 1;
}
/* Narrow dock: the pills collapse to their icons — label and meta hide and
   the padding squares up (no trailing optical compensation to balance). */
.chat-dock.pills-compact .dock-workbar :deep(.ui-pill) {
  padding: var(--space-2);
}
.chat-dock.pills-compact .dock-workbar :deep(.ui-pill) > span {
  display: none;
}

.dock-workbar .dw-count { color: var(--color-text-muted); }
/* Live-status meta: a pulsing dot + the running count, only while work runs. */
.dock-workbar .dw-running {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--color-text-muted);
}
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

.dock-panel-enter-active {
  transition: opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.dock-panel-leave-active {
  transition: opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
}
.dock-panel-enter-from,
.dock-panel-leave-to {
  opacity: 0;
  transform: translateY(var(--motion-panel-shift)) scale(var(--motion-panel-scale));
}
</style>
