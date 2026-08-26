<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, onUpdated, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ApprovalBlock, FilePreviewRequest } from '../../types';
import type { ApprovalDecision } from '../../api/types';
import { useAppearance } from '@moonshot-ai/app-core';
import { Markdown } from '@moonshot-ai/app-markdown';
import { Badge, Button, Icon, IconButton, Spinner, Textarea, openDialogCount, useImeComposition } from '@moonshot-ai/app-ui';
import { HighlightedCode } from '@moonshot-ai/app-components';
import {
  approvalDecisionName,
  type ApprovalTelemetryAction,
  type ApprovalVia,
} from '../../lib/approvalTelemetry';
import { track } from '@moonshot-ai/app-client/contracts';

const props = defineProps<{
  block: ApprovalBlock;
  agentName?: string;
  /** Approval request id, reported as request_id on approval_decision. */
  requestId?: string;
  /** True while a decision for this approval is in flight. Drives the action
   *  buttons' loading/disabled state and blocks duplicate decisions. */
  busy?: boolean;
  /** Open a file in the right-side preview panel (plan path, markdown paths). */
  openFile?: (target: FilePreviewRequest) => void;
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

// Scroll seams: the plan body scrolls in a capped area; once scrolled, a soft
// shadow fades in at the scroll area's top edge (the sidebar's scroll-linked
// seam language), so clipped content reads as passing under the card chrome
// instead of ending flush against it. When fixed chrome squeezes the card
// (iOS keyboard + grown feedback box), the WRAP becomes the scroller instead
// (see .body-plan-wrap); when even the fixed chrome alone exceeds the height
// cap, the CARD itself is the scroller of last resort (see .appr) and gets
// its own seam. Scroll events don't bubble, hence a listener on each element.
// cardRef doubles as the feedback box's width observer (see below).
const cardRef = ref<HTMLElement | null>(null);
const planWrapEl = ref<HTMLElement | null>(null);
const planBodyEl = ref<HTMLElement | null>(null);
const planScrolled = ref(false);
const cardScrolled = ref(false);

function updateScrollSeams(): void {
  planScrolled.value = (planWrapEl.value?.scrollTop ?? 0) > 0 || (planBodyEl.value?.scrollTop ?? 0) > 0;
  cardScrolled.value = (cardRef.value?.scrollTop ?? 0) > 0;
}

function onPlanScroll(): void {
  updateScrollSeams();
}

// Lift the content body's height cap so long plans / Write previews / Edit
// diffs can be read in full ("expand to tallest"). Independent of `minimized`
// (the whole-card bar). Only shown for the kinds that can grow tall.
const expanded = ref(false);
const expandable = computed(() => {
  const k = props.block.kind;
  return k === 'plan_review' || k === 'diff' || k === 'file';
});

// The whole minimized bar is a click target — not just the chevron icon.
function expandFromBar(): void {
  if (minimized.value) minimized.value = false;
}

// ---------------------------------------------------------------------------
// Header: per-kind icon + title. The subject (command / path / url …) lives
// only in the body — the head never repeats it. While minimized the body is
// hidden, so a one-line `peek` summary keeps the bar identifiable.
// ---------------------------------------------------------------------------

const titleKinds = ['shell', 'diff', 'file', 'fileop', 'url', 'search', 'invocation', 'todo', 'plan_review', 'generic'];

function safeKind(): string {
  return titleKinds.includes(props.block.kind) ? props.block.kind : 'generic';
}

function title(): string {
  return t(`approval.title.${safeKind()}`);
}

const peek = computed<string>(() => {
  const b = props.block;
  switch (b.kind) {
    case 'diff':
    case 'file':
    case 'fileop':
      return b.path;
    case 'shell':
      return b.command;
    case 'url':
      return b.url;
    case 'search':
      return b.query;
    case 'invocation':
      return b.name;
    case 'generic':
      return b.summary;
    default:
      return '';
  }
});

// ---------------------------------------------------------------------------
// Inline feedback — a rejection with an explanation. While open it owns the
// footer (submit / cancel), so the decision buttons can't fire behind it.
// ---------------------------------------------------------------------------

const feedbackOpen = ref(false);
const feedbackText = ref('');
const feedbackRef = ref<InstanceType<typeof Textarea> | null>(null);

// Auto-grow: the textarea starts at three rows and grows with its content up
// to 40% of the visible viewport height, then scrolls internally. The growth
// always goes UPWARD — the card lives at the bottom of the bottom-anchored
// chat dock (.chat-dock, inset: auto 0 0), so a taller card raises its top
// edge while its bottom edge (and the feedback footer) stays put; once the
// card hits its height cap the plan scroll area above yields the extra
// height instead.
const FEEDBACK_MAX_VIEWPORT_RATIO = 0.4;

function fitFeedback(): void {
  const ta = feedbackRef.value?.el;
  if (!ta) return;
  ta.style.height = 'auto';
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const max = viewportHeight * FEEDBACK_MAX_VIEWPORT_RATIO;
  ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
  ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
}

watch(feedbackText, () => void nextTick(fitFeedback));

// Re-expanding from the minimized bar remounts the textarea (v-if) at its
// three-row default while the typed text survives, so re-fit once it is back.
watch(minimized, (m) => {
  if (!m) void nextTick(fitFeedback);
});

// Font-scale changes (SettingsDialog / MobileSettingsSheet) rewrite
// --text-base and the line heights, which changes the textarea's
// scrollHeight with no width or viewport signal for the observers below —
// re-fit once the new metrics have applied.
const { fontScale } = useAppearance();
watch(fontScale, () => void nextTick(fitFeedback));

// Re-fit when the visible viewport changes (window resize, iOS keyboard
// opening/closing) — a height fitted against a taller viewport must not
// outlive it. Column drags (App.vue's sidebar / preview ResizeHandle) change
// the card's width without any window/viewport resize event, so also observe
// the card root: rewrapped lines change scrollHeight and the fitted height
// would otherwise go stale (clipped when narrower, slack when wider). The
// width guard keeps the observer from reacting to fitFeedback's own height
// writes.
let feedbackWidthObserver: ResizeObserver | null = null;
let lastCardWidth = 0;
onMounted(() => {
  window.addEventListener('resize', fitFeedback);
  window.visualViewport?.addEventListener('resize', fitFeedback);
  feedbackWidthObserver = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width ?? 0;
    if (w !== lastCardWidth) {
      lastCardWidth = w;
      fitFeedback();
    }
  });
  if (cardRef.value) feedbackWidthObserver.observe(cardRef.value);
});
onUnmounted(() => {
  window.removeEventListener('resize', fitFeedback);
  window.visualViewport?.removeEventListener('resize', fitFeedback);
  feedbackWidthObserver?.disconnect();
});

