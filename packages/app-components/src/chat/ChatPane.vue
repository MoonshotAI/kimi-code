<script setup lang="ts">
import { docToText, composerSnapshotDocument, parseComposerSnapshot, type ComposerDocumentSnapshot } from '@moonshot-ai/app-composer/model';
import { browserReferenceAnchor, useComposerBrowserReferenceHost } from '../composer/browserReferences';
import BrowserReferenceDetails from '../composer/BrowserReferenceDetails.vue';
import { useBrowserReferenceDetails } from '../composer/browserReferenceDetails';
import { composerSnapshotFromMetadata, rebindComposerSnapshotMedia } from '@moonshot-ai/app-client/lib';
import { computed, inject, nextTick, onMounted, onUnmounted, provide, reactive, ref, watch, watchSyncEffect, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ChatTurn, ApprovalBlock, OpenMediaRequest, ToolMedia, QueuedPromptView, TurnAttachment, UIQuestion } from '@moonshot-ai/app-core/client/types';
import type { AppSessionRatingResponse } from '@moonshot-ai/app-core/api';
import { collectTurnImages, formatProviderErrorMessage, turnAttachmentToMedia } from '@moonshot-ai/app-core/client';
import ToolCall from './ToolCall.vue';
import { BrowserToolContextKey } from './tool-calls/browserToolContext';
import { browserToolContexts } from './tool-calls/browserToolPresentation';
import { CronToolContextKey, cronToolContexts } from './tool-calls/cronToolContext';
import BlockList from './BlockList.vue';
import TranscriptList from './TranscriptList.vue';
import { settledSteerTurnIdsFor, syncSettledSteerTurnIds } from './steerContinuationState';
import { TranscriptScrollKey } from '@moonshot-ai/app-core/contracts';
import ActivityRun from './ActivityRun.vue';
import TurnFold from './TurnFold.vue';
import RequestDebugRow from './RequestDebugRow.vue';
import TurnFilesSummary from './TurnFilesSummary.vue';
import BrowserSources from './tool-calls/browser/BrowserSources.vue';
import NotificationCard from './NotificationCard.vue';
import { createHistoryImageCache, HistoryImageCacheKey, Markdown, tableSelectionContextText } from '@moonshot-ai/app-markdown';
import { FetchTurnFileChangesKey, LatestNotifyToolCallIdKey, NotifyUserEnabledKey, PinScrollKey, SelectionContextMenuKey, SessionRatingKey } from '@moonshot-ai/app-client/contracts';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import { useTurnFileStats } from './useTurnFileStats';
import { editedFileCount } from '../lib/fileStaleness';
import type { TurnFileChange } from '@moonshot-ai/app-core/client/types';
import ThinkingBlock from './ThinkingBlock.vue';
import SessionRatingRow from './SessionRatingRow.vue';
import ActivityNotice from './ActivityNotice.vue';
import CronNotice from './CronNotice.vue';
import GoalNotice from './GoalNotice.vue';
import MessageTime from './MessageTime.vue';
import MediaLightbox from './MediaLightbox.vue';
import { openFileContextMenu } from './fileContextMenu';
import { createChatFilePathResolver } from './turnFilePathIndex';
import MediaRail from './MediaRail.vue';
import WorkingIndicator from './WorkingIndicator.vue';
import SelectionActionBubble from './SelectionActionBubble.vue';
import TableSelectionContextMenu from './TableSelectionContextMenu.vue';
import { Icon, IconButton, Spinner, Button, Tooltip } from '@moonshot-ai/app-ui';
import { useActivityRunFolding, useConfirmDialog, useIsMobile, useTurnFolding } from '@moonshot-ai/app-client/composables';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import { copyTextToClipboard, formatMessageTime } from '@moonshot-ai/app-core/lib';
import { editRefillAttachments } from '@moonshot-ai/app-client/lib';
import { SELECTION_QUOTE_ENABLED, isContextClick, selectionHitByPointer, selectionOwnedByRoot, selectionQuoteAnchor, type SelectionActionPayload, type SelectionQuoteAnchor } from '@moonshot-ai/app-client/lib';
import { parseAttachmentLinks, serializeMention, stripAttachmentLinks } from '@moonshot-ai/app-composer/model';
import { attachmentIconSvg, attachmentTargetFor, buildMessageCopyFlavor } from '@moonshot-ai/app-composer/features/attachment';
import { canUndoSkillActivation, canUndoSkillActivations, skillActivationEditText, skillActivationsBubbleText, skillActivationsEditText, skillSnapshotWithVariantPaths, skillActivationHasPill, startMentionSelectionSync, truncateMentionName } from '@moonshot-ai/app-composer/features/mention';
import { ComposerText, copyComposerSnapshot, copyTextWithFlavor } from '@moonshot-ai/app-composer/transcript';
import {
  activityRunTailIndex as getActivityRunTailIndex,
  formatTokens,
  canCopyUserTurn,
  estimateUserTurnHeight,
  isoMs,
  flattenAssistantFold,
  latestNotifyToolCallId,
  latestSettledDaemonTurnIds,
  renderBlockKey,
  splitAssistantFold,
  streamingTailIndex as getStreamingTailIndex,
  turnInteractionParked,
  turnActivitySeedMs,
  turnBlocks,
  turnHasOutput,
  turnToMarkdown,
  turnVisibleFinalText,
  userTurnDisplayText,
} from '@moonshot-ai/app-components';
import type { AssistantFold, AssistantRenderBlock } from '@moonshot-ai/app-components';

const { t } = useI18n();
const mediaLabels = computed(() => ({
  image: t('composer.attachmentImage'),
  video: t('composer.attachmentVideo'),
}));
const pastedTextMeta = (lineCount: number): string => t('composer.pastedTextLines', { n: lineCount }, lineCount);

const isMobile = useIsMobile();
const queueSteerLabel = computed(() => t(isMobile.value ? 'composer.queueSteerMobile' : 'composer.queueSteer'));

const client = useKimiWebClient();
const browserReferenceHost = useComposerBrowserReferenceHost();

const { confirm } = useConfirmDialog();

const { turnFolding } = useTurnFolding();
const { activityRunFolding } = useActivityRunFolding();

onUnmounted(() => {
  if (copiedTimer !== null) {
    clearTimeout(copiedTimer);
    copiedTimer = null;
  }
  if (copiedConversationTimer !== null) {
    clearTimeout(copiedConversationTimer);
    copiedConversationTimer = null;
  }
  if (undoFallbackTimer !== null) {
    clearTimeout(undoFallbackTimer);
    undoFallbackTimer = null;
  }
});

const props = withDefaults(
  defineProps<{
    turns: ChatTurn[];
    sessionId?: string | null;
    forkEnabled?: boolean;
    forkPending?: boolean;
    cwd?: string;
    turnFilesInteractive?: boolean;
    approvals?: { approvalId: string; block: ApprovalBlock; agentName?: string; toolCallId?: string }[];
    questions?: UIQuestion[];
    turnActive?: boolean;
    working?: boolean;
    sessionLoading?: boolean;
    compaction?: { status: 'running' } | null;
    hasMoreMessages?: boolean;
    loadingMore?: boolean;
    loadingMoreError?: boolean;
    isFollowing?: boolean;
    readOnly?: boolean;
    undoable?: boolean;
    selectionActions?: boolean;
    inspector?: boolean;
    windowHistory?: boolean;
    renderAllHistory?: boolean;
    historyState?: Map<string, unknown>;
    queued?: QueuedPromptView[];
    interruptedTurnId?: string | null;
    turnFailed?: boolean;
    turnError?: { code?: string; message?: string; statusCode?: number; requestId?: string; endReason?: string } | null;
    turnRetry?: { nextAttempt: number; maxAttempts: number } | null;
  }>(),
  {
    approvals: () => [],
    questions: () => [],
    turnFilesInteractive: true,
    turnActive: false,
    working: false,
    compaction: null,
    hasMoreMessages: false,
    loadingMore: false,
    loadingMoreError: false,
    isFollowing: false,
    readOnly: false,
    undoable: true,
    selectionActions: true,
    forkEnabled: false,
    forkPending: false,
    inspector: false,
    windowHistory: false,
    renderAllHistory: false,
    queued: () => [],
    interruptedTurnId: null,
    turnFailed: false,
    turnError: null,
    turnRetry: null,
  },
);

defineSlots<{
  'assistant-reply-actions'?: (props: { turn: ChatTurn | undefined }) => unknown;
  'assistant-reply-status'?: (props: { turn: ChatTurn | undefined }) => unknown;
}>();

const topSentinelRef = ref<HTMLElement | null>(null);
let topSentinelObserver: IntersectionObserver | null = null;

function historyScrollRoot(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

function observeTopSentinel(): void {
  if (!topSentinelRef.value || typeof IntersectionObserver === 'undefined') return;
  topSentinelObserver?.disconnect();
  const root = historyScrollRoot(topSentinelRef.value);
  topSentinelObserver = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      if (
        entry?.isIntersecting &&
        props.hasMoreMessages &&
        !props.loadingMore &&
        !props.loadingMoreError &&
        !props.sessionLoading &&
        !props.isFollowing
      ) {
        emit('loadOlderMessages');
      }
    },
    { root, rootMargin: `${root?.clientHeight ?? 0}px 0px 0px 0px`, threshold: 0 },
  );
  topSentinelObserver.observe(topSentinelRef.value);
}

onMounted(observeTopSentinel);
onUnmounted(() => {
  topSentinelObserver?.disconnect();
  topSentinelObserver = null;
});

const chatRootRef = ref<HTMLElement | null>(null);
let stopMentionSelectionSync: (() => void) | null = null;
onMounted(() => {
  stopMentionSelectionSync = startMentionSelectionSync(() => chatRootRef.value);
});
onUnmounted(() => {
  stopMentionSelectionSync?.();
  stopMentionSelectionSync = null;
});
watch(
  () => [props.hasMoreMessages, props.loadingMore, props.loadingMoreError],
  () => {
    void nextTick().then(observeTopSentinel);
  },
);

const streamingTurnId = computed<string | null>(() => {
  if (!props.turnActive || props.turns.length === 0) return null;
  const last = props.turns.at(-1)!;
  return last.role === 'assistant' ? last.id : null;
});

const assistantTurnGroups = computed(() => {
  const groups = new Map<string, ChatTurn[]>();
  for (const turn of props.turns) {
    if (turn.role !== 'assistant') continue;
    const key = turn.daemonTurnId !== undefined ? `d${turn.daemonTurnId}` : turn.id;
    const group = groups.get(key);
    if (group) group.push(turn);
    else groups.set(key, [turn]);
  }
  return groups;
});

const lastAssistantGroup = computed<ChatTurn[] | undefined>(() => {
  let last: ChatTurn[] | undefined;
  for (const group of assistantTurnGroups.value.values()) last = group;
  return last;
});

function groupSettled(group: readonly ChatTurn[]): boolean {
  const state = group[group.length - 1]?.daemonTurnState;
  if (state !== undefined) {
    return state === 'completed' || state === 'failed' || state === 'cancelled';
  }
  if (group.some((turn) => turn.id === streamingTurnId.value)) return false;
  if (!props.working) return true;
  return lastAssistantGroup.value !== group;
}

function forkEntryAvailable(turn: ChatTurn): boolean {
  if (!props.forkEnabled || props.readOnly || props.inspector || turn.daemonTurnId === undefined || turn.forkTurnIndex === undefined) return false;
  const group = assistantTurnGroups.value.get(`d${turn.daemonTurnId}`);
  return group?.at(-1)?.id === turn.id && groupSettled(group);
}

function forkAssistantRun(turn: ChatTurn): void {
  if (props.forkPending || !forkEntryAvailable(turn) || turn.forkTurnIndex === undefined) return;
  emit('forkTurn', { turnIndex: turn.forkTurnIndex });
}

const liveTurnKeys = new Set<string>();
function liveTurnKey(turnId: number): string {
  return `${props.sessionId ?? ''}:${turnId}`;
}
watchSyncEffect(() => {
  for (const group of assistantTurnGroups.value.values()) {
    const turnId = group[0]!.daemonTurnId;
    if (turnId !== undefined && !groupSettled(group)) liveTurnKeys.add(liveTurnKey(turnId));
  }
});

