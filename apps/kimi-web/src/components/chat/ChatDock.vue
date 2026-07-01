<!-- ChatDock.vue -->
<!-- Bottom dock that belongs to the chat tab: goal strip, running-task chips, -->
<!-- pending question/approval cards, and the composer. Only rendered inside a -->
<!-- chat-pane group so it never leaks into files/tasks/preview/btw panes. -->
<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ActivationBadges, ApprovalBlock, ConversationStatus, PermissionMode, QueuedPromptView, TaskItem, TodoView, UIQuestion } from '../../types';
import type { AppGoal, AppModel, AppSkill, QuestionResponse, ThinkingLevel } from '../../api/types';
import type { FileItem } from './MentionMenu.vue';
import Composer from './Composer.vue';
import GoalStrip from './GoalStrip.vue';
import QuestionCard from './QuestionCard.vue';
import ApprovalCard from './ApprovalCard.vue';
import TasksPane from './TasksPane.vue';
import TodoCard from './TodoCard.vue';
import Icon from '../ui/Icon.vue';
import Pill from '../ui/Pill.vue';

const props = defineProps<{
  sessionId?: string;
  running?: boolean;
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
  starredIds?: string[];
  skills?: AppSkill[];
  goal?: AppGoal | null;
  goalExpandSignal?: number;
  dockPanel: 'bash' | 'subagent' | 'todos' | null;
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
  mobile?: boolean;
}>();

const emit = defineEmits<{
  submit: [payload: { text: string; attachments: { fileId: string; kind: 'image' | 'video' }[] }];
  steer: [payload: { text: string; attachments: { fileId: string; kind: 'image' | 'video' }[] }];
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
  answer: [questionId: string, response: QuestionResponse];
  dismiss: [questionId: string];
  approval: [approvalId: string, response: { decision: 'approved' | 'rejected' | 'cancelled'; scope?: 'session'; feedback?: string; selectedLabel?: string }];
  cancelTask: [taskId: string];
  'toggle-dock-panel': [panel: 'bash' | 'subagent' | 'todos'];
  'close-dock-panel': [];
  /** A background subagent chip was clicked — open its live detail panel. */
  openAgent: [taskId: string];
}>();

const { t } = useI18n();
const composerRef = ref<{ loadForEdit: (value: string) => void; focus: () => void } | null>(null);
const workPanelRef = ref<HTMLElement | null>(null);
const workbarRef = ref<HTMLElement | null>(null);

function loadForEdit(value: string): void {
  composerRef.value?.loadForEdit(value);
}

function focus(): void {
  composerRef.value?.focus();
}

function onDocumentMouseDown(event: MouseEvent): void {
  if (!props.dockPanel) return;
  const target = event.target as Node | null;
  if (!target) return;
  if (workPanelRef.value?.contains(target)) return;
  if (workbarRef.value?.contains(target)) return;
  emit('close-dock-panel');
}

watch(
  () => props.dockPanel,
  (panel) => {
    if (typeof document === 'undefined') return;
    document.removeEventListener('mousedown', onDocumentMouseDown, true);
    if (panel) document.addEventListener('mousedown', onDocumentMouseDown, true);
  },
  { immediate: true },
);

onUnmounted(() => {
  if (typeof document !== 'undefined') {
    document.removeEventListener('mousedown', onDocumentMouseDown, true);
  }
});

defineExpose({ loadForEdit, focus });
</script>

<template>
  <div class="chat-dock" :class="[mobile ? 'align-mobile' : 'align-center']" @click.stop>
    <Transition name="dock-panel">
      <div
        ref="workPanelRef"
        v-if="dockPanel"
        class="dock-work-panel"
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
        </div>
        <div class="dock-work-body">
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
        </div>
      </div>
    </Transition>

    <GoalStrip
      v-if="goal"
      :goal="goal"
      :force-expanded="goalExpandSignal"
      @control-goal="emit('controlGoal', $event)"
    />
    <div v-if="hasDockWork" ref="workbarRef" class="dock-workbar">
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
      @decide="emit('approval', pendingApproval!.approvalId, $event)"
    />
    <Composer
      v-else
      ref="composerRef"
      :session-id="sessionId"
      :running="running"
      :queued="queued"
      :search-files="searchFiles"
      :upload-image="uploadImage"
      :status="status"
      :thinking="thinking"
      :plan-mode="planMode"
      :swarm-mode="swarmMode"
      :goal-mode="goalMode"
      :activation-badges="activationBadges"
      :models="models"
      :starred-ids="starredIds"
      :skills="skills"
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
  position: relative;
  background: var(--color-bg);
  z-index: var(--z-sticky);
}
.chat-dock.align-center { margin-left: auto; margin-right: auto; }
.chat-dock.align-left { margin-left: 0; margin-right: auto; }
.chat-dock.align-mobile { max-width: none; }

.dock-work-panel {
  position: absolute;
  left: 16px;
  right: calc(16px + var(--panes-scrollbar-width, 0px));
  bottom: 100%;
  background: var(--color-surface);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
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
  padding: 8px 10px;
  border-bottom: 1px solid var(--color-line);
}
.dock-work-tab {
  font-size: var(--text-base);
  font-weight: 500;
  color: var(--color-text);
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
}
.dock-work-tab.static {
  background: transparent;
  border-color: transparent;
  padding-left: 2px;
}
.dock-work-body {
  padding: 8px 10px;
  overflow-y: auto;
  min-height: 0;
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
  gap: 6px;
  padding: 4px var(--dock-inline-right) 2px var(--dock-inline-left);
}
.dock-workbar .dw-count { margin-left: 1px; }
.dock-workbar .dw-count b { font-weight: 500; }

.dock-approval {
  margin-top: 8px;
}

@media (max-width: 640px) {
  .chat-dock {
    --dock-inline-left: max(12px, env(safe-area-inset-left));
    --dock-inline-right: max(12px, env(safe-area-inset-right));
  }
  .chat-dock.align-mobile {
    padding-left: env(safe-area-inset-left);
    padding-right: env(safe-area-inset-right);
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
