<!-- apps/kimi-web/src/components/chat/ApprovalCard.vue -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ApprovalBlock } from '../../types';
import type { ApprovalDecision } from '../../api/types';
import Markdown from './Markdown.vue';
import Card from '../ui/Card.vue';
import Badge from '../ui/Badge.vue';
import Button from '../ui/Button.vue';
import IconButton from '../ui/IconButton.vue';
import Icon from '../ui/Icon.vue';
import Kbd from '../ui/Kbd.vue';
import Tooltip from '../ui/Tooltip.vue';

const props = defineProps<{
  block: ApprovalBlock;
  agentName?: string;
  /** True while a decision for this approval is in flight. Drives the action
   *  buttons' loading/disabled state and blocks duplicate decisions. */
  busy?: boolean;
}>();

const emit = defineEmits<{
  decide: [response: { decision: ApprovalDecision; scope?: 'session'; feedback?: string; selectedLabel?: string }];
}>();

const { t } = useI18n();

interface PlanReviewView {
  plan: string;
  path?: string;
  options: { label: string; description?: string }[];
}

const planReview = computed<PlanReviewView | null>(() => {
  const b = props.block;
  if (b.kind !== 'plan_review') return null;
  return { plan: b.plan, path: b.path, options: b.options ?? [] };
});

// Temporarily collapse to a thin bar so the approval stops covering the chat
// while the user reads. The decision buttons + body return on expand.
const minimized = ref(false);

// ---------------------------------------------------------------------------
// Title by kind
// ---------------------------------------------------------------------------

const titleKinds = ['shell', 'diff', 'file', 'fileop', 'url', 'search', 'invocation', 'todo', 'plan_review', 'generic'];

function title(): string {
  const kind = titleKinds.includes(props.block.kind) ? props.block.kind : 'generic';
  return t(`approval.title.${kind}`);
}

// ---------------------------------------------------------------------------
// Inline feedback
// ---------------------------------------------------------------------------

const feedbackOpen = ref(false);
const feedbackText = ref('');
const feedbackRef = ref<HTMLTextAreaElement | null>(null);

function openFeedback(): void {
  if (props.busy) return;
  feedbackOpen.value = true;
  feedbackText.value = '';
  // Focus textarea next tick
  setTimeout(() => feedbackRef.value?.focus(), 0);
}

function submitFeedback(): void {
  if (props.busy) return;
  const fb = feedbackText.value.trim();
  if (planReview.value) {
    // Revise: keep plan mode active and pass optional feedback to the agent.
    act('feedback', { decision: 'rejected', selectedLabel: 'Revise', feedback: fb || undefined });
  } else {
    act('feedback', { decision: 'rejected', feedback: fb || undefined });
  }
  feedbackOpen.value = false;
  feedbackText.value = '';
}

function cancelFeedback(): void {
  feedbackOpen.value = false;
  feedbackText.value = '';
}

function onFeedbackKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitFeedback();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelFeedback();
  }
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

// The action the user just triggered, kept locally so its button can show a
// spinner. The card unmounts on a successful decide; on failure `busy` flips
// back to false and we clear this so the buttons re-enable for retry.
const pendingAction = ref<string | null>(null);
watch(
  () => props.busy,
  (b) => {
    if (!b) pendingAction.value = null;
  },
);

function act(
  action: string,
  response: { decision: ApprovalDecision; scope?: 'session'; feedback?: string; selectedLabel?: string },
): void {
  // A second click (or number key) while the first decide is in flight must
  // not fire a duplicate request.
  if (props.busy) return;
  pendingAction.value = action;
  emit('decide', response);
}

function approve(): void { act('approve', { decision: 'approved' }); }
function approveSession(): void { act('approveSession', { decision: 'approved', scope: 'session' }); }
function reject(): void { act('reject', { decision: 'rejected' }); }

// plan_review actions
function approvePlan(): void { act('approvePlan', { decision: 'approved' }); }
function approveOption(label: string): void { act(`option:${label}`, { decision: 'approved', selectedLabel: label }); }
function revisePlan(): void {
  if (props.busy) return;
  openFeedback();
}
function rejectAndExitPlan(): void { act('rejectAndExit', { decision: 'rejected', selectedLabel: 'Reject and Exit' }); }

