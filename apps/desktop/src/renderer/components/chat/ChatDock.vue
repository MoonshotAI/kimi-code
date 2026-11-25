<script setup lang="ts">
import type { ComposerDocumentSnapshot } from '@moonshot-ai/app-composer/model';
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ApprovalBlock, TaskItem, TodoView, TurnAttachment, UIQuestion } from '../../types';
import type { GlobalShortcutFailureReason } from '../../../shared/global-shortcut';
import type { QuestionResponse, SessionPlan } from '../../api/types';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import { useAppearance } from '@moonshot-ai/app-core';
import type { AttachmentEntry } from '@moonshot-ai/app-composer/features/attachment';
import { Composer, type ComposerEmits } from '@moonshot-ai/app-components';
import { GoalPanel } from '@moonshot-ai/app-components';
import { PlanPanel } from '@moonshot-ai/app-components';
import { QuestionCard } from '@moonshot-ai/app-components';
import ApprovalCard from './ApprovalCard.vue';
import { TasksPane } from '@moonshot-ai/app-components';
import { SubagentGrid } from '@moonshot-ai/app-components';
import { TodoCard } from '@moonshot-ai/app-components';
import { WorkPill } from '@moonshot-ai/app-components';
import { WorkPanelHead } from '@moonshot-ai/app-components';
import { Icon, IconButton, StatusDot } from '@moonshot-ai/app-ui';
import { useConfirmDialog } from '@moonshot-ai/app-client/composables';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import { createDockMetricsPublisher, dockTasksPillPriority, installImeCompositionLatch, isImeKeyEvent, LIVE_PILL_PRIORITY, planDockPillCollapse, publishDockHeightPx } from '@moonshot-ai/app-client/lib';
import type { DockPillKey } from '@moonshot-ai/app-client/lib';
import type { SlashCommand } from '@moonshot-ai/app-core/lib';
import { formatDuration } from '@moonshot-ai/app-components';
import { useAppDialogs } from '@moonshot-ai/app-client/composables';

const props = defineProps<{
  interruptArmed?: boolean;
  sessionPlans?: Record<string, SessionPlan>;
  dockPanel: 'bash' | 'subagent' | 'todos' | 'goal' | 'plan' | null;
  bashTasks: TaskItem[];
  subagentTasks: TaskItem[];
  bashRunning: number;
  subagentRunning: number;
  todoDoneCount: number;
  hasDockWork: boolean;
  todos?: TodoView[];
  pendingQuestion?: UIQuestion;
  questionBusyKind?: 'answer' | 'dismiss';
  pendingApproval?: { approvalId: string; block: ApprovalBlock; agentName?: string };
  approvalBusy?: boolean;
  mobile?: boolean;
  statusNote?: string;
  sessionSubmitBlockedReason?: string;
  sessionSubmitBlockedTooltip?: string;
  beforeSubmit?: () => boolean;
  deferSubmitReset?: boolean;
  extraBuiltinCommands?: readonly SlashCommand[];
  onCaptureScreenshot?: () => void;
  screenshotShortcutKeys?: string[];
  screenshotShortcutUnavailable?: boolean;
  screenshotShortcutFailureReason?: GlobalShortcutFailureReason;
  onConfigureScreenshotShortcut?: () => void;
}>();

const emit = defineEmits<ComposerEmits & {
  answer: [questionId: string, response: QuestionResponse];
  approval: [approvalId: string, response: { decision: 'approved' | 'rejected' | 'cancelled'; scope?: 'session'; feedback?: string; selectedLabel?: string }];
  'toggle-dock-panel': [panel: 'bash' | 'subagent' | 'todos' | 'goal' | 'plan'];
  'close-dock-panel': [];
}>();

const { t } = useI18n();
const { confirm, isConfirmOpen } = useConfirmDialog();
const { fontScale } = useAppearance();

const client = useKimiWebClient();
const { anyOverlayOpen } = useAppDialogs();
const goal = client.goal;
const goalEditing = ref(false);
watch(() => props.dockPanel, (panel) => {
  if (panel !== 'goal') goalEditing.value = false;
});
const planMode = client.planMode;
const planArmed = client.planArmed;

const panelApi = inject(panelApiKey);
const focusComposer = computed(
  () =>
    panelApi?.isExpanded() === true &&
    panelApi.activeTabType() !== 'btw' &&
    !panelApi.activeTabPurePreview(),
);
const panelExpanded = computed(() => panelApi?.isExpanded() === true);
const pfcHost = computed(() => panelApi?.pfcHost() ?? null);
const hasPendingCard = computed(() => props.pendingQuestion != null || props.pendingApproval != null);