function openFeedback(): void {
  if (props.busy) return;
  feedbackOpen.value = true;
  feedbackText.value = '';
  // Focus textarea next tick
  setTimeout(() => feedbackRef.value?.el?.focus(), 0);
}

function submitFeedback(): void {
  if (props.busy) return;
  const fb = feedbackText.value.trim();
  // The feedback UI has no number-key equivalent (key 4 only OPENS the box),
  // so a submitted decide always counts as via 'button'.
  if (planReview.value) {
    // Revise: keep plan mode active and pass optional feedback to the agent.
    act('feedback', { decision: 'rejected', selectedLabel: 'Revise', feedback: fb || undefined }, 'button');
  } else {
    act('feedback', { decision: 'rejected', feedback: fb || undefined }, 'button');
  }
  feedbackOpen.value = false;
  feedbackText.value = '';
}

function cancelFeedback(): void {
  if (props.busy) return;
  feedbackOpen.value = false;
  feedbackText.value = '';
}

// IME guard: Enter that only confirms a composition candidate must not submit.
const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();

function onFeedbackKeydown(e: KeyboardEvent): void {
  if (isComposingKeyEvent(e)) return;
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
  action: ApprovalTelemetryAction,
  response: { decision: ApprovalDecision; scope?: 'session'; feedback?: string; selectedLabel?: string },
  via: ApprovalVia,
): void {
  // A second click (or number key) while the first decide is in flight must
  // not fire a duplicate request.
  if (props.busy) return;
  pendingAction.value = action;
  track('approval_decision', {
    decision: approvalDecisionName(action, response.selectedLabel),
    via,
    request_id: props.requestId,
  });
  emit('decide', response);
}