// ---------------------------------------------------------------------------
// Number key shortcuts. Generic cards: 1=approve, 2=session, 3=reject,
// 4=feedback. Plan review cards: 1/2/3 map to the offered approaches (or
// approve / revise / reject-and-exit when no approaches are offered).
// Guard: do not fire when a textarea/input is focused
// ---------------------------------------------------------------------------

function handleKeydown(e: KeyboardEvent): void {
  const tag = (document.activeElement?.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  // While a decision is in flight, ignore number-key shortcuts so a stray key
  // can't fire a duplicate decide.
  if (props.busy) return;
  // Hidden actions shouldn't fire from number keys while minimized.
  if (minimized.value) return;
  const pr = planReview.value;
  if (pr) {
    if (pr.options.length === 0) {
      if (e.key === '1') { e.preventDefault(); approvePlan(); }
      else if (e.key === '2') { e.preventDefault(); revisePlan(); }
      else if (e.key === '3') { e.preventDefault(); rejectAndExitPlan(); }
      return;
    }
    if (e.key === '1' && pr.options[0]) { e.preventDefault(); approveOption(pr.options[0].label); }
    else if (e.key === '2' && pr.options[1]) { e.preventDefault(); approveOption(pr.options[1].label); }
    else if (e.key === '3' && pr.options[2]) { e.preventDefault(); approveOption(pr.options[2].label); }
    return;
  }
  if (e.key === '1') { e.preventDefault(); approve(); }
  else if (e.key === '2') { e.preventDefault(); approveSession(); }
  else if (e.key === '3') { e.preventDefault(); reject(); }
  else if (e.key === '4') { e.preventDefault(); openFeedback(); }
}

onMounted(() => document.addEventListener('keydown', handleKeydown));
onUnmounted(() => document.removeEventListener('keydown', handleKeydown));
</script>

<template>
  <Card class="appr" :class="{ minimized }">
    <!-- Header -->
    <template #head>
      <div class="ah">
        <span class="ah-ic">!</span>
        <span class="akind">{{ title() }}</span>
        <span class="apath">
          <template v-if="block.kind === 'diff' || block.kind === 'file' || block.kind === 'fileop'">{{ block.path }}</template>
          <template v-else-if="block.kind === 'shell'">{{ block.command }}</template>
          <template v-else-if="block.kind === 'url'">{{ block.url }}</template>
          <template v-else-if="block.kind === 'search'">{{ block.query }}</template>
          <template v-else-if="block.kind === 'invocation'">{{ block.name }}</template>
          <template v-else-if="block.kind === 'generic'">{{ block.summary }}</template>
        </span>
        <Badge v-if="agentName && !minimized" variant="neutral" size="sm">{{ t('approval.subagentBadge', { name: agentName }) }}</Badge>
        <Badge v-if="!minimized" variant="warning" size="sm" class="aw">{{ t('approval.required') }}</Badge>
        <IconButton
          class="amin"
          size="sm"
          :label="minimized ? t('question.expand') : t('question.minimize')"
          @click="minimized = !minimized"
        >
          <Icon v-if="minimized" name="chevron-up" size="md" />
          <Icon v-else name="minus" size="md" />
        </IconButton>
      </div>
    </template>

    <!-- Body + actions collapse when minimized -->
    <template v-if="!minimized" #default>
      <!-- plan_review: plan file path on the body's first line -->
      <Tooltip v-if="block.kind === 'plan_review' && block.path" :text="block.path">
        <div class="ah-path">{{ block.path }}</div>
      </Tooltip>

      <!-- Body by kind -->

      <!-- diff -->
      <div v-if="block.kind === 'diff'" class="diff">
        <div v-for="(line, i) in block.diff" :key="i" class="dl" :class="line.kind === 'add' ? 'add' : line.kind === 'rem' ? 'del' : ''">
          <span class="dg">{{ line.gutter }}</span><span class="dc">{{ line.text }}</span>
        </div>
      </div>

      <!-- shell -->
      <div v-else-if="block.kind === 'shell'" class="body-shell">
        <div class="shell-cmd"><span class="shell-dollar">$</span> {{ block.command }}</div>
        <div v-if="block.cwd" class="shell-cwd">cwd: {{ block.cwd }}</div>
        <div v-if="block.danger" class="shell-danger">{{ t('approval.danger', { detail: block.danger }) }}</div>
      </div>

      <!-- file -->
      <div v-else-if="block.kind === 'file'" class="body-file">
        <div class="file-bar">
          <span class="file-lang">{{ block.language ?? '' }}</span>
        </div>
        <div class="file-content">
          <div v-for="(line, i) in block.content.split('\n')" :key="i" class="file-line">
            <span class="file-ln">{{ i + 1 }}</span><span class="file-text">{{ line }}</span>
          </div>
        </div>
      </div>

      <!-- fileop -->
      <div v-else-if="block.kind === 'fileop'" class="body-chip">
        <span class="chip-label">{{ block.op }}</span>
        <span class="chip-value">{{ block.path }}</span>
        <span v-if="block.detail" class="chip-detail">{{ block.detail }}</span>
      </div>

      <!-- url -->
      <div v-else-if="block.kind === 'url'" class="body-chip">
        <span v-if="block.method" class="chip-label">{{ block.method }}</span>
        <span class="chip-value">{{ block.url }}</span>
      </div>

      <!-- search -->
      <div v-else-if="block.kind === 'search'" class="body-chip">
        <span class="chip-label">{{ t('approval.searchQueryLabel') }}</span>
        <span class="chip-value">{{ block.query }}</span>
        <span v-if="block.scope" class="chip-detail">{{ t('approval.searchScope', { scope: block.scope }) }}</span>
      </div>

      <!-- invocation -->
      <div v-else-if="block.kind === 'invocation'" class="body-chip">
        <span class="chip-label">{{ block.kind2 }}</span>
        <span class="chip-value">{{ block.name }}</span>
        <span v-if="block.description" class="chip-detail">{{ block.description }}</span>
      </div>

      <!-- todo -->
      <div v-else-if="block.kind === 'todo'" class="body-todo">
        <div v-for="(item, i) in block.items" :key="i" class="todo-item">
          <span class="todo-glyph">{{ item.status === 'done' || item.status === 'completed' ? '✓' : '○' }}</span>
          <span class="todo-title" :class="{ 'todo-done': item.status === 'done' || item.status === 'completed' }">{{ item.title }}</span>
        </div>
      </div>

      <!-- plan_review -->
      <div v-else-if="block.kind === 'plan_review'" class="body-plan">
        <Markdown :text="block.plan" />
      </div>

      <!-- generic -->
      <div v-else class="body-generic">
        <span class="gen-text">{{ block.summary }}</span>
      </div>

      <!-- Inline feedback textarea -->
      <div v-if="feedbackOpen" class="feedback-wrap">
        <textarea
          ref="feedbackRef"
          v-model="feedbackText"
          class="feedback-ta"
          :placeholder="t('approval.feedbackPlaceholder')"
          rows="2"
          @keydown="onFeedbackKeydown"
        />
        <div class="feedback-hint">{{ t('approval.feedbackHint') }}</div>
      </div>
    </template>

    <!-- Actions -->
    <template v-if="!minimized" #foot>
      <!-- plan_review actions -->
      <div v-if="planReview" class="plan-actions">
        <template v-if="planReview.options.length > 0">
          <Tooltip
            v-for="(opt, i) in planReview.options"
            :key="i"
            :text="opt.description"
          >
            <Button
              class="kbtn"
              size="sm"
              variant="primary"
              :loading="pendingAction === `option:${opt.label}`"
              :disabled="busy"
              @click="approveOption(opt.label)"
            >{{ opt.label }}<Kbd class="k" :keys="[String(i + 1)]" /></Button>
          </Tooltip>
        </template>
        <Button v-else class="kbtn" size="sm" variant="primary" :loading="pendingAction === 'approvePlan'" :disabled="busy" @click="approvePlan">{{ t('approval.approvePlan') }}<Kbd class="k" :keys="['1']" /></Button>
        <Button class="kbtn" size="sm" variant="secondary" :disabled="busy" @click="revisePlan">{{ t('approval.revise') }}<Kbd v-if="planReview.options.length === 0" class="k" :keys="['2']" /></Button>
        <Button class="kbtn" size="sm" variant="danger-soft" :loading="pendingAction === 'rejectAndExit'" :disabled="busy" @click="rejectAndExitPlan">{{ t('approval.rejectAndExit') }}<Kbd v-if="planReview.options.length === 0" class="k" :keys="['3']" /></Button>
      </div>

      <!-- default actions row -->
      <div v-else class="abtn">
        <Button class="kbtn" size="sm" variant="primary" :loading="pendingAction === 'approve'" :disabled="busy" @click="approve">{{ t('approval.approve') }}<Kbd class="k" :keys="['1']" /></Button>
        <Button class="kbtn" size="sm" variant="secondary" :loading="pendingAction === 'approveSession'" :disabled="busy" @click="approveSession">{{ t('approval.approveSession') }}<Kbd class="k" :keys="['2']" /></Button>
        <Button class="kbtn" size="sm" variant="secondary" :loading="pendingAction === 'reject'" :disabled="busy" @click="reject">{{ t('approval.reject') }}<Kbd class="k" :keys="['3']" /></Button>
        <Button class="kbtn" size="sm" variant="secondary" :disabled="busy" @click="openFeedback">{{ t('approval.feedback') }}<Kbd class="k" :keys="['4']" /></Button>
      </div>
    </template>
  </Card>
</template>

<style scoped>
.appr {
  margin: var(--space-2) 0;
}
/* Warning attention-card head band layered on top of the shared flat Card
   primitive (Card supplies the border, radius and surface; no shadow). */
.appr.ui-card { border-color: var(--color-warning-bd); }
.appr :deep(.ui-card__head) {
  background: var(--color-warning-soft);
  border-bottom-color: var(--color-warning-bd);
}
/* When minimized the body/foot slots are not rendered; collapse the (always-
   rendered) Card body and drop the head border so the card is a thin bar. */
.appr.minimized :deep(.ui-card__body) { display: none; }
.appr.minimized :deep(.ui-card__head) { border-bottom: none; }

/* Header — content row (Card provides the band padding/border). Single row:
   title + truncating path on the left, "required" badge + minimize pinned to
   the right. */
.ah {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  font: var(--text-sm)/var(--leading-normal) var(--font-ui);
  flex-wrap: nowrap;
}
.ah-ic {
  width: var(--p-ic-md);
  height: var(--p-ic-md);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-warning);
  font-weight: var(--weight-semibold);
  font-size: 15px;
  line-height: 1;
  flex: none;
}
.akind {
  color: var(--color-warning);
  font-size: var(--text-base);
  font-weight: var(--weight-semibold);
  white-space: nowrap;
  flex: none;
}
.apath {
  color: var(--color-text);
  font: var(--text-sm) var(--font-mono);
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Body first line — full-width plan file path, below the title row. */
.ah-path {
  margin-bottom: var(--space-2);
  color: var(--color-text-muted);
  font: var(--text-xs) var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.aw {
  margin-left: auto;
}

/* Minimize toggle — when the "required" badge is hidden (minimized) it falls
   to the right via its own margin. */
.minimized .amin {
  margin-left: auto;
}

/* Diff — sunken code panel. */
.diff {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface-sunken);
  overflow: hidden;
  font: var(--text-sm)/1.85 var(--font-mono);
}
.dl { display: flex; padding: 0 var(--space-3); }
.dg { width: 30px; color: var(--color-text-muted); text-align: right; padding-right: var(--space-3); user-select: none; }
.dc { white-space: pre; font: inherit; }
.del { background: var(--color-danger-soft); }
.del .dc { color: var(--color-danger); }
.add { background: var(--color-success-soft); }
.add .dc { color: var(--color-success); }

/* Shell */
.shell-cmd {
  font: var(--text-sm) var(--font-mono);
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 160px;
  overflow-y: auto;
  color: var(--color-text);
}
.shell-dollar { color: var(--color-accent-hover); font-weight: var(--weight-medium); margin-right: var(--space-2); }
.shell-cwd { font: var(--text-xs) var(--font-mono); color: var(--color-text-muted); margin-top: var(--space-1); }
.shell-danger {
  margin-top: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-danger-bd);
  border-radius: var(--radius-sm);
  color: var(--color-danger);
  font: var(--text-sm) var(--font-ui);
  background: var(--color-danger-soft);
}