const goalStatusLabel = computed(() => {
  switch (goal.value?.status) {
    case 'active': return t('status.goalStatusActive');
    case 'paused': return t('status.goalStatusPaused');
    case 'blocked': return t('status.goalStatusBlocked');
    case 'complete': return t('status.goalStatusComplete');
    default: return '';
  }
});

const goalWallClockLabel = computed(() =>
  goal.value
    ? formatDuration(goal.value.wallClockMs, {
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
  if (confirmed) client.controlGoal('cancel');
}

const todoAllDone = computed(
  () => (props.todos?.length ?? 0) > 0 && props.todoDoneCount === (props.todos?.length ?? 0),
);

const hasToolTasks = computed(() => props.bashTasks.some((t) => t.kind === 'tool'));
const bashPanelLabelKey = computed(() => (hasToolTasks.value ? 'tasks.dockTasks' : 'tasks.dockBash'));

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
const latestPlan = computed(() => Object.values(props.sessionPlans ?? {}).at(-1));
const planReviewLabel = computed(() => {
  const state = latestPlan.value?.review?.state;
  return state ? t(`tools.plan.review.${state}`) : '';
});

function openLatestPlan(): void {
  const plan = latestPlan.value;
  if (!plan?.path) return;
  panelApi?.openFile(plan.plan ? { path: plan.path, content: plan.plan } : { path: plan.path });
}

const composerRef = ref<{
  loadForEdit: (value: string, snapshot?: ComposerDocumentSnapshot) => boolean;
  insertQuote: (quote: string, comment?: string, source?: string) => void;
  insertPathMention: (path: string, kind: 'file' | 'folder') => void;
  insertScreenshotAnnotation: (file: File, comment: string) => void;
  addFiles: (files: File[]) => void;
  loadAttachmentsForEdit: (atts: TurnAttachment[]) => void;
  restoreDraftEntries: (entries: AttachmentEntry[]) => void;
  focus: () => void;
  clearAfterDispatch: (expectedSnapshot?: ComposerDocumentSnapshot) => void;
  closeOverlays?: () => void;
  anyPopupOpen?: boolean;
  isEmpty?: () => boolean;
} | null>(null);
const anyPopupOpen = computed(() => composerRef.value?.anyPopupOpen === true);
const raisedForPanel = computed(() => anyPopupOpen.value || props.dockPanel != null);
const workPanelRef = ref<HTMLElement | null>(null);
const dockRef = ref<HTMLElement | null>(null);
const workbarRef = ref<HTMLElement | null>(null);
const collapsedPills = ref<DockPillKey[]>([]);

const panelOriginX = ref('50%');

function onPillClick(panel: 'bash' | 'subagent' | 'todos' | 'goal' | 'plan', e: MouseEvent): void {
  if (props.pendingQuestion) return;
  const pillEl = e.currentTarget as HTMLElement | null;
  if (pillEl && dockRef.value) {
    const pr = pillEl.getBoundingClientRect();
    const dr = dockRef.value.getBoundingClientRect();
    panelOriginX.value = `${pr.left + pr.width / 2 - dr.left}px`;
  }
  emit('toggle-dock-panel', panel);
}

function loadForEdit(value: string, snapshot?: ComposerDocumentSnapshot): boolean {
  if (!composerRef.value) return false;
  composerRef.value.loadForEdit(value, snapshot);
  return true;
}

function insertQuote(quote: string, comment?: string, source?: string): boolean {
  if (!composerRef.value) return false;
  composerRef.value.insertQuote(quote, comment, source);
  return true;
}

function insertPathMention(path: string, kind: 'file' | 'folder'): boolean {
  if (!composerRef.value) return false;
  composerRef.value.insertPathMention(path, kind);
  return true;
}

function insertScreenshotAnnotation(file: File, comment: string): boolean {
  if (!composerRef.value) return false;
  composerRef.value.insertScreenshotAnnotation(file, comment);
  return true;
}

function addFiles(files: File[]): boolean {
  if (!composerRef.value) return false;
  composerRef.value.addFiles(files);
  return true;
}

function hasInsertableComposer(): boolean {
  return composerRef.value !== null && !hasPendingCard.value;
}

function loadAttachmentsForEdit(atts: TurnAttachment[]): void {
  composerRef.value?.loadAttachmentsForEdit(atts);
}

function restoreDraftEntries(entries: AttachmentEntry[]): void {
  composerRef.value?.restoreDraftEntries(entries);
}

function focus(): void {
  composerRef.value?.focus();
}

function clearAfterDispatch(expectedSnapshot?: ComposerDocumentSnapshot): void {
  composerRef.value?.clearAfterDispatch(expectedSnapshot);
}

const isEmpty = () => composerRef.value?.isEmpty?.() ?? false;

function onDocumentMouseDown(event: MouseEvent): void {
  if (!props.dockPanel) return;
  const target = event.target as Node | null;
  if (!target) return;
  if (workPanelRef.value?.contains(target)) return;
  if (target instanceof Element && target.closest('.ui-pill')) return;
  emit('close-dock-panel');
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.repeat || isImeKeyEvent(event)) return;
  if (event.defaultPrevented) return;
  if (event.target instanceof Element && event.target.closest('.goal-editor')) return;
  if (event.target instanceof Element && event.target.closest('.terminal-host')) return;
  if (anyPopupOpen.value || isConfirmOpen.value) return;
  if (anyOverlayOpen.value) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  emit('close-dock-panel');
}

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

watch(
  () => props.pendingQuestion,
  (q) => {
    if (q && props.dockPanel) emit('close-dock-panel');
  },
);

watch(hasPendingCard, (pending) => {
  if (pending) composerRef.value?.closeOverlays?.();
});

let dockResizeObserver: ResizeObserver | null = null;

const publishDockMetrics = createDockMetricsPublisher({
  setDockHeight: publishDockHeightPx,
});

const pillPriority = computed<Record<DockPillKey, number>>(() => ({
  goal: goal.value?.status === 'active' ? LIVE_PILL_PRIORITY : 0,
  plan: planMode.value ? LIVE_PILL_PRIORITY : 0,
  bash: dockTasksPillPriority(props.bashTasks),
  subagent: dockTasksPillPriority(props.subagentTasks),
  todos: (props.todos ?? []).some((todo) => todo.status === 'in_progress') ? LIVE_PILL_PRIORITY : 0,
}));

const visiblePillKeys = computed<DockPillKey[]>(() => {
  const keys: DockPillKey[] = [];
  if (goal.value) keys.push('goal');
  if (planMode.value || latestPlan.value) keys.push('plan');
  if (props.bashTasks.length > 0) keys.push('bash');
  if (props.subagentTasks.length > 0) keys.push('subagent');
  if ((props.todos?.length ?? 0) > 0) keys.push('todos');
  return keys;
});

const pillWidths: Partial<Record<DockPillKey, { expanded: number; collapsed: number }>> = {};
let pillCollapsedAt: Partial<Record<DockPillKey, number>> = {};

function measurePillCollapse(): void {
  const bar = workbarRef.value;
  const dock = dockRef.value;
  if (!bar || !dock) return;
  const collapsedSet = new Set(collapsedPills.value);
  for (const el of bar.querySelectorAll<HTMLElement>('[data-pill]')) {
    const key = el.dataset.pill as DockPillKey;
    const entry = (pillWidths[key] ??= { expanded: 0, collapsed: 0 });
    if (collapsedSet.has(key)) entry.collapsed = el.offsetWidth;
    else entry.expanded = el.offsetWidth;
  }
  const style = getComputedStyle(bar);
  const available =
    bar.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0);
  const plan = planDockPillCollapse({
    pills: visiblePillKeys.value.map((key) => ({
      key,
      priority: pillPriority.value[key],
      expandedWidth: Math.max(pillWidths[key]?.expanded ?? 0, pillWidths[key]?.collapsed ?? 0),
      collapsedWidth: pillWidths[key]?.collapsed || pillWidths[key]?.expanded || 0,
    })),
    availableWidth: available,
    gap: Number.parseFloat(style.columnGap) || 0,
    collapsed: collapsedPills.value,
    collapsedAt: pillCollapsedAt,
    dockWidth: dock.offsetWidth,
  });
  pillCollapsedAt = plan.collapsedAt;
  const next = plan.collapsed;
  if (next.length !== collapsedPills.value.length || next.some((key, i) => collapsedPills.value[i] !== key)) {
    collapsedPills.value = next;
    void nextTick(measurePillCollapse);
  }
}