const turnFileChangesById = computed(() => {
  const map = new Map<string, { changes: TurnFileChange[]; daemonTurnId: number; expected?: number }>();
  if (props.inspector) return map;
  for (const group of assistantTurnGroups.value.values()) {
    const turnId = group[0]!.daemonTurnId;
    if (turnId === undefined || !groupSettled(group)) continue;
    const fetched = fetchedFileStats.value.get(turnId);
    if (fetched === 'pending') {
      if (!liveTurnKeys.has(liveTurnKey(turnId))) continue;
      const expected = editedFileCount(group, props.cwd);
      if (expected > 0) map.set(group[group.length - 1]!.id, { changes: [], daemonTurnId: turnId, expected });
      continue;
    }
    if (!Array.isArray(fetched) || fetched.length === 0) continue;
    map.set(group[group.length - 1]!.id, {
      changes: fetched.map((change) => ({
        path: change.path,
        added: change.additions,
        removed: change.deletions,
        binary: change.binary,
        oversize: change.oversize,
        status: change.status,
      })),
      daemonTurnId: turnId,
    });
  }
  return map;
});

const fetchTurnFileChanges = inject(FetchTurnFileChangesKey, undefined);
const sessionRating = inject(SessionRatingKey, undefined);
const ratingTurnId = computed(() => {
  const last = props.turns.at(-1);
  return last?.role === 'assistant' ? last.id : undefined;
});
const ratingView = computed(() => {
  if (sessionRating === undefined || !props.sessionId || props.inspector) return undefined;
  const view = sessionRating.view(props.sessionId);
  return view.phase === 'closed' ? undefined : view;
});

function ratingShown(appearanceId: string): void {
  if (!props.sessionId) return;
  sessionRating?.shown(props.sessionId, appearanceId);
}

function selectRating(response: AppSessionRatingResponse): void {
  if (!sessionRating || !props.sessionId || ratingView.value === undefined) return;
  sessionRating.select(props.sessionId, ratingView.value.appearanceId, response);
}

function undoRating(): void {
  if (!sessionRating || !props.sessionId || ratingView.value === undefined) return;
  sessionRating.undo(props.sessionId, ratingView.value.appearanceId);
}

const ratingStandalone = computed(() => {
  if (ratingView.value === undefined) return false;
  if (ratingTurnId.value === undefined) return true;
  const index = props.turns.length - 1;
  const turn = props.turns[index]!;
  if (turn.id === streamingTurnId.value || forkEntryAvailable(turn)) return false;
  return !assistantRunHasOutput(index) || (assistantRunFinalText(index).trim().length === 0 && turnTimeLabel(turn) === '');
});
const TURN_FILE_STATS_LIMIT = 3;
const fetchedFileStats = useTurnFileStats(
  () => latestSettledDaemonTurnIds([...assistantTurnGroups.value.values()], groupSettled, TURN_FILE_STATS_LIMIT),
  () => !props.inspector,
  fetchTurnFileChanges,
);

const showWorking = computed(() => props.working);

const sessionLoadingVisible = ref(false);
let sessionLoadingTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => props.sessionLoading,
  (loading) => {
    if (sessionLoadingTimer) {
      clearTimeout(sessionLoadingTimer);
      sessionLoadingTimer = null;
    }
    if (loading) {
      sessionLoadingTimer = setTimeout(() => {
        sessionLoadingTimer = null;
        sessionLoadingVisible.value = true;
      }, 250);
    } else {
      sessionLoadingVisible.value = false;
    }
  },
  { immediate: true },
);
onUnmounted(() => {
  if (sessionLoadingTimer) clearTimeout(sessionLoadingTimer);
});
const isCompacting = computed(() => props.compaction?.status === 'running');
const showMascot = computed(() => showWorking.value || isCompacting.value || props.turns.length > 0);

const localSettledSteerTurnIds = reactive(new Set<string>());

function hasFollowingAssistantOutput(index: number): boolean {
  return index >= 0 && props.turns
    .slice(index + 1)
    .some((turn) => turn.role === 'assistant' && turnHasOutput(turn));
}

function isSteerSettled(turnId: string): boolean {
  return settledSteerTurnIdsFor(props.sessionId, localSettledSteerTurnIds).has(turnId);
}

watch(
  () => [props.sessionId, props.turns, props.sessionLoading] as const,
  ([sessionId, turns, sessionLoading]) => {
    syncSettledSteerTurnIds(sessionId, localSettledSteerTurnIds, turns, sessionLoading);
  },
  { immediate: true, flush: 'sync' },
);

const latestSteer = computed(() => {
  for (let i = props.turns.length - 1; i >= 0; i--) {
    const turn = props.turns[i]!;
    if (turn.role !== 'user' || turn.steered !== true || turn.steerPhase === undefined) continue;
    for (let j = i + 1; j < props.turns.length; j++) {
      const after = props.turns[j]!;
      if (after.role === 'user' && after.steered !== true) return undefined;
    }
    return { turn, index: i, phase: turn.steerPhase };
  }
  return undefined;
});

function steerContinuationStarted(index: number): boolean {
  if (index < 0) return false;
  const turn = props.turns[index];
  if (turn !== undefined && isSteerSettled(turn.id)) return true;
  return hasFollowingAssistantOutput(index);
}

function steerReceiptPhase(turn: ChatTurn): 'sending' | 'accepted' | 'injected' | undefined {
  if (turn.role !== 'user' || turn.steered !== true) return undefined;
  if (turn.steerPhase !== 'injected') return turn.steerPhase;
  if (isSteerSettled(turn.id)) return undefined;
  return steerContinuationStarted(props.turns.indexOf(turn)) ? undefined : 'injected';
}

function steerReceiptText(turn: ChatTurn): string {
  const phase = steerReceiptPhase(turn);
  if (phase === undefined) return '';
  return t(phase === 'injected' ? 'conversation.steerRead' : 'conversation.steerUnread');
}

function steerReceiptTooltip(turn: ChatTurn): string {
  const phase = steerReceiptPhase(turn);
  return t(phase === 'injected' ? 'conversation.steerInjectedTooltip' : 'conversation.steerWaitingTooltip');
}

const workingLabel = computed(() => {
  const retry = props.turnRetry;
  if (retry !== null && retry !== undefined) {
    return t('conversation.workingRetry', { n: retry.nextAttempt, max: retry.maxAttempts });
  }
  const steer = latestSteer.value;
  if (steer !== undefined) {
    if (steer.phase === 'sending') return t('conversation.steerSending');
    if (steer.phase === 'accepted') return t('conversation.steerWaiting');
    if (!steerContinuationStarted(steer.index)) return t('conversation.steerInjected');
  }
  const last = props.turns.at(-1);
  const hasOutput =
    last?.role === 'assistant' &&
    (last.text.trim().length > 0 ||
      (last.thinking?.trim().length ?? 0) > 0 ||
      (last.tools?.length ?? 0) > 0);
  return t(hasOutput ? 'conversation.working' : 'conversation.requesting');
});

const turnFailedTitle = computed(() =>
  props.turnError?.endReason === 'max_steps'
    ? t('conversation.turnFailedMaxSteps')
    : t('conversation.turnFailed'),
);

const turnErrorMeta = computed(() => {
  const error = props.turnError;
  if (!error) return '';
  const parts: string[] = [];
  if (error.code !== undefined && error.code.length > 0) parts.push(error.code);
  if (error.statusCode !== undefined) parts.push(`HTTP ${error.statusCode}`);
  if (error.requestId !== undefined && error.requestId.length > 0) parts.push(error.requestId);
  return parts.join(' · ');
});

const turnErrorDisplayMessage = computed(() => {
  const message = props.turnError?.message;
  return message === undefined ? '' : formatProviderErrorMessage(message);
});

provide(BrowserToolContextKey, computed(() => browserToolContexts(props.turns)));
provide(CronToolContextKey, computed(() => cronToolContexts(props.turns)));
provide(LatestNotifyToolCallIdKey, computed(() => latestNotifyToolCallId(props.turns)));
const notifyUserEnabled = computed(() => client.experimentalFlags.value['notify_user'] === true);
provide(NotifyUserEnabledKey, notifyUserEnabled);

const emit = defineEmits<{
  openMedia: [payload: OpenMediaRequest];
  copyConversationCopied: [];
  editMessage: [payload: { text: string; attachments?: TurnAttachment[]; snapshot?: ComposerDocumentSnapshot; turnId: string }];
  loadOlderMessages: [options?: { manual?: boolean }];
  editQueued: [index: number];
  reorderQueue: [payload: { from: number; to: number }];
  steerQueued: [index: number];
  resumeTurn: [];
  forkTurn: [payload: { turnIndex: number }];
  quoteAction: [payload: SelectionActionPayload];
}>();

const panelApi = inject(panelApiKey);

const onOpenMedia = (payload: OpenMediaRequest) =>
  emit('openMedia', { ...payload, images: payload.images ?? collectTurnImages(props.turns) });
const onDetach = (toolCallId: string) => void client.detachTask(toolCallId);

const selectionContextMenu = inject(SelectionContextMenuKey, undefined);
const tableSelectionMenuRef = ref<InstanceType<typeof TableSelectionContextMenu> | null>(null);
const selectionBubble = ref<SelectionQuoteAnchor | null>(null);
const selectionKeyboard = ref(false);
const selectionActionsOn = computed(() => props.selectionActions && SELECTION_QUOTE_ENABLED);
let selectionPointerDown = false;
let selectionDismissed = false;

function refreshSelectionBubble(pointer?: { x: number; y: number }): void {
  if (!SELECTION_QUOTE_ENABLED) return;
  setTimeout(() => {
    const anchor = selectionDismissed ? null : selectionQuoteAnchor(window.getSelection());
    if (anchor !== null) {
      const prev = selectionBubble.value;
      const carry =
        prev !== null && prev.quote === anchor.quote && prev.x === anchor.x && prev.y === anchor.y && prev.bottom === anchor.bottom ? prev : null;
      const px = pointer?.x ?? carry?.px;
      const py = pointer?.y ?? carry?.py;
      if (px !== undefined && py !== undefined) {
        anchor.px = px;
        anchor.py = py;
      }
    }
    selectionBubble.value = anchor;
  }, 0);
}

function onChatMouseup(e: MouseEvent): void {
  if (selectionContextMenu !== undefined && isContextClick(e)) return;
  selectionKeyboard.value = false;
  refreshSelectionBubble(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : undefined);
}

function onChatPointerdown(): void {
  selectionPointerDown = true;
  selectionKeyboard.value = false;
}

function onChatContextMenu(event: MouseEvent): void {
  openFileContextMenu(event, props.cwd);
  if (event.defaultPrevented) {
    if (selectionBubble.value !== null) onSelectionBubbleClose();
    return;
  }
  const target = event.target;
  if (target instanceof HTMLElement && target.isContentEditable) return;
  const tableSelection = tableSelectionContextText(target);
  if (tableSelection !== null && target instanceof Element) {
    const wrapper = target.closest<HTMLElement>('.table-node-wrapper');
    if (wrapper) {
      event.preventDefault();
      selectionPointerDown = false;
      if (selectionBubble.value !== null) onSelectionBubbleClose();
      void tableSelectionMenuRef.value?.show(wrapper, event.clientX, event.clientY);
      return;
    }
  }
  if (selectionContextMenu === undefined) return;
  const selection = window.getSelection();
  if (!selectionOwnedByRoot(selection, chatRootRef.value, event) || !selectionHitByPointer(selection, event)) return;
  event.preventDefault();
  selectionPointerDown = false;
  refreshSelectionBubble(selectionBubble.value === null ? { x: event.clientX, y: event.clientY } : undefined);
  selectionContextMenu(selection!.toString());
}

function onDocPointerUp(e: PointerEvent): void {
  if (!selectionPointerDown) return;
  selectionPointerDown = false;
  if (e.button !== 0) return;
  refreshSelectionBubble();
}

function onChatKeyup(e: KeyboardEvent): void {
  if (e.key === 'Escape') return;
  selectionKeyboard.value = true;
  refreshSelectionBubble();
}

const SELECTION_CHANGE_DEBOUNCE_MS = 250;
let selectionChangeTimer: ReturnType<typeof setTimeout> | null = null;

function onDocSelectionChange(): void {
  selectionDismissed = false;
  if (selectionChangeTimer !== null) clearTimeout(selectionChangeTimer);
  selectionChangeTimer = setTimeout(() => {
    selectionChangeTimer = null;
    const active = document.activeElement;
    if (active instanceof Element && active.closest('.sab')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && !selectionOwnedByRoot(sel, chatRootRef.value)) {
      selectionBubble.value = null;
      return;
    }
    if (selectionPointerDown) return;
    refreshSelectionBubble();
  }, SELECTION_CHANGE_DEBOUNCE_MS);
}

