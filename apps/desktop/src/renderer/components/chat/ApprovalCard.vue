<script setup lang="ts">
import { computed, inject, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, onUpdated, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ApprovalBlock } from '../../types';
import type { ApprovalDecision } from '../../api/types';
import { useAppearance } from '@moonshot-ai/app-core';
import { Markdown } from '@moonshot-ai/app-markdown';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import { Badge, Button, Icon, IconButton, Spinner, Textarea, openDialogCount, useImeComposition } from '@moonshot-ai/app-ui';
import { browserApprovalPresentation, HighlightedCode, createCwdAssumedResolver } from '@moonshot-ai/app-components';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import { basename, isApplePlatform } from '@moonshot-ai/app-core/lib';
import {
  approvalDecisionName,
  type ApprovalTelemetryAction,
  type ApprovalVia,
} from '../../lib/approvalTelemetry';
import { track } from '@moonshot-ai/app-client/contracts';

const props = defineProps<{
  block: ApprovalBlock;
  agentName?: string;
  requestId?: string;
  busy?: boolean;
}>();

const emit = defineEmits<{
  decide: [response: { decision: ApprovalDecision; scope?: 'session'; feedback?: string; selectedLabel?: string }];
}>();

const panelApi = inject(panelApiKey);

const client = useKimiWebClient();
const assumedFilePathResolver = computed(() => createCwdAssumedResolver(client.status.value.cwd));

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

const minimized = ref(false);
const paneMounted = ref(!minimized.value);
const paneEl = ref<HTMLElement | null>(null);
let paneAnim: Animation | undefined;
let paneTimer: ReturnType<typeof setTimeout> | null = null;

function settlePane(open: boolean): void {
  const el = paneEl.value;
  if (el) el.style.height = open ? '' : '0px';
}

function runPane(open: boolean): void {
  const el = paneEl.value;
  if (!el) return;
  if (typeof el.animate !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    settlePane(open);
    return;
  }
  paneAnim?.cancel();
  const from = el.getBoundingClientRect().height;
  el.style.height = '';
  const to = open ? el.getBoundingClientRect().height : 0;
  el.style.height = `${from}px`;
  paneAnim = el.animate(
    [{ height: `${from}px`, opacity: open ? 0 : 1 }, { height: `${to}px`, opacity: open ? 1 : 0 }],
    { duration: 220, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
  );
  paneAnim.onfinish = () => {
    paneAnim = undefined;
    settlePane(open);
  };
}

watch(minimized, (isMin) => {
  if (paneTimer !== null) {
    clearTimeout(paneTimer);
    paneTimer = null;
  }
  if (!isMin) {
    if (paneMounted.value) {
      void nextTick(() => runPane(true));
      return;
    }
    paneMounted.value = true;
    void nextTick(() => {
      if (paneEl.value) paneEl.value.style.height = '0px';
      runPane(true);
    });
    return;
  }
  runPane(false);
  paneTimer = setTimeout(() => {
    paneTimer = null;
    paneMounted.value = false;
  }, 260);
});

onUnmounted(() => {
  paneAnim?.cancel();
  if (paneTimer !== null) clearTimeout(paneTimer);
});

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

const expanded = ref(false);
const expandable = computed(() => {
  const k = props.block.kind;
  return k === 'plan_review' || k === 'diff' || k === 'file';
});

function expandFromBar(): void {
  if (minimized.value) minimized.value = false;
}

const titleKinds = ['shell', 'diff', 'file', 'fileop', 'url', 'search', 'invocation', 'todo', 'plan_review', 'browser', 'generic'];

function safeKind(): string {
  return titleKinds.includes(props.block.kind) ? props.block.kind : 'generic';
}

const OP_VERBS = ['read', 'grep', 'glob', 'edit', 'write', 'delete'];

function title(): string {
  const b = props.block;
  if (b.kind === 'fileop' && b.path && OP_VERBS.includes(b.op)) {
    return t('approval.allowOp', { verb: t(`approval.opVerb.${b.op}`), name: basename(b.path) });
  }
  return t(`approval.title.${safeKind()}`);
}

const browserApproval = computed(() => props.block.kind === 'browser'
  ? browserApprovalPresentation(props.block.input, t) : null);
const showBrowserDetails = ref(false);

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
    case 'browser':
      return browserApproval.value?.label ?? '';
    case 'generic':
      return b.summary;
    default:
      return '';
  }
});