function resetPillCollapse(): void {
  collapsedPills.value = [];
  pillCollapsedAt = {};
  for (const key of Object.keys(pillWidths) as DockPillKey[]) delete pillWidths[key];
  void nextTick(measurePillCollapse);
}

watch(
  [
    goalPillLabel,
    bashPillLabel,
    subagentPillLabel,
    todosPillLabel,
    fontScale,
    () => visiblePillKeys.value.map((key) => `${key}:${pillPriority.value[key]}`).join('|'),
  ],
  resetPillCollapse,
);

function onDockResize(): void {
  publishDockMetrics(dockRef.value);
  measurePillCollapse();
}

onMounted(() => {
  installImeCompositionLatch();
  document.fonts?.ready.then(resetPillCollapse);
  if (typeof ResizeObserver !== 'function' || !dockRef.value) return;
  dockResizeObserver = new ResizeObserver(onDockResize);
  dockResizeObserver.observe(dockRef.value);
  onDockResize();
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

defineExpose({ loadForEdit, insertQuote, insertScreenshotAnnotation, insertPathMention, addFiles, hasInsertableComposer, loadAttachmentsForEdit, restoreDraftEntries, focus, anyPopupOpen, isEmpty, clearAfterDispatch });
</script>

<template>
  <div
    ref="dockRef"
    class="chat-dock"
    :class="[
      mobile ? 'align-mobile' : 'align-center',
      { 'has-popup': raisedForPanel, 'has-approval': !!pendingApproval && !pendingQuestion, 'has-question': !!pendingQuestion },
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
          />
          <WorkPanelHead
            v-else-if="dockPanel === 'subagent'"
            icon="sparkles"
            :title="t('tasks.dockSubagent')"
            :meta="`${subagentRunning} ${t('tasks.running')}`"
          />
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
                  v-if="goal.status !== 'complete' && !goalEditing"
                  size="sm"
                  :label="t('status.goalEdit')"
                  :tooltip="t('status.goalEdit')"
                  @click.stop="goalEditing = true"
                >
                  <Icon name="pencil" size="md" />
                </IconButton>
                <IconButton
                  v-if="goal.status === 'active'"
                  size="sm"
                  :label="t('status.goalPause')"
                  :tooltip="t('status.goalPause')"
                  @click.stop="client.controlGoal('pause')"
                >
                  <Icon name="pause" size="md" />
                </IconButton>
                <IconButton
                  v-if="goal.status === 'paused' || goal.status === 'blocked'"
                  size="sm"
                  :label="t('status.goalResume')"
                  :tooltip="t('status.goalResume')"
                  :disabled="!client.goalModeAvailable.value"
                  @click.stop="client.controlGoal('resume')"
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
          <WorkPanelHead
            v-else-if="dockPanel === 'plan'"
            icon="file-edit"
            :title="t('status.planLabel')"
            :meta="planReviewLabel"
          >
            <template #actions>
              <IconButton
                v-if="latestPlan?.path"
                size="sm"
                :label="t('tasks.openPanel')"
                :tooltip="t('tasks.openPanel')"
                @click.stop="openLatestPlan"
              >
                <Icon name="external-link" size="md" />
              </IconButton>
              <IconButton
                v-if="planArmed || planMode"
                size="sm"
                :label="t('status.workModeDismiss')"
                :tooltip="t('status.workModeDismiss')"
                @click.stop="client.togglePlanMode()"
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
          </WorkPanelHead>
        </div>
        <div ref="workBodyRef" class="dock-work-body" @scroll="onWorkBodyScroll">
          <TasksPane
            v-if="dockPanel === 'bash'"
            :tasks="bashTasks"
            :cancelling-task-ids="client.pendingTaskCancellations"
            @cancel="client.cancelTask($event)"
          />
          <SubagentGrid
            v-else-if="dockPanel === 'subagent'"
            :tasks="subagentTasks"
            :cancelling-task-ids="client.pendingTaskCancellations"
            @cancel="client.cancelTask($event)"
          />
          <TodoCard
            v-else-if="dockPanel === 'todos'"
            :todos="todos ?? []"
          />
          <GoalPanel
            v-else-if="dockPanel === 'goal' && goal"
            v-model:editing="goalEditing"
            :goal="goal"
          />
          <PlanPanel
            v-else-if="dockPanel === 'plan'"
            :plan="latestPlan"
            :plan-mode-on="planMode"
          />
        </div>
      </div>
    </Transition>

    <div v-if="hasDockWork || planMode || latestPlan" ref="workbarRef" class="dock-workbar">
      <WorkPill
        v-if="goal"
        icon="target"
        :label="goalPillLabel"
        :active="dockPanel === 'goal'"
        :class="{ 'pill-collapsed': collapsedPills.includes('goal') }"
        data-pill="goal"
        @click="onPillClick('goal', $event)"
      >
        {{ t('status.goalLabel') }}
        <template #meta>
          <span class="dw-goal-status" :class="`dw-goal-status--${goal.status}`">{{ goalStatusLabel }}</span>
        </template>
      </WorkPill>
      <!-- The plan entry: shown once plan mode is live server-side or a
           persisted plan exists (the pill then stays as the plan viewer even
           after disarm). A merely ARMED directive never lands here — it is
           local intent, carried solely by the composer's inline pill, whose ×
           cancels it. Cancelling the live mode lives in the panel head. -->
      <WorkPill
        v-if="planMode || latestPlan"
        icon="file-edit"
        :label="t('status.planLabel')"
        :active="dockPanel === 'plan'"
        :class="{ 'pill-collapsed': collapsedPills.includes('plan') }"
        data-pill="plan"
        @click="onPillClick('plan', $event)"
      >
        {{ t('status.planLabel') }}
      </WorkPill>
      <WorkPill
        v-if="bashTasks.length > 0"
        icon="terminal"
        :label="bashPillLabel"
        :active="dockPanel === 'bash'"
        :class="{ 'pill-collapsed': collapsedPills.includes('bash') }"
        data-pill="bash"
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
        :class="{ 'pill-collapsed': collapsedPills.includes('subagent') }"
        data-pill="subagent"
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
        :class="{ 'pill-collapsed': collapsedPills.includes('todos') }"
        data-pill="todos"
        @click="onPillClick('todos', $event)"
      >
        {{ t('tasks.todoProgressTitle') }}
        <template #meta>
          <span class="dw-count">{{ todoDoneCount }}/{{ todos?.length ?? 0 }}</span>
        </template>
      </WorkPill>
    </div>
    <Teleport :to="pfcHost" :disabled="!panelExpanded || pfcHost === null">
      <KeepAlive :max="1">
        <QuestionCard
          v-if="pendingQuestion"
          :key="pendingQuestion.questionId"
          class="dock-question"
          :question="pendingQuestion"
          :busy-kind="questionBusyKind"
          @answer="(qid, resp) => emit('answer', qid, resp)"
          @dismiss="client.dismissQuestion($event)"
        />
      </KeepAlive>
      <KeepAlive :max="1">
        <ApprovalCard
          v-if="!pendingQuestion && pendingApproval"
          :key="pendingApproval.approvalId"
          class="dock-approval"
          :block="pendingApproval.block"
          :agent-name="pendingApproval.agentName"
          :request-id="pendingApproval.approvalId"
          :busy="approvalBusy"
          @decide="emit('approval', pendingApproval!.approvalId, $event)"
        />
      </KeepAlive>
    </Teleport>
    <slot name="notice" />
    <Teleport :to="pfcHost" :disabled="!focusComposer || pfcHost === null">
      <Composer
        :style="hasPendingCard ? { display: 'none' } : undefined"
        :status-note="props.statusNote"
        :session-submit-blocked-reason="props.sessionSubmitBlockedReason"
        :session-submit-blocked-tooltip="props.sessionSubmitBlockedTooltip"
        :before-submit="props.beforeSubmit"
        :defer-submit-reset="props.deferSubmitReset"
        :extra-builtin-commands="props.extraBuiltinCommands"
        ref="composerRef"
        :on-capture-screenshot="props.onCaptureScreenshot"
        :screenshot-shortcut-keys="props.screenshotShortcutKeys"
        :screenshot-shortcut-unavailable="props.screenshotShortcutUnavailable"
        :screenshot-shortcut-failure-reason="props.screenshotShortcutFailureReason"
        :on-configure-screenshot-shortcut="props.onConfigureScreenshotShortcut"
        :interrupt-armed="interruptArmed"
        @submit="emit('submit', $event)"
        @steer="emit('steer', $event)"
        @steer-queued="emit('steerQueued', $event)"
        @command="emit('command', $event)"
        @interrupt="emit('interrupt')"
        @focus-goal="emit('focusGoal')"
        @pick-model="emit('pickModel')"
        @login="emit('login')"
        @configure-model="emit('configureModel')"
      />
    </Teleport>
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

.chat-dock > * {
  position: relative;
  z-index: 1;
}

.dock-work-panel {
  position: absolute;
  left: calc(var(--dock-inline-left) + var(--space-1));
  right: calc(var(--dock-inline-right) + var(--space-1) + var(--panes-scrollbar-width, 0px));
  bottom: 100%;
  background: var(--color-dock-panel-bg);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-2xl);
  max-height: min(300px, 50vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  user-select: none;
}
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
  margin-top: var(--space-2);
  padding: 0 var(--space-4) var(--space-4);
}
.dock-work-panel.panel-todos .dock-work-head,
.dock-work-panel.panel-goal .dock-work-head,
.dock-work-panel.panel-plan .dock-work-head,
.dock-work-panel.panel-subagent .dock-work-head,
.dock-work-panel.panel-bash .dock-work-head {
  padding: var(--space-4) var(--space-4) 0;
  border-bottom: none;
}
.dock-work-panel.panel-todos .dock-work-tab,
.dock-work-panel.panel-goal .dock-work-tab,
.dock-work-panel.panel-plan .dock-work-tab,
.dock-work-panel.panel-subagent .dock-work-tab,
.dock-work-panel.panel-bash .dock-work-tab {
  padding: 0;
  line-height: var(--leading-solid);
}
.dock-work-panel.panel-goal .gh-time {
  color: var(--color-text-muted);
}
.dock-work-panel.panel-todos .dock-work-body,
.dock-work-panel.panel-goal .dock-work-body,
.dock-work-panel.panel-plan .dock-work-body,
.dock-work-panel.panel-subagent .dock-work-body,
.dock-work-panel.panel-bash .dock-work-body {
  margin-top: var(--space-2);
  padding: 0 var(--space-4) var(--space-4);
}
.dock-work-panel.panel-goal .dock-work-body {
  margin-top: 0;
  padding-top: var(--space-2);
}
.dock-work-tab.tab-progress {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}
.dock-work-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--p-hairline) solid var(--color-line);
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
@media (max-width: 480px) {
  .dock-work-head { flex-wrap: wrap; }
}
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
  flex-wrap: wrap;
  gap: var(--space-1);
  padding: var(--space-1) calc(var(--dock-inline-right) + var(--space-4)) 0 calc(var(--dock-inline-left) + var(--space-4));
}
.dock-workbar ~ :deep(.composer) {
  padding-top: var(--space-1);
}
.dock-workbar :deep(.ui-pill) {
  position: relative;
  gap: var(--space-1-5);
  height: auto;
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-dock-pill);
  background: var(--color-hover);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-regular);
  line-height: round(calc(var(--text-base) * 1.42), 1px);
}
.dock-workbar :deep(.ui-pill svg) {
  width: var(--p-ic-dock);
  height: var(--p-ic-dock);
  color: inherit;
}
.dock-workbar :deep(.ui-pill)::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--color-hover);
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
  pointer-events: none;
}
.dock-workbar :deep(.ui-pill:hover:not(:disabled))::after,
.dock-workbar :deep(.ui-pill.is-active)::after {
  opacity: 1;
}
.chat-dock .dock-workbar :deep(.ui-pill.pill-collapsed) > span {
  display: none;
}