function approve(via: ApprovalVia): void { act('approve', { decision: 'approved' }, via); }
function approveSession(via: ApprovalVia): void { act('approveSession', { decision: 'approved', scope: 'session' }, via); }
function reject(via: ApprovalVia): void { act('reject', { decision: 'rejected' }, via); }

// plan_review actions
function approvePlan(via: ApprovalVia): void { act('approvePlan', { decision: 'approved' }, via); }
function approveOption(label: string, via: ApprovalVia): void {
  act(`option:${label}`, { decision: 'approved', selectedLabel: label }, via);
}
function revisePlan(): void {
  if (props.busy) return;
  openFeedback();
}
function rejectAndExitPlan(via: ApprovalVia): void {
  act('rejectAndExit', { decision: 'rejected', selectedLabel: 'Reject and Exit' }, via);
}

// ---------------------------------------------------------------------------
// Number key shortcuts. Generic cards: 1=approve, 2=session, 3=reject,
// 4=feedback. Plan review cards: 1/2/3 map to the offered approaches (or
// approve / revise / reject-and-exit when no approaches are offered).
// Guard: do not fire when a textarea/input is focused
// ---------------------------------------------------------------------------

function handleKeydown(e: KeyboardEvent): void {
  const tag = (document.activeElement?.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  // Bare-key conveniences only: a modified chord (⌘1, Ctrl+2, …) belongs to
  // the shortcut system or the browser, never to the card.
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // A modal dialog/lightbox owns the keyboard — never fire decision shortcuts
  // through it (mirrors QuestionCard's openDialogCount guard).
  if (openDialogCount.value > 0 || e.defaultPrevented) return;
  // Esc anywhere outside the textarea also cancels the feedback mode.
  if (feedbackOpen.value) {
    if (e.key === 'Escape') { e.preventDefault(); cancelFeedback(); }
    // The decision buttons are swapped out while feedback is open — don't let
    // number keys fire actions the user can't see.
    return;
  }
  // While a decision is in flight, ignore number-key shortcuts so a stray key
  // can't fire a duplicate decide.
  if (props.busy) return;
  // Hidden actions shouldn't fire from number keys while minimized.
  if (minimized.value) return;
  const pr = planReview.value;
  if (pr) {
    if (pr.options.length === 0) {
      if (e.key === '1') { e.preventDefault(); approvePlan('number-key'); }
      else if (e.key === '2') { e.preventDefault(); revisePlan(); }
      else if (e.key === '3') { e.preventDefault(); rejectAndExitPlan('number-key'); }
      return;
    }
    if (e.key === '1' && pr.options[0]) { e.preventDefault(); approveOption(pr.options[0].label, 'number-key'); }
    else if (e.key === '2' && pr.options[1]) { e.preventDefault(); approveOption(pr.options[1].label, 'number-key'); }
    else if (e.key === '3' && pr.options[2]) { e.preventDefault(); approveOption(pr.options[2].label, 'number-key'); }
    return;
  }
  if (e.key === '1') { e.preventDefault(); approve('number-key'); }
  else if (e.key === '2') { e.preventDefault(); approveSession('number-key'); }
  else if (e.key === '3') { e.preventDefault(); reject('number-key'); }
  else if (e.key === '4') { e.preventDefault(); openFeedback(); }
}

onMounted(() => document.addEventListener('keydown', handleKeydown));
onUnmounted(() => document.removeEventListener('keydown', handleKeydown));
// The plan scroll area unmounts with minimize / kind switches — recompute the
// seams after every render so they can't linger on a detached or reset
// element.
onUpdated(updateScrollSeams);
</script>

<template>
  <div ref="cardRef" class="appr" :class="{ minimized, scrolled: cardScrolled }" @scroll="updateScrollSeams">
    <!-- Header: quiet neutral row — per-kind icon + title, optional subagent
         badge, minimize pinned right. No status band; the card itself is the
         "needs a decision" signal. -->
    <div class="ah" :class="{ clickable: minimized }" @click="expandFromBar">
      <span class="akind">{{ title() }}</span>
      <Badge v-if="agentName && !minimized" variant="neutral" size="sm">{{ t('approval.subagentBadge', { name: agentName }) }}</Badge>
      <span v-if="minimized && peek" class="apeek">{{ peek }}</span>
      <IconButton
        v-if="expandable && !minimized"
        class="aexpand"
        size="sm"
        :label="expanded ? t('approval.collapsePlan') : t('approval.expandPlan')"
        :tooltip="expanded ? t('approval.collapsePlan') : t('approval.expandPlan')"
        @click="expanded = !expanded"
      >
        <Icon :name="expanded ? 'collapse' : 'expand'" size="md" />
      </IconButton>
      <IconButton
        class="amin"
        size="sm"
        :label="minimized ? t('question.expand') : t('question.minimize')"
        :tooltip="minimized ? t('question.expand') : t('question.minimize')"
        @click.stop="minimized = !minimized"
      >
        <Icon v-if="minimized" name="chevron-up" size="md" />
        <Icon v-else name="minus" size="md" />
      </IconButton>
    </div>

    <template v-if="!minimized">
      <div class="ab">
        <!-- plan_review: plan file path as a link — opens the file preview in
             the right-side panel (inline content: the plan file lives outside
             the workspace root, so the preview renders the in-memory plan). -->
        <button
          v-if="block.kind === 'plan_review' && block.path"
          type="button"
          class="plan-path"
          :title="block.path"
          @click="props.openFile?.({ path: block.path!, content: block.plan })"
        >{{ block.path }}</button>

        <!-- Body by kind -->

        <!-- diff (Edit approval): mono path + syntax-highlighted line diff
             (hunk-relative rows, no file line-number gutter) -->
        <div v-if="block.kind === 'diff'" class="body-code" :class="{ expanded }">
          <div class="code-path">{{ block.path }}</div>
          <HighlightedCode v-if="block.diff.length > 0" :lines="block.diff" :path="block.path" />
        </div>

        <!-- shell -->
        <div v-else-if="block.kind === 'shell'" class="body-shell">
          <div class="shell-cmd"><span class="shell-dollar">$</span> {{ block.command }}</div>
          <div v-if="block.cwd" class="shell-cwd">cwd: {{ block.cwd }}</div>
          <div v-if="block.danger" class="shell-danger">
            <Icon name="alert-triangle" size="sm" class="shell-danger-ic" />
            <span>{{ t('approval.danger', { detail: block.danger }) }}</span>
          </div>
        </div>

        <!-- file (Write approval): mono path + syntax-highlighted preview of
             the content about to land on disk -->
        <div v-else-if="block.kind === 'file'" class="body-code" :class="{ expanded }">
          <div class="code-path">{{ block.path }}</div>
          <HighlightedCode :code="block.content" :path="block.path" />
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

        <!-- plan_review: plan markdown in a capped scroll area, then the
             offered approaches as numbered option rows PINNED below the
             scroll area (the approve action must never be buried at the end
             of a long plan; if fixed chrome squeezes the card past its cap
             the whole wrap — body + options — scrolls as one instead, and
             below even that budget the card itself scrolls, so the options
             are never clipped out of reach) -->
        <div v-else-if="block.kind === 'plan_review'" ref="planWrapEl" class="body-plan-wrap" :class="{ scrolled: planScrolled }" @scroll="onPlanScroll">
          <div ref="planBodyEl" class="body-plan" :class="{ expanded }" @scroll="onPlanScroll">
            <Markdown :text="block.plan" :open-file="props.openFile" />
          </div>
          <div v-if="planReview && planReview.options.length > 0" class="plan-opts">
            <button
              v-for="(opt, i) in planReview.options"
              :key="i"
              type="button"
              class="popt"
              :disabled="busy"
              @click="approveOption(opt.label, 'button')"
            >
              <span class="popt-key">{{ i + 1 }}</span>
              <span class="popt-text">
                <span class="popt-label">{{ opt.label }}</span>
                <span v-if="opt.description" class="popt-desc">{{ opt.description }}</span>
              </span>
              <Spinner v-if="pendingAction === `option:${opt.label}`" size="sm" class="popt-spin" />
            </button>
          </div>
        </div>

        <!-- generic -->
        <div v-else class="body-generic">
          <span class="gen-text">{{ block.summary }}</span>
        </div>

        <!-- Inline feedback textarea (shared §03 Textarea primitive; the
             keydown / composition listeners fall through to its native
             element) -->
        <div v-if="feedbackOpen" class="feedback-wrap">
          <Textarea
            ref="feedbackRef"
            v-model="feedbackText"
            :placeholder="t('approval.feedbackPlaceholder')"
            :rows="3"
            :resize="false"
            @keydown="onFeedbackKeydown"
            @compositionstart="handleCompositionStart"
            @compositionend="handleCompositionEnd"
          />
          <div class="feedback-hint">{{ t('approval.feedbackHint') }}</div>
        </div>
      </div>

      <!-- Footer: actions left-aligned in number-key order — the solid dark
           primary decision first, quiet text buttons after. -->
      <div class="af">
        <div class="abtns">
          <!-- feedback mode: the decision row is swapped for submit / cancel -->
          <template v-if="feedbackOpen">
            <Button size="md" variant="danger-soft" :loading="pendingAction === 'feedback'" :disabled="busy" @click="submitFeedback">{{ t('approval.feedbackSubmit') }}</Button>
            <Button size="md" variant="ghost" :disabled="busy" @click="cancelFeedback">{{ t('approval.feedbackCancel') }}</Button>
          </template>

          <!-- plan_review actions -->
          <template v-else-if="planReview">
            <Button v-if="planReview.options.length === 0" class="amain" size="md" variant="primary" :loading="pendingAction === 'approvePlan'" :disabled="busy" @click="approvePlan('button')"><span class="knum">1</span>{{ t('approval.approvePlan') }}</Button>
            <Button size="md" variant="ghost" :disabled="busy" @click="revisePlan"><span v-if="planReview.options.length === 0" class="knum">2</span>{{ t('approval.revise') }}</Button>
            <Button size="md" variant="ghost" :loading="pendingAction === 'rejectAndExit'" :disabled="busy" @click="rejectAndExitPlan('button')"><span v-if="planReview.options.length === 0" class="knum">3</span>{{ t('approval.rejectAndExit') }}</Button>
          </template>

          <!-- default actions row -->
          <template v-else>
            <Button class="amain" size="md" variant="primary" :loading="pendingAction === 'approve'" :disabled="busy" @click="approve('button')"><span class="knum">1</span>{{ t('approval.approve') }}</Button>
            <Button size="md" variant="ghost" :loading="pendingAction === 'approveSession'" :disabled="busy" @click="approveSession('button')"><span class="knum">2</span>{{ t('approval.approveSession') }}</Button>
            <Button size="md" variant="ghost" :loading="pendingAction === 'reject'" :disabled="busy" @click="reject('button')"><span class="knum">3</span>{{ t('approval.reject') }}</Button>
            <Button size="md" variant="ghost" :disabled="busy" @click="openFeedback"><span class="knum">4</span>{{ t('approval.feedback') }}</Button>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Floating neutral card: white surface, hairline border, quiet radius and a
   faint popover shadow — it hovers above the transcript in place of the
   composer. The card is a flex column capped just below the chat header, so
   a tall plan + options can never overflow past the pane: only the plan
   scroll area shrinks; header / options / footer keep their natural
   height. The cap follows the VISUAL viewport (--app-height mirrors
   visualViewport.height, see App.vue's setAppHeight) — 100dvh does not
   shrink when the iOS keyboard opens, so a dvh-based cap would let the card
   run under the keyboard and get clipped by .app-shell's overflow: hidden.
   overflow-y: auto is the scroller of last resort: when the squeezed cap
   falls below the FIXED chrome alone (header + mobile's stacked ≥46px
   footer buttons, e.g. an iOS landscape keyboard leaving a ~200px visual
   viewport), the body has already shrunk to zero and the whole card scrolls
   instead of clipping the submit / cancel footer away; the card seam below
   marks that scroll. overflow-x stays hidden so nothing ever pokes out
   sideways, and the border-radius still clips scrolled content. */
.appr {
  display: flex;
  flex-direction: column;
  max-height: calc(var(--app-height, 100dvh) - var(--dock-card-top-clearance));
  margin: var(--space-2) 0;
  background: var(--color-surface-raised);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-menu);
  overflow: hidden auto;
  animation: kimi-card-in var(--duration-base) var(--ease-out);
}
/* Card-level scroll seam — the same scroll-linked language as the plan
   wrap's seam below, for the last-resort case above: once the whole card
   scrolls, a soft shadow fades in at the card's top edge so the header
   reads as passing under the card chrome. Sticky (not absolute) so it pins
   to the visible top edge of the card's own scrollport; the negative margin
   takes it out of the layout flow. */
.appr::before {
  content: '';
  position: sticky;
  top: 0;
  flex: none;
  height: var(--p-scroll-seam-h);
  margin-bottom: calc(-1 * var(--p-scroll-seam-h));
  z-index: var(--z-raised);
  pointer-events: none;
  opacity: 0;
  background:
    linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 2.5%, transparent), transparent 35%),
    linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 1.75%, transparent), transparent 65%),
    linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 1.25%, transparent), transparent);
  transition: opacity var(--duration-slow) var(--ease-out);
}
.appr.scrolled::before { opacity: 1; }
.appr > .ah,
.appr > .af { flex: none; }
/* Minimized bar: subtle hover fill as the click affordance. */
.appr.minimized { transition: background var(--duration-fast) var(--ease-out); }
.appr.minimized:hover { background: var(--color-hover); }