const feedbackOpen = ref(false);
const feedbackText = ref('');
const feedbackRef = ref<InstanceType<typeof Textarea> | null>(null);

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

watch(minimized, (m) => {
  if (!m) void nextTick(fitFeedback);
});

const { fontScale } = useAppearance();
watch(fontScale, () => void nextTick(fitFeedback));

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
  setTimeout(() => feedbackRef.value?.el?.focus({ preventScroll: true }), 0);
}

function submitFeedback(): void {
  if (props.busy) return;
  const fb = feedbackText.value.trim();
  if (planReview.value) {
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


function handleKeydown(e: KeyboardEvent): void {
  const active = document.activeElement;
  const tag = (active?.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || (active instanceof HTMLElement && active.isContentEditable)) return;
  if (e.altKey || e.shiftKey || e.repeat || isComposingKeyEvent(e)) return;
  if (openDialogCount.value > 0 || e.defaultPrevented) return;
  const plain = !e.metaKey && !e.ctrlKey;
  const modEnter = e.key === 'Enter' && (isApplePlatform() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
  const enter = e.key === 'Enter' && plain && !active?.closest('button, a[href], select, summary, [role="button"]');
  const escape = e.key === 'Escape' && plain;
  const digit = plain ? e.key : '';
  if (feedbackOpen.value) {
    if (escape) { e.preventDefault(); cancelFeedback(); }
    return;
  }
  if (props.busy) return;
  if (minimized.value) return;
  const pr = planReview.value;
  if (pr) {
    if (escape) { e.preventDefault(); rejectAndExitPlan('shortcut-key'); return; }
    if (pr.options.length === 0) {
      if (enter) { e.preventDefault(); approvePlan('shortcut-key'); }
      else if (digit === '1') { e.preventDefault(); approvePlan('number-key'); }
      else if (digit === '2') { e.preventDefault(); revisePlan(); }
      else if (digit === '3') { e.preventDefault(); rejectAndExitPlan('number-key'); }
      return;
    }
    const option = /^[1-9]$/.test(digit) ? pr.options[Number(digit) - 1] : undefined;
    if (option) { e.preventDefault(); approveOption(option.label, 'number-key'); }
    return;
  }
  if (modEnter) { e.preventDefault(); approveSession('shortcut-key'); }
  else if (enter) { e.preventDefault(); approve('shortcut-key'); }
  else if (escape) { e.preventDefault(); reject('shortcut-key'); }
  else if (digit === '1') { e.preventDefault(); approve('number-key'); }
  else if (digit === '2') { e.preventDefault(); approveSession('number-key'); }
  else if (digit === '3') { e.preventDefault(); reject('number-key'); }
  else if (digit === '4') { e.preventDefault(); openFeedback(); }
}

onMounted(() => document.addEventListener('keydown', handleKeydown, true));
onUnmounted(() => document.removeEventListener('keydown', handleKeydown, true));
onDeactivated(() => document.removeEventListener('keydown', handleKeydown, true));
onActivated(() => {
  document.addEventListener('keydown', handleKeydown, true);
  if (!feedbackOpen.value) return;
  void nextTick(() => {
    fitFeedback();
    if (document.activeElement === document.body) feedbackRef.value?.el?.focus({ preventScroll: true });
  });
});
function reviewTitle(review: NonNullable<ApprovalBlock['review']>): string {
  if (review.outcome === 'failed') return t('approval.reviewFailed');
  const risk = review.risk === 'high' ? t('approval.reviewRisk.high') : t('approval.reviewRisk.medium');
  return t('approval.reviewDenied', { risk });
}

onUpdated(updateScrollSeams);
</script>

<template>
  <div ref="cardRef" class="appr" :class="{ minimized, scrolled: cardScrolled }" @scroll="updateScrollSeams">
    <div class="ah" :class="{ clickable: minimized }" @click="expandFromBar">
      <span class="adot" aria-hidden="true" />
      <span class="akind">{{ title() }}</span>
      <Badge v-if="agentName && !minimized" variant="neutral" size="sm">{{ t('approval.subagentBadge', { name: agentName }) }}</Badge>
      <Transition name="apeek">
        <span v-if="minimized && peek" class="apeek">{{ peek }}</span>
      </Transition>
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

    <div v-if="paneMounted" ref="paneEl" class="apane" :inert="minimized">
      <div class="ab">
        <div v-if="block.review" class="review-detail">
          <div class="review-title">{{ reviewTitle(block.review) }}</div>
          <div class="review-body">{{ block.review.reason }}</div>
        </div>

        <button
          v-if="block.kind === 'plan_review' && block.path"
          type="button"
          class="plan-path"
          :title="block.path"
          @click="panelApi?.openFile({ path: block.path!, content: block.plan })"
        >{{ block.path }}</button>

        <div v-if="block.kind === 'diff'" class="body-code" :class="{ expanded }">
          <div class="code-path">{{ block.path }}</div>
          <HighlightedCode v-if="block.diff.length > 0" :lines="block.diff" :path="block.path" />
        </div>

        <div v-else-if="block.kind === 'shell'" class="body-shell">
          <div class="shell-cmd">$ {{ block.command }}</div>
          <div v-if="block.cwd" class="shell-cwd">{{ t('approval.field.cwd', { value: block.cwd }) }}</div>
          <div v-if="block.danger" class="shell-danger">
            <Icon name="alert-triangle" size="sm" class="shell-danger-ic" />
            <span>{{ t('approval.danger', { detail: block.danger }) }}</span>
          </div>
        </div>

        <div v-else-if="block.kind === 'file'" class="body-code" :class="{ expanded }">
          <div class="code-path">{{ block.path }}</div>
          <HighlightedCode :code="block.content" :path="block.path" />
        </div>

        <div v-else-if="block.kind === 'fileop'" class="body-fields">
          <div v-if="block.tool" class="field">{{ t('approval.field.tool', { value: block.tool }) }}</div>
          <div v-if="block.op && !(block.path && OP_VERBS.includes(block.op))" class="field">{{ t('approval.field.op', { value: block.op }) }}</div>
          <div class="field">{{ t('approval.field.base', { value: block.path }) }}</div>
          <div v-if="block.detail" class="field">{{ block.detail }}</div>
        </div>

        <div v-else-if="block.kind === 'url'" class="body-chip">
          <span v-if="block.method" class="chip-label">{{ block.method }}</span>
          <span class="chip-value">{{ block.url }}</span>
        </div>

        <div v-else-if="block.kind === 'search'" class="body-chip">
          <span class="chip-label">{{ t('approval.searchQueryLabel') }}</span>
          <span class="chip-value">{{ block.query }}</span>
          <span v-if="block.scope" class="chip-detail">{{ t('approval.searchScope', { scope: block.scope }) }}</span>
        </div>

        <div v-else-if="block.kind === 'invocation'" class="body-chip">
          <span class="chip-label">{{ block.kind2 }}</span>
          <span class="chip-value">{{ block.name }}</span>
          <span v-if="block.description" class="chip-detail">{{ block.description }}</span>
        </div>

        <div v-else-if="block.kind === 'todo'" class="body-todo">
          <div v-for="(item, i) in block.items" :key="i" class="todo-item">
            <span class="todo-glyph">{{ item.status === 'done' || item.status === 'completed' ? '✓' : '○' }}</span>
            <span class="todo-title" :class="{ 'todo-done': item.status === 'done' || item.status === 'completed' }">{{ item.title }}</span>
          </div>
        </div>

        <div v-else-if="block.kind === 'plan_review'" ref="planWrapEl" class="body-plan-wrap" :class="{ scrolled: planScrolled }" @scroll="onPlanScroll">
          <div ref="planBodyEl" class="body-plan" :class="{ expanded }" @scroll="onPlanScroll">
            <Markdown :text="block.plan" :open-file="panelApi?.openFile" :resolve-file-path="assumedFilePathResolver" />
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

        <div v-else-if="block.kind === 'browser'" class="body-generic browser-approval">
          <div class="browser-approval-action"><Icon name="browser" size="sm" /><span>{{ browserApproval?.label }}</span></div>
          <div v-if="browserApproval?.detail" class="chip-detail">{{ browserApproval.detail }}</div>
          <Button variant="text" size="sm" :aria-expanded="showBrowserDetails" @click="showBrowserDetails = !showBrowserDetails">{{ t('approval.browserDetails') }}</Button>
          <HighlightedCode v-if="showBrowserDetails" :code="JSON.stringify(block.input, null, 2)" path="browser-action.json" wrap />
        </div>

        <div v-else class="body-generic">
          <span class="gen-text">{{ block.summary }}</span>
        </div>

        <Transition name="afb">
          <div v-if="feedbackOpen" class="feedback-wrap">
            <div class="feedback-inner">
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
            </div>
          </div>
        </Transition>
      </div>

      <div class="af">
        <Transition name="abtn" mode="out-in">
          <div v-if="feedbackOpen" key="feedback" class="abtns">
            <Button variant="secondary" :keys="['escape']" :disabled="busy" @click="cancelFeedback">{{ t('approval.feedbackCancel') }}</Button>
            <Button variant="primary" :keys="['enter']" :loading="pendingAction === 'feedback'" :disabled="busy" @click="submitFeedback">{{ t('approval.feedbackSubmit') }}</Button>
          </div>
          <div v-else-if="planReview" key="plan" class="abtns">
            <Button variant="secondary" :disabled="busy" @click="revisePlan">{{ t('approval.revise') }}</Button>
            <Button variant="secondary" :keys="['escape']" :loading="pendingAction === 'rejectAndExit'" :disabled="busy" @click="rejectAndExitPlan('button')">{{ t('approval.rejectAndExit') }}</Button>
            <Button v-if="planReview.options.length === 0" class="amain" variant="primary" :keys="['enter']" :loading="pendingAction === 'approvePlan'" :disabled="busy" @click="approvePlan('button')">{{ t('approval.approvePlan') }}</Button>
          </div>
          <div v-else key="default" class="abtns">
            <Button class="asession" variant="secondary" :keys="['mod', 'enter']" :loading="pendingAction === 'approveSession'" :disabled="busy" @click="approveSession('button')">{{ t('approval.approveSession') }}</Button>
            <Button variant="secondary" :disabled="busy" @click="openFeedback">{{ t('approval.feedback') }}</Button>
            <Button variant="secondary" :keys="['escape']" :loading="pendingAction === 'reject'" :disabled="busy" @click="reject('button')">{{ t('approval.reject') }}</Button>
            <Button class="amain" variant="primary" :keys="['enter']" :loading="pendingAction === 'approve'" :disabled="busy" @click="approve('button')">{{ t('approval.approve') }}</Button>
          </div>
        </Transition>
      </div>
    </div>
  </div>
</template>

<style scoped>
.appr {
  display: flex;
  flex-direction: column;
  max-height: calc(var(--app-height, 100dvh) - var(--dock-card-top-clearance));
  margin: var(--space-2) 0;
  background: var(--color-surface-raised);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-2xl);
  box-shadow: var(--shadow-input);
  overflow: hidden auto;
  animation: kimi-card-in var(--duration-base) var(--ease-out);
  container-type: inline-size;
}
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
.apane > .af { flex: none; }
.apane {
  display: flex;
  flex-direction: column;
  flex: 0 1 auto;
  min-height: 0;
  overflow: hidden;
}
.appr.minimized { transition: background var(--duration-fast) var(--ease-out); }
.appr.minimized:hover { background: var(--color-hover); }

.ah {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: var(--space-4) var(--space-4) 0;
  flex-wrap: nowrap;
  transition: padding-bottom 220ms cubic-bezier(0.2, 0, 0, 1);
}

.adot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 14px;
  height: 14px;
}
.adot::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--color-attention);
}
.appr.minimized .ah { padding-bottom: var(--space-3); }
.appr.minimized .ah.clickable { cursor: pointer; }
.akind {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-lg);
  line-height: var(--leading-normal);
  font-weight: var(--weight-medium);
  white-space: nowrap;
  text-overflow: ellipsis;
}
.apeek {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
  font: var(--content-font-size)/1.571 var(--font-mono);
}
.apeek-enter-active,
.apeek-leave-active {
  transition: opacity var(--duration-base) var(--ease-out);
}
.apeek-enter-from,
.apeek-leave-to {
  opacity: 0;
}
.amin {
  margin-left: auto;
  flex: none;
}
.aexpand {
  margin-left: auto;
  flex: none;
}
.aexpand + .amin {
  margin-left: 0;
}