.dock-workbar .dw-count { color: var(--color-text-muted); }
.dock-workbar .dw-running {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1-5);
  color: var(--color-text);
}
.dock-workbar .dw-goal-status--active { color: var(--color-success); }
.dock-workbar .dw-goal-status--paused { color: var(--color-warning); }
.dock-workbar .dw-goal-status--blocked { color: var(--color-danger); }

.dock-approval {
  margin-top: 8px;
}

.chat-dock.has-approval,
.chat-dock.has-question {
  display: flex;
  flex-direction: column;
  max-height: calc(var(--app-height, 100dvh) - var(--dock-card-top-clearance));
}
.chat-dock.has-approval > .dock-workbar,
.chat-dock.has-question > .dock-workbar {
  flex: none;
}
.chat-dock.has-approval > .dock-approval,
.chat-dock.has-question > .dock-question {
  min-height: 0;
}

@media (max-width: 640px) {
  .chat-dock {
    --dock-inline-left: max(12px, var(--safe-left));
    --dock-inline-right: max(12px, var(--safe-right));
  }
  .dock-work-panel {
    left: 10px;
    right: calc(10px + var(--panes-scrollbar-width, 0px));
  }
  .dock-work-head-actions :deep(.ui-seg__item) {
    height: var(--touch-target-min);
  }
  .dock-work-head-actions :deep(.ui-icon-button) {
    width: var(--touch-target-min);
    height: var(--touch-target-min);
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