onMounted(() => {
  if (selectionActionsOn.value) {
    document.addEventListener('selectionchange', onDocSelectionChange);
    document.addEventListener('pointerup', onDocPointerUp);
    document.addEventListener('pointercancel', onDocPointerUp);
  }
});
onUnmounted(() => {
  document.removeEventListener('selectionchange', onDocSelectionChange);
  document.removeEventListener('pointerup', onDocPointerUp);
  document.removeEventListener('pointercancel', onDocPointerUp);
  if (selectionChangeTimer !== null) {
    clearTimeout(selectionChangeTimer);
    selectionChangeTimer = null;
  }
});

function onSelectionBubbleClose(): void {
  selectionBubble.value = null;
  selectionDismissed = true;
  if (selectionChangeTimer !== null) {
    clearTimeout(selectionChangeTimer);
    selectionChangeTimer = null;
  }
}

function onSelectionAction(payload: SelectionActionPayload): void {
  selectionBubble.value = null;
  window.getSelection()?.removeAllRanges();
  emit('quoteAction', payload);
}

function onTableSelectionQuote(markdown: string): void {
  onSelectionAction({ action: 'quote', quote: markdown });
}

const dragFrom = ref<number | null>(null);
const dragOver = ref<{ index: number; position: 'before' | 'after' } | null>(null);

const browserDetails = useBrowserReferenceDetails(() => JSON.stringify([client.activeSessionId.value, props.cwd, props.turns[0]?.sessionId]));
const turnSnapshotCache = new WeakMap<ChatTurn, ComposerDocumentSnapshot | null>();
const queueSnapshotCache = new WeakMap<QueuedPromptView, ComposerDocumentSnapshot | null>();

function turnSnapshot(turn: ChatTurn): ComposerDocumentSnapshot | undefined {
  if (!turnSnapshotCache.has(turn)) {
    const snapshot = composerSnapshotFromMetadata(turn.clientMetadata);
    if (snapshot === null) {
      turnSnapshotCache.set(turn, null);
    } else {
      const acts = turn.skillActivation === undefined ? (turn.skillActivations ?? []) : [turn.skillActivation];
      const rebound = rebindComposerSnapshotMedia(snapshot, editRefillAttachments(turn));
      turnSnapshotCache.set(turn, skillSnapshotWithVariantPaths(acts, rebound, { defaultPath: defaultSkillPath }));
    }
  }
  return turnSnapshotCache.get(turn) ?? undefined;
}

function queueSnapshot(item: QueuedPromptView): ComposerDocumentSnapshot | undefined {
  if (!queueSnapshotCache.has(item)) queueSnapshotCache.set(item, parseComposerSnapshot(item.snapshot));
  return queueSnapshotCache.get(item) ?? undefined;
}

const filePathResolverCache = new WeakMap<ChatTurn, { key: string; fn: ReturnType<typeof createChatFilePathResolver>; imageFn: (src: string) => Promise<string> }>();

function turnResolvers(turn: ChatTurn) {
  const cwd = props.cwd ?? '';
  const key = `${cwd}:${turn.blocks?.length ?? 0}:${turn.tools?.length ?? 0}`;
  const hit = filePathResolverCache.get(turn);
  if (hit && hit.key === key) return hit;
  const fn = createChatFilePathResolver(turn, cwd);
  const imageFn = (src: string): Promise<string> => {
    const resolved = fn(src);
    return resolved !== null && !resolved.assumed ? client.resolveImageUrl(resolved.path) : client.resolveImageUrl(src);
  };
  const entry = { key, fn, imageFn };
  filePathResolverCache.set(turn, entry);
  return entry;
}

function turnFilePathResolver(turn: ChatTurn): ReturnType<typeof createChatFilePathResolver> {
  return turnResolvers(turn).fn;
}

function turnImageResolver(turn: ChatTurn): (src: string) => Promise<string> {
  return turnResolvers(turn).imageFn;
}

function ordinaryMedia(attachments: readonly TurnAttachment[], snapshot?: ComposerDocumentSnapshot): MediaTurnAttachment[] {
  const hidden = new Set(snapshot?.attachments.filter((entry) => entry.purpose === 'browser-screenshot').map((entry) => `${entry.sessionId ?? ''}:${entry.fileId}`));
  const result = attachments.filter(isMediaAttachment).filter((entry) => !hidden.has(`${entry.sessionId ?? ''}:${entry.fileId}`));
  return hidden.size === 0 ? result : result.map((entry, index) => ({ ...entry, mediaOrdinal: index + 1 }));
}

async function openTurnBrowserReference(turn: ChatTurn, id: string, anchor?: HTMLElement): Promise<void> {
  const snapshot = turnSnapshot(turn);
  const reference = snapshot?.browserReferences?.find((entry) => entry.id === id);
  const capture = snapshot?.browserCaptures?.find((entry) => entry.id === reference?.captureId);
  if (reference === undefined || capture === undefined) { client.notify({ severity: 'warning', title: t('browserReference.missing') }); return; }
  const thumbnail = snapshot?.attachments.find((entry) => entry.attId === capture.screenshot?.attachmentId)?.thumbnailUrl;
  if (browserReferenceHost === null) {
    await browserDetails.open({ reference, capture, thumbnail, readOnly: true });
    return;
  }
  const response = await browserReferenceHost.edit(reference, capture, thumbnail, true, undefined, browserReferenceAnchor(anchor));
  if (response?.locate && !(await browserReferenceHost.locate(capture))) client.notify({ severity: 'warning', title: t('browserReference.stale') });
}

function queueMediaAttachments(item: QueuedPromptView): TurnAttachment[] {
  return ordinaryMedia(item.attachments ?? [], queueSnapshot(item));
}

function queueFileAttachments(item: QueuedPromptView): TurnAttachment[] {
  return queueStripAttachments(item).filter((attachment) => attachment.kind === 'file');
}

function stripInlineAttachments(text: string, atts: TurnAttachment[]): TurnAttachment[] {
  const links = parseAttachmentLinks(text);
  if (links.length === 0) return atts;
  const hiddenFiles = new Set<number>();
  for (const link of links) {
    if (attachmentTargetFor(link.attrs.attId, atts) === undefined) continue;
    if (/^[1-9]\d*$/.test(link.attrs.attId)) hiddenFiles.add(Number(link.attrs.attId));
  }
  if (hiddenFiles.size === 0) return atts;
  let filePosition = 0;
  return atts.filter((att) => {
    if (att.kind === 'file') {
      filePosition += 1;
      return !hiddenFiles.has(filePosition);
    }
    return true;
  });
}

function queueStripAttachments(item: QueuedPromptView): TurnAttachment[] {
  return stripInlineAttachments(item.text, item.attachments ?? []);
}

function stripSnapshotAttachments(snapshot: ComposerDocumentSnapshot, atts: TurnAttachment[]): TurnAttachment[] {
  const hidden = new Set<TurnAttachment>();
  composerSnapshotDocument(snapshot).descendants((node) => {
    if (node.type.name !== 'attachment') return;
    const target = attachmentTargetFor(node.attrs.attId as string, atts, snapshot.attachments);
    if (target !== undefined) hidden.add(target);
  });
  return atts.filter((att) => !hidden.has(att));
}

function onQueueEdit(index: number): void {
  emit('editQueued', index);
}

function onQueueBodyTap(index: number): void {
  if (typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches) return;
  onQueueEdit(index);
}

function onQueueDragStart(index: number, event: DragEvent): void {
  dragFrom.value = index;
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(index));
  const row = (event.currentTarget as HTMLElement | null)?.closest<HTMLElement>('.q-turn');
  if (row) event.dataTransfer.setDragImage(row, 24, 24);
}

function onQueueDragOver(index: number, event: DragEvent): void {
  if (dragFrom.value === null) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  dragOver.value = { index, position };
}

function onQueueDrop(index: number, event: DragEvent): void {
  event.preventDefault();
  const from = dragFrom.value;
  const position = dragOver.value?.position ?? 'before';
  dragFrom.value = null;
  dragOver.value = null;
  if (from === null) return;
  let to = position === 'before' ? index : index + 1;
  if (from < to) to -= 1;
  if (from === to) return;
  emit('reorderQueue', { from, to });
}

function onQueueDragEnd(): void {
  dragFrom.value = null;
  dragOver.value = null;
}

const undoableTurnIds = computed(() => {
  const afterCompaction = props.turns.slice(props.turns.findLastIndex((turn) => turn.role === 'compaction') + 1);
  return new Set(afterCompaction.flatMap((turn) => (turn.undoTurnId === undefined ? [] : [turn.id])));
});

function defaultSkillPath(name: string): string | undefined {
  return client.skills.value.find((skill) => skill.name.toLowerCase() === name.toLowerCase())?.path;
}

function canEditTurn(turn: ChatTurn): boolean {
  return (
    !props.readOnly &&
    props.undoable &&
    turn.role === 'user' &&
    undoableTurnIds.value.has(turn.id) &&
    turn.steered !== true &&
    !props.working &&
    !turn.pluginCommand &&
    !(turn.skillActivation && !canUndoSkillActivation(turn.skillActivation, {
      revivePill: true,
      defaultPath: defaultSkillPath(turn.skillActivation.name),
    })) &&
    !(
      turn.skillActivations &&
      !canUndoSkillActivations(turn.skillActivations, turn.text, { revivePill: true, defaultPath: defaultSkillPath })
    )
  );
}

function canOpenCompactionSummary(turn: ChatTurn): boolean {
  return Boolean(turn.text && panelApi?.openCompaction !== undefined);
}

function isCompactionSummaryOpen(turn: ChatTurn): boolean {
  return canOpenCompactionSummary(turn) && panelApi?.isCompactionOpen?.(turn.id) === true;
}

function compactionBaseLabel(turn: ChatTurn): string {
  return turn.compaction?.trigger === 'auto'
    ? t('conversation.compactedAuto')
    : t('conversation.compactedPlain');
}

function compactionTokenDelta(turn: ChatTurn): string {
  const c = turn.compaction;
  if (typeof c?.tokensBefore !== 'number' || typeof c?.tokensAfter !== 'number') return '';
  return t('conversation.compactedTokens', {
    before: formatTokens(c.tokensBefore),
    after: formatTokens(c.tokensAfter),
  });
}

function compactionSavedLabel(turn: ChatTurn): string {
  const c = turn.compaction;
  if (typeof c?.tokensBefore !== 'number' || typeof c?.tokensAfter !== 'number') return '';
  const saved = c.tokensBefore - c.tokensAfter;
  if (saved <= 0) return '';
  return `-${formatTokens(saved)}`;
}

const copiedTurn = ref<string | null>(null);

function turnTimeLabel(turn: ChatTurn): string {
  const startMs = turn.createdAt === undefined ? NaN : Date.parse(turn.createdAt);
  const stamp =
    turn.endedAt ??
    (Number.isFinite(startMs) && turn.durationMs !== undefined
      ? new Date(startMs + turn.durationMs).toISOString()
      : turn.createdAt);
  return stamp === undefined ? '' : formatMessageTime(stamp, t('conversation.yesterday'));
}

const undoingTurnId = ref<string | null>(null);
let undoFallbackTimer: ReturnType<typeof setTimeout> | null = null;
const UNDO_FALLBACK_MS = 2500;

async function onUndo(turn: ChatTurn): Promise<void> {
  if (
    await confirm({
      title: t('conversation.undo'),
      message: t('conversation.undoConfirm'),
      variant: 'primary',
    })
  ) {
    confirmEditMessage(turn);
  }
}

function confirmEditMessage(turn: ChatTurn): void {
  if (undoingTurnId.value !== null) return;
  const turnId = turn.undoTurnId;
  if (turnId === undefined) return;
  undoingTurnId.value = turn.id;
  const text = turn.skillActivation
    ? (skillActivationEditText(turn.skillActivation, {
        revivePill: true,
        defaultPath: defaultSkillPath(turn.skillActivation.name),
      }) ?? turn.text)
    : turn.skillActivations
      ? (skillActivationsEditText(turn.skillActivations, turn.text, { revivePill: true, defaultPath: defaultSkillPath }) ??
        turn.text)
      : turn.text;
  const attachments = editRefillAttachments(turn);
  emit('editMessage', {
    text,
    attachments,
    snapshot: turnSnapshot(turn),
    turnId,
  });
  undoFallbackTimer = setTimeout(() => {
    undoFallbackTimer = null;
    undoingTurnId.value = null;
  }, UNDO_FALLBACK_MS);
}

watch(
  () => props.turns,
  (turns) => {
    if (undoingTurnId.value === null) return;
    if (turns.some((t) => t.id === undoingTurnId.value)) return;
    undoingTurnId.value = null;
    if (undoFallbackTimer !== null) {
      clearTimeout(undoFallbackTimer);
      undoFallbackTimer = null;
    }
  },
  { flush: 'post' },
);