/* Header — one quiet row: plain dark title. */
.ah {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4) 0;
  flex-wrap: nowrap;
}
.appr.minimized .ah { padding-bottom: var(--space-3); }
/* Minimized: the whole bar is the expand target. */
.appr.minimized .ah.clickable { cursor: pointer; }
.akind {
  color: var(--color-text);
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  white-space: nowrap;
  flex: none;
}
/* One-line subject preview, only rendered while minimized — truncated. */
.apeek {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
  font: var(--text-xs) var(--font-mono);
}
.amin {
  margin-left: auto;
  flex: none;
}
.aexpand {
  margin-left: auto;
  flex: none;
}
/* When the plan expand toggle is present it owns the rightward push; the
   minimize button follows it flush instead of splitting the free space. */
.aexpand + .amin {
  margin-left: 0;
}

/* Body */
.ab {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: var(--space-3) var(--space-4) 0;
}
/* Shrink by default — a blacklist, not a per-kind whitelist: every direct
   child of the body column may shrink below its content height and scroll
   internally (min-height: 0 unlocks the shrink; each scrollable body keeps
   its own overflow-y: auto and HighlightedCode owns its own scroll), so the
   auto-growing feedback box can push the card to its height cap without
   clipping the feedback box or the footer away. Only what must keep its
   natural height opts out: the one-line plan-path link. The plan wrap still
   grows to fill the column. The feedback box itself yields last — once the
   fixed chrome (header, options, mobile's stacked footer) plus the box
   exceeds the cap, as when the iOS keyboard shrinks the visual viewport,
   the plan wrap scrolls as a whole (body AND options, see .body-plan-wrap
   below) and the feedback box scrolls internally; below even that budget —
   fixed chrome alone over the cap — the whole card scrolls (see .appr
   above). The approve options and the submit/cancel footer stay reachable
   at every budget. */