/* File — sunken code panel. */
.body-file {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.file-bar {
  padding: var(--space-1) var(--space-3);
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-line);
  font: var(--text-xs) var(--font-mono);
  color: var(--color-text-muted);
}
.file-lang { letter-spacing: 0.04em; }
.file-content {
  padding: var(--space-2) 0;
  font: var(--text-sm)/1.7 var(--font-mono);
  background: var(--color-surface-sunken);
  max-height: 240px;
  overflow-y: auto;
}
.file-line { display: flex; padding: 0 var(--space-3); }
.file-ln { width: 30px; color: var(--color-text-muted); text-align: right; padding-right: var(--space-3); user-select: none; flex: none; }
.file-text { white-space: pre; font: inherit; }

/* Chip (fileop/url/search/invocation) */
.body-chip {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
  color: var(--color-text);
}
.chip-label {
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  padding: 2px var(--space-2);
  font: var(--weight-semibold) var(--text-xs) var(--font-mono);
  color: var(--color-text-muted);
  white-space: nowrap;
}
.chip-value {
  font: var(--text-sm) var(--font-mono);
  color: var(--color-text);
  word-break: break-all;
}
.chip-detail { font: var(--text-xs) var(--font-ui); color: var(--color-text-muted); }

/* Todo */
.todo-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-1) 0;
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
  color: var(--color-text);
}
.todo-glyph { color: var(--color-accent); font-size: var(--text-sm); flex: none; width: 14px; }
.todo-title { color: var(--color-text); }
.todo-done { color: var(--color-text-muted); text-decoration: line-through; }