const copiedConversation = ref(false);
let copiedConversationTimer: ReturnType<typeof setTimeout> | null = null;

function copyConversation(onCopied?: (ok: boolean) => void): void {
  if (props.turns.length === 0) {
    onCopied?.(false);
    return;
  }
  const lines: string[] = [];
  for (const turn of props.turns) {
    if (turn.role === 'compaction' || turn.role === 'cron' || turn.role === 'goal') continue;
    const roleLabel = turn.role === 'user' ? 'User' : 'Assistant';
    const content = turnToMarkdown(turn);
    if (content.trim()) {
      lines.push(`**${roleLabel}**\n\n${content}`);
    }
  }
  const markdown = lines.join('\n\n---\n\n');
  void copyTextToClipboard(markdown).then((ok) => {
    onCopied?.(ok);
    if (!ok) return;
    copiedConversation.value = true;
    emit('copyConversationCopied');
    if (copiedConversationTimer !== null) clearTimeout(copiedConversationTimer);
    copiedConversationTimer = setTimeout(() => {
      copiedConversationTimer = null;
      copiedConversation.value = false;
    }, 2000);
  }).catch(() => {
    onCopied?.(false);
  });
}

function assistantRunEndingAt(index: number): ChatTurn[] {
  const run: ChatTurn[] = [];
  for (let i = index; i >= 0; i--) {
    const turn = props.turns[i];
    if (!turn || turn.role !== 'assistant') break;
    run.unshift(turn);
  }
  return run;
}

const assistantRunCache = new WeakMap<ChatTurn, ChatTurn[]>();

function stableAssistantRun(index: number): ChatTurn[] {
  const run = assistantRunEndingAt(index);
  const last = run.at(-1);
  if (last === undefined) return run;
  const known = assistantRunCache.get(last);
  if (known !== undefined && known.length === run.length && known.every((turn, position) => turn === run[position])) return known;
  assistantRunCache.set(last, run);
  return run;
}

function assistantRunFinal(index: number): { turn: ChatTurn; text: string } | undefined {
  for (let position = index; position >= 0; position -= 1) {
    const turn = props.turns[position];
    if (turn?.role !== 'assistant') break;
    const text = turnVisibleFinalText(turn);
    if (text) return { turn, text };
  }
}

function assistantRunFinalText(index: number): string {
  return assistantRunFinal(index)?.text ?? '';
}

function assistantRunFinalTurn(index: number): ChatTurn | undefined {
  const last = assistantRunFinal(index);
  return last?.text.trim() ? last.turn : undefined;
}

function assistantRunHasOutput(index: number): boolean {
  return assistantRunEndingAt(index).some(turnHasOutput);
}

function finalSummaryText(): string {
  for (let i = props.turns.length - 1; i >= 0; i -= 1) {
    if (props.turns[i]?.role === 'assistant') return assistantRunFinalText(i);
  }
  return '';
}

function copyFinalSummary(onCopied?: (ok: boolean) => void): void {
  const text = finalSummaryText();
  if (!text.trim()) {
    onCopied?.(false);
    return;
  }
  void copyTextToClipboard(text).then((ok) => {
    onCopied?.(ok);
    if (!ok) return;
    copiedConversation.value = true;
    emit('copyConversationCopied');
    if (copiedConversationTimer !== null) clearTimeout(copiedConversationTimer);
    copiedConversationTimer = setTimeout(() => {
      copiedConversationTimer = null;
      copiedConversation.value = false;
    }, 2000);
  }).catch(() => {
    onCopied?.(false);
  });
}

if (props.windowHistory) provide(HistoryImageCacheKey, createHistoryImageCache());
const historyState = props.historyState ?? new Map<string, unknown>();
const transcriptHost = inject(TranscriptScrollKey, null);
const transcriptList = props.windowHistory && transcriptHost !== null;
const transcriptAuxRefs = new Map<string, (el: unknown) => void>();
function transcriptAux(id: string): (el: unknown) => void {
  let bind = transcriptAuxRefs.get(id);
  if (!bind) {
    bind = (el: unknown) => {
      const node = el && typeof el === 'object' && '$el' in el ? el.$el : el;
      transcriptHost?.observeAux('tail', node instanceof HTMLElement ? node : null, id);
    };
    transcriptAuxRefs.set(id, bind);
  }
  return bind;
}
if (transcriptList) watch(topSentinelRef, transcriptAux('sentinel'), { flush: 'sync' });
function historyTurnKey(turn: ChatTurn): string {
  return turn.id;
}
function historyTurnKind(turn: ChatTurn): string {
  return turn.role;
}
function historyTurnEstimate(turn: ChatTurn): number {
  return estimateTurnHeight(turn) + (turn.role === 'assistant' ? 10 : 16);
}
const historyList = computed<{ is: Component; key: string; props: Record<string, unknown> }>(() => transcriptList
  ? {
      is: TranscriptList,
      key: `v2:${props.sessionId ?? 'empty'}`,
      props: { scope: props.sessionId ?? 'empty', state: historyState, items: props.turns, itemKey: historyTurnKey, estimate: historyTurnEstimate, kind: historyTurnKind, renderAll: props.renderAllHistory },
    }
  : {
      is: BlockList,
      key: `blocks:${props.sessionId ?? 'empty'}`,
      props: { items: props.turns, itemKey: historyTurnKey },
    });
const historyRef = ref<{ reveal: (key: string) => Promise<HTMLElement | null>; release: () => void } | null>(null);
async function revealTurn(id: string): Promise<HTMLElement | null> {
  return await historyRef.value?.reveal(id) ?? null;
}
defineExpose({ copyConversation, copyFinalSummary, revealTurn });

function isAssistantRunEnd(index: number): boolean {
  const turn = props.turns[index];
  if (!turn || turn.role !== 'assistant') return false;
  const next = props.turns[index + 1];
  return !next || next.role !== 'assistant';
}

let copiedTimer: ReturnType<typeof setTimeout> | null = null;
function copyAssistantRun(index: number): void {
  const turn = props.turns[index];
  if (!turn) return;
  const text = assistantRunFinalText(index);
  if (!text.trim()) return;
  void copyTextToClipboard(text).then((ok) => {
    if (!ok) return;
    copiedTurn.value = turn.id;
    if (copiedTimer !== null) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copiedTimer = null;
      copiedTurn.value = null;
    }, 1400);
  }).catch(() => {/* ignore */});
}

function copyUserMessage(turn: ChatTurn): void {
  const snapshot = turnSnapshot(turn);
  const copy = snapshot === undefined ? null : copyComposerSnapshot(snapshot);
  const text = copy?.plain ?? userTurnDisplayText(turn);
  if (!text.trim()) return;
  void copyTextWithFlavor(
    copy?.plain ?? stripAttachmentLinks(text),
    copy?.flavor ?? buildMessageCopyFlavor(text, turn.inlineAttachments),
  ).then((ok) => {
    if (!ok) return;
    copiedTurn.value = turn.id;
    if (copiedTimer !== null) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copiedTimer = null;
      copiedTurn.value = null;
    }, 1400);
  }).catch(() => {/* ignore */});
}

const USER_TEXT_CLAMP_LINES = 10;
const QUEUE_TEXT_CLAMP_LINES = 3;

const clampableUserTurns = reactive(new Set<string>());
const expandedUserTurns = reactive(new Set<string>());

const userTextEls = new Map<string, HTMLElement>();
const userTextTurnIds = new WeakMap<HTMLElement, string>();
const pinScroll = inject(PinScrollKey, () => {});

const userTextObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const el = entry.target as HTMLElement;
    const turnId = userTextTurnIds.get(el);
    if (turnId !== undefined) measureUserText(turnId, el);
  }
});
onUnmounted(() => userTextObserver.disconnect());

function measureUserText(turnId: string, el: HTMLElement): void {
  const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
  const text = el.textContent ?? '';
  const trailingBlanks = text.match(/\n+$/)?.[0].length ?? 0;
  const contentHeight = el.scrollHeight - Math.max(0, trailingBlanks - 1) * lineHeight;
  const maxLines = turnId.startsWith('queue:') ? QUEUE_TEXT_CLAMP_LINES : USER_TEXT_CLAMP_LINES;
  if (contentHeight > lineHeight * maxLines + 1) {
    clampableUserTurns.add(turnId);
  } else {
    clampableUserTurns.delete(turnId);
  }
}

function registerUserTextEl(turnId: string, el: unknown): void {
  if (!(el instanceof HTMLElement)) {
    const previous = userTextEls.get(turnId);
    if (previous) userTextObserver.unobserve(previous);
    userTextEls.delete(turnId);
    return;
  }
  if (userTextEls.get(turnId) === el) return;
  const prev = userTextEls.get(turnId);
  if (prev !== undefined) userTextObserver.unobserve(prev);
  userTextEls.set(turnId, el);
  userTextTurnIds.set(el, turnId);
  userTextObserver.observe(el);
  measureUserText(turnId, el);
}

function queueClampId(item: QueuedPromptView): string {
  return `queue:${item.id}`;
}

watch(
  [() => props.turns, () => props.queued],
  () => {
    const ids = new Set(props.turns.map((t) => t.id));
    for (const item of props.queued) ids.add(queueClampId(item));
    for (const [id, el] of userTextEls) {
      if (ids.has(id)) continue;
      userTextObserver.unobserve(el);
      userTextEls.delete(id);
    }
    for (const id of clampableUserTurns) if (!ids.has(id)) clampableUserTurns.delete(id);
    for (const id of expandedUserTurns) if (!ids.has(id)) expandedUserTurns.delete(id);
  },
);

function userTextContent(turn: ChatTurn): string | null {
  const snapshot = turnSnapshot(turn);
  if (snapshot !== undefined) return docToText(composerSnapshotDocument(snapshot)) || null;
  if (turn.skillActivation) {
    const act = turn.skillActivation;
    if (skillActivationHasPill(act)) {
      return skillActivationEditText(act, {
        revivePill: true,
        defaultPath: defaultSkillPath(act.name),
      }) ?? act.args ?? null;
    }
    const pill = serializeMention({ kind: 'skill', name: act.name, path: act.path ?? '' });
    return act.args ? `${pill} ${act.args}` : pill;
  }
  if (turn.skillActivations && turn.skillActivations.length > 0) {
    const text = skillActivationsEditText(turn.skillActivations, turn.text, {
      revivePill: true,
      defaultPath: defaultSkillPath,
    }) ?? turn.text;
    return skillActivationsBubbleText(turn.skillActivations, text) || null;
  }
  if (turn.pluginCommand) return turn.pluginCommand.args || null;
  return turn.text || null;
}
function isCommandArgs(turn: ChatTurn): boolean {
  return turn.pluginCommand !== undefined;
}

function isUserTextClamped(turnId: string): boolean {
  return clampableUserTurns.has(turnId) && !expandedUserTurns.has(turnId);
}

function toggleUserText(turnId: string, event: MouseEvent): void {
  const collapsing = expandedUserTurns.has(turnId);
  if (collapsing && event.currentTarget instanceof HTMLElement) {
    pinScroll(event.currentTarget);
  }
  if (collapsing) expandedUserTurns.delete(turnId);
  else expandedUserTurns.add(turnId);
}

type MediaTurnAttachment = TurnAttachment & { kind: 'image' | 'video' };

function isMediaAttachment(att: TurnAttachment): att is MediaTurnAttachment {
  return att.kind === 'image' || att.kind === 'video';
}

function mediaAttachments(turn: ChatTurn): MediaTurnAttachment[] {
  return ordinaryMedia(turn.attachments ?? [], turnSnapshot(turn));
}

function fileAttachments(turn: ChatTurn): TurnAttachment[] {
  const atts = turn.attachments ?? [];
  const snapshot = turnSnapshot(turn);
  return (snapshot === undefined ? stripInlineAttachments(turn.text, atts) : stripSnapshotAttachments(snapshot, atts))
    .filter((att) => !isMediaAttachment(att));
}

const mediaLightbox = ref<ToolMedia | null>(null);
const mediaLightboxImg = ref<HTMLImageElement | null>(null);
const mediaLightboxIndex = ref<number | undefined>(undefined);

const railImageAttachments = computed(() =>
  [
    props.turns.flatMap((turn) => mediaAttachments(turn).map((attachment) => ({ attachment, sourceId: turn.id }))),
    props.queued.flatMap((item) =>
      queueMediaAttachments(item).map((attachment) => ({ attachment, sourceId: queueClampId(item) })),
    ),
  ]
    .flat()
    .filter(({ attachment }) => attachment.kind === 'image'),
);