.ab {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  padding: var(--space-2) var(--space-4) 0;
}
.ab > * { flex: 0 1 auto; min-height: 0; }
.ab > .plan-path { flex: none; }
.ab > .body-plan-wrap { flex: 1; }

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

.body-code {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
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

.body-shell {
  overflow-y: auto;
}
.shell-cmd {
  font: var(--content-font-size)/1.571 var(--font-mono);
  color: var(--color-text-muted);
  background: var(--color-bg);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
  padding: 6px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 160px;
  overflow-y: auto;
}
.shell-cwd {
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
  color: var(--color-text-faint);
  margin-top: var(--space-2);
}
.shell-danger,
.review-detail {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  color: var(--color-danger);
  font: var(--text-sm)/var(--leading-normal) var(--font-ui);
  background: var(--color-danger-soft);
}
.shell-danger {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
}
.shell-danger-ic { flex: none; }
.review-detail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: var(--space-2);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.review-title {
  font-weight: var(--weight-medium);
}

.body-fields {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  color: var(--color-text-faint);
  font: var(--text-base)/20px var(--font-ui);
  overflow-wrap: anywhere;
  overflow-y: auto;
}

.body-chip {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
  color: var(--color-text);
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

.body-todo {
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

.browser-approval { display: flex; flex-direction: column; gap: var(--space-2); }
.browser-approval-action { display: flex; align-items: center; gap: var(--space-2); }
.browser-approval .chip-detail { overflow-wrap: anywhere; white-space: pre-wrap; }
.browser-approval > .ui-button { align-self: flex-start; }
.body-generic {
  font: var(--text-base)/var(--leading-normal) var(--font-ui);
  color: var(--color-text);
  word-break: break-word;
  overflow-y: auto;
}

.body-plan-wrap {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
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

.plan-opts {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: var(--p-hairline) solid var(--color-line);
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
.popt-desc {
  color: var(--color-text-muted);
  font: var(--text-xs)/var(--leading-normal) var(--font-ui);
}
.popt-spin { flex: none; color: var(--color-text-muted); }

.feedback-wrap {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
}
.feedback-inner {
  min-height: 0;
  overflow: hidden;
  padding-top: var(--space-3);
}
.afb-enter-active,
.afb-leave-active {
  transition:
    grid-template-rows var(--duration-slow) var(--ease-out),
    opacity var(--duration-slow) var(--ease-out);
}
.afb-enter-from,
.afb-leave-to {
  grid-template-rows: minmax(0, 0fr);
  opacity: 0;
}
.feedback-wrap :deep(.ui-textarea:focus) {
  border-color: var(--color-line-strong);
  box-shadow: none;
}

.af {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding: 0 var(--space-4) var(--space-4);
}
.abtns {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
  width: 100%;
}
.abtns > :deep(.asession) {
  margin-right: auto;
}
.abtn-enter-active,
.abtn-leave-active {
  transition:
    opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
}
.abtn-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
.abtn-leave-to {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .afb-enter-active,
  .afb-leave-active,
  .abtn-enter-active,
  .abtn-leave-active,
  .apeek-enter-active,
  .apeek-leave-active,
  .ah {
    transition: none;
  }
}
@media (max-width: 640px) {
  .appr {
    margin-inline: max(12px, var(--safe-left)) max(12px, var(--safe-right));
  }
}
@media (pointer: coarse) {
  .popt-key,
  .abtns :deep(.ui-button__cap) {
    display: none;
  }
}
@container (max-width: 640px) {
  .popt {
    min-height: 44px;
    padding: var(--space-3);
  }

  .abtns {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .abtns > :deep(.ui-button) {
    width: 100%;
    min-width: 0;
    min-height: 46px;
    justify-content: center;
    white-space: normal;
  }
  .abtns > :deep(.asession) {
    margin-right: 0;
  }
}

@container (max-width: 480px) {
  .af { flex-direction: column; align-items: stretch; }
  .abtns .amain {
    order: -1;
    grid-column: 1 / -1;
  }
  .abtns > :deep(.asession) {
    grid-column: 1 / -1;
  }
}
</style>