.ab > * { flex: 0 1 auto; min-height: 0; }
.ab > .plan-path { flex: none; }
.ab > .body-plan-wrap { flex: 1; }

/* Body first line — plan file path, rendered as a link that opens the file
   preview in the right-side panel. */
.plan-path {
  display: block;
  width: 100%;
  margin-bottom: var(--space-2);
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-accent);
  font: var(--text-xs) var(--font-mono);
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.plan-path:hover { text-decoration: underline; }
.plan-path:focus-visible {
  outline: none;
  text-decoration: underline;
  border-radius: var(--radius-xs);
  box-shadow: var(--p-focus-ring);
}

/* Code previews (Write content / Edit diff): mono path above the highlighted
   block (HighlightedCode owns the frame, its 24-row cap and scroll). The
   expand header toggle lifts the cap so the block fills the whole card. */
.body-code {
  display: flex;
  flex-direction: column;
}
.body-code.expanded { flex: 1; }
.body-code.expanded :deep(.hl-code) {
  max-height: none;
  flex: 1;
}
.code-path {
  flex: none;
  color: var(--color-text-muted);
  font: var(--text-xs) var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Shell */
.body-shell {
  /* May shrink when the feedback box grows — scroll instead of clipping. */
  overflow-y: auto;
}
.shell-cmd {
  font: var(--text-sm) var(--font-mono);
  background: var(--color-surface-sunken);
  border: 0.5px solid var(--color-line);
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
/* Danger callout — a filled row, not a framed box (surface over stroke). */
.shell-danger {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  color: var(--color-danger);
  font: var(--text-sm)/var(--leading-normal) var(--font-ui);
  background: var(--color-danger-soft);
}
.shell-danger-ic { flex: none; }

/* Chip (fileop/url/search/invocation) */
.body-chip {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
  color: var(--color-text);
  /* May shrink when the feedback box grows — scroll instead of clipping. */
  overflow-y: auto;
}
.chip-label {
  background: var(--color-inline-code-bg);
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
.body-todo {
  /* May shrink when the feedback box grows — scroll instead of clipping. */
  overflow-y: auto;
}
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
  /* May shrink when the feedback box grows — scroll instead of clipping. */
  overflow-y: auto;
}

/* Plan review — the scroll area caps at half the viewport height and is the
   only flexible region of the card: it shrinks first when the card hits its
   height cap, and expands to fill the whole card in expanded mode. The wrap
   itself takes over scrolling when squeezed: the option rows are flex:none
   and can never shrink, so once fixed chrome (options, auto-grown feedback
   box) exceeds what the capped card leaves — as when the iOS keyboard
   shrinks the visual viewport — the whole plan region (body AND options)
   scrolls as one and an approve option stays reachable. Below even that
   budget the wrap has shrunk to zero and the CARD scrolls as the last
   resort (see .appr), so nothing is ever clipped out of reach. */
.body-plan-wrap {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
/* Scroll seam — once the plan scrolls, a soft shadow fades in at the scroll
   area's top edge (same scroll-linked language as the sidebar list), so
   clipped content reads as passing under the card chrome. Sticky, not
   absolute: the wrap itself can scroll (see above), and the seam must stay
   pinned to the visible top edge instead of scrolling away with the
   content; the negative margin takes it out of the layout flow. */
.body-plan-wrap::before {
  content: '';
  position: sticky;
  top: 0;
  flex: none;
  height: var(--p-scroll-seam-h);
  margin-bottom: calc(-1 * var(--p-scroll-seam-h));
  z-index: var(--z-raised);
  pointer-events: none;
  opacity: 0;
  background:
    linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 2.5%, transparent), transparent 35%),
    linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 1.75%, transparent), transparent 65%),
    linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 1.25%, transparent), transparent);
  transition: opacity var(--duration-slow) var(--ease-out);
}
.body-plan-wrap.scrolled::before { opacity: 1; }
.body-plan-wrap > .plan-opts { flex: none; }
.body-plan { max-height: 50vh; overflow-y: auto; min-height: 0; }
.body-plan.expanded { max-height: none; flex: 1; }