const railImages = computed<ToolMedia[]>(() => railImageAttachments.value.map(({ attachment }) => railMedia(attachment)));

function railImageIndex(attachment: TurnAttachment, sourceId: string): number | undefined {
  const list = railImageAttachments.value;
  const byRef = list.findIndex((entry) => entry.attachment === attachment);
  if (byRef !== -1) return byRef;
  const matches = list
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        entry.sourceId === sourceId &&
        entry.attachment.fileId === attachment.fileId &&
        entry.attachment.url === attachment.url &&
        entry.attachment.name === attachment.name &&
        entry.attachment.size === attachment.size,
    );
  if (matches.length === 0) return undefined;
  const byOrdinal = matches.find(
    ({ entry }) =>
      attachment.mediaOrdinal !== undefined && entry.attachment.mediaOrdinal === attachment.mediaOrdinal,
  );
  return (byOrdinal ?? matches[0]!).index;
}

function railMedia(attachment: TurnAttachment): ToolMedia {
  return turnAttachmentToMedia(attachment as TurnAttachment & { kind: 'image' | 'video' });
}

function openRailMedia(attachment: TurnAttachment, img: HTMLImageElement | null, sourceId = ''): void {
  if (attachment.kind !== 'image' && attachment.kind !== 'video') return;
  mediaLightboxIndex.value = railImageIndex(attachment, sourceId);
  mediaLightbox.value = railMedia(attachment);
  mediaLightboxImg.value = img;
}

function isStreamingRenderBlock(turn: ChatTurn, block: { sourceIndex: number }): boolean {
  return block.sourceIndex === streamingTailIndex(turn);
}

function isStreamingActivityRun(turn: ChatTurn, block: { items: { sourceIndex: number }[] }): boolean {
  const last = block.items.at(-1);
  return last !== undefined && last.sourceIndex === streamingTailIndex(turn);
}

function isLiveActivityRun(turn: ChatTurn, block: { items: { sourceIndex: number }[] }): boolean {
  const last = block.items.at(-1);
  return last !== undefined && last.sourceIndex === activityRunTailIndex(turn);
}

function activityRunTailIndex(turn: ChatTurn): number | null {
  return getActivityRunTailIndex(turn, streamingTurnId.value, props.approvals, props.questions);
}

function turnParked(turn: ChatTurn): boolean {
  return turnInteractionParked(turn, streamingTurnId.value, props.approvals, props.questions);
}

const EMPTY_FOLD: AssistantFold = { folded: [], visible: [] };
function assistantFold(turn: ChatTurn): AssistantFold {
  if (turn.role !== 'assistant') return EMPTY_FOLD;
  return splitAssistantFold(turn, { notifyUserEnabled: notifyUserEnabled.value });
}

function assistantVisibleBlocks(turn: ChatTurn): AssistantRenderBlock[] {
  const fold = assistantFold(turn);
  const blocks = props.inspector || !turnFolding.value ? flattenAssistantFold(fold) : fold.visible;
  return blocks.filter(block => block.kind !== 'text' || block.text);
}

function estimateTurnHeight(turn: ChatTurn): number {
  if (turn.role === 'user') {
    const attachments = (turn.attachments?.length ?? 0) + (turn.inlineAttachments?.length ?? 0);
    return estimateUserTurnHeight(userTextContent(turn), attachments, expandedUserTurns.has(turn.id), USER_TEXT_CLAMP_LINES);
  }
  if (turn.role !== 'assistant') return 60;
  const fold = assistantFold(turn);
  const folded = !props.inspector && turnFolding.value && fold.folded.length > 0 && turn.id !== streamingTurnId.value;
  const visible = folded ? fold.visible : flattenAssistantFold(fold);
  let height = 30 + (folded ? 28 : 0);
  for (const block of visible) {
    if (block.kind === 'text' && block.text) height += Math.max(24, Math.ceil(block.text.length / 50) * 24);
    else if (block.kind === 'activity-run') height += (props.inspector || !activityRunFolding.value ? block.items.length : 1) * 28;
    else if (block.kind === 'thinking' || block.kind === 'tool' || block.kind === 'notification') height += 28;
  }
  return height;
}

function streamingTailIndex(turn: ChatTurn): number | null {
  return getStreamingTailIndex(turn, streamingTurnId.value, props.approvals, props.questions);
}

</script>