/* Generic */
.body-generic {
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
  color: var(--color-text);
  word-break: break-word;
}

/* Plan review — Markdown body, capped at half the viewport height with scroll
   for longer plans. */
.body-plan { max-height: 50vh; overflow-y: auto; }

/* Feedback */
.feedback-wrap {
  margin-top: var(--space-3);
}
.feedback-ta {
  width: 100%;
  box-sizing: border-box;
  font: var(--text-sm) var(--font-ui);
  padding: var(--space-2) var(--space-2);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  resize: none;
  outline: none;
  color: var(--color-text);
  background: var(--color-surface-raised);
}
.feedback-ta:focus-visible {
  border-color: var(--color-accent);
  box-shadow: var(--p-focus-ring);
}

.feedback-hint { font: var(--text-xs) var(--font-ui); color: var(--color-text-muted); margin-top: var(--space-1); }

/* Actions row — right-aligned sm buttons (primary / secondary / ghost-danger). */
.abtn,
.plan-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  width: 100%;
}
.plan-actions { flex-wrap: wrap; }
.k { opacity: .75; }

/* =========================================================================
   MOBILE (≤640px): the card spans the full chat column, inner previews scroll
   horizontally instead of overflowing the page, and the action buttons become a
   stack of ≥44px tall, easily-tappable targets.
   ========================================================================= */
@media (max-width: 640px) {
  /* Diff / file code blocks: scroll sideways for long lines (mono stays pre). */
  .diff,
  .file-content {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .file-content { max-height: 50vh; }

  /* Actions → full-width stacked rows, each a tall ≥44px tap target. */
  .abtn,
  .plan-actions { flex-direction: column; }
  .kbtn {
    width: 100%;
    min-height: 46px;
  }
}
</style>