/* Plan approach options — borderless numbered rows PINNED below the scroll
   area (hairline-separated from the plan); the number chip doubles as the
   number-key hint. */
.plan-opts {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 0.5px solid var(--color-line);
}
.popt {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text);
  font: var(--text-sm)/var(--leading-normal) var(--font-ui);
  text-align: left;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out);
}
.popt:hover:not(:disabled) { background: var(--color-hover); }
.popt:focus-visible {
  outline: none;
  background: var(--color-hover);
  box-shadow: var(--p-focus-ring);
}
.popt:disabled { cursor: default; opacity: 0.6; }
/* Number chip — small filled square, also the keyboard hint. */
.popt-key {
  width: var(--p-chip-num);
  height: var(--p-chip-num);
  border-radius: var(--radius-sm);
  background: var(--color-inline-code-bg);
  color: var(--color-text);
  font: var(--weight-medium) var(--text-xs)/var(--p-chip-num) var(--font-ui);
  text-align: center;
  flex: none;
}
.popt-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.popt-label {
  color: var(--color-text);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
}
/* Description always takes its own second line — fully readable, no
   truncation, no ragged inline wrap. */
.popt-desc {
  color: var(--color-text-muted);
  font: var(--text-xs)/var(--leading-normal) var(--font-ui);
}
.popt-spin { flex: none; color: var(--color-text-muted); }