<template>
  <div class="chat" :class="{ 'chat-unwindowed': !windowHistory }" :data-first-kind="turns[0]?.role" ref="chatRootRef" tabindex="-1" @mouseup="onChatMouseup" @keyup="onChatKeyup" @pointerdown="onChatPointerdown" @contextmenu="onChatContextMenu">
    <BrowserReferenceDetails :state="browserDetails.state.value" @resolve="browserDetails.finish" />
    <div v-if="sessionLoadingVisible" :ref="transcriptAux('loading')" class="chat-loading">
      <Spinner size="sm" />
      <span class="chat-loading-text">{{ t('conversation.loading') }}</span>
    </div>
    <div v-if="!sessionLoading && turns.length === 0 && (!approvals || approvals.length === 0)" class="chat-empty" />

    <div
      v-if="hasMoreMessages || loadingMore"
      ref="topSentinelRef"
      class="top-sentinel"
      :class="{ 'top-sentinel-loading': loadingMore }"
    >
      <Button
        v-if="!loadingMore"
        class="top-sentinel-btn"
        variant="secondary"
        size="xs"
        @click="emit('loadOlderMessages', { manual: true })"
      >
        {{ t('conversation.loadOlder') }}
      </Button>
      <span v-else class="top-sentinel-text">
        <Spinner size="sm" />
        {{ t('conversation.loadingOlder') }}
      </span>
    </div>

    <component :is="historyList.is" ref="historyRef" :key="historyList.key" v-bind="historyList.props">
      <template #default="{ item: turn, index: ti }: { item: ChatTurn; index: number }">
      <div class="chat-row" :data-row-kind="turn.role" :data-row-key="windowHistory ? undefined : turn.id">
      <template v-if="turn.role === 'user'">
        <div class="u-turn">
          <div class="u-bub turn-anchor" :class="{ undoing: undoingTurnId === turn.id }" :data-turn-id="turn.id">
            <MediaRail
              v-if="mediaAttachments(turn).length > 0"
              class="u-media-rail"
              :attachments="mediaAttachments(turn)"
              :label="t('composer.mediaAttachments')"
              @activate="(att, img) => openRailMedia(att, img, turn.id)"
            />
            <div v-if="fileAttachments(turn).length > 0" class="u-atts">
              <template v-for="(att, ai) in fileAttachments(turn)" :key="ai">
                <button
                  v-if="att.url !== ''"
                  type="button"
                  class="attachment-pill attachment-file"
                  :data-attachment-id="att.fileId ?? att.name ?? ''"
                  data-attachment-kind="file"
                  :data-attachment-name="att.name ?? ''"
                  :data-attachment-url="att.url"
                  :data-attachment-file-id="att.fileId"
                  :data-attachment-media-type="att.mediaType"
                  :data-attachment-size="att.size"
                  :aria-label="att.name"
                ><span class="attachment-pill-icon" aria-hidden="true" v-html="attachmentIconSvg()" /><span class="attachment-pill-name">{{ truncateMentionName(att.name ?? '') }}</span></button>
                <span
                  v-else
                  class="attachment-pill attachment-file"
                  :data-attachment-id="att.fileId ?? att.name ?? ''"
                  data-attachment-kind="file"
                  :data-attachment-name="att.name ?? ''"
                  :data-attachment-file-id="att.fileId"
                  :data-attachment-media-type="att.mediaType"
                  :data-attachment-size="att.size"
                  :aria-label="att.name"
                ><span class="attachment-pill-icon" aria-hidden="true" v-html="attachmentIconSvg()" /><span class="attachment-pill-name">{{ truncateMentionName(att.name ?? '') }}</span></span>
              </template>
            </div>
            <!-- Plugin command card (replaces expanded body) -->
            <div v-if="turn.pluginCommand" class="skill-act">
              <div class="skill-act-head">
                <span class="skill-act-arrow">▶</span>
                <span>/{{ turn.pluginCommand.pluginId }}:{{ turn.pluginCommand.commandName }}</span>
              </div>
            </div>
            <!-- User text verbatim (pre-wrap), never Markdown; a skill
                 activation's args ARE the original text (the pill's link form
                 revives in place), a plugin command's args follow its card;
                 skipped when empty AND attachment-less — an inline-attachment
                 turn still mounts the block so its pills render. Overlong
                 content clamps with a fade + toggle. -->
            <div
              v-if="userTextContent(turn) !== null || (turn.inlineAttachments?.length ?? 0) > 0"
              class="u-text-wrap"
              :class="{ 'is-clamped': isUserTextClamped(turn.id), 'u-text-wrap-args': isCommandArgs(turn) }"
            >
              <div
                :class="isCommandArgs(turn) ? 'skill-act-args' : 'u-text'"
                :ref="(el) => registerUserTextEl(turn.id, el)"
              ><ComposerText :text="userTextContent(turn) ?? ''" :snapshot="turnSnapshot(turn)" :open-file="panelApi?.openFile" :attachments="editRefillAttachments(turn)" :media-labels="mediaLabels" :pasted-text-meta="pastedTextMeta" :open-browser-reference="(id, anchor) => openTurnBrowserReference(turn, id, anchor)" /></div>
              <button
                v-if="clampableUserTurns.has(turn.id)"
                type="button"
                class="u-text-toggle"
                :aria-expanded="!isUserTextClamped(turn.id)"
                @click="toggleUserText(turn.id, $event)"
              >
                <span>{{
                  isUserTextClamped(turn.id)
                    ? t('conversation.userMessage.expand')
                    : t('conversation.userMessage.collapse')
                }}</span>
                <Icon class="u-text-toggle-car" name="chevron-down" size="sm" aria-hidden="true" />
              </button>
            </div>
          </div>
          <div v-if="turn.createdAt || canEditTurn(turn) || steerReceiptPhase(turn)" class="u-meta">
            <Tooltip v-if="steerReceiptPhase(turn)" :text="steerReceiptTooltip(turn)">
              <span
                class="u-steer-receipt"
                :class="`is-${steerReceiptPhase(turn)}`"
                role="status"
                tabindex="0"
              >
                <span>{{ steerReceiptText(turn) }}</span>
              </span>
            </Tooltip>
            <Tooltip :text="t('filePreview.copy')">
            <IconButton
              v-if="canCopyUserTurn(turn)"
              class="u-copy"
              size="xs"
              :label="t('filePreview.copy')"
              @click.stop="copyUserMessage(turn)"
            >
              <Icon v-if="copiedTurn !== turn.id" name="copy" size="sm" />
              <Icon v-else name="check" size="sm" />
            </IconButton>
            </Tooltip>
            <div v-if="canEditTurn(turn)" class="u-edit-wrap" :class="{ undoing: undoingTurnId === turn.id }">
              <Tooltip :text="t('conversation.undoTooltip')">
              <IconButton
                class="u-edit"
                size="xs"
                :label="t('conversation.undoTooltip')"
                @click="onUndo(turn)"
              >
                <Icon name="undo" size="sm" />
              </IconButton>
              </Tooltip>
            </div>
            <MessageTime v-if="turn.createdAt" :time="turn.createdAt" />
          </div>
        </div>
      </template>

      <!-- Compaction divider — prior turns stay untouched; summary opens in
           the right-side panel on click. The entry needs the provider's
           compaction lookup: where the API is blanked (an embedded subagent
           transcript, whose turns the root lookup cannot resolve) the label
           stays a plain inert divider. -->
      <div
        v-else-if="turn.role === 'compaction'"
        class="compact-divider compact-divider--compacted turn-anchor"
        :data-turn-id="turn.id"
        role="separator"
      >
        <component
          :is="canOpenCompactionSummary(turn) ? 'button' : 'span'"
          v-bind="canOpenCompactionSummary(turn) ? { type: 'button', 'aria-expanded': isCompactionSummaryOpen(turn) } : {}"
          class="cd-card"
          :class="{ 'cd-btn': canOpenCompactionSummary(turn), 'cd-open': isCompactionSummaryOpen(turn) }"
          @click="canOpenCompactionSummary(turn) ? panelApi?.openCompaction?.({ turnId: turn.id }) : undefined"
        >
          <span class="cd-chip" aria-hidden="true">
            <Icon name="collapse" size="sm" />
          </span>
          <span class="cd-title">{{ compactionBaseLabel(turn) }}</span>
          <span v-if="compactionTokenDelta(turn)" class="cd-tokens">{{ compactionTokenDelta(turn) }}</span>
          <span v-if="compactionSavedLabel(turn)" class="cd-saved">{{ compactionSavedLabel(turn) }}</span>
          <span v-if="canOpenCompactionSummary(turn)" class="cd-chevron" aria-hidden="true">
            <Icon name="chevron-right" size="sm" />
          </span>
        </component>
      </div>

      <!-- Cron notice — a turn triggered by a scheduled reminder, rendered as
           a lightweight in-transcript notice rather than a user bubble. -->
      <CronNotice v-else-if="turn.role === 'cron'" :text="turn.text" :cron="turn.cron" :turn-id="turn.id" :created-at="turn.createdAt" />

      <GoalNotice v-else-if="turn.role === 'goal'" :text="turn.text" :turn-id="turn.id" :created-at="turn.createdAt" />

      <!-- Assistant turn → left-aligned, no name/role label. Everything before
           the final text block folds into a TurnFold row once the turn
           settles; the final text (and any trailing blocks) stays visible. -->
      <div v-else class="a-msg turn-anchor" :data-turn-id="turn.id">
        <TurnFold
          v-if="!inspector && turnFolding && assistantFold(turn).folded.length > 0"
          data-block-key="fold"
          :items="assistantFold(turn).folded"
          mobile
          :streaming-tail-index="streamingTailIndex(turn)"
          :activity-run-tail-index="activityRunTailIndex(turn)"
          :live="turn.id === streamingTurnId"
          :parked="turnParked(turn)"
          :seed-ms="turnActivitySeedMs(turnBlocks(turn))"
          :created-ms="isoMs(turn.createdAt)"
          :ended-ms="isoMs(turn.endedAt)"
          :duration-ms="turn.durationMs"
          :resolve-file-path="turnFilePathResolver(turn)"
          :resolve-image="turnImageResolver(turn)"
          @open-media="onOpenMedia"
          @detach="onDetach"
        />
        <BlockList :items="assistantVisibleBlocks(turn)" :item-key="renderBlockKey" :enabled="windowHistory" scope="visible-blocks"><template #default="{ item: blk, index: bi }">
          <ThinkingBlock v-if="blk.kind === 'thinking'" :data-block-key="renderBlockKey(blk, bi)" :text="blk.thinking" mobile :streaming="isStreamingRenderBlock(turn, blk)" :started-at="blk.startedAt" :duration-ms="blk.durationMs" :instant-reveal="inspector" />
          <div v-else-if="blk.kind === 'text' && blk.text" class="msg" :data-block-key="renderBlockKey(blk, bi)"><Markdown :text="blk.text" :streaming="isStreamingRenderBlock(turn, blk)" :state-key="renderBlockKey(blk, bi)" :open-file="panelApi?.openFile" :resolve-file-path="turnFilePathResolver(turn)" :resolve-image="turnImageResolver(turn)" /></div>
          <ActivityRun
            v-else-if="blk.kind === 'activity-run'"
            :data-block-key="renderBlockKey(blk, bi)"
            :items="blk.items"
            mobile
            :live="isLiveActivityRun(turn, blk)"
            :streaming="isStreamingActivityRun(turn, blk)"
            :force-open="inspector"
            :resolve-file-path="turnFilePathResolver(turn)"
            :resolve-image="turnImageResolver(turn)"
            @open-media="onOpenMedia"
            @detach="onDetach"
          />
          <ToolCall v-else-if="blk.kind === 'tool'" :data-block-key="renderBlockKey(blk, bi)" :tool="blk.tool" mobile :resolve-file-path="turnFilePathResolver(turn)" :resolve-image="turnImageResolver(turn)" @open-media="onOpenMedia" @detach="onDetach" />
          <NotificationCard v-else-if="blk.kind === 'notification'" :data-block-key="renderBlockKey(blk, bi)" :items="blk.items" />
          <template v-if="blk.kind === 'thinking' || blk.kind === 'text' || blk.kind === 'tool'"><RequestDebugRow v-for="(debug, di) in blk.debug ?? []" :key="di" :debug="debug" /></template>
        </template></BlockList>
        <BrowserSources
          v-if="!inspector && turn.id !== streamingTurnId && isAssistantRunEnd(ti)"
          :turns="stableAssistantRun(ti)"
        />
        <!-- Per-turn file-change summary — suppressed in inspector mode: the
             sub-agent detail view stays a pure trajectory, no diff card. -->
        <TurnFilesSummary
          v-if="!inspector && turnFileChangesById.get(turn.id)"
          data-block-key="files"
          :changes="turnFileChangesById.get(turn.id)!.changes"
          :turn-id="turn.id"
          :daemon-turn-id="turnFileChangesById.get(turn.id)!.daemonTurnId"
          :expected="turnFileChangesById.get(turn.id)!.expected"
          :session-id="turn.sessionId"
          :cwd="props.cwd"
          :interactive="turnFilesInteractive"
        />
        <div v-if="!inspector && turn.id !== streamingTurnId && isAssistantRunEnd(ti) && (props.turns[ti + 1]?.steered !== true || forkEntryAvailable(turn)) && (assistantRunHasOutput(ti) || forkEntryAvailable(turn)) && (assistantRunFinalText(ti).trim().length > 0 || turnTimeLabel(turn) || forkEntryAvailable(turn))" class="a-msg-ft" data-block-key="footer">
          <div class="a-msg-meta">
            <Tooltip :text="t('filePreview.copy')">
            <button
              v-if="assistantRunFinalText(ti).trim().length > 0"
              class="a-cpbtn"
              :aria-label="t('filePreview.copy')"
              @click="copyAssistantRun(ti)"
            >
              <Icon v-if="copiedTurn !== turn.id" name="copy" size="sm" />
              <Icon v-else name="check" size="sm" />
            </button>
            </Tooltip>
            <Tooltip v-if="forkEntryAvailable(turn)" :text="t('conversation.forkFromHere')">
            <button
              class="a-cpbtn"
              :aria-label="t('conversation.forkFromHere')"
              :disabled="forkPending"
              @click="forkAssistantRun(turn)"
            >
              <Icon name="git-fork" size="sm" />
            </button>
            </Tooltip>
            <div v-if="$slots['assistant-reply-actions']" class="a-reply-actions">
              <slot name="assistant-reply-actions" :turn="assistantRunFinalTurn(ti)" />
            </div>
            <span v-if="turnTimeLabel(turn)" class="a-time">{{ turnTimeLabel(turn) }}</span>
            <slot v-if="$slots['assistant-reply-status']" name="assistant-reply-status" :turn="assistantRunFinalTurn(ti)" />
          </div>
          <Transition name="sr-fade">
            <SessionRatingRow
              v-if="ratingView && turn.id === ratingTurnId"
              :key="ratingView.appearanceId"
              :view="ratingView"
              @shown="ratingShown"
              @select="selectRating"
              @undo="undoRating"
            />
          </Transition>
        </div>
      </div>

      <!-- Manually stopped latest turn (Esc) — from the session's lastTurnReason. -->
      <div
        v-if="turn.role === 'assistant' && turn.id === interruptedTurnId"
        class="compact-divider compact-divider-interrupted"
        role="separator"
      >
        <span class="cd-line" aria-hidden="true" />
        <span class="cd-label" role="status">{{ t('conversation.turnInterrupted') }}</span>
        <span class="cd-line" aria-hidden="true" />
      </div>
      </div>
      </template>
    </component>

    <!-- Model-request failure (e.g. provider 429 after retry exhaustion): the
         turn died and nothing resumes it on its own — a persistent card, since
         the transient error toast alone leaves a silently dead session. -->
    <div v-if="turnFailed" :ref="transcriptAux('failed')" class="turn-failed" role="alert">
      <span class="tf-chip" aria-hidden="true"><Icon name="alert-triangle" size="sm" /></span>
      <div class="tf-main">
        <span class="tf-title">{{ turnFailedTitle }}</span>
        <span v-if="turnErrorDisplayMessage" class="tf-sub">{{ turnErrorDisplayMessage }}</span>
        <span v-if="turnErrorMeta" class="tf-meta" :title="turnErrorMeta">{{ turnErrorMeta }}</span>
      </div>
      <Button v-if="!readOnly" variant="secondary" size="sm" @click="emit('resumeTurn')">
        {{ t('conversation.turnFailedResume') }}
      </Button>
    </div>

    <Transition name="sr-fade">
      <div v-if="ratingStandalone && ratingView" :ref="transcriptAux('rating')" class="sr-tailrow">
        <SessionRatingRow
          :key="ratingView.appearanceId"
          :view="ratingView"
          standalone
          @shown="ratingShown"
          @select="selectRating"
          @undo="undoRating"
        />
      </div>
    </Transition>

    <!-- Pending approvals are rendered in the bottom dock (ConversationPane),
         alongside questions, so both blocking prompts share one position. -->

    <div v-if="showMascot" :ref="transcriptAux('working')" class="sending-placeholder">
      <WorkingIndicator
        :label="isCompacting ? t('conversation.compacting') : showWorking ? workingLabel : ''"
        :idle="!showWorking && !isCompacting"
        :static-label="isCompacting"
      >
        <ActivityNotice v-if="isCompacting" />
      </WorkingIndicator>
    </div>

    <!-- Inline queue — pending user messages shown after the running turn.
         The head row steers into the running turn; click to edit, × to
         remove, drag the grip to reorder. -->
    <div v-if="queued.length > 0" :ref="transcriptAux('queue')" class="q-stack">
      <div class="q-head">
        <span class="q-title">
          <Icon name="mail" size="sm" />
          {{ t('composer.queueLabel') }} · <b>{{ t('composer.queuePending', { n: queued.length }) }}</b>
        </span>
      </div>
      <div
        v-for="(item, qi) in queued"
        :key="item.id"
        class="u-turn q-turn"
        :class="{
          'q-dragging': dragFrom === qi,
          'drop-before': dragOver?.index === qi && dragOver.position === 'before',
          'drop-after': dragOver?.index === qi && dragOver.position === 'after',
        }"
        @dragover="onQueueDragOver(qi, $event)"
        @drop="onQueueDrop(qi, $event)"
      >
        <Tooltip v-if="qi === 0 && item.kind !== 'compact'" :text="queueSteerLabel">
          <button
            type="button"
            class="q-send"
            :aria-label="queueSteerLabel"
            @click.stop="emit('steerQueued', qi)"
          >
            <Icon name="send" size="lg" />
          </button>
        </Tooltip>
        <div class="u-bub q-bub">
          <span
            class="q-grip"
            :title="t('composer.queueDragTitle')"
            draggable="true"
            @dragstart="onQueueDragStart(qi, $event)"
            @dragend="onQueueDragEnd"
          >
            <Icon name="grip" size="sm" />
          </span>
          <div class="q-content">
            <MediaRail
              v-if="queueMediaAttachments(item).length > 0"
              class="q-media-rail"
              :attachments="queueMediaAttachments(item)"
              :label="t('composer.mediaAttachments')"
              @activate="(att, img) => openRailMedia(att, img, queueClampId(item))"
            />
            <div class="q-clamp u-text-wrap" :class="{ 'is-clamped': isUserTextClamped(queueClampId(item)) }">
              <Tooltip :text="t('composer.editQueued')">
                <button
                  type="button"
                  class="q-body"
                  :ref="(el) => registerUserTextEl(queueClampId(item), el)"
                  @click="onQueueBodyTap(qi)"
                >
                  <span v-if="item.text" class="u-text q-text"><ComposerText :text="item.text" :snapshot="queueSnapshot(item)" :interactive="false" :attachments="item.attachments" :media-labels="mediaLabels" :pasted-text-meta="pastedTextMeta" /></span>
                  <span v-else class="q-text q-text-placeholder">
                    <Icon name="file" size="sm" />
                    {{ t('composer.queuedAttachments', { n: item.attachments?.length ?? 0 }) }}
                  </span>
                </button>
              </Tooltip>
              <button
                v-if="clampableUserTurns.has(queueClampId(item))"
                type="button"
                class="u-text-toggle"
                :aria-expanded="!isUserTextClamped(queueClampId(item))"
                @click="toggleUserText(queueClampId(item), $event)"
              >
                <span>{{
                  isUserTextClamped(queueClampId(item))
                    ? t('conversation.userMessage.expand')
                    : t('conversation.userMessage.collapse')
                }}</span>
                <Icon class="u-text-toggle-car" name="chevron-down" size="sm" aria-hidden="true" />
              </button>
            </div>
            <div v-if="queueFileAttachments(item).length > 0" class="q-imgs">
              <template v-for="(att, ai) in queueFileAttachments(item)" :key="ai">
                <span class="q-file">
                  <Icon name="file" size="sm" />
                  {{ att.name ?? att.fileId }}
                </span>
              </template>
            </div>
          </div>
          <!-- Touch-only explicit edit: on hover devices the body itself is
               tap-to-edit; on touch a stray tap must not dequeue the draft. -->
          <IconButton
            class="q-edit"
            size="xs"
            :label="t('composer.editQueued')"
            @click.stop="onQueueEdit(qi)"
          >
            <Icon name="pencil" size="sm" />
          </IconButton>
          <Tooltip :text="t('composer.remove')">
          <IconButton
            class="q-rm"
            size="xs"
            tone="danger"
            :label="t('composer.remove')"
            @click.stop="void client.unqueue(qi)"
          >
            <Icon name="close" size="sm" />
          </IconButton>
          </Tooltip>
        </div>
      </div>
    </div>
  </div>

  <!-- Floating preview for user-bubble media thumbnails (image/video). -->
  <MediaLightbox
    v-if="mediaLightbox"
    :media="mediaLightbox"
    :origin-img="mediaLightboxImg"
    :images="railImages"
    :index="mediaLightboxIndex"
    @close="
      mediaLightbox = null;
      mediaLightboxImg = null;
      mediaLightboxIndex = undefined;
    "
  />

  <!-- Selection quote bubble (划词) — teleports to body, anchored to the
       selection inside an assistant message. Disabled in transcript-only
       embeds (side chat, agent detail) and by the release gate
       (SELECTION_QUOTE_ENABLED). -->
  <SelectionActionBubble
    v-if="selectionActionsOn"
    :visible="selectionBubble !== null"
    :x="selectionBubble?.x ?? 0"
    :y="selectionBubble?.y ?? 0"
    :bottom="selectionBubble?.bottom ?? 0"
    :px="selectionBubble?.px"
    :py="selectionBubble?.py"
    :quote="selectionBubble?.quote ?? ''"
    :focus-on-open="selectionKeyboard"
    :focus-return-el="chatRootRef"
    :boundary-el="chatRootRef"
    :keep-on-context-click="selectionContextMenu !== undefined"
    @action="onSelectionAction"
    @close="onSelectionBubbleClose"
  />
  <TableSelectionContextMenu ref="tableSelectionMenuRef" :allow-quote="selectionActionsOn" @quote="onTableSelectionQuote" />
</template>

<style scoped>
.chat-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px 16px;
  color: var(--color-text-quaternary);
  text-align: center;
}
.chat-empty-text { font-size: var(--text-sm); }

.chat-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px 16px;
  color: var(--color-text-faint);
}
.chat-loading-text { font-size: var(--text-sm); }

.chat {
  text-autospace: normal;
  --chat-turn-gap: 16px;
  --chat-assistant-gap: 10px;
  --chat-block-gap: 10px;
  --chat-strip-gap: 12px;
  --chat-group-gap: 6px;
  --chat-strip-tight: 4px;
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 16px 14px 20px;
  flex: 1;
  min-height: 0;
  position: relative;
}
.chat :deep(pre),
.chat :deep(code) { text-autospace: no-autospace; }
.chat .chat-empty { align-self: stretch; }

.chat-row {
  padding-top: var(--chat-turn-gap);
}
.chat-row[data-row-kind='assistant'] {
  padding-top: var(--chat-assistant-gap);
}
.chat > .chat-row:first-child {
  padding-top: 0;
}
.chat[data-first-kind] > :is(.block-list, .transcript-list) {
  margin-top: calc(-1 * var(--chat-turn-gap));
}
.chat[data-first-kind='assistant'] > :is(.block-list, .transcript-list) {
  margin-top: calc(-1 * var(--chat-assistant-gap));
}
.chat > .top-sentinel + :is(.block-list, .transcript-list) {
  margin-top: 0;
}

.chat > .sending-placeholder,
.chat > :deep(.activity-notice) {
  margin-top: var(--chat-turn-gap);
}
.chat > .sending-placeholder:first-child,
.chat > :deep(.activity-notice:first-child) {
  margin-top: 0;
}

.chat-unwindowed .u-turn,
.chat-unwindowed .a-msg > :is(.think, .activity-run),
.chat-unwindowed :deep(.ar-body-inner > *) {
  content-visibility: auto;
  contain-intrinsic-block-size: auto var(--chat-block-placeholder-h);
  overflow-clip-margin: var(--space-2);
}

.u-turn {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  align-self: flex-start;
  width: 100%;
}

.u-bub {
  align-self: flex-end;
  max-width: min(640px, 78%);
  background: var(--color-user-bubble-bg);
  color: var(--color-text);
  border-radius: var(--radius-lg);
  padding: 10px 12px;
  font-size: var(--content-font-size);
  line-height: var(--leading-normal);
}
.u-meta {
  align-self: flex-end;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 6px;
  max-width: 78%;
  margin-top: 6px;
}
.u-steer-receipt {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--color-text-muted);
  font-size: var(--text-base);
  line-height: 20px;
  white-space: nowrap;
}
.u-steer-receipt.is-accepted { color: var(--color-accent); }
.u-meta :deep(.msg-time) {
  min-height: 20px;
  padding: 0 0 0 3px;
  color: var(--color-text-muted);
  font-size: var(--text-base);
  font-weight: var(--weight-regular);
  line-height: 20px;
  opacity: 1;
}
.u-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.u-text-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
}
.u-text-wrap-args {
  margin-top: var(--space-1);
}
.u-text-wrap.is-clamped {
  min-width: 120px;
}
.u-text-wrap.is-clamped > .u-text,
.u-text-wrap.is-clamped > .skill-act-args {
  max-height: calc(10 * 1lh);
  overflow: hidden;
  mask-image: linear-gradient(to bottom, black calc(100% - 5lh), transparent calc(100% - 1lh));
  -webkit-mask-image: linear-gradient(to bottom, black calc(100% - 5lh), transparent calc(100% - 1lh));
}
.u-text-wrap.is-clamped > .ui-tip > .q-body {
  max-height: calc(3 * 1lh);
  overflow: hidden;
  mask-image: linear-gradient(to bottom, black calc(100% - 1.2lh), transparent calc(100% - 0.2lh));
  -webkit-mask-image: linear-gradient(to bottom, black calc(100% - 1.2lh), transparent calc(100% - 0.2lh));
}
.u-text-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  align-self: center;
  margin-top: var(--space-2);
  padding: var(--space-2) var(--space-4);
  border: none;
  border-radius: var(--radius-full);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-sm);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  line-height: 1;
  cursor: pointer;
  user-select: none;
  transition: box-shadow var(--duration-base) var(--ease-out);
}
.u-text-toggle:hover {
  box-shadow: var(--shadow-md);
}
.u-text-toggle:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}
.u-text-wrap.is-clamped .u-text-toggle {
  position: absolute;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  margin-top: 0;
}
.u-text-toggle-car {
  transition: transform var(--duration-base) var(--ease-out);
}
.u-text-toggle[aria-expanded='true'] .u-text-toggle-car {
  transform: rotate(180deg);
}

.u-meta .u-edit:hover:not(:disabled),
.u-meta .u-copy:hover:not(:disabled) { color: var(--color-accent); }
.u-edit-wrap { display: flex; justify-content: flex-end; }

.compact-divider {
  display: flex;
  align-items: center;
  gap: 10px;
  align-self: stretch;
  width: 100%;
  margin: 0;
}
.compact-divider-interrupted {
  margin-top: var(--chat-turn-gap);
}
.cd-line {
  flex: 1;
  height: 1px;
  background: var(--color-line);
}
.cd-label {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 80%;
  font-size: var(--text-base);
  color: var(--color-text-faint);
  white-space: nowrap;
}
.cd-card {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  padding: 4px 8px 4px 5px;
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  font: var(--text-xs)/1.25 var(--font-ui);
  color: var(--color-text-muted);
  white-space: nowrap;
}
.cd-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--color-context-compaction) 13%, transparent);
  color: var(--color-context-compaction);
}
.cd-title {
  color: var(--color-text);
  font-weight: var(--weight-medium);
}
.cd-tokens {
  font-variant-numeric: tabular-nums;
}
.cd-saved {
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  background: var(--color-success-soft);
  color: var(--color-success);
  font-size: 11px;
  font-weight: var(--weight-medium);
  font-variant-numeric: tabular-nums;
}
.cd-chevron {
  display: inline-flex;
  color: var(--color-text-faint);
}
.cd-btn {
  cursor: pointer;
}
.cd-card.cd-btn:hover {
  background: var(--color-hover);
  border-color: var(--color-line-strong);
}
.cd-card.cd-open {
  border-color: var(--color-line-strong);
}
.cd-card.cd-open .cd-chevron {
  color: var(--color-text);
}
.cd-card.cd-btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}