/* Feedback — the shared Textarea primitive auto-grows from three rows up to
   40% of the visual viewport height (fitFeedback sets an explicit px height
   on the native element and flips overflow-y to auto at the cap), growing
   upward inside the bottom-anchored dock: the card's bottom edge and the
   submit/cancel footer never move. min-height: 0 lets the wrap shrink past
   its content and scroll (see the `.ab >` flex rule above) instead of
   pushing the footer past the card's height cap; and when the cap has
   fallen below the fixed chrome alone, the whole card scrolls (see .appr)
   so the footer stays reachable. */
.feedback-wrap {
  margin-top: var(--space-3);
  overflow-y: auto;
}
.feedback-hint { font: var(--text-xs) var(--font-ui); color: var(--color-text-muted); margin-top: var(--space-1); }

/* Footer — hairline-separated action row: the solid dark primary decision
   first, quiet text buttons after, in number-key order. */
.af {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-top: 0.5px solid var(--color-line);
}
.abtns {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
/* Number chip inside footer buttons — the visible number-key hint. Same
   vocabulary as the option-row number chips. */
.knum {
  min-width: 16px;
  height: 16px;
  padding: 0 3px;
  border-radius: var(--radius-xs);
  background: var(--color-inline-code-bg);
  color: var(--color-text);
  font: var(--weight-medium) var(--text-xs)/16px var(--font-ui);
  text-align: center;
}
/* On the solid primary: frosted chip, legible in both themes. */
.abtns .ui-button--primary .knum {
  background: color-mix(in srgb, var(--color-text-on-accent) 28%, transparent);
  color: var(--color-text-on-accent);
}

/* =========================================================================
   MOBILE (≤640px): the card spans the full chat column, inner previews scroll
   horizontally instead of overflowing the page, and the action buttons become a
   stack of ≥44px tall, easily-tappable targets.
   ========================================================================= */
@media (max-width: 640px) {
  /* Plan options → taller, finger-friendly rows. */
  .popt {
    min-height: 44px;
    padding: var(--space-3);
  }

  /* Footer → buttons become full-width stacked rows with the primary on top. */
  .af { flex-direction: column; align-items: stretch; }
  .abtns { flex-direction: column; margin-left: 0; gap: var(--space-2); }
  .abtns :deep(.ui-button) {
    width: 100%;
    min-height: 46px;
  }
  .abtns .amain { order: -1; }
}
</style>