.chat > .turn-failed {
  margin-top: var(--chat-turn-gap);
}
.chat > .turn-failed:first-child {
  margin-top: 0;
}
.turn-failed {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: var(--p-hairline) solid var(--color-danger-bd);
  border-radius: var(--radius-lg);
  background: var(--color-danger-soft);
  box-shadow: var(--shadow-xs);
  animation: kimi-card-in var(--duration-slow) var(--ease-out);
}
.tf-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--space-6);
  height: var(--space-6);
  border-radius: var(--radius-md);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-xs);
  flex: none;
  color: var(--color-danger);
}
.tf-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.tf-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  line-height: var(--leading-normal);
}
.tf-sub {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.tf-meta {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  line-height: var(--leading-normal);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.a-msg {
  align-self: flex-start;
  max-width: 94%;
  width: 94%;
}
.a-msg-ft {
  display: flex;
  justify-content: flex-start;
  align-items: center;
  gap: 6px;
  height: auto;
  margin-top: 6px;
  overflow: visible;
}
.a-msg-meta {
  display: flex;
  align-items: center;
  gap: 6px;
}
.a-reply-actions { display: contents; }
.a-msg-meta:has(> .a-reply-actions > *) { gap: 2px; }
.a-msg-meta:has(> .a-reply-actions > *) .a-time {
  margin-inline: 6px;
  color: light-dark(rgb(0 0 0 / 45%), rgb(255 255 255 / 42%));
  font-size: var(--ui-c1);
  line-height: 1.5;
}
.chat > .sr-tailrow {
  margin-top: 6px;
}
.sr-tailrow {
  display: flex;
  align-items: center;
  min-height: 20px;
}
.sr-fade-leave-active {
  transition: opacity var(--duration-slow) var(--ease-out);
}
.sr-fade-leave-to {
  opacity: 0;
}
.a-time {
  display: inline-flex;
  align-items: center;
  font-size: var(--text-base);
  color: var(--color-text-muted);
  line-height: 20px;
}

.a-cpbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 3px;
  background: none;
  border: none;
  border-radius: var(--radius-xs);
  color: var(--color-text-muted);
  font: inherit;
  font-size: var(--text-base);
  line-height: 1;
  cursor: pointer;
  transition: opacity 0.12s, color 0.12s, background-color 0.12s;
  min-height: 20px;
  box-sizing: border-box;
}
.a-cpbtn:hover {
  opacity: 1;
  color: var(--color-accent);
  background: var(--color-hover);
}
.a-cpbtn svg {
  display: block;
  flex: none;
}
@media (hover: none) {
  .a-msg-ft {
    height: auto;
    margin-top: 6px;
  }
  .a-cpbtn {
    font-size: var(--text-sm);
    padding: 8px 10px;
    margin: -4px -6px;
  }
}
.a-msg .msg {
  font-size: var(--text-base);
  line-height: var(--leading-prose);
  color: var(--color-text);
  font-weight: 500;
}
.a-msg .msg :deep(p) { margin: 0; }
.a-msg .msg :deep(p + p) { margin-top: 8px; }
.a-msg > :deep(.think),
.a-msg > :deep(.block-list > .history-row > .think),
.a-msg > :deep(.tool-group),
.a-msg > :deep(.block-list > .history-row > .tool-group),
.a-msg > :deep(.activity-run),
.a-msg > :deep(.block-list > .history-row > .activity-run),
.a-msg > :deep(.agent-group),
.a-msg > :deep(.block-list > .history-row > .agent-group),
.a-msg > :deep(.tool-line),
.a-msg > :deep(.block-list > .history-row > .tool-line),
.a-msg > :deep(.media-tool),
.a-msg > :deep(.block-list > .history-row > .media-tool),
.a-msg > :deep(.ask-receipt),
.a-msg > :deep(.block-list > .history-row > .ask-receipt) {
  margin-top: var(--chat-block-gap);
}
.a-msg > :deep(.think),
.a-msg > :deep(.block-list > .history-row > .think),
.a-msg > :deep(.turn-fold),
.a-msg > :deep(.block-list > .history-row > .turn-fold),
.a-msg > :deep(.activity-run),
.a-msg > :deep(.block-list > .history-row > .activity-run) {
  margin-top: var(--chat-strip-gap);
}
.a-msg > :deep(.tool-line),
.a-msg > :deep(.block-list > .history-row > .tool-line),
.a-msg > :deep(.ntf-list),
.a-msg > :deep(.block-list > .history-row > .ntf-list) {
  margin-top: var(--chat-group-gap);
}
.a-msg > .msg + :deep(.tool-line),
.a-msg > :deep(.block-list > .history-row:has(> .msg) + .history-row > .tool-line),
.a-msg > .msg + :deep(.ntf-list),
.a-msg > :deep(.block-list > .history-row:has(> .msg) + .history-row > .ntf-list) {
  margin-top: var(--chat-strip-gap);
}
.a-msg > :deep(.tool-line + .tool-line),
.a-msg > :deep(.block-list > .history-row:has(> .tool-line) + .history-row > .tool-line),
.a-msg > :deep(.ntf-list + .tool-line),
.a-msg > :deep(.block-list > .history-row:has(> .ntf-list) + .history-row > .tool-line),
.a-msg > :deep(.tool-line + .ntf-list),
.a-msg > :deep(.block-list > .history-row:has(> .tool-line) + .history-row > .ntf-list) {
  margin-top: var(--chat-strip-tight);
}
.a-msg > :deep(.tool-line.open + .tool-line),
.a-msg > :deep(.block-list > .history-row:has(> .tool-line.open) + .history-row > .tool-line),
.a-msg > :deep(.ntf-list:has(.tool-line.open) + .tool-line),
.a-msg > :deep(.block-list > .history-row:has(> .ntf-list .tool-line.open) + .history-row > .tool-line),
.a-msg > :deep(.tool-line.open + .ntf-list),
.a-msg > :deep(.block-list > .history-row:has(> .tool-line.open) + .history-row > .ntf-list) {
  margin-top: var(--chat-group-gap);
}
.a-msg > :deep(.tool-line + .think),
.a-msg > :deep(.tool-line + .activity-run),
.a-msg > :deep(.ntf-list + .think),
.a-msg > :deep(.ntf-list + .activity-run),
.a-msg > :deep(.block-list > .history-row:has(> .tool-line) + .history-row > .think),
.a-msg > :deep(.block-list > .history-row:has(> .tool-line) + .history-row > .activity-run),
.a-msg > :deep(.block-list > .history-row:has(> .ntf-list) + .history-row > .think),
.a-msg > :deep(.block-list > .history-row:has(> .ntf-list) + .history-row > .activity-run) {
  margin-top: var(--chat-strip-tight);
}
.a-msg > :deep(.tool-line.open + .think),
.a-msg > :deep(.tool-line.open + .activity-run),
.a-msg > :deep(.ntf-list:has(.tool-line.open) + .think),
.a-msg > :deep(.ntf-list:has(.tool-line.open) + .activity-run),
.a-msg > :deep(.block-list > .history-row:has(> .tool-line.open) + .history-row > .think),
.a-msg > :deep(.block-list > .history-row:has(> .tool-line.open) + .history-row > .activity-run),
.a-msg > :deep(.block-list > .history-row:has(> .ntf-list .tool-line.open) + .history-row > .think),
.a-msg > :deep(.block-list > .history-row:has(> .ntf-list .tool-line.open) + .history-row > .activity-run) {
  margin-top: var(--chat-group-gap);
}

.a-msg > .msg:first-child,
.a-msg > :deep(.think:first-child),
.a-msg > :deep(.tool-group:first-child),
.a-msg > :deep(.activity-run:first-child),
.a-msg > :deep(.agent-group:first-child),
.a-msg > :deep(.tool-line:first-child),
.a-msg > :deep(.ntf-list:first-child),
.a-msg > :deep(.media-tool:first-child),
.a-msg > :deep(.ask-receipt:first-child),
.a-msg > :deep(.block-list:first-child > .history-row:first-child > .msg),
.a-msg > :deep(.block-list:first-child > .history-row:first-child > .think),
.a-msg > :deep(.block-list:first-child > .history-row:first-child > .tool-group),
.a-msg > :deep(.block-list:first-child > .history-row:first-child > .activity-run),
.a-msg > :deep(.block-list:first-child > .history-row:first-child > .agent-group),
.a-msg > :deep(.block-list:first-child > .history-row:first-child > .tool-line),
.a-msg > :deep(.block-list:first-child > .history-row:first-child > .ntf-list),
.a-msg > :deep(.block-list:first-child > .history-row:first-child > .media-tool),
.a-msg > :deep(.block-list:first-child > .history-row:first-child > .ask-receipt) {
  margin-top: 0;
}
.a-msg > :deep(.ntf-list),
.a-msg > :deep(.block-list > .history-row > .ntf-list) {
  margin-bottom: 0;
}
.a-msg > :deep(.block-list > .history-row > .agent-card) {
  margin: 0;
}
.a-msg > :deep(.block-list:last-child > .history-row:last-child > .agent-card) {
  margin-bottom: var(--space-1);
}
.a-msg :deep(:not(pre) > code:not(.md code)) {
  font: .9em var(--font-mono);
  background: var(--color-inline-code-bg);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-sm);
  padding: 1px 6px;
  color: var(--color-accent-hover);
}

@container (min-width: 760px) {
  .a-msg .msg :deep(.markstream-vue.markdown-renderer:has(.md-table-actions)) {
    content-visibility: visible;
  }

  .a-msg .msg :deep(.table-node-wrapper.md-table-wide) {
    --md-table-wide-full: calc(
      100cqi - var(--space-5) - var(--space-5) - var(--markdown-code-action-size) - var(--markdown-code-action-gap)
    );
    --md-table-wide-width: min(var(--md-table-wide-full), var(--p-table-wide-max));
    width: var(--md-table-wide-width);
    min-width: min(100%, var(--md-table-wide-width));
    max-width: var(--md-table-wide-width) !important;
    margin-left: calc(-0.5 * max(0px, (var(--markdown-code-action-size) + var(--markdown-code-action-gap)) - (var(--md-table-wide-full) - var(--md-table-wide-width))));
  }

  .a-msg .msg :deep(.table-node-wrapper:not(.md-table-wide)) {
    --table-cell-cap: min(var(--p-table-cell-max), 36cqi);
  }
}

.u-atts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
  margin-bottom: var(--space-2);
}
.u-media-rail {
  margin-bottom: var(--space-2);
}
.u-atts button.attachment-pill {
  appearance: none;
  border: none;
  background: none;
  padding-block: 0;
  font-family: inherit;
  font-size: inherit;
}

.sending-placeholder {
  align-self: flex-start;
  padding: var(--space-4) 0 10px;
}

.skill-act {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.skill-act-head {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--color-accent-hover);
  display: flex;
  align-items: center;
  gap: 6px;
}
.skill-act-arrow {
  color: var(--color-accent);
  font-size: var(--text-base);
}
.skill-act-args {
  font-size: var(--text-base);
  color: var(--color-text-faint);
  padding-left: 17px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

@media (max-width: 640px) {
  .chat {
    box-sizing: border-box;
    width: 100%;
    padding: 14px max(12px, var(--safe-right)) 18px max(12px, var(--safe-left));
  }
  .u-bub {
    max-width: min(88%, calc(100vw - 52px));
  }
  .a-msg {
    width: 100%;
    max-width: 100%;
  }
  .a-msg :deep(.md),
  .a-msg :deep(.markdown-renderer),
  .a-msg :deep(.code-block-container),
  .a-msg :deep(.diff-wrap),
  .a-msg :deep(pre) {
    max-width: 100%;
  }
  .a-msg :deep(.code-block-container pre),
  .a-msg :deep(.diff-pre) {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  .a-msg :deep(.media-tool.mob) {
    width: min(44vw, 160px);
  }
  .cd-label {
    min-width: 0;
    max-width: calc(100% - 48px);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cd-card {
    flex-wrap: wrap;
    white-space: normal;
    row-gap: 4px;
  }
  .u-edit-confirm {
    flex-wrap: wrap;
    justify-content: flex-end;
    max-width: calc(100vw - 28px);
  }
  .ts {
    font-size: var(--text-sm);
  }
  .chat-empty-text,
  .chat-loading-text {
    font-size: var(--ui-b1);
  }
  .cd-label {
    font-size: var(--text-base);
  }
}

.top-sentinel {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 0;
  min-height: 28px;
  user-select: none;
}
.top-sentinel-loading {
  opacity: 0.8;
}
.top-sentinel-text {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--color-text-faint);
  font-size: var(--text-sm);
}

.chat { background: transparent; }
.chat {
  gap: 0;
  padding: 22px 20px 26px;
}
.u-bub {
  background: var(--color-user-bubble-bg);
  border-radius: var(--radius-lg);
  padding: 10px 12px;
}
.a-msg {
  max-width: 100%;
  width: 100%;
}

.chat > .q-stack {
  margin-top: var(--chat-turn-gap);
}
.chat > .q-stack:first-child {
  margin-top: 0;
}
.q-stack {
  align-self: flex-end;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.q-head {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 6px;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
}
.q-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.q-title b {
  color: var(--color-accent-hover);
  font-weight: var(--weight-medium);
}
.q-turn {
  position: relative;
  flex-direction: row;
  align-items: center;
  justify-content: flex-end;
  gap: var(--space-2);
}
.q-send {
  flex: none;
  width: var(--space-6);
  height: var(--space-6);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  color: var(--color-text-on-accent);
  box-shadow: var(--shadow-xs);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.q-send:hover {
  background: var(--color-accent-hover);
}
.q-send:active {
  transform: scale(0.92);
}
.q-send:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}
.q-send svg {
  display: block;
  flex: none;
}
.q-bub {
  display: flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  background: var(--color-user-bubble-bg);
  padding: 8px 8px 8px 6px;
  transition: background var(--duration-fast) var(--ease-out);
}
.q-bub:hover {
  background: var(--color-hover);
}
.q-content {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-2);
}
.q-media-rail {
  width: min(100%, 320px);
}
.q-grip {
  flex: none;
  display: inline-flex;
  align-items: center;
  padding: 2px;
  color: var(--color-text-faint);
  cursor: grab;
  opacity: 0.7;
}
.q-grip:hover {
  opacity: 1;
}
.q-grip:active {
  cursor: grabbing;
}
.q-clamp {
  flex: 1;
  min-width: 0;
}
.q-body {
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  font: inherit;
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
  opacity: 0.82;
}
.q-bub:hover .q-body {
  opacity: 1;
}
.q-body:disabled {
  cursor: default;
}
.q-body :deep(.attachment-pill) {
  cursor: default;
}
.q-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.q-text-placeholder {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--color-text-muted);
}
.q-imgs {
  display: flex;
  gap: 4px;
  flex: none;
}
.q-file {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  border: var(--p-hairline) solid var(--color-line);
  color: var(--color-text-muted);
  font-size: calc(var(--text-base) - 3px);
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.q-bub .q-rm,
.q-bub .q-edit {
  width: 22px;
  height: 22px;
  color: var(--color-text-faint);
}
.q-bub .q-rm {
  opacity: 0;
  transition: opacity 0.12s ease, background 0.12s ease, color 0.12s ease;
}
.q-bub:hover .q-rm,
.q-bub:focus-within .q-rm,
.q-bub .q-rm:focus-visible {
  opacity: 1;
}
.q-bub .q-edit {
  display: none;
}

@media (hover: none) {
  .q-grip { display: none; }
  .q-bub .q-edit { display: inline-flex; }
  .q-bub .q-rm,
  .q-bub .q-edit {
    opacity: 1;
    position: relative;
  }
  .q-rm::before,
  .q-edit::before {
    content: "";
    position: absolute;
    inset: -11px;
  }
}
.q-turn.q-dragging .q-bub {
  opacity: 0.45;
}
.q-turn.drop-before::before,
.q-turn.drop-after::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--color-accent);
  border-radius: var(--radius-full);
  z-index: 1;
}
.q-turn.drop-before::before {
  top: -5px;
}
.q-turn.drop-after::after {
  bottom: -5px;
}

</style>
