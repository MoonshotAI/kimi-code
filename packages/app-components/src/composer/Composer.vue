<script lang="ts">
import type { PromptAttachment } from '@moonshot-ai/app-client/client';
import type { AttachmentEntry } from '@moonshot-ai/app-composer/features/attachment';
import type { ComposerDocumentSnapshot } from '@moonshot-ai/app-composer/model';

export interface ComposerSubmitPayload {
  text: string;
  restoreText: string;
  editText: string;
  attachments: PromptAttachment[];
  restoreEntries: AttachmentEntry[];
  snapshot?: ComposerDocumentSnapshot;
  skills?: { name: string; path?: string }[];
  forceQueue?: boolean;
}

export interface ComposerSteerPayload {
  text: string;
  restoreText: string;
  editText: string;
  attachments: PromptAttachment[];
  restoreEntries: AttachmentEntry[];
  snapshot?: ComposerDocumentSnapshot;
  skills?: { name: string; path?: string }[];
}

export interface ComposerCommandPayload {
  cmd: string;
  attachments: PromptAttachment[];
  restoreText?: string;
  skillName?: string;
  skillPath?: string;
  restoreEntries?: AttachmentEntry[];
  snapshot?: ComposerDocumentSnapshot;
  editText?: string;
  delivery?: 'steer' | 'queue';
  preserveDraft?: boolean;
}

export type ComposerEmits = {
  submit: [payload: ComposerSubmitPayload];
  steer: [payload: ComposerSteerPayload];
  steerQueued: [index: number];
  command: [payload: ComposerCommandPayload];
  interrupt: [];
  focusGoal: [];
  login: [];
  configureModel: [];
};

let composerMenuSequence = 0;
</script>

<script setup lang="ts">
import { useComposerNativeMenuHost } from './nativeMenus';
import { applyModelMenuDraft } from './modelMenuDraft';
import BrowserReferenceDetails from './BrowserReferenceDetails.vue';
import ContextSummaryBody, { resolveCompactPhase } from './ContextSummaryBody.vue';
import { useBrowserReferenceDetails } from './browserReferenceDetails';
import { BrowserScreenshotRecovery } from '@moonshot-ai/app-client/lib';
import { useComposerBrowserReferenceHost, restoreBrowserCaptureBookmark, browserReferenceAnchor, type BrowserCaptureResource } from './browserReferences';
import type { BrowserCapture, BrowserReference } from '@moonshot-ai/app-core/browser-reference';
import { newAttId } from '@moonshot-ai/app-composer/features/attachment';
import { composerSnapshotDocument, docToText } from '@moonshot-ai/app-composer/model';
import type { NativeMenuItem } from '@moonshot-ai/app-core/native-menu';
import { measureNaturalWidth, prepareWithSegments } from '@chenglou/pretext';
import { v4 as randomUUID } from 'uuid';
import { computed, inject, nextTick, onMounted, onUnmounted, ref, shallowRef, useId, watch, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { type AppModel, type ReadRequestOptions, type SessionContextSummary, type ThinkingLevel } from '@moonshot-ai/app-core/api';
import type { QuickModelMenuAction, QuickModelMenuPayload } from '@moonshot-ai/app-core/quick-model-menu';
import { analyzeLeadingSlashCommand, basename, buildSlashItems, formatShortcutText, formatTokens, providerDisplayName, type SlashCommand } from '@moonshot-ai/app-core/lib';
import { placeholderText } from '@moonshot-ai/app-core/lib';
import { useAppearance, useContextInspector } from '@moonshot-ai/app-core';
import type { IconName } from '@moonshot-ai/app-client/icons';
import type { PermissionMode, ToolMedia, TurnAttachment } from '@moonshot-ai/app-core/client/types';
import {
  effectiveThinkingLevel,
  effortLabel,
  isThinkingOn,
} from '@moonshot-ai/app-core/lib';
import { openAgentSettings, openHostSettings, useInputHistory, useIsMobile, useRunningSendMode } from '@moonshot-ai/app-client/composables';
import { slashMenuQuery, useSlashMenu } from '@moonshot-ai/app-client/composables';
import { useMentionMenu, type MentionEntry } from '@moonshot-ai/app-client/composables';
import { useComposerDraft } from '@moonshot-ai/app-client/composables';
import { useAttachmentUpload, usePasteImageAutoMention } from '@moonshot-ai/app-client/composables';
import { useKimiWebClient } from '@moonshot-ai/app-client/client';
import { hostsStore } from '@moonshot-ai/app-client/stores';
import {
  createComposerEditor,
  discardStashedEditorState,
  liveComposerEditorFor,
  registerLiveComposerEditor,
  type ComposerEditorApi,
} from '@moonshot-ai/app-composer/runtime';
import {
  adoptAttachment,
  attachmentReferenceName,
  rebaseAttachmentMediaOrdinals,
  type AttachmentInventoryState,
} from '@moonshot-ai/app-composer/features/attachment';
import { startMentionSelectionSync } from '@moonshot-ai/app-composer/features/mention';
import { mayStartWithSlashCommand, parseAttachmentLinks, removeAttachmentLinks, rewriteAttachmentLinksForSubmit, serializeAttachment, stripAttachmentLinks, submitNormalizedText } from '@moonshot-ai/app-composer/model';
import {
  applyEntryPatch,
  attachmentKind,
  buildSubmitPayload,
  composerAttachmentStore,
  createVideoThumbnail,
  orderedModelProviders,
  providerModelsForMenu,
  recentModelsForMenu,
  insertsAttachmentReference,
  mediaReorderTargetIndex,
  mergePatchedDraftEntries,
  pillSubmitBlockers,
  decideComposerSubmit,
  decideSubmitKind,
  planFileAttachment,
  planFolderAttachment,
  resetComposerAfterDispatch,
  retainAttachmentsForDeparture,
  rewriteInlineLinksForSubmit,
  seedEntriesForTurnAttachments,
  snapshotAttachmentEntries,
  unreferencedSeedFiles,
  type SubmitDecision,
  type AttachmentInputSource,
} from '@moonshot-ai/app-client/lib';
import { getKimiWebApi, sessionObservationOptions } from '@moonshot-ai/app-client/client';
import { composerSessionScope } from '@moonshot-ai/app-core/lib';
import {
  ContextRing,
  Icon,
  IconButton,
  Input,
  Kbd,
  Menu,
  MenuItem,
  Spinner,
  Tooltip,
  trackMenuSurface,
} from '@moonshot-ai/app-ui';
import { resolveComposerBinding } from '@moonshot-ai/app-client/contracts';
import { panelApiKey } from '@moonshot-ai/app-client/panel';
import BottomSheet from '../dialogs/BottomSheet.vue';
import MediaLightbox from '../chat/MediaLightbox.vue';
import ComposerMediaRail from './ComposerMediaRail.vue';
import ComposerScreenshotShortcut from './ComposerScreenshotShortcut.vue';
import MentionMenu from './MentionMenu.vue';
import SlashMenu from './SlashMenu.vue';
import ModelQuickMenu from './ModelQuickMenu.vue';
import { clampModelMenuMaxHeight } from './modelMenuLayout';

const props = defineProps<{
  variant?: 'full' | 'side-chat';
  workingOverride?: boolean;
  interruptArmed?: boolean;
  hideContext?: boolean;
  submitDisabled?: boolean;
  statusNote?: string;
  beforeSubmit?: () => boolean;
  deferSubmitReset?: boolean;
  draftScopeKey?: string;
  placeholderText?: string;
  extraBuiltinCommands?: readonly SlashCommand[];
  onCaptureScreenshot?: () => void;
  screenshotShortcutKeys?: string[];
  screenshotShortcutUnavailable?: boolean;
  screenshotShortcutFailureReason?: 'channel-disabled' | 'conflicted' | 'invalid';
  onConfigureScreenshotShortcut?: () => void;
}>();

const isSideChat = computed(() => props.variant === 'side-chat');

const { t, locale } = useI18n();
const panelApi = inject(panelApiKey, undefined);
const client = useKimiWebClient();

const sessionId = client.activeSessionId;
const scopeId = computed(() => props.draftScopeKey ?? sessionId.value);
const running = computed(() => client.activity.value !== 'idle');
const working = client.working;
const stopButtonVisible = computed(() => (isSideChat.value ? Boolean(props.workingOverride) : working.value));
const starting = client.isStartingFirstPrompt;
const queued = client.queued;
const compacting = computed(() => client.compaction?.value?.status === 'running');
const compactPhase = computed(() => resolveCompactPhase(client.compaction?.value, queued?.value));
const searchFiles = client.searchFiles;
const uploadImage = client.uploadImage;
const status = client.status;
const thinking = client.thinking;
const planMode = client.planMode;
const planArmed = client.planArmed;
const swarmMode = client.swarmMode;
const towerMode = client.towerMode;
const goalMode = client.goalMode;
const goal = client.goal;
const activationBadges = client.activationBadges;
const models = client.models;
const recentIds = client.recentModelIds;
const skills = client.skills;
const skillsLoaded = client.skillsLoaded;
const gateVerdict = client.chatGateVerdict;

const isMobile = useIsMobile();
const {
  runningSendMode,
  runningSendTipVisible,
  noteDefaultRunningSteerTriggered,
  dismissRunningSendTip,
} = useRunningSendMode();

function openRunningSendSettings(): void {
  dismissRunningSendTip();
  openAgentSettings(isMobile.value);
}

const modKeyLabel = computed(() => formatShortcutText(['mod'])[0] ?? 'Ctrl');

const placeholder = computed(() =>
  props.placeholderText !== undefined
    ? props.placeholderText
    : starting.value
      ? t('composer.starting')
      : running.value && !isSideChat.value
        ? runningSendMode.value === 'steer'
          ? isMobile.value
            ? t('composer.placeholderRunningSteerMobile')
            : t('composer.placeholderRunningSteer', { mod: modKeyLabel.value })
          : t(isMobile.value ? 'composer.placeholderRunningMobile' : 'composer.placeholderRunning')
        : goalMode.value
          ? t('status.goalPlaceholder')
          : planArmed.value || planMode.value
            ? t('status.planPlaceholder')
            : t(isMobile.value || isSideChat.value ? 'composer.placeholder' : 'composer.placeholderHints')
);

const emit = defineEmits<ComposerEmits>();

const browserReferenceHost = useComposerBrowserReferenceHost();
const browserDetails = useBrowserReferenceDetails(() => JSON.stringify([sessionId.value, client.activeWorkspaceId.value]));
const browserReferences = ref<BrowserReference[]>([]);
const browserCaptures = ref<BrowserCapture[]>([]);

const towerExperimentEnabled = computed(() => client.experimentalFlags.value['tower'] === true);
const towerAvailable = computed(() => client.towerModeAvailable.value);
const towerEntryEnabled = computed(() => towerExperimentEnabled.value && towerAvailable.value);
const planEnabled = computed(() => client.planModeAvailable.value);
const swarmEnabled = computed(() => client.swarmModeAvailable.value);
const goalEnabled = computed(() => client.goalModeAvailable.value);

const attachmentEntries = ref<AttachmentEntry[]>([]);
const attachmentInventoryState = shallowRef<AttachmentInventoryState>({
  orderedIds: [],
  activeIds: new Set(),
  refCounts: new Map(),
  resourceRevision: 0,
});
const activeAttachmentEntries = computed(() => {
  const byAttId = new Map(attachmentEntries.value.map((entry) => [entry.attId, entry] as const));
  return attachmentInventoryState.value.orderedIds
    .map((attId) => byAttId.get(attId))
    .filter((entry): entry is AttachmentEntry => entry !== undefined);
});

const promptPredictionIdle = computed(() =>
  client.experimentalFlags.value['prompt_prediction'] === true &&
  client.promptPredictionHasTurn?.value === true &&
  props.placeholderText === undefined &&
  !starting.value &&
  !isSideChat.value &&
  !running.value &&
  !goalMode.value &&
  !planArmed.value &&
  !planMode.value &&
  text.value.trim().length === 0 &&
  activeAttachmentEntries.value.length === 0
);
const promptPredictionSuggestion = computed(() => {
  const suggestion = client.promptPrediction?.value ?? null;
  if (!promptPredictionIdle.value || suggestion === null || suggestion.sessionId !== sessionId.value) return undefined;
  return suggestion;
});
const promptPredictionText = computed(() => promptPredictionSuggestion.value?.text);
const promptPredictionPlaceholderActive = computed(() => promptPredictionIdle.value || promptPredictionText.value !== undefined);
const promptPredictionPlaceholder = computed(() => promptPredictionText.value ?? placeholder.value);
const promptPredictionActionAvailable = computed(() => promptPredictionIdle.value);
const promptPredictionA11yId = useId();
const promptPredictionA11yText = computed(() => {
  const prediction = promptPredictionText.value;
  return prediction === undefined ? '' : t('composer.promptPredictionHint', { prediction });
});

const { text, editorRef, loadForEdit: loadTextForEdit, clearDraft, loadDraftAttachments, saveDraftAttachments, saveDraft, loadRestorableDraftSnapshot, saveDraftSnapshot } = useComposerDraft({
  sessionId: () => scopeId.value,
  onBeforeSessionSave: (sid) => {
    restoreBrowsingDraftForDeparture(sid);
    if (editor !== null && editorSessionScope === composerSessionScope(sid)) saveDraftSnapshot(sid, editor.getSnapshot());
  },
});

let insertedPromptPredictionRevision: string | undefined;
watch(promptPredictionSuggestion, (suggestion) => {
  if (suggestion?.accepted !== true) return;
  const revision = `${suggestion.predictionId}:${String(suggestion.acceptedRevision)}`;
  if (insertedPromptPredictionRevision === revision) return;
  insertedPromptPredictionRevision = revision;
  loadTextForEdit(suggestion.text);
  handleInput();
});

const highlightCommands = computed(() => buildSlashItems([], {
  towerEnabled: towerExperimentEnabled.value,
  planEnabled: planEnabled.value,
  swarmEnabled: swarmEnabled.value,
  goalEnabled: goalEnabled.value,
  extraBuiltins: props.extraBuiltinCommands,
}));

const pendingCommandArgument = computed(() => {
  if (isSideChat.value || !mayStartWithSlashCommand(text.value)) return null;
  const match = analyzeLeadingSlashCommand(submitNormalizedText(text.value), highlightCommands.value);
  if (!match?.item.argHint) return null;
  const hasArgument = text.value.slice(match.argumentRange.start, match.argumentRange.end).trim() !== '';
  return hasArgument ? null : { command: match.item.name, hint: t(match.item.argHint) };
});

const commandArgumentPlaceholder = computed(() => pendingCommandArgument.value?.hint ?? '');

const commandArgumentDescription = computed(() => {
  const pending = pendingCommandArgument.value;
  return pending ? t('composer.commandArgumentHint', { command: pending.command, argument: pending.hint }) : '';
});

const commandArgumentDescriptionId = useId();

let releaseAttachmentStore: (() => void) | null = null;
let inventoryReady = false;

function attachmentScope(sid = scopeId.value): string {
  return composerSessionScope(sid);
}

const activeMediaEntries = computed(() =>
  activeAttachmentEntries.value.filter(
    (entry): entry is AttachmentEntry & { kind: 'image' | 'video' } =>
      (entry.kind === 'image' || entry.kind === 'video') && entry.purpose !== 'browser-screenshot',
  ),
);
function referenceNameForAttachment(entry: AttachmentEntry): string {
  return attachmentReferenceName(entry, {
    image: t('composer.attachmentImage'),
    video: t('composer.attachmentVideo'),
  });
}
const attachmentMentionCandidates = computed(() =>
  activeAttachmentEntries.value.filter((entry) => entry.purpose !== 'browser-screenshot').map((entry) => ({
    entry,
    label: referenceNameForAttachment(entry),
  })),
);
const previewAttachmentId = ref<string | null>(null);
const previewAttachmentImg = ref<HTMLImageElement | null>(null);
function entryPreviewMedia(entry: AttachmentEntry & { kind: 'image' | 'video' }): ToolMedia {
  const local = entry.previewUrl?.startsWith('blob:') === true;
  return {
    kind: entry.kind,
    url: entry.previewUrl ?? '',
    name: entry.name,
    mimeType: entry.mediaType,
    bytes: entry.size,
    fileId: local ? undefined : entry.fileId,
    sessionId: local ? undefined : entry.sessionId,
  };
}
const previewMedia = computed<ToolMedia | null>(() => {
  const entry = activeMediaEntries.value.find((candidate) => candidate.attId === previewAttachmentId.value);
  return entry === undefined ? null : entryPreviewMedia(entry);
});
const previewImages = computed<ToolMedia[]>(() =>
  activeMediaEntries.value.filter((entry) => entry.kind === 'image').map(entryPreviewMedia),
);
const previewIndex = computed(() => {
  const entries = activeMediaEntries.value.filter((entry) => entry.kind === 'image');
  const index = entries.findIndex((entry) => entry.attId === previewAttachmentId.value);
  return index === -1 ? undefined : index;
});

function openMediaAttachment(entry: AttachmentEntry, img: HTMLImageElement | null): void {
  previewAttachmentId.value = entry.attId;
  previewAttachmentImg.value = img;
}

function closeMediaAttachment(): void {
  previewAttachmentId.value = null;
  previewAttachmentImg.value = null;
}

function removeMediaAttachment(attId: string): void {
  if (previewAttachmentId.value === attId) closeMediaAttachment();
  editor?.deactivateAttachment(attId);
}

function reorderMediaAttachment(attId: string, to: number): void {
  const mediaIds = activeMediaEntries.value.map((entry) => entry.attId);
  const targetIndex = mediaReorderTargetIndex(
    attachmentInventoryState.value.orderedIds,
    mediaIds,
    attId,
    to,
  );
  if (targetIndex !== null) editor?.reorderAttachment(attId, targetIndex);
}

function mentionMediaAttachment(entry: AttachmentEntry): void {
  const name = referenceNameForAttachment(entry);
  editor?.insertAttachment({
    attId: entry.attId,
    name,
    kind: entry.kind,
  });
}

function bindAttachmentStore(sid: string | undefined): AttachmentEntry[] {
  releaseAttachmentStore?.();
  const scope = attachmentScope(sid);
  const snapshot = loadRestorableDraftSnapshot(sid);
  const draft = snapshot?.attachments ?? loadDraftAttachments(sid);
  composerAttachmentStore.restore(scope, () => draft);
  releaseAttachmentStore = composerAttachmentStore.subscribe(scope, (entries) => {
    attachmentEntries.value = [...entries];
    if (!inventoryReady) return;
    const active = attachmentInventoryState.value.orderedIds
      .map((attId) => entries.find((entry) => entry.attId === attId))
      .filter((entry): entry is AttachmentEntry => entry !== undefined);
    saveDraftAttachments(sid, active);
    if (editor !== null && editorSessionScope === scope) saveDraftSnapshot(sid, editor.getSnapshot());
  });
  return draft.flatMap(({ attId }) => {
    const entry = composerAttachmentStore.entry(scope, attId);
    return entry === undefined ? [] : [entry];
  });
}

let historyEntrySnapshot: AttachmentEntry[] | null = null;
let restoringInputHistory = false;

function resetHistoryBrowse(): void {
  history.resetBrowsing();
  historyEntrySnapshot = null;
}

function restoreBrowsingDraftForDeparture(sid: string | undefined): void {
  history.restoreDraft(sid);
  if (historyEntrySnapshot !== null) {
    saveDraft(sid, text.value);
    saveDraftAttachments(sid, historyEntrySnapshot);
    historyEntrySnapshot = null;
  }
}

function handleInventoryChange(inventory: AttachmentInventoryState): void {
  if (editorSessionScope !== attachmentScope()) return;
  const previous = attachmentInventoryState.value;
  attachmentInventoryState.value = inventory;
  for (const attId of previous.activeIds) {
    if (!inventory.activeIds.has(attId)) composerAttachmentStore.abortUpload(attachmentScope(), attId);
  }
  let entries = composerAttachmentStore.entries(attachmentScope()).map((entry) => ({
    ...entry,
    refCount: inventory.refCounts.get(entry.attId) ?? 0,
  }));
  const rebasedEntries = rebaseAttachmentMediaOrdinals(entries, inventory.orderedIds);
  const mediaOrdinalsChanged = rebasedEntries.some(
    (entry, index) => entry.mediaOrdinal !== entries[index]?.mediaOrdinal,
  );
  entries = rebasedEntries;
  composerAttachmentStore.sync(attachmentScope(), entries);
  if (mediaOrdinalsChanged) queueMicrotask(() => editor?.refreshAttachmentLabels());
  composerAttachmentStore.releaseInactiveResources(attachmentScope(), inventory.activeIds);
  const activated = inventory.orderedIds.filter((attId) => !previous.activeIds.has(attId));
  if (activated.length > 0) {
    const activationScope = attachmentScope();
    queueMicrotask(() => {
      const ed = editor;
      if (ed === null || attachmentScope() !== activationScope) return;
      for (const attId of activated) {
        if (!ed.getAttachmentInventory().activeIds.has(attId)) continue;
        const entry = composerAttachmentStore.entry(attachmentScope(), attId);
        if (entry === undefined) continue;
        if (!ed.getAttachmentEntries().some((candidate) => candidate.attId === attId)) {
          ed.upsertAttachmentEntry(entry);
        }
        const source = composerAttachmentStore.source(attachmentScope(), attId);
        const remoteSource = composerAttachmentStore.remoteSource(attachmentScope(), attId);
        if (entry.fileId === undefined && source === undefined && remoteSource !== undefined && !composerAttachmentStore.uploadRunning(attachmentScope(), attId)) {
          upsertEditorAttachmentEntry({ ...entry, ...remoteSource });
          continue;
        }
        if (entry.purpose === 'browser-screenshot' && entry.fileId === undefined) {
          void recoverBrowserScreenshot(attId, true);
          continue;
        }
        if (entry.kind === 'video' && entry.thumbnailUrl === undefined && source !== undefined) {
          void mintVideoThumbnail(source, scopeId.value, attId, entry);
        }
        if (
          entry.uploading &&
          source !== undefined &&
          !composerAttachmentStore.uploadRunning(attachmentScope(), attId)
        ) {
          drivePillUpload(source, entry.name, scopeId.value, attId, uploadImage);
        }
      }
      remintMediaPreviews();
    });
  }
}

function upsertEditorAttachmentEntry(entry: AttachmentEntry): void {
  const destinationSid = scopeId.value;
  const destinationScope = attachmentScope(destinationSid);
  const foreignSession =
    entry.sessionId !== undefined && entry.sessionId !== destinationSid && entry.fileId !== undefined;
  if (!foreignSession) {
    composerAttachmentStore.upsert(destinationScope, entry);
    return;
  }
  const sourceSessionId = entry.sessionId!;
  const sourceFileId = entry.fileId!;
  const adopted: AttachmentEntry = {
    ...entry,
    uploading: true,
    uploadProgress: undefined,
    fileId: undefined,
    sessionId: undefined,
    error: undefined,
    previewUrl: undefined,
  };
  composerAttachmentStore.upsert(destinationScope, adopted);
  composerAttachmentStore.setRemoteSource(destinationScope, entry.attId, {
    sessionId: sourceSessionId, fileId: sourceFileId,
  });
  const adoptionTask = composerAttachmentStore.beginUpload(destinationScope, entry.attId);
  if (adoptionTask === null) return;
  const isCurrent = (): boolean =>
    composerAttachmentStore.uploadIsCurrent(destinationScope, entry.attId, adoptionTask.generation);
  const adoptionEntry = (): AttachmentEntry | undefined => {
    const current = composerAttachmentStore.entry(destinationScope, entry.attId);
    return current?.key === adopted.key && current.uploading === true ? current : undefined;
  };
  void getKimiWebApi().getSessionMediaBlob(sourceSessionId, sourceFileId, { signal: adoptionTask.signal })
    .then((blob) => {
      if (!isCurrent() || adoptionEntry() === undefined) return;
      composerAttachmentStore.setSource(destinationScope, entry.attId, blob);
      patchPillEntry(destinationSid, entry.attId, {
        size: blob.size || entry.size,
        mediaType: entry.mediaType || blob.type || undefined,
        previewUrl: URL.createObjectURL(blob),
      });
      if (entry.kind === 'video') {
        const current = composerAttachmentStore.entry(destinationScope, entry.attId);
        if (current !== undefined && current.thumbnailUrl === undefined) {
          void mintVideoThumbnail(blob, destinationSid, entry.attId, current);
        }
      }
      if (isCurrent()) drivePillUpload(blob, entry.name, destinationSid, entry.attId, uploadImage);
    })
    .catch(() => {
      if (!isCurrent() || adoptionEntry() === undefined) return;
      patchPillEntry(destinationSid, entry.attId, {
        uploading: false,
        error: 'upload-interrupted',
      });
      if (isCurrent()) {
        composerAttachmentStore.settleUpload(destinationScope, entry.attId, adoptionTask.generation);
      }
    });
}

function clearDraftAttachments(): void {
  saveDraftAttachments(scopeId.value, []);
  composerAttachmentStore.clear(attachmentScope());
  editor?.setText('', { entries: [] });
  if (editor !== null) handleInventoryChange(editor.getAttachmentInventory());
}

const editorHostRef = ref<HTMLElement | null>(null);
let editor: ComposerEditorApi | null = null;
let pendingDocumentSnapshot: ComposerDocumentSnapshot | undefined;
let editorSessionScope = composerSessionScope(scopeId.value);
let stopMentionSelectionSync: (() => void) | null = null;
let releaseLiveRegistration: (() => void) | null = null;

function refreshBrowserReferences(): void {
  if (editor === null) return;
  const snapshot = editor.getSnapshot();
  const captures = snapshot.browserCaptures ?? [];
  if (inventoryReady) browserReferenceHost?.syncMarkers(editor, captures);
  browserReferences.value = snapshot.browserReferences ?? [];
  browserCaptures.value = captures;
}

async function showBrowserReference(id: string, anchor?: HTMLElement): Promise<void> {
  const reference = browserReferences.value.find((entry) => entry.id === id);
  const capture = browserCaptures.value.find((entry) => entry.id === reference?.captureId);
  if (reference === undefined || capture === undefined) {
    client.notify({ severity: 'warning', title: t('browserReference.missing') });
    return;
  }
  const originScope = attachmentScope();
  const originWorkspace = client.activeWorkspaceId.value;
  const ed = editor;
  const image = attachmentEntries.value.find((entry) => entry.attId === capture.screenshot?.attachmentId);
  const screenshotState = capture.screenshot === undefined ? undefined : image?.uploading ? 'uploading' : image?.fileId === undefined || image.error !== undefined ? 'failed' : undefined;
  const result = browserReferenceHost === null
    ? await browserDetails.open({ reference, capture, thumbnail: image?.thumbnailUrl, screenshotState, canRetry: image !== undefined && browserScreenshotRecovery.canRecover(originScope, image.attId, { readRemote: readRemoteBrowserScreenshot }) })
    : await browserReferenceHost.edit(reference, capture, image?.thumbnailUrl, false, screenshotState, browserReferenceAnchor(anchor));
  if (result === null || editor !== ed || originScope !== attachmentScope() || client.activeWorkspaceId.value !== originWorkspace) return;
  ed?.updateBrowserReference(id, result.comment, result.includeScreenshot);
  if (result.retryScreenshot && image !== undefined) await recoverBrowserScreenshot(image.attId, true);
  if (result.locate && browserReferenceHost !== null && !(await browserReferenceHost.locate(capture))) client.notify({ severity: 'warning', title: t('browserReference.stale') });
}


async function acceptBrowserCapture(resource: BrowserCaptureResource, comment: string, bookmark: string, signal: AbortSignal, includeScreenshot = true): Promise<boolean> {
  const ed = editor;
  if (ed === null || signal.aborted) return false;
  const scope = attachmentScope();
  const capture = structuredClone(resource.capture);
  if (capture.screenshot !== undefined && resource.assetId === undefined) return false;
  if (!restoreBrowserCaptureBookmark(ed, bookmark, signal)) return false;
  if (resource.assetId !== undefined && capture.screenshot !== undefined) {
    const attId = newAttId();
    const entry: AttachmentEntry = {
      attId, key: `blob:${attId}`, kind: 'image', name: `browser-${resource.assetId}.png`, mediaType: 'image/png',
      size: resource.size, uploading: true, refCount: 0, purpose: 'browser-screenshot',
      browserAssetId: resource.assetId, thumbnailUrl: resource.thumbnail,
    };
    capture.screenshot.attachmentId = attId;
    composerAttachmentStore.upsert(scope, entry);
  }
  ed.insertBrowserReference(capture, { id: `br_${randomUUID()}`, captureId: capture.id, comment: comment || undefined, includeScreenshot: capture.target.kind === 'region' || includeScreenshot });
  ed.focus();
  return true;
}

let releaseBrowserTarget: (() => void) | undefined;

onMounted(() => {
  const host = editorHostRef.value;
  if (!host) return;
  window.addEventListener('online', recoverOnlineMedia);
  editorSessionScope = attachmentScope();
  const initialEntries = bindAttachmentStore(scopeId.value);
  editor = createComposerEditor(host, {
    initialText: text.value,
    initialSnapshot: pendingDocumentSnapshot ?? loadRestorableDraftSnapshot(scopeId.value) ?? undefined,
    onChange: (value) => {
      text.value = value;
      if (!restoringInputHistory) handleInput();
    },
    onSnapshotChange: (snapshot) => {
      if (inventoryReady && editorSessionScope === attachmentScope()) saveDraftSnapshot(scopeId.value, snapshot);
    },
    onBrowserReferenceOpen: (id, anchor) => { void showBrowserReference(id, anchor); },
    onBrowserReferencesChange: refreshBrowserReferences,
    handleKeyDown: (e) => handleKeydown(e),
    onBlur: handleEditorBlur,
    onWorkModeDismiss: clearWorkMode,
    onCompositionStart: handleCompositionStart,
    onCompositionEnd: handleCompositionEnd,
    pastedTextMeta: (lineCount) => t('composer.pastedTextLines', { n: lineCount }, lineCount),
    recognizeSlashCommands: !isSideChat.value,
    slashCommands: highlightCommands.value,
    attachments: {
      initialEntries,
      onInventoryChange: handleInventoryChange,
      getEntries: () => composerAttachmentStore.entries(attachmentScope()),
      upsertEntry: upsertEditorAttachmentEntry,
      patchEntry: (attId, patch) => {
        composerAttachmentStore.patch(attachmentScope(), attId, patch);
      },
      referenceName: referenceNameForAttachment,
    },
  });
  inventoryReady = true;
  refreshBrowserReferences();
  releaseBrowserTarget = browserReferenceHost?.registerTarget({ editor: () => editor, accept: acceptBrowserCapture });
  handleInventoryChange(editor.getAttachmentInventory());
  editor.refreshAttachmentLabels();
  editor.setEditable(!starting.value);
  editorRef.value = editor;
  stopMentionSelectionSync = startMentionSelectionSync(() => editorHostRef.value);

  watchEffect(() => {
    editor?.setWorkMode(
      workMode.value
        ? {
            mode: workMode.value,
            label: workMode.value === 'goal' ? t('status.goalLabel') : t('status.planLabel'),
            dismissLabel: t('status.workModeDismiss'),
          }
        : null,
    );
  });
  watchEffect(() => {
    editor?.setPlaceholder(commandArgumentPlaceholder.value || promptPredictionPlaceholder.value, {
      allowWhitespace: commandArgumentPlaceholder.value === '' && promptPredictionPlaceholderActive.value,
    });
  });

  function restoreSessionState(sid: string | undefined): void {
    if (!editor) return;
    inventoryReady = false;
    attachmentInventoryState.value = {
      orderedIds: [],
      activeIds: new Set(),
      refCounts: new Map(),
      resourceRevision: 0,
    };
    const scope = composerSessionScope(sid);
    const entries = bindAttachmentStore(sid);
    const snapshot = loadRestorableDraftSnapshot(sid);
    if (editor.restoreState(scope)) {
      const restored = editor.getText();
      if (restored !== text.value) text.value = restored;
    } else if (snapshot !== null) {
      editor.setSnapshot(snapshot);
    } else {
      editor.setText(text.value, { entries });
    }
    editorSessionScope = composerSessionScope(sid);
    inventoryReady = true;
    refreshBrowserReferences();
    handleInventoryChange(editor.getAttachmentInventory());
    remintMediaPreviews();
    releaseLiveRegistration?.();
    releaseLiveRegistration = registerLiveComposerEditor(scope, editor);
  }

  restoreSessionState(scopeId.value);
  remintMediaPreviews();
  adoptStoredDrafts();

  watch(
    () => scopeId.value,
    (newSid, oldSid) => {
      if (!editor || newSid === oldSid) return;
      const previousScope = composerSessionScope(oldSid);
      if (editorSessionScope === previousScope) editor.stashState(previousScope);
      restoreSessionState(newSid);
      adoptStoredDrafts();
    },
  );

  watch(text, (value) => {
    if (editor && value !== editor.getText()) {
      const staged = pendingSeedEntries;
      pendingSeedEntries = null;
      const entries = staged !== null
        ? staged
        : history.isBrowsing()
          ? []
          : activeAttachmentEntries.value;
      editor.setText(value, { entries });
    }
  });

  watch(
    attachmentEntries,
    () => {
      const sid = sessionId.value;
      for (const entry of attachmentEntries.value) {
        if (entry.sessionId !== undefined && entry.sessionId !== sid && entry.error === undefined) {
          patchPillEntry(scopeId.value, entry.attId, { error: 'upload-interrupted' });
        }
      }
    },
    { deep: true },
  );

  watch(
    () => starting.value,
    (starting) => editor?.setEditable(!starting),
  );

  watch(highlightCommands, (commands) => editor?.setSlashCommands(commands));

  watchEffect(() => {
    const dom = editor?.dom;
    if (!dom) return;
    dom.setAttribute('aria-label', t('composer.inputLabel'));
    dom.setAttribute('aria-placeholder', placeholderText(commandArgumentPlaceholder.value || promptPredictionPlaceholder.value));
    const descriptionIds = [
      commandArgumentDescription.value ? commandArgumentDescriptionId : '',
      promptPredictionA11yText.value ? promptPredictionA11yId : '',
    ].filter((id) => id !== '').join(' ');
    if (descriptionIds) dom.setAttribute('aria-describedby', descriptionIds);
    else dom.removeAttribute('aria-describedby');
    dom.setAttribute('aria-expanded', String(!!menuAriaControls.value));
    const controls = menuAriaControls.value;
    if (controls) dom.setAttribute('aria-controls', controls);
    else dom.removeAttribute('aria-controls');
    const activeDescendant = menuAriaActiveDescendant.value;
    if (activeDescendant) dom.setAttribute('aria-activedescendant', activeDescendant);
    else dom.removeAttribute('aria-activedescendant');
  });
});

onUnmounted(() => {
  releaseBrowserTarget?.();
  window.removeEventListener('online', recoverOnlineMedia);
  for (const timer of remintRetryTimers.values()) window.clearTimeout(timer);
  remintRetryTimers.clear();
  remintFailures.clear();
  const liveScope = attachmentScope();
  if (editorSessionScope === liveScope) restoreBrowsingDraftForDeparture(scopeId.value);
  if (editor && editorSessionScope === liveScope) {
    if (text.value !== editor.getText()) {
      editor.setText(text.value, { entries: editor.getAttachmentEntries() });
    }
    editor.stashState(liveScope);
    saveDraftSnapshot(scopeId.value, editor.getSnapshot());
  }
  releaseLiveRegistration?.();
  releaseLiveRegistration = null;
  releaseAttachmentStore?.();
  releaseAttachmentStore = null;
  stopMentionSelectionSync?.();
  editor?.destroy();
  editor = null;
  editorRef.value = null;
});

const expanded = ref(false);
function toggleExpand(): void {
  expanded.value = !expanded.value;
  void nextTick(() => {
    recomputeGrown();
    editor?.focus();
  });
}

function collapseAndRefit(): void {
  if (!expanded.value) return;
  expanded.value = false;
  void nextTick(recomputeGrown);
}

const RESTING_HEIGHT_FALLBACK_PX = 36;
function restingHeightPx(el: HTMLElement): number {
  if (typeof getComputedStyle === 'undefined') return RESTING_HEIGHT_FALLBACK_PX;
  const min = Number.parseFloat(getComputedStyle(el).minHeight);
  return Number.isFinite(min) && min > 0 ? min : RESTING_HEIGHT_FALLBACK_PX;
}
const isGrown = ref(false);
function recomputeGrown(): void {
  const el = editorHostRef.value;
  isGrown.value = !!el && el.scrollHeight > restingHeightPx(el);
}
watch(text, () => {
  void nextTick(recomputeGrown);
});
watch(locale, () => {
  editor?.refreshAttachmentLabels();
});

const history = useInputHistory({
  text, editorRef, sessionId: () => scopeId.value,
  hasAttachments: () => activeAttachmentEntries.value.length > 0,
  getSnapshot: () => editor?.getSnapshot(),
  onRecall: (value, snapshot, sid) => {
    const ed = editor;
    const scope = composerSessionScope(sid);
    if (ed === null || editorSessionScope !== scope) return;
    restoringInputHistory = true;
    try {
      if (snapshot === undefined) ed.setText(value, { entries: [] });
      else {
        composerAttachmentStore.load(scope, snapshot.attachments);
        ed.setSnapshot(snapshot);
      }
      if (scope === attachmentScope()) remintMediaPreviews();
    } finally {
      restoringInputHistory = false;
    }
  },
});

function armPlanMode(): void {
  if (planOn.value) return;
  if (goalMode.value) client.toggleGoalMode();
  client.togglePlanMode();
}
function armGoalMode(): void {
  if (goalActive.value) {
    emit('focusGoal');
    return;
  }
  if (goalMode.value) return;
  if (planOn.value) client.togglePlanMode();
  client.toggleGoalMode();
}

function insertMentionEntry(entry: MentionEntry, range: { start: number; end: number }): void {
  if (entry.kind === 'browser') {
    const capture = browserCaptures.value.find((candidate) => candidate.id === entry.captureId);
    if (capture !== undefined) editor?.insertBrowserReference(capture, { id: `br_${randomUUID()}`, captureId: capture.id }, range);
    return;
  }
  if (entry.kind === 'attachment') {
    editor?.insertAttachment(
      {
        attId: entry.attId,
        name: entry.name,
        kind: entry.attachmentKind,
      },
      range,
    );
    return;
  }
  editor?.insertMention(
    entry.kind === 'skill'
      ? { kind: 'skill', name: entry.name, path: entry.path }
      : { kind: entry.kind, name: entry.name, path: entry.path },
    range,
  );
}

const {
  open: slashOpen,
  items: slashItems,
  ranges: slashRanges,
  active: slashActive,
  update: updateSlashMenu,
  close: closeSlashMenu,
  dismiss: dismissSlashMenu,
  select: selectSlashCommand,
  complete: completeSlashCommand,
} = useSlashMenu({
  text,
  editorRef,
  skills: () => skills.value,
  insertSkillMention: insertMentionEntry,
  emitCommand: (cmd) => {
    if (cmd === '/plan') {
      armPlanMode();
      return;
    }
    if (cmd === '/goal') {
      armGoalMode();
      return;
    }
    if (cmd === '/swarm') {
      if (!swarmOn.value) void client.toggleSwarmMode();
      return;
    }
    if (cmd === '/tower') {
      void client.toggleTowerMode();
      return;
    }
    emit('command', { cmd, attachments: [] });
  },
  historyPush: (entry) => history.push(entry),
  clearDraft,
  towerEnabled: () => towerEntryEnabled.value,
  extraBuiltins: () => props.extraBuiltinCommands,
  planEnabled: () => planEnabled.value,
  swarmEnabled: () => swarmEnabled.value,
  goalEnabled: () => goalEnabled.value,
  resolveDesc: (item) => (item.isSkill ? item.desc : t(item.desc)),
});

const slashQuery = computed(() => slashMenuQuery(text.value) ?? '');

const menuAriaControls = computed(() => {
  if (slashOpen.value) return 'composer-slash-menu';
  if (mentionOpen.value) return 'composer-mention-menu';
  return undefined;
});
const menuAriaActiveDescendant = computed(() => {
  if (slashOpen.value && slashItems.value.length > 0) return `composer-slash-option-${slashActive.value}`;
  if (mentionOpen.value && mentionItems.value.length > 0) return `composer-mention-option-${mentionActive.value}`;
  return undefined;
});

const {
  open: mentionOpen,
  items: mentionItems,
  active: mentionActive,
  loading: mentionLoading,
  query: mentionQuery,
  sessionMenuOpen: mentionSessionMenuOpen,
  update: updateMentionMenu,
  close: closeMentionMenu,
  dismiss: dismissMentionMenu,
  select: selectMentionItem,
  complete: completeMentionItem,
  navigate: mentionNavigate,
  leaveSessionMenu: leaveMentionSessionMenu,
  getToken: getMentionToken,
} = useMentionMenu({
  text,
  editorRef,
  searchFiles: () => searchFiles,
  skills: () => skills.value,
  sessions: () => client.sessionMentionCandidates.value,
  searchSessions: client.searchSessionMentions,
  attachments: () => attachmentMentionCandidates.value,
  browsers: () => browserCaptures.value.map((capture) => ({
    captureId: capture.id, label: capture.label, title: capture.page.title, url: capture.page.url,
    thumbnail: attachmentEntries.value.find((entry) => entry.attId === capture.screenshot?.attachmentId)?.thumbnailUrl,
  })),
  insertMention: insertMentionEntry,
  completeMention: (completion, range) => {
    editor?.replaceTextRange(range, completion);
    if (isMobile.value && mentionOpen.value) {
      const live = getMentionToken();
      if (live) mentionSheetQuery.value = live.token;
      mentionSearchRef.value?.focus();
    }
  },
});

const mentionSubmenuTitle = computed(() => (mentionSessionMenuOpen.value ? t('mention.sessions') : undefined));

const slashSheetQuery = computed<string>({
  get: () => slashQuery.value,
  set: (v) => {
    text.value = `/${v}`;
    updateSlashMenu();
  },
});
const mentionSheetStart = ref<number | null>(null);
const mentionSheetQuery = ref('');
watch(mentionSheetQuery, (v) => {
  const start = mentionSheetStart.value;
  if (start == null || !mentionOpen.value) return;
  const val = text.value;
  const after = val.slice(start + 1);
  let ws = -1;
  for (let i = 0; i < after.length; i++) {
    if (/\s/.test(after[i]!)) {
      ws = i;
      break;
    }
  }
  const tokenEnd = ws === -1 ? val.length : start + 1 + ws;
  const anchored = val.slice(start, tokenEnd);
  if (anchored === `@${v}`) return;
  text.value = `${val.slice(0, start)}@${v}${val.slice(tokenEnd)}`;
  void nextTick(() => {
    const ed = editorRef.value;
    const pos = start + 1 + v.length;
    ed?.setSelectionRange(pos, pos);
    updateMentionMenu();
  });
});
const slashSearchRef = ref<InstanceType<typeof Input> | null>(null);
const mentionSearchRef = ref<InstanceType<typeof Input> | null>(null);
watch(slashOpen, (open) => {
  if (open && isMobile.value) void nextTick(() => slashSearchRef.value?.focus());
});
watch(mentionOpen, (open) => {
  if (open && isMobile.value) {
    const range = getMentionToken();
    mentionSheetStart.value = range?.start ?? null;
    mentionSheetQuery.value = range?.token ?? '';
    void nextTick(() => mentionSearchRef.value?.focus());
  } else {
    mentionSheetStart.value = null;
  }
});
function onSlashSheetClose(): void {
  closeSlashMenu();
}
function onMentionSheetClose(): void {
  closeMentionMenu();
}
function onAddSheetClose(): void {
  closeAddMenu();
}

const slashMenuRef = ref<InstanceType<typeof SlashMenu> | null>(null);
const mentionMenuRef = ref<InstanceType<typeof MentionMenu> | null>(null);
const slashMenuEl = computed(() => slashMenuRef.value?.el ?? null);
const mentionMenuEl = computed(() => mentionMenuRef.value?.el ?? null);
trackMenuSurface(slashOpen, slashMenuEl);
trackMenuSurface(mentionOpen, mentionMenuEl);

function onTokenMenuOutsidePointerDown(e: PointerEvent): void {
  const target = e.target as Node;
  const inside = [editorHostRef.value, slashMenuEl.value, mentionMenuEl.value].some((el) => el?.contains(target) === true);
  if (inside) return;
  closeSlashMenu();
  closeMentionMenu();
}

watch(
  () => !isMobile.value && (slashOpen.value || mentionOpen.value),
  (open) => {
    if (open) document.addEventListener('pointerdown', onTokenMenuOutsidePointerDown, true);
    else document.removeEventListener('pointerdown', onTokenMenuOutsidePointerDown, true);
  },
);

onUnmounted(() => {
  document.removeEventListener('pointerdown', onTokenMenuOutsidePointerDown, true);
});

watch(() => scopeId.value, () => {
  expanded.value = false;
  closeSlashMenu();
  closeMentionMenu();
});

function handleEditorBlur(): void {
  if (isMobile.value) return;
  closeSlashMenu();
  closeMentionMenu();
}

function handleInput(): void {
  resetHistoryBrowse();
  if (!isSideChat.value) {
    client.handlePromptPredictionInput();
    updateSlashMenu();
    updateMentionMenu();
  }
  if (slashOpen.value || mentionOpen.value || addMenuOpen.value) closeAddMenu();
}

function insertFolderPaths(paths: string[]): void {
  const ed = editor;
  resetHistoryBrowse();
  if (!ed) return;
  if (client.visibleWorkspace.value?.hostId !== undefined) {
    client.notify({ severity: 'warning', title: t('composer.localFolderOnRemote') });
    return;
  }
  let firstPos: number | undefined =
    document.activeElement === ed.dom ? (ed.selectionStart ?? undefined) : ed.getText().length;
  for (const path of paths) {
    const plan = planFolderAttachment(attachmentEntries.value, path);
    ed.insertAttachment({ attId: plan.attId, name: plan.name, kind: 'folder' }, firstPos);
    firstPos = undefined;
    if (plan.entry) ed.upsertAttachmentEntry(plan.entry);
  }
  closeSlashMenu();
  closeMentionMenu();
}

function insertPathMention(path: string, kind: 'file' | 'folder'): void {
  const ed = editor;
  resetHistoryBrowse();
  if (!ed) return;
  const pos = document.activeElement === ed.dom ? (ed.selectionStart ?? ed.getText().length) : ed.getText().length;
  ed.insertMention({ kind, name: basename(path) || path, path }, { start: pos, end: pos });
  closeSlashMenu();
  closeMentionMenu();
  ed.focus({ preventScroll: true });
}

function drivePillUpload(
  file: Blob,
  name: string,
  sid: string | undefined,
  attId: string,
  upload: typeof uploadImage,
): void {
  const scope = attachmentScope(sid);
  composerAttachmentStore.setSource(scope, attId, file);
  const task = composerAttachmentStore.beginUpload(scope, attId);
  if (task === null) return;
  const isCurrent = (): boolean =>
    composerAttachmentStore.uploadIsCurrent(scope, attId, task.generation);
  let lastPercent = -1;
  let lastProgressAt = 0;
  const onProgress = (loaded: number, total: number): void => {
    if (!isCurrent()) return;
    if (total <= 0) return;
    const percent = Math.floor((loaded / total) * 100);
    const now = Date.now();
    if (percent === lastPercent) return;
    if (loaded < total && now - lastProgressAt < 120) return;
    lastPercent = percent;
    lastProgressAt = now;
    patchPillEntry(sid, attId, { uploadProgress: loaded / total });
  };
  void upload(file, name, onProgress, task.signal).then((result) => {
    if (!isCurrent()) return;
    patchPillEntry(sid, attId, result ? { fileId: result.fileId, mediaType: result.mediaType, uploading: false, error: undefined, uploadProgress: undefined } : { uploading: false, error: 'upload-failed', uploadProgress: undefined });
    composerAttachmentStore.settleUpload(scope, attId, task.generation);
  }).catch(() => {
    if (!isCurrent()) return;
    patchPillEntry(sid, attId, { uploading: false, error: 'upload-failed', uploadProgress: undefined });
    composerAttachmentStore.settleUpload(scope, attId, task.generation);
  });
}

function mintVideoThumbnail(
  source: Blob,
  sid: string | undefined,
  attId: string,
  expected: Pick<AttachmentEntry, 'key' | 'size' | 'lastModified'>,
): Promise<void> {
  const scope = attachmentScope(sid);
  return createVideoThumbnail(source).then((thumbnailUrl) => {
    if (thumbnailUrl === undefined) return;
    const current = composerAttachmentStore.entry(scope, attId);
    const active = liveComposerEditorFor(scope)?.getAttachmentInventory().activeIds.has(attId) === true;
    if (
      !active ||
      current?.kind !== 'video' ||
      current.key !== expected.key ||
      current.size !== expected.size ||
      current.lastModified !== expected.lastModified
    ) return;
    patchPillEntry(sid, attId, { thumbnailUrl });
  });
}

function insertFileAttachments(
  files: readonly { file: File; path: string | null }[],
  context: {
    source: AttachmentInputSource;
    at?: { clientX: number; clientY: number };
  },
): boolean[] {
  const ed = editor;
  const upload = uploadImage;
  if (!ed || !upload) return files.map(() => false);
  const { pasteImageAutoMention } = usePasteImageAutoMention();
  const items: { attrs: { attId: string; name: string; kind: 'file' | 'image' | 'video' }; pos?: number; reference: boolean }[] = [];
  const uploads: { file: File; attId: string }[] = [];
  let dropPointAvailable = context.at !== undefined;
  let referenceTaken = false;
  for (const { file, path } of files) {
    const kind = attachmentKind(file.type);
    const reference = insertsAttachmentReference(kind, context.source, pasteImageAutoMention.value);
    let pos: number | undefined;
    if (reference) {
      if (dropPointAvailable && context.at !== undefined) {
        pos = ed.textOffsetAtCoords({ left: context.at.clientX, top: context.at.clientY }) ?? ed.getText().length;
        dropPointAvailable = false;
      } else if (!referenceTaken) {
        pos = document.activeElement === ed.dom ? (ed.selectionStart ?? undefined) : ed.getText().length;
      }
      referenceTaken = true;
    }
    const plan = planFileAttachment(attachmentEntries.value, { name: file.name, size: file.size, path, mediaType: file.type || undefined, lastModified: file.lastModified || undefined, kind });
    const previewUrl = kind !== 'file' ? URL.createObjectURL(file) : undefined;
    if (plan.entry) {
      const entry = previewUrl !== undefined ? { ...plan.entry, previewUrl } : plan.entry;
      composerAttachmentStore.upsert(attachmentScope(), entry, file);
      ed.upsertAttachmentEntry(entry);
    } else if (plan.startUpload) {
      const existing = attachmentEntries.value.find((entry) => entry.attId === plan.attId);
      const entry = {
        ...existing!,
        key: existing!.path !== undefined ? existing!.key : `blob:${plan.attId}`,
        uploading: true,
        error: undefined,
        uploadProgress: undefined,
        fileId: plan.resetRemoteIdentity ? undefined : existing!.fileId,
        sessionId: undefined,
        thumbnailUrl: plan.resetRemoteIdentity ? undefined : existing!.thumbnailUrl,
        size: file.size,
        mediaType: file.type || undefined,
        lastModified: file.lastModified || undefined,
        ...(previewUrl !== undefined ? { previewUrl } : {}),
      };
      composerAttachmentStore.upsert(attachmentScope(), entry, file);
      ed.upsertAttachmentEntry(entry);
    } else if (previewUrl !== undefined) {
      URL.revokeObjectURL(previewUrl);
    }
    const storedEntry = composerAttachmentStore.entry(attachmentScope(), plan.attId);
    if (kind === 'video' && storedEntry !== undefined && storedEntry.thumbnailUrl === undefined) {
      void mintVideoThumbnail(file, scopeId.value, plan.attId, storedEntry);
    }
    const referenceName = storedEntry === undefined ? file.name : referenceNameForAttachment(storedEntry);
    items.push({
      attrs: {
        attId: plan.attId,
        name: referenceName,
        kind,
      },
      pos,
      reference,
    });
    if (plan.startUpload) uploads.push({ file, attId: plan.attId });
  }
  ed.insertAttachments(items);
  for (const item of uploads) {
    drivePillUpload(item.file, item.file.name, scopeId.value, item.attId, upload);
  }
  return files.map(() => true);
}

function insertFileAttachment(
  file: File,
  path: string | null,
  context: {
    source: AttachmentInputSource;
    at?: { clientX: number; clientY: number };
  },
): boolean {
  return insertFileAttachments([{ file, path }], context)[0] ?? false;
}

const browserScreenshotRecovery = new BrowserScreenshotRecovery(composerAttachmentStore);

function readRemoteBrowserScreenshot(source: { sessionId: string; fileId: string }, signal: AbortSignal): Promise<Blob> {
  return getKimiWebApi().getSessionMediaBlob(source.sessionId, source.fileId, { signal });
}

function recoverBrowserScreenshot(attId: string, retry = false): Promise<boolean> {
  const sid = scopeId.value;
  const host = browserReferenceHost;
  return browserScreenshotRecovery.recover({
    scope: attachmentScope(sid), attId, retry,
    readAsset: host === null ? undefined : (id) => host.readAsset(id),
    readRemote: readRemoteBrowserScreenshot,
    patch: (patch) => patchPillEntry(sid, attId, patch),
    upload: (blob, name) => drivePillUpload(blob, name, sid, attId, uploadImage),
  });
}

function recoverOnlineMedia(): void {
  browserScreenshotRecovery.resetAttempts();
  remintMediaPreviews();
}

function insertScreenshotAnnotation(file: File, comment: string): boolean {
  const ed = editor;
  const upload = uploadImage;
  if (!ed || !upload) return false;
  const pos = document.activeElement === ed.dom ? (ed.selectionStart ?? undefined) : ed.getText().length;
  const kind = attachmentKind(file.type);
  const plan = planFileAttachment(attachmentEntries.value, {
    name: file.name,
    size: file.size,
    path: null,
    mediaType: file.type || undefined,
    lastModified: file.lastModified || undefined,
    kind,
  });
  const previewUrl = URL.createObjectURL(file);
  const entry = plan.entry === null
    ? undefined
    : { ...plan.entry, previewUrl };
  ed.insertAttachmentWithText(
    { attId: plan.attId, name: file.name, kind },
    comment,
    pos,
    entry,
  );
  if (entry === undefined) URL.revokeObjectURL(previewUrl);
  if (plan.startUpload) drivePillUpload(file, file.name, sessionId.value, plan.attId, upload);
  return true;
}

const remintInflight = new Set<string>();
const remintFailures = new Map<string, number>();
const remintRetryTimers = new Map<string, number>();
const MAX_REMINT_ATTEMPTS = 3;

function scheduleRemintRetry(inflightKey: string, destinationScope: string): void {
  const failures = (remintFailures.get(inflightKey) ?? 0) + 1;
  if (failures >= MAX_REMINT_ATTEMPTS) {
    remintFailures.delete(inflightKey);
    return;
  }
  remintFailures.set(inflightKey, failures);
  if (remintRetryTimers.has(inflightKey)) return;
  const timer = window.setTimeout(() => {
    remintRetryTimers.delete(inflightKey);
    if (editor !== null && attachmentScope() === destinationScope) remintMediaPreviews();
  }, 250 * (2 ** (failures - 1)));
  remintRetryTimers.set(inflightKey, timer);
}

function remintMediaPreviews(): void {
  if (editor === null) return;
  const api = getKimiWebApi();
  const destinationSid = scopeId.value;
  const destinationScope = attachmentScope(destinationSid);
  const activeIds = new Set(attachmentInventoryState.value.activeIds);
  for (const entry of composerAttachmentStore.entries(destinationScope)) {
    if (activeIds.has(entry.attId) && entry.purpose === 'browser-screenshot' && entry.fileId === undefined) {
      void recoverBrowserScreenshot(entry.attId);
      continue;
    }
    const missingImagePreview = entry.kind === 'image' && entry.previewUrl === undefined;
    const missingVideoThumbnail = entry.kind === 'video' && entry.thumbnailUrl === undefined;
    if (!activeIds.has(entry.attId) || entry.fileId === undefined || (!missingImagePreview && !missingVideoThumbnail)) continue;
    const { attId, fileId, sessionId: resourceSessionId } = entry;
    const inflightKey = `${destinationScope} ${resourceSessionId ?? ''} ${attId} ${fileId}`;
    if (remintInflight.has(inflightKey)) continue;
    remintInflight.add(inflightKey);
    const remintTask = composerAttachmentStore.beginUpload(destinationScope, attId);
    if (remintTask === null) {
      remintInflight.delete(inflightKey);
      continue;
    }
    const isCurrent = (): boolean =>
      composerAttachmentStore.uploadIsCurrent(destinationScope, attId, remintTask.generation);
    const readOptions = {
      signal: remintTask.signal,
      ...(entry.kind === 'video' ? { prefixBytes: 2 * 1024 * 1024 } : {}),
    };
    const request = resourceSessionId !== undefined
      ? api.getSessionMediaBlob(resourceSessionId, fileId, readOptions)
      : api.getFileBlob(fileId, readOptions);
    void request
      .then(async (blob) => {
        if (!isCurrent()) return;
        const current = composerAttachmentStore.entry(destinationScope, attId);
        if (
          current === undefined ||
          current.fileId !== fileId ||
          current.sessionId !== resourceSessionId
        ) return;
        if (current.kind === 'image' && current.previewUrl === undefined) {
          patchPillEntry(destinationSid, attId, { previewUrl: URL.createObjectURL(blob) });
        } else if (current.kind === 'video' && current.thumbnailUrl === undefined) {
          await mintVideoThumbnail(blob, destinationSid, attId, current);
        }
        remintFailures.delete(inflightKey);
      })
      .catch(() => {
        if (isCurrent()) scheduleRemintRetry(inflightKey, destinationScope);
      })
      .finally(() => {
        const stale = !isCurrent();
        if (isCurrent()) {
          composerAttachmentStore.settleUpload(destinationScope, attId, remintTask.generation);
        }
        remintInflight.delete(inflightKey);
        if (stale) {
          queueMicrotask(() => {
            const target = liveComposerEditorFor(destinationScope);
            const current = composerAttachmentStore.entry(destinationScope, attId);
            if (
              target?.getAttachmentInventory().activeIds.has(attId) === true &&
              current?.fileId === fileId &&
              current.sessionId === resourceSessionId &&
              current.previewUrl === undefined &&
              !composerAttachmentStore.uploadRunning(destinationScope, attId)
            ) remintMediaPreviews();
          });
        }
      });
  }
}

let pendingSeedEntries: AttachmentEntry[] | null = null;

const pendingFileAdoptions: TurnAttachment[] = [];

function adoptFileAttachment(att: TurnAttachment, at?: number): void {
  const ed = editor;
  if (!att.fileId) return;
  if (!ed) {
    pendingFileAdoptions.push(att);
    return;
  }
  resetHistoryBrowse();
  adoptAttachment(ed, {
    kind: 'file',
    name: att.name ?? 'file',
    size: att.size,
    mediaType: att.mediaType,
    uploading: false,
    fileId: att.fileId,
  }, at);
}

function adoptMediaAttachment(att: TurnAttachment, at?: number): void {
  const ed = editor;
  if (!att.fileId || !ed) return;
  history.resetBrowsing();
  const kind = att.kind === 'video' ? 'video' : 'image';
  adoptAttachment(ed, {
    kind,
    name: att.name ?? kind,
    size: att.size,
    mediaType: att.mediaType,
    uploading: false,
    fileId: att.fileId,
    sessionId: att.sessionId,
    mediaName: (ordinal) => `${t(kind === 'video' ? 'composer.attachmentVideo' : 'composer.attachmentImage')} ${ordinal}`,
  }, at);
  remintMediaPreviews();
}

function fetchAndHydrateUnbackedMedia(att: TurnAttachment, attId: string): void {
  const ed = editor;
  const upload = uploadImage;
  if (!ed || !upload) return;
  history.resetBrowsing();
  const destinationSid = scopeId.value;
  const destinationScope = attachmentScope(destinationSid);
  const kind = att.kind === 'video' ? 'video' : 'image';
  if (att.url === '') {
    patchPillEntry(destinationSid, attId, { uploading: false, error: 'upload-interrupted' });
    return;
  }
  const adoptionKey = composerAttachmentStore.entry(destinationScope, attId)?.key;
  const adoptionTask = composerAttachmentStore.beginUpload(destinationScope, attId);
  if (adoptionKey === undefined || adoptionTask === null) return;
  const isCurrent = (): boolean =>
    composerAttachmentStore.uploadIsCurrent(destinationScope, attId, adoptionTask.generation);
  const adoptionEntry = (): AttachmentEntry | undefined => {
    const current = composerAttachmentStore.entry(destinationScope, attId);
    return current?.key === adoptionKey && current.uploading === true ? current : undefined;
  };
  const superseded = (): boolean =>
    !isCurrent() && composerAttachmentStore.uploadRunning(destinationScope, attId);
  void fetch(att.url)
    .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(`media fetch ${res.status}`))))
    .then((blob) => {
      if (superseded() || adoptionEntry() === undefined) return;
      composerAttachmentStore.setSource(destinationScope, attId, blob);
      patchPillEntry(destinationSid, attId, {
        size: blob.size || att.size,
        mediaType: att.mediaType || blob.type || undefined,
        previewUrl: URL.createObjectURL(blob),
      });
      if (kind === 'video') {
        const current = composerAttachmentStore.entry(destinationScope, attId);
        if (current !== undefined && current.thumbnailUrl === undefined) {
          void mintVideoThumbnail(blob, destinationSid, attId, current);
        }
      }
      const target = liveComposerEditorFor(destinationScope);
      const targetInventory = target?.getAttachmentInventory();
      const active = targetInventory?.activeIds.has(attId) === true;
      if (isCurrent() || active) {
        drivePillUpload(blob, att.name ?? kind, destinationSid, attId, upload);
      } else {
        composerAttachmentStore.releaseInactiveResources(
          destinationScope,
          targetInventory?.activeIds ?? new Set(),
        );
      }
    })
    .catch(() => {
      if (superseded() || adoptionEntry() === undefined) return;
      patchPillEntry(destinationSid, attId, { uploading: false, error: 'upload-interrupted' });
      if (isCurrent()) {
        composerAttachmentStore.settleUpload(destinationScope, attId, adoptionTask.generation);
      }
    });
}

function patchPillEntry(
  sid: string | undefined,
  attId: string,
  patch: Parameters<ComposerEditorApi['updateAttachmentEntry']>[1],
): void {
  const scope = attachmentScope(sid);
  const live = liveComposerEditorFor(scope);
  if (live !== undefined) live.updateAttachmentEntry(attId, patch);
  else {
    const patched = composerAttachmentStore.patch(scope, attId, patch);
    saveDraftAttachments(sid, mergePatchedDraftEntries(loadDraftAttachments(sid), attId, patch, patched));
  }
  if (historyEntrySnapshot !== null && scope === attachmentScope()) {
    historyEntrySnapshot = applyEntryPatch(historyEntrySnapshot, attId, patch);
  }
}

const {
  fileInputRef,
  isDragOver,
  openFilePicker,
  addFiles,
  handleFileInputChange,
  handleDragOver,
  handleDragLeave,
  handleDrop,
  adoptStoredDrafts,
} = useAttachmentUpload({
  api: getKimiWebApi(),
  uploadImage: () => uploadImage,
  sessionId: () => scopeId.value,
  windowDrop: () => !isSideChat.value,
  dropSurfaceVisible: () => (editorHostRef.value?.closest('.composer')?.getClientRects().length ?? 0) > 0,
  insertFolderPaths,
  insertFileAttachment,
  insertFileAttachments,
  adoptFileAttachment,
  adoptMediaAttachment,
  pasteTarget: () => {
    const active = document.activeElement;
    if (active === editor?.dom) return 'editor';
    const composer = editorHostRef.value?.closest('.composer');
    return active instanceof Node && composer?.contains(active) ? 'composer' : 'ignore';
  },
});

void fileInputRef;

onMounted(() => {
  if (text.value) {
    void nextTick(recomputeGrown);
  }
});

onUnmounted(() => {
  clearCompositionEndTimer();
});

function focus(): void {
  editor?.focus({ preventScroll: true });
}

function insertQuote(quote: string, comment?: string, source?: string): void {
  editor?.insertQuote({ text: quote, ...(source !== undefined && source.length > 0 ? { source } : {}) }, comment);
}

function loadAttachmentsForEdit(atts: TurnAttachment[]): void {
  const seedEntries = seedEntriesForTurnAttachments(atts);
  pendingSeedEntries = seedEntries;
  void nextTick(() => {
    const stagedEntries = pendingSeedEntries;
    pendingSeedEntries = null;
    const ed = editor;
    if (!ed) return;
    if (stagedEntries !== null) {
      ed.setText(text.value, {
        entries: stagedEntries,
      });
    }
    const referenced = new Set(ed.getOrderedAttachmentIds());
    const linkNames = new Map(parseAttachmentLinks(ed.getText()).map((link) => [link.attrs.attId, link.attrs.name] as const));
    for (const entry of seedEntries) {
      const linkedName = linkNames.get(entry.attId);
      ed.upsertAttachmentEntry(
        referenced.has(entry.attId) && linkedName !== undefined
          ? entry.kind === 'image' || entry.kind === 'video'
            ? entry
            : { ...entry, name: linkedName }
          : entry,
      );
    }
    remintMediaPreviews();
    const unreferencedFiles = new Map(unreferencedSeedFiles(atts, referenced).map(({ att, ordinal }) => [att, ordinal] as const));
    let mediaOrdinal = 0;
    for (const att of atts) {
      if (att.kind === 'image' || att.kind === 'video') {
        mediaOrdinal += 1;
        if (att.fileId === undefined) fetchAndHydrateUnbackedMedia(att, `m${mediaOrdinal}`);
        continue;
      }
      const ordinal = unreferencedFiles.get(att);
      if (ordinal !== undefined) {
        const anchor = parseAttachmentLinks(ed.getText()).find((link) => {
          const attIndex = Number(link.attrs.attId);
          return Number.isInteger(attIndex) && attIndex > ordinal;
        });
        const entry = seedEntries.find((candidate) => candidate.attId === String(ordinal));
        if (entry !== undefined) {
          ed.insertAttachment(
            { attId: entry.attId, name: entry.name, kind: entry.kind },
            anchor?.start,
          );
        }
      }
    }
  });
}

function loadForEdit(value: string, snapshot?: ComposerDocumentSnapshot): void {
  discardStashedEditorState(attachmentScope());
  if (snapshot === undefined) {
    loadTextForEdit(value);
    return;
  }
  composerAttachmentStore.load(attachmentScope(), snapshot.attachments);
  if (editor === null) {
    pendingDocumentSnapshot = snapshot;
    loadTextForEdit(docToText(composerSnapshotDocument(snapshot)));
    saveDraftSnapshot(scopeId.value, snapshot);
    return;
  }
  editor.setSnapshot(snapshot);
  remintMediaPreviews();
  void nextTick(() => editor?.focus());
}

function restoreDraftEntries(entries: AttachmentEntry[]): void {
  const restoredEntries = snapshotAttachmentEntries(entries);
  const ed = editor;
  if (!ed) {
    pendingSeedEntries = restoredEntries;
    return;
  }
  composerAttachmentStore.load(attachmentScope(), restoredEntries);
  ed.setText(text.value, { entries: restoredEntries });
  remintMediaPreviews();
}

const pillGate = computed(() => {
  void text.value;
  return pillSubmitBlockers(
    activeAttachmentEntries.value,
    editor?.getOrderedAttachmentIds() ?? [],
    { sessionId: sessionId.value },
  );
});

function submitAssembly(): { promptAttachments: PromptAttachment[]; fileAttIds: string[]; mediaAttIds: string[] } {
  const submit = buildSubmitPayload(
    attachmentInventoryState.value.orderedIds,
    activeAttachmentEntries.value,
    { sessionId: sessionId.value },
  );
  return {
    promptAttachments: submit.promptAttachments,
    fileAttIds: submit.fileAttIds,
    mediaAttIds: submit.mediaAttIds,
  };
}

function rewriteForSubmit(trimmed: string, indexes: { fileAttIds: readonly string[]; mediaAttIds: readonly string[] }): string {
  return rewriteAttachmentLinksForSubmit(trimmed, indexes, {
    resolveFolder: (attId) => attachmentEntries.value.find((e) => e.attId === attId)?.path,
    resolveMediaName: (attId, ordinal) => {
      const entry = attachmentEntries.value.find((candidate) => candidate.attId === attId);
      return entry === undefined ? undefined : referenceNameForAttachment({ ...entry, mediaOrdinal: ordinal });
    },
  });
}

function preserveAttachmentPills(): () => void {
  const ed = editor;
  if (!ed) return () => {};
  const byAttId = new Map(attachmentEntries.value.map((entry) => [entry.attId, entry] as const));
  const sequence = parseAttachmentLinks(ed.getText()).map((match) => match.attrs);
  if (sequence.length === 0) return () => {};
  return () => {
    void nextTick(() => {
      const target = editor;
      if (!target) return;
      const upserted = new Set<string>();
      for (const attrs of sequence) {
        const entry = byAttId.get(attrs.attId);
        if (entry === undefined) continue;
        target.insertAttachment({ ...attrs, attId: entry.attId, kind: entry.kind });
        if (!upserted.has(attrs.attId)) {
          target.upsertAttachmentEntry(entry);
          upserted.add(attrs.attId);
        }
      }
    });
  };
}

type AttachmentLinkAttrs = ReturnType<typeof parseAttachmentLinks>[number]['attrs'];

function persistPillsForDeparture(
  entries: readonly AttachmentEntry[],
  sequence: readonly AttachmentLinkAttrs[],
): void {
  const byAttId = new Map(entries.map((entry) => [entry.attId, entry] as const));
  const links: string[] = [];
  for (const attrs of sequence) {
    const entry = byAttId.get(attrs.attId);
    if (entry === undefined) continue;
    links.push(serializeAttachment({ ...attrs, attId: entry.attId, kind: entry.kind }));
  }
  const kept = retainAttachmentsForDeparture(entries, sequence.map((attrs) => attrs.attId));
  if (links.length === 0 && kept.length === 0) return;
  saveDraftAttachments(scopeId.value, kept);
  text.value = links.join(' ');
}

function submitCommandContext() {
  return {
    skillMentions: editor?.getSkillMentions() ?? [],
    skills: skills.value,
    skillsLoaded: skillsLoaded.value,
    working: working.value,
    running: running.value,
    queueLength: queued.value.length,
    goalMode: goalMode.value,
    towerEnabled: towerExperimentEnabled.value,
    towerAvailable: towerAvailable.value,
    towerActive: towerOn.value,
    extraBuiltins: props.extraBuiltinCommands,
    planEnabled: planEnabled.value,
    swarmEnabled: swarmEnabled.value,
    goalEnabled: goalEnabled.value,
  };
}

function currentSubmitDecision(): SubmitDecision {
  if (props.submitDisabled === true) return { kind: 'noop' };
  const trimmed = text.value.trim();
  const assembly = submitAssembly();
  if (isSideChat.value) {
    if (!trimmed && assembly.promptAttachments.length === 0) return { kind: 'noop' };
    if (pillGate.value.uploading || pillGate.value.errored || pillGate.value.missing) return { kind: 'noop' };
    const rewritten = rewriteForSubmit(trimmed, assembly);
    const historyText = trimmed !== '' && removeAttachmentLinks(trimmed).trim() === '' ? '' : stripAttachmentLinks(rewritten);
    return { kind: 'submit', text: rewriteInlineLinksForSubmit(rewritten).trim(), restoreText: trimmed, editText: rewritten, attachments: assembly.promptAttachments, historyText };
  }
  return decideComposerSubmit({
    text: trimmed,
    rewritten: rewriteForSubmit(trimmed, assembly),
    blocked: pillGate.value.uploading || pillGate.value.errored || pillGate.value.missing,
    assembly,
    ...submitCommandContext(),
  });
}

const canSend = computed(() => {
  if (props.submitDisabled === true) return false;
  const trimmed = text.value.trim();
  const assembly = submitAssembly();
  const blocked = pillGate.value.uploading || pillGate.value.errored || pillGate.value.missing;
  if (isSideChat.value) return (trimmed !== '' || assembly.promptAttachments.length > 0) && !blocked;
  return decideSubmitKind({
    text: trimmed,
    blocked,
    assembly,
    ...submitCommandContext(),
  }).kind !== 'noop';
});

const clearDispatchPolicy = {
  attachments: 'clear',
  mentionMenu: 'close',
} as const;
const preserveDispatchPolicy = {
  attachments: 'preserve',
  mentionMenu: 'preserve',
} as const;

function resetAfterDispatch(
  policy: typeof clearDispatchPolicy | typeof preserveDispatchPolicy,
): void {
  resetComposerAfterDispatch(
    {
      setText: (value) => {
        text.value = value;
      },
      clearDraft,
      clearDraftAttachments,
      closeSlashMenu,
      closeMentionMenu,
      collapse: collapseAndRefit,
    },
    policy,
  );
}

function clearAfterDispatch(expectedSnapshot?: ComposerDocumentSnapshot): void {
  if (props.deferSubmitReset === true && expectedSnapshot !== undefined) {
    const current = editor?.getSnapshot();
    if (
      current === undefined ||
      docToText(composerSnapshotDocument(current)) !== docToText(composerSnapshotDocument(expectedSnapshot)) ||
      JSON.stringify(current.attachmentOrder) !== JSON.stringify(expectedSnapshot.attachmentOrder) ||
      JSON.stringify(current.browserReferences ?? []) !== JSON.stringify(expectedSnapshot.browserReferences ?? [])
    ) return;
  }
  resetAfterDispatch(clearDispatchPolicy);
}

function passSubmitGate(): boolean {
  if (props.beforeSubmit !== undefined && props.beforeSubmit() === false) return false;
  if (hostSetupId.value !== undefined) {
    openHostSetup();
    return false;
  }
  return true;
}

function handleRunningSend(delivery: 'steer' | 'queue'): void {
  const decision = currentSubmitDecision();
  if (
    decision.kind !== 'submit' &&
    decision.kind !== 'multi-skill-activation' &&
    !(decision.kind === 'prompt-command' && decision.target === 'main')
  ) {
    return;
  }
  if (!passSubmitGate()) return;
  const snapshot = editor?.getSnapshot();
  const restoreEntries = snapshotAttachmentEntries(activeAttachmentEntries.value);
  history.push(decision.historyText, snapshot);
  historyEntrySnapshot = null;
  if (props.deferSubmitReset !== true || decision.kind === 'prompt-command') clearAfterDispatch();
  if (decision.kind === 'prompt-command') {
    emit('command', { cmd: decision.cmd, attachments: decision.attachments, restoreText: decision.restoreText, restoreEntries, snapshot, editText: decision.editText, delivery });
    return;
  }
  if (delivery === 'steer') {
    emit('steer', { text: decision.text, restoreText: decision.restoreText, editText: decision.editText, attachments: decision.attachments, restoreEntries, snapshot, ...(decision.kind === 'multi-skill-activation' ? { skills: decision.skills } : {}) });
    return;
  }
  emit('submit', { text: decision.text, restoreText: decision.restoreText, editText: decision.editText, attachments: decision.attachments, restoreEntries, snapshot, ...(decision.kind === 'multi-skill-activation' ? { skills: decision.skills } : {}), forceQueue: true });
}

function handleSteer(): void {
  handleRunningSend('steer');
}

function handleQueue(): void {
  handleRunningSend('queue');
}

function handleSubmit(): void {
  const decision = currentSubmitDecision();
  if (decision.kind === 'noop') return;
  if (decision.kind === 'disabled-command') {
    client.notify({ severity: 'warning', title: t('composer.disabledCommand', { cmd: decision.cmd }) });
    return;
  }
  if (decision.kind === 'invalid-command') {
    client.notify({ severity: 'warning', title: t('composer.noArgCommand', { cmd: decision.cmd }) });
    return;
  }
  const sessionBound =
    decision.kind === 'submit' ||
    decision.kind === 'multi-skill-activation' ||
    decision.kind === 'skill-activation' ||
    decision.kind === 'skill-command' ||
    decision.kind === 'unresolved-skill-command' ||
    decision.kind === 'prompt-command' ||
    (decision.kind === 'builtin-command' && decision.leave === true);
  if (sessionBound && !passSubmitGate()) return;
  if (!isSideChat.value) client.handlePromptPredictionSubmit(text.value);
  const snapshot = editor?.getSnapshot();
  const restoreEntries = snapshotAttachmentEntries(activeAttachmentEntries.value);
  history.push(decision.historyText, snapshot);
  historyEntrySnapshot = null;

  switch (decision.kind) {
    case 'mode': {
      const restorePills = preserveAttachmentPills();
      resetAfterDispatch(preserveDispatchPolicy);
      if (decision.mode === 'plan') armPlanMode();
      else if (decision.mode === 'goal') armGoalMode();
      else if (decision.mode === 'swarm') {
        if (!swarmOn.value) void client.toggleSwarmMode();
      } else if (decision.mode === 'tower') {
        if (!towerOn.value) void client.toggleTowerMode();
      }
      restorePills();
      return;
    }

    case 'skill-activation':
    case 'skill-command':
    case 'unresolved-skill-command': {
      resetAfterDispatch(clearDispatchPolicy);
      const skillName = decision.kind === 'unresolved-skill-command'
        ? undefined
        : decision.skillName;
      emit('command', {
        cmd: decision.cmd,
        attachments: decision.attachments,
        restoreText: decision.restoreText,
        ...(skillName !== undefined ? { skillName } : {}),
        skillPath: decision.kind === 'skill-activation' ? decision.skillPath : undefined,
        restoreEntries, snapshot,
      });
      return;
    }

    case 'prompt-command': {
      resetAfterDispatch(clearDispatchPolicy);
      const delivery =
        !isSideChat.value && running.value && decision.target === 'main'
          ? runningSendMode.value
          : undefined;
      if (delivery === 'steer') noteDefaultRunningSteerTriggered();
      emit('command', {
        cmd: decision.cmd,
        attachments: decision.attachments,
        restoreText: decision.restoreText,
        restoreEntries,
        snapshot,
        editText: decision.editText,
        ...(delivery !== undefined ? { delivery } : {}),
      });
      return;
    }

    case 'builtin-command': {
      const departurePills = decision.leave
        ? parseAttachmentLinks(editor?.getText() ?? '').map((match) => match.attrs)
        : [];
      resetAfterDispatch(preserveDispatchPolicy);
      if (decision.leave) {
        persistPillsForDeparture(restoreEntries, departurePills);
        emit('command', { cmd: decision.cmd, attachments: [], restoreText: decision.restoreText, restoreEntries, snapshot });
        return;
      }
      const restorePills = preserveAttachmentPills();
      restorePills();
      emit('command', { cmd: decision.cmd, attachments: [], restoreText: decision.restoreText, restoreEntries, snapshot, editText: decision.editText });
      return;
    }

    case 'submit':
    case 'multi-skill-activation': {
      const payload = {
        text: decision.text,
        restoreText: decision.restoreText,
        editText: decision.editText,
        attachments: decision.attachments,
        restoreEntries,
        snapshot,
        ...(decision.kind === 'multi-skill-activation' ? { skills: decision.skills } : {}),
      };
      if (props.deferSubmitReset !== true) clearAfterDispatch();
      if (!isSideChat.value && running.value) {
        if (runningSendMode.value === 'steer') {
          noteDefaultRunningSteerTriggered();
          emit('steer', payload);
          return;
        }
        emit('submit', { ...payload, forceQueue: true });
        return;
      }
      emit('submit', payload);
      return;
    }
  }
}

let isComposingText = false;
let compositionEndTimer: ReturnType<typeof setTimeout> | null = null;

function clearCompositionEndTimer(): void {
  if (compositionEndTimer !== null) {
    clearTimeout(compositionEndTimer);
    compositionEndTimer = null;
  }
}

function handleCompositionStart(): void {
  clearCompositionEndTimer();
  isComposingText = true;
}

function handleCompositionEnd(): void {
  clearCompositionEndTimer();
  compositionEndTimer = setTimeout(() => {
    compositionEndTimer = null;
    isComposingText = false;
  }, 0);
}

function isComposingKeyEvent(e: KeyboardEvent): boolean {
  return isComposingText || e.isComposing || e.keyCode === 229;
}

function acceptPromptPrediction(key: 'tab' | 'right'): boolean {
  if (!promptPredictionActionAvailable.value) return false;
  const prediction = client.acceptPromptPrediction(key);
  return prediction !== null || (client.promptPredictionPending?.value ?? null) !== null;
}

function handleKeydown(e: KeyboardEvent): boolean {
  if (isComposingKeyEvent(e)) return false;

  if (workMode.value && e.key === 'Backspace' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
    const sel = editorRef.value;
    if (sel?.selectionStart === 0 && sel.selectionEnd === 0) {
      e.preventDefault();
      clearWorkMode();
      return true;
    }
  }

  if (e.key === 'Escape') {
    if (addMenuOpen.value) {
      e.preventDefault();
      closeAddMenu();
      return true;
    }
    if (dropdownOpen.value) {
      e.preventDefault();
      closeDropdown();
      return true;
    }
    if (permDropdownOpen.value) {
      e.preventDefault();
      closePermDropdown();
      return true;
    }
    if (ctxCardOpen.value) {
      e.preventDefault();
      closeCtxCard();
      return true;
    }
  }

  if (slashOpen.value) {
    if (e.key === 'Escape') {
      e.preventDefault();
      dismissSlashMenu();
      return true;
    }
    if (e.key === 'Tab' && slashItems.value.length === 0) {
      closeSlashMenu();
      return false;
    }
  }
  if (slashOpen.value && slashItems.value.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      slashActive.value = (slashActive.value + 1) % slashItems.value.length;
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      slashActive.value = (slashActive.value - 1 + slashItems.value.length) % slashItems.value.length;
      return true;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = slashItems.value[slashActive.value];
      if (item) selectSlashCommand(item);
      return true;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const item = slashItems.value[slashActive.value];
      if (item) completeSlashCommand(item);
      return true;
    }
  }

  if (mentionOpen.value) {
    if (e.key === 'Escape') {
      e.preventDefault();
      dismissMentionMenu();
      return true;
    }
    if (e.key === 'Backspace' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && mentionSessionMenuOpen.value && getMentionToken()?.token === '') {
      e.preventDefault();
      leaveMentionSessionMenu();
      return true;
    }
    if (e.key === 'Tab' && mentionItems.value.length === 0) {
      closeMentionMenu();
      return false;
    }
    if (e.key === 'Enter' && mentionItems.value.length === 0 && mentionLoading.value) {
      e.preventDefault();
      return true;
    }
    if (mentionItems.value.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionNavigate((mentionActive.value + 1) % mentionItems.value.length);
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionNavigate((mentionActive.value - 1 + mentionItems.value.length) % mentionItems.value.length);
        return true;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const item = mentionItems.value[mentionActive.value];
        if (item) selectMentionItem(item);
        return true;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const item = mentionItems.value[mentionActive.value];
        if (item) completeMentionItem(item);
        return true;
      }
    }
  }

  if (
    (e.key === 'Tab' || e.key === 'ArrowRight') &&
    !e.shiftKey &&
    !e.altKey &&
    !e.metaKey &&
    !e.ctrlKey &&
    acceptPromptPrediction(e.key === 'Tab' ? 'tab' : 'right')
  ) {
    e.preventDefault();
    return true;
  }

  if (e.key === 's' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    if (!isSideChat.value && !e.repeat && running.value) {
      if (queued.value.length > 0) emit('steerQueued', 0);
      else handleSteer();
    }
    return true;
  }

  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && running.value && !isSideChat.value) {
    e.preventDefault();
    if (!e.repeat) {
      if (runningSendMode.value === 'steer') handleQueue();
      else handleSteer();
    }
    return true;
  }

  const slashMenuBlocking = slashOpen.value && slashItems.value.length > 0;
  if (!expanded.value && !slashMenuBlocking && !mentionOpen.value && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
    const browsing = history.isBrowsing();
    if (e.key === 'ArrowUp' && history.canRecallOlder()) {
      e.preventDefault();
      if (!browsing) {
        historyEntrySnapshot = activeAttachmentEntries.value.map((entry) => {
          const { previewUrl: _dropped, ...rest } = entry;
          return rest;
        });
      }
      history.recallOlder();
      closeSlashMenu();
      return true;
    }
    if (e.key === 'ArrowDown' && browsing) {
      e.preventDefault();
      history.recallNewer();
      closeSlashMenu();
      if (!history.isBrowsing()) {
        const snapshot = historyEntrySnapshot;
        historyEntrySnapshot = null;
        if (snapshot !== null && snapshot.length > 0) {
          pendingSeedEntries = snapshot;
          void nextTick(remintMediaPreviews);
        }
      }
      return true;
    }
  }

  const keyCtx = { expanded: expanded.value };
  const newlineBinding = resolveComposerBinding('newline', keyCtx);
  if (newlineBinding !== null && newlineBinding.matches(e)) {
    e.preventDefault();
    insertNewlineAtCaret();
    return true;
  }
  const sendBinding = resolveComposerBinding('send', keyCtx);
  if (sendBinding !== null && sendBinding.matches(e)) {
    e.preventDefault();
    handleSubmit();
    return true;
  }
  const swallowBinding = resolveComposerBinding('swallow', keyCtx);
  if (swallowBinding !== null && swallowBinding.matches(e)) {
    e.preventDefault();
    return true;
  }
  return false;
}

function insertNewlineAtCaret(): void {
  if (!editor) {
    text.value += '\n';
    handleInput();
    return;
  }
  editor.insertNewlineAtCaret();
}

const sendLabel = computed(() => t('composer.send'));
const hasUpload = computed(() => !!uploadImage);

const dropdownOpen = ref(false);
const permDropdownOpen = ref(false);
const ctxCardOpen = ref(false);
const addMenuOpen = ref(false);
type MenuHandle = InstanceType<typeof Menu>;
const toolbarRef = ref<HTMLElement | null>(null);
const addMenuRef = ref<HTMLElement | null>(null);
const addSheetRef = ref<HTMLElement | null>(null);
const permPillRef = ref<HTMLElement | null>(null);
const ctxBtnRef = ref<HTMLElement | null>(null);
const ctxCardRef = ref<MenuHandle | null>(null);
const modelPillRef = ref<HTMLElement | null>(null);

const { contextInspectorEnabled } = useContextInspector();
const ctxSnapshot = shallowRef<SessionContextSummary | null>(null);
const ctxLoading = ref(false);
const ctxError = ref('');
const ctxCardLeft = ref('');
const ctxCardMaxWidth = ref('');
const ctxCardMaxHeight = ref('');
const ctxCardDropDown = ref(false);
const ctxCardStyle = computed<Record<string, string>>(() => {
  const style: Record<string, string> = {};
  if (ctxCardLeft.value) {
    style.left = ctxCardLeft.value;
    style.right = 'auto';
  }
  if (ctxCardMaxWidth.value) style.maxWidth = ctxCardMaxWidth.value;
  if (ctxCardMaxHeight.value) style.maxHeight = ctxCardMaxHeight.value;
  return style;
});
let ctxFetchToken = 0;

trackMenuSurface(addMenuOpen, addMenuRef);

function menuElement(menu: MenuHandle | null): HTMLElement | null {
  return menu?.el ?? null;
}

const addScrollRef = ref<HTMLElement | null>(null);
const addThumb = ref<{ top: number; height: number } | null>(null);
let addScrollObserver: ResizeObserver | null = null;

function updateAddScrollState(): void {
  const el = addScrollRef.value;
  if (!el) return;
  const { scrollTop, scrollHeight, clientHeight } = el;
  if (scrollHeight <= clientHeight + 1) {
    addThumb.value = null;
    return;
  }
  const menuStyle = getComputedStyle(el);
  const inset =
    parseFloat(menuStyle.getPropertyValue('--menu-scrollbar-track-inset')) || 0;
  const minThumb =
    parseFloat(menuStyle.getPropertyValue('--menu-scrollbar-thumb-min')) || 24;
  const track = clientHeight - inset * 2;
  const height = Math.max(minThumb, (clientHeight / scrollHeight) * track);
  const maxScroll = scrollHeight - clientHeight;
  const top = el.offsetTop + inset + (scrollTop / maxScroll) * (track - height);
  addThumb.value = { top, height };
}

function onAddMenuScroll(): void {
  updateAddScrollState();
}

watch(addMenuOpen, async (open) => {
  addScrollObserver?.disconnect();
  addScrollObserver = null;
  addThumb.value = null;
  if (!open) return;
  await nextTick();
  updateAddScrollState();
  if (typeof ResizeObserver === 'function' && addScrollRef.value) {
    addScrollObserver = new ResizeObserver(updateAddScrollState);
    addScrollObserver.observe(addScrollRef.value);
  }
});
onUnmounted(() => {
  addScrollObserver?.disconnect();
  addScrollObserver = null;
});
const modelMenuRight = ref('');
const modelMenuStyle = computed<Record<string, string>>(() => {
  const style: Record<string, string> = {};
  if (modelMenuRight.value) style.right = modelMenuRight.value;
  return style;
});

const anyPopupOpen = computed(
  () =>
    dropdownOpen.value ||
    permDropdownOpen.value ||
    ctxCardOpen.value ||
    addMenuOpen.value ||
    slashOpen.value ||
    mentionOpen.value,
);

function closeOverlays(): void {
  closeSlashMenu();
  closeMentionMenu();
  closeAddMenu();
  closeDropdown();
  closePermDropdown();
  closeCtxCard();
  closeMediaAttachment();
  browserDetails.close();
}

const isEmpty = () => text.value.trim().length === 0 && activeAttachmentEntries.value.length === 0;

defineExpose({ loadForEdit, insertQuote, insertScreenshotAnnotation, insertPathMention, addFiles, loadAttachmentsForEdit, restoreDraftEntries, focus, openModelMenu: () => { if (!dropdownOpen.value) toggleDropdown(); }, closeOverlays, anyPopupOpen, isEmpty, clearAfterDispatch });

function hasAnyToolbarMenuOpen(): boolean {
  return dropdownOpen.value || permDropdownOpen.value || ctxCardOpen.value || addMenuOpen.value;
}

function toggleDropdown(): void {
  const opening = !dropdownOpen.value;
  if (nativeModelMenu?.available && !isMobile.value && modelPillRef.value !== null) {
    closePermDropdown();
    closeCtxCard();
    closeAddMenu();
    if (opening) prepareModelMenu();
    nativeModelMenu.toggle(modelPillRef.value, { initialFocus: 'first-item' });
    return;
  }
  if (opening) prepareModelMenu();
  dropdownOpen.value = opening;
  if (opening) {
    updateModelMenuPosition();
    permDropdownOpen.value = false;
    ctxCardOpen.value = false;
    addMenuOpen.value = false;
    document.addEventListener('click', onDocClick, true);
  } else if (!hasAnyToolbarMenuOpen()) {
    document.removeEventListener('click', onDocClick, true);
  }
}

function closeDropdown(): void {
  nativeModelMenu?.close();
  dropdownOpen.value = false;
  if (!hasAnyToolbarMenuOpen()) {
    document.removeEventListener('click', onDocClick, true);
  }
}

function togglePermDropdown(): void {
  if (nativePermissionMenu?.available && !isMobile.value && permPillRef.value !== null) {
    closeDropdown();
    closeCtxCard();
    closeAddMenu();
    nativePermissionMenu.toggle(permPillRef.value, { initialFocus: 'first-item' });
    return;
  }
  permDropdownOpen.value = !permDropdownOpen.value;
  if (permDropdownOpen.value) {
    updatePermissionMenuPosition();
    dropdownOpen.value = false;
    ctxCardOpen.value = false;
    addMenuOpen.value = false;
    document.addEventListener('click', onDocClick, true);
  } else if (!hasAnyToolbarMenuOpen()) {
    document.removeEventListener('click', onDocClick, true);
  }
}

function closePermDropdown(): void {
  nativePermissionMenu?.close();
  permDropdownOpen.value = false;
  if (!hasAnyToolbarMenuOpen()) {
    document.removeEventListener('click', onDocClick, true);
  }
}

function toggleCtxCard(): void {
  ctxCardOpen.value = !ctxCardOpen.value;
  if (ctxCardOpen.value) {
    closeDropdown();
    closePermDropdown();
    addMenuOpen.value = false;
    slashOpen.value = false;
    closeMentionMenu();
    document.addEventListener('click', onDocClick, true);
  } else if (!hasAnyToolbarMenuOpen()) {
    document.removeEventListener('click', onDocClick, true);
  }
}

function closeCtxCard(): void {
  ctxCardOpen.value = false;
  if (!hasAnyToolbarMenuOpen()) {
    document.removeEventListener('click', onDocClick, true);
  }
}

function toggleAddMenu(): void {
  addMenuOpen.value = !addMenuOpen.value;
  if (addMenuOpen.value) {
    closeDropdown();
    closePermDropdown();
    ctxCardOpen.value = false;
    closeSlashMenu();
    closeMentionMenu();
    document.addEventListener('click', onDocClick, true);
    void nextTick(() => {
      const root = isMobile.value ? addSheetRef.value : addMenuRef.value;
      root?.querySelector<HTMLElement>('.am-row')?.focus();
    });
  } else if (!hasAnyToolbarMenuOpen()) {
    document.removeEventListener('click', onDocClick, true);
  }
}

function closeAddMenu(): void {
  addMenuOpen.value = false;
  if (!hasAnyToolbarMenuOpen()) {
    document.removeEventListener('click', onDocClick, true);
  }
}

const addItems = computed(() => {
  const items: { id: string; icon: IconName; nameKey: string; descKey?: string; shortcutKeys?: string[]; action: () => void }[] = [];
  if (hasUpload.value) {
    items.push({ id: 'files', icon: 'attachment', nameKey: 'composer.addFiles', descKey: 'composer.addFilesDesc', action: onAddFiles });
  }
  if (props.onCaptureScreenshot !== undefined) {
    items.push({ id: 'screenshot', icon: 'screenshot', nameKey: 'composer.addScreenshot', descKey: 'composer.addScreenshotDesc', shortcutKeys: props.screenshotShortcutKeys, action: onAddScreenshot });
  }
  if (isMobile.value) {
    items.push({ id: 'slash', icon: 'terminal', nameKey: 'composer.addSlash', descKey: 'composer.addSlashDesc', action: onAddSlashMenu });
    items.push({ id: 'mention', icon: 'at', nameKey: 'composer.addMention', descKey: 'composer.addMentionDesc', action: onAddMentionMenu });
  }
  if (goalEnabled.value) {
    items.push({ id: 'goal', icon: 'target', nameKey: 'status.goalLabel', descKey: 'composer.addGoalDesc', action: onAddGoalMode });
  }
  if (planEnabled.value) {
    items.push({ id: 'plan', icon: 'file-edit', nameKey: 'status.planLabel', descKey: 'composer.addPlanDesc', action: onAddPlanMode });
  }
  if (swarmEnabled.value) {
    items.push({ id: 'swarm', icon: 'sparkles', nameKey: 'status.swarmLabel', descKey: 'composer.addSwarmDesc', action: onAddSwarmMode });
  }
  if (towerEntryEnabled.value) {
    items.push({ id: 'tower', icon: 'tower', nameKey: 'status.towerLabel', descKey: 'composer.addTowerDesc', action: onAddTowerMode });
  }
  if (isSideChat.value) {
    return items.filter((item) => item.id === 'files');
  }
  return items;
});

function selectAddItem(item: { id?: string; action: () => void }): void {
  item.action();
  if (isMobile.value && item.id === 'files') return;
  focus();
}

function onAddMenuKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeAddMenu();
    focus();
    return;
  }
  if (e.key === 'Tab') {
    closeAddMenu();
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const root = isMobile.value ? addSheetRef.value : addMenuRef.value;
  const items = Array.from(root?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
  items[next]?.focus();
}

function onAddFiles(): void {
  closeAddMenu();
  openFilePicker();
}

function onAddScreenshot(): void {
  closeAddMenu();
  props.onCaptureScreenshot?.();
}

function onConfigureScreenshotShortcut(): void {
  closeAddMenu();
  props.onConfigureScreenshotShortcut?.();
}

function primeComposerToken(token: '/' | '@'): void {
  closeAddMenu();
  text.value = token;
  void nextTick(() => {
    const ed = editorRef.value;
    const end = text.value.length;
    ed?.setSelectionRange(end, end);
    if (token === '/') updateSlashMenu();
    else updateMentionMenu();
  });
}
function onAddSlashMenu(): void {
  primeComposerToken('/');
}
function onAddMentionMenu(): void {
  primeComposerToken('@');
}

function onAddGoalMode(): void {
  closeAddMenu();
  if (!goalMode.value) armGoalMode();
}

function onAddPlanMode(): void {
  closeAddMenu();
  if (!planOn.value) armPlanMode();
}

function onAddSwarmMode(): void {
  closeAddMenu();
  if (!swarmOn.value) void client.toggleSwarmMode();
}

function onAddTowerMode(): void {
  closeAddMenu();
  if (!towerOn.value) void client.toggleTowerMode();
}

function onDocClick(e: MouseEvent): void {
  const target = e.target as Node;
  const insideToolbar = toolbarRef.value?.contains(target) ?? false;
  const insideAddMenu = addMenuRef.value?.contains(target) ?? false;
  if (!insideToolbar && !insideAddMenu) {
    closeDropdown();
    closePermDropdown();
    closeCtxCard();
    closeAddMenu();
  }
}

onUnmounted(() => {
  document.removeEventListener('click', onDocClick, true);
});

const pct = computed(() => {
  const max = status.value?.ctxMax ?? 0;
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.ceil(((status.value?.ctxUsed ?? 0) / max) * 100)));
});

const ctxTooltip = computed(() => {
  const usedRaw = status.value?.ctxUsed ?? 0;
  const maxRaw = status.value?.ctxMax ?? 0;
  const used = formatTokens(usedRaw);
  const max = formatTokens(maxRaw);
  if (contextInspectorEnabled.value && maxRaw > 0) {
    const remaining = formatTokens(Math.max(0, maxRaw - usedRaw));
    return t('inspector.ringTooltipWithMax', { used, remaining, max, pct: pct.value });
  }
  return t('status.ctxTooltip', { used, max, pct: pct.value });
});

const canOpenContextDetail = computed(() => Boolean(panelApi?.openContext));

async function refreshCtxSnapshot(options?: ReadRequestOptions): Promise<void> {
  const sid = sessionId.value;
  if (!ctxCardOpen.value || !sid) {
    ctxLoading.value = false;
    return;
  }
  if (ctxSnapshot.value && ctxSnapshot.value.session_id !== sid) {
    ctxSnapshot.value = null;
  }
  const token = ++ctxFetchToken;
  ctxLoading.value = true;
  ctxError.value = '';
  try {
    const next = await getKimiWebApi().getSessionContextSummary(sid, undefined, options);
    if (token !== ctxFetchToken || !ctxCardOpen.value || sessionId.value !== sid) return;
    ctxSnapshot.value = next;
  } catch (err) {
    if (token !== ctxFetchToken || !ctxCardOpen.value || sessionId.value !== sid) return;
    if (err instanceof Error && err.name === 'AbortError') return;
    ctxError.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (token === ctxFetchToken) ctxLoading.value = false;
  }
}

watch(sessionId, () => {
  ctxSnapshot.value = null;
  ctxError.value = '';
  ctxLoading.value = false;
  closeCtxCard();
});

const canCompactContext = computed(() => {
  if (!ctxCardOpen.value || !sessionId.value) return false;
  if (running.value || client.turns?.value === undefined) return true;
  return client.turns.value.length > 0;
});

watch(
  [ctxCardOpen, sessionId, () => status.value?.ctxUsed, () => running.value, compacting],
  ([open, sid, used, isRunning, isCompacting], [wasOpen, prevSid, prevUsed, wasRunning, wasCompacting]) => {
    if (!open) {
      ctxLoading.value = false;
      return;
    }
    if (
      wasOpen &&
      sid === prevSid &&
      used === prevUsed &&
      isRunning === wasRunning &&
      isCompacting &&
      !wasCompacting
    ) {
      return;
    }
    void refreshCtxSnapshot(wasOpen ? sessionObservationOptions(sid ?? undefined) : undefined).then(() => {
      if (ctxCardOpen.value) void nextTick(clampCtxCardToViewport);
    });
  },
);

function handleCompactFromCard(): void {
  closeCtxCard();
  emit('command', { cmd: '/compact', attachments: [], preserveDraft: true });
}

function handleOpenContextDetail(): void {
  closeCtxCard();
  panelApi?.openContext?.();
}

function onCtxCardKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !ctxCardOpen.value) return;
  event.preventDefault();
  closeCtxCard();
  ctxBtnRef.value?.focus();
}

const currentModel = computed(() =>
  models.value?.find((m) => m.id === status.value?.modelId),
);
const thinkingLevel = computed(() => effectiveThinkingLevel(currentModel.value, thinking.value));
const thinkingOn = computed(() => isThinkingOn(thinkingLevel.value));
const thinkingSuffix = computed(() => {
  if (!thinkingOn.value) return '';
  const hasEfforts = (currentModel.value?.supportEfforts?.length ?? 0) > 0;
  const level = thinkingLevel.value;
  if (hasEfforts && level !== 'on') return t('composer.thinkingSuffixEffort', { level: effortLabel(level) });
  return t('composer.thinkingSuffix');
});

const planOn = computed(() => planArmed.value === true || planMode.value === true);
const swarmOn = computed(() => swarmMode.value === true);
const towerOn = computed(() => towerMode.value === true);
const goalStatus = computed(() => goal.value?.status ?? activationBadges.value?.goal?.status ?? null);
const goalActive = computed(() => goalStatus.value !== null && goalStatus.value !== 'complete');

const workMode = computed<'plan' | 'goal' | null>(() =>
  isSideChat.value ? null : goalMode.value ? 'goal' : planArmed.value ? 'plan' : null,
);
function clearWorkMode(): void {
  if (workMode.value === 'goal') client.toggleGoalMode();
  else if (workMode.value === 'plan') client.togglePlanMode();
}

const PERM_MODES: { mode: PermissionMode; icon: IconName; color: string; labelKey: string; descKey: string }[] = [
  { mode: 'manual', icon: 'hand', color: 'var(--color-text)', labelKey: 'status.permissionManual', descKey: 'status.permissionManualDesc' },
  { mode: 'yolo', icon: 'shield-question', color: 'var(--color-warning)', labelKey: 'status.permissionYolo', descKey: 'status.permissionYoloDesc' },
  { mode: 'auto', icon: 'full-access', color: 'var(--color-danger)', labelKey: 'status.permissionAuto', descKey: 'status.permissionAutoDesc' },
];

const menuMeasureRef = ref<HTMLElement | null>(null);
const permissionDescriptionWidth = ref('');
const permissionMenuLeft = ref('');
const permissionMenuMaxWidth = ref('');
const permissionMenuMaxHeight = ref('');
const permMenuDropDown = ref(false);
function menuDescStyle(width: string): Record<string, string> {
  const style: Record<string, string> = {};
  if (width) style['--composer-menu-desc-width'] = width;
  return style;
}
const permissionMenuStyle = computed<Record<string, string>>(() => ({
  ...menuDescStyle(permissionDescriptionWidth.value),
  ...(permissionMenuLeft.value ? { left: permissionMenuLeft.value } : {}),
  ...(permissionMenuMaxWidth.value ? { maxWidth: permissionMenuMaxWidth.value } : {}),
  ...(permissionMenuMaxHeight.value ? { maxHeight: permissionMenuMaxHeight.value } : {}),
}));

function updatePermissionMenuPosition(): void {
  const anchor = permPillRef.value;
  const toolbar = toolbarRef.value;
  if (!anchor || !toolbar) {
    permissionMenuLeft.value = '';
    return;
  }
  permissionMenuLeft.value = `${Math.max(0, Math.round(anchor.getBoundingClientRect().left - toolbar.getBoundingClientRect().left))}px`;
}

function updateModelMenuPosition(): void {
  const anchor = modelPillRef.value;
  const toolbar = toolbarRef.value;
  if (!anchor || !toolbar) {
    modelMenuRight.value = '';
    return;
  }
  const anchorRect = anchor.getBoundingClientRect();
  modelMenuRight.value = `${Math.max(0, Math.round(toolbar.getBoundingClientRect().right - anchorRect.right))}px`;
  const viewportTop = window.visualViewport?.offsetTop ?? 0;
  webModelMenuMaxHeight.value = clampModelMenuMaxHeight(anchorRect.top - viewportTop);
}
let menuMeasureFrame: number | null = null;

function cssPx(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function canvasFont(style: CSSStyleDeclaration): string {
  return `${style.fontStyle || 'normal'} ${style.fontWeight || '400'} ${style.fontSize} ${style.fontFamily}`;
}

function letterSpacingPx(style: CSSStyleDeclaration): number {
  return style.letterSpacing === 'normal' ? 0 : cssPx(style.letterSpacing);
}

function measureTextWidth(text: string, style: CSSStyleDeclaration): number {
  if (!text) return 0;
  const prepared = prepareWithSegments(text, canvasFont(style), {
    letterSpacing: letterSpacingPx(style),
  });
  return measureNaturalWidth(prepared);
}

function measureMenuDescriptions(): void {
  const probe = menuMeasureRef.value?.querySelector<HTMLElement>('.pd-desc');
  if (!probe) return;
  const style = getComputedStyle(probe);
  const permissionWidth = Math.max(
    0,
    ...PERM_MODES.map((opt) => measureTextWidth(t(opt.descKey), style)),
  );
  permissionDescriptionWidth.value = permissionWidth > 0 ? `${Math.ceil(permissionWidth)}px` : '';
}

function scheduleMenuDescriptionMeasure(): void {
  if (typeof window === 'undefined') return;
  if (menuMeasureFrame !== null) {
    window.cancelAnimationFrame(menuMeasureFrame);
  }
  void nextTick(() => {
    menuMeasureFrame = window.requestAnimationFrame(() => {
      menuMeasureFrame = null;
      measureMenuDescriptions();
    });
  });
}

watch(
  locale,
  () => {
    scheduleMenuDescriptionMeasure();
    if (slashOpen.value) updateSlashMenu();
  },
  { immediate: true },
);

onMounted(() => {
  scheduleMenuDescriptionMeasure();
  void document.fonts?.ready.then(scheduleMenuDescriptionMeasure);
});

onUnmounted(() => {
  if (menuMeasureFrame !== null) {
    window.cancelAnimationFrame(menuMeasureFrame);
    menuMeasureFrame = null;
  }
});

function choosePermission(mode: PermissionMode): void {
  client.setPermission(mode);
  closePermDropdown();
}

const permInfo = computed(() => PERM_MODES.find((p) => p.mode === status.value?.permission));
const permLabel = computed(() => (permInfo.value ? t(permInfo.value.labelKey) : ''));
const permIcon = computed<IconName>(() => permInfo.value?.icon ?? 'hand');

const toolbarLabelsCollapsed = ref(false);
const modelPillCollapsed = ref(false);
const modelPillGone = ref(false);
const mpNameRef = ref<HTMLElement | null>(null);
const toolbarRightRef = ref<HTMLElement | null>(null);
let labelsCollapsedAt = 0;
let modelCollapsedAt = 0;
let modelGoneAt = 0;

function toolbarCollapseTokens(): { valveFloor: number; expandMargin: number } {
  const style = toolbarRef.value ? getComputedStyle(toolbarRef.value) : null;
  return {
    valveFloor: style ? lengthToken(style, '--composer-valve-floor', 56) : 56,
    expandMargin: style ? lengthToken(style, '--composer-valve-expand-margin', 48) : 48,
  };
}

function rightClusterOverflows(right: HTMLElement): boolean {
  const boxLeft = right.getBoundingClientRect().left;
  for (const el of right.querySelectorAll('.ctx-group, .model-pill, .stop, .send')) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.left < boxLeft - 1) return true;
  }
  return false;
}

function lengthToken(style: CSSStyleDeclaration, name: string, fallback: number): number {
  const raw = style.getPropertyValue(name).trim();
  const value = parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return raw.endsWith('em') ? value * parseFloat(style.fontSize) : value;
}

function textCrushed(el: HTMLElement): boolean {
  return (
    el.scrollWidth > el.clientWidth + 1 ||
    (el.clientWidth === 0 && (el.textContent?.length ?? 0) > 0)
  );
}

function measureToolbarCollapse(): void {
  const toolbar = toolbarRef.value;
  if (!toolbar) return;
  const { valveFloor, expandMargin } = toolbarCollapseTokens();
  const width = toolbar.getBoundingClientRect().width;
  const right = toolbarRightRef.value;

  if (modelPillGone.value) {
    if (width > modelGoneAt + expandMargin) {
      modelPillGone.value = false;
      void nextTick(measureToolbarCollapse);
    }
    return;
  }
  if (modelPillCollapsed.value) {
    if (width > modelCollapsedAt + expandMargin) {
      modelPillCollapsed.value = false;
      void nextTick(measureToolbarCollapse);
      return;
    }
    if (right && rightClusterOverflows(right)) {
      modelGoneAt = width;
      modelPillGone.value = true;
      if (dropdownOpen.value) closeDropdown();
      void nextTick(measureToolbarCollapse);
    }
    return;
  }
  if (toolbarLabelsCollapsed.value && width > labelsCollapsedAt + expandMargin) {
    toolbarLabelsCollapsed.value = false;
    void nextTick(measureToolbarCollapse);
    return;
  }

  const nameEl = mpNameRef.value;
  const valveExhausted =
    nameEl !== null &&
    textCrushed(nameEl) &&
    nameEl.getBoundingClientRect().width < valveFloor;
  if (!valveExhausted) return;
  if (!toolbarLabelsCollapsed.value) {
    labelsCollapsedAt = width;
    toolbarLabelsCollapsed.value = true;
  } else {
    modelCollapsedAt = width;
    modelPillCollapsed.value = true;
  }
  void nextTick(measureToolbarCollapse);
}

let toolbarLabelObserver: ResizeObserver | null = null;
onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !toolbarRef.value) return;
  toolbarLabelObserver = new ResizeObserver(measureToolbarCollapse);
  toolbarLabelObserver.observe(toolbarRef.value);
});
onUnmounted(() => {
  toolbarLabelObserver?.disconnect();
  toolbarLabelObserver = null;
});
const { fontScale } = useAppearance();
const hostSetupId = computed(() => {
  const hostId = client.visibleWorkspace?.value?.hostId;
  if (hostId === undefined || hostsStore().displayState(hostId) !== 'ready') return undefined;
  return hostsStore().needsLogin(hostId) ? hostId : undefined;
});

function openHostSetup(): void {
  const hostId = hostSetupId.value;
  if (hostId !== undefined) openHostSettings(hostId);
}

watch(
  [
    permLabel,
    swarmOn,
    towerOn,
    thinkingSuffix,
    () => status.value?.model,
    () => working.value,
    gateVerdict,
    hostSetupId,
    () => models.value?.length,
    fontScale,
    locale,
  ],
  () => {
    if (toolbarLabelsCollapsed.value) toolbarLabelsCollapsed.value = false;
    if (modelPillCollapsed.value) modelPillCollapsed.value = false;
    if (modelPillGone.value) modelPillGone.value = false;
    void nextTick(measureToolbarCollapse);
  },
);
onMounted(() => {
  void document.fonts?.ready.then(measureToolbarCollapse);
});

const modelIconLabel = computed(() => `${status.value?.model ?? ''}${thinkingSuffix.value}`);

const currentProvider = computed(() => currentModel.value?.provider ?? '');
const menuProvider = ref('');
const recentModelsSnapshot = ref<AppModel[]>([]);
const providerModelsSnapshot = ref<AppModel[]>([]);
const webModelMenuMaxHeight = ref(480);
const modelDropdownRef = ref<InstanceType<typeof ModelQuickMenu> | null>(null);

const menuProviders = computed(() =>
  orderedModelProviders(models.value ?? []).map((id) => ({ id, label: providerDisplayName(id, t) })),
);

function prepareModelMenu(): void {
  const catalog = models.value ?? [];
  menuProvider.value = currentProvider.value || orderedModelProviders(catalog)[0] || '';
  recentModelsSnapshot.value = recentModelsForMenu(catalog, recentIds.value ?? [], currentModel.value?.id);
  providerModelsSnapshot.value = menuProvider.value
    ? providerModelsForMenu(catalog, menuProvider.value, currentModel.value?.id)
    : [];
}

const quickModelMenuPayload = computed<QuickModelMenuPayload>(() => ({
  models: models.value ?? [],
  recentModels: recentModelsSnapshot.value,
  providerModels: providerModelsSnapshot.value,
  providers: menuProviders.value,
  activeProvider: menuProvider.value,
  activeProviderLabel: providerDisplayName(menuProvider.value, t),
  ...(status.value?.modelId === undefined ? {} : { currentModelId: status.value.modelId }),
  ...(thinking.value === undefined ? {} : { currentEffort: thinking.value }),
}));

function onQuickModelAction(action: QuickModelMenuAction): void {
  if (action.type === 'select-provider') {
    menuProvider.value = action.providerId;
    providerModelsSnapshot.value = providerModelsForMenu(models.value ?? [], action.providerId, status.value?.modelId);
    return;
  }
  if (action.type === 'select-effort') {
    void client.setThinking(action.effort as ThinkingLevel);
    return;
  }
  void applyModelMenuDraft(
    { modelId: action.modelId, ...(action.effort === undefined ? {} : { effort: action.effort as ThinkingLevel }) },
    {
      currentModelId: status.value?.modelId,
      currentSessionId: sessionId.value,
      getCurrentModelId: () => status.value?.modelId,
      getCurrentSessionId: () => sessionId.value,
      selectModel: (id) => client.selectModel(id),
      setThinking: (level) => client.setThinking(level),
    },
  );
}

const showSignIn = computed(() => gateVerdict.value === 'login');
const showPickModel = computed(() => gateVerdict.value === 'pick-model');
const showConfigureModel = computed(() => gateVerdict.value === 'configure-model');

const permDropdownRef = ref<MenuHandle | null>(null);

function clampToolbarPopupToViewport(options: {
  menu: HTMLElement | null;
  anchor: HTMLElement | null;
  align: 'left' | 'right' | 'center';
  setOffset: (value: string) => void;
  setMaxWidth: (value: string) => void;
  setMaxHeight: (value: string) => void;
  setDropDown: (value: boolean) => void;
}): void {
  const { menu, anchor, align, setOffset, setMaxWidth, setMaxHeight, setDropDown } = options;
  const toolbar = toolbarRef.value;
  if (!menu || !toolbar) return;
  const style = getComputedStyle(menu);
  const gap = cssPx(style.getPropertyValue('--space-1')) || 4;
  const margin = cssPx(style.getPropertyValue('--space-2')) || 8;
  const vv = window.visualViewport;
  const viewportTop = vv?.offsetTop ?? 0;
  const viewportBottom = viewportTop + (vv?.height ?? window.innerHeight);
  const rect = toolbar.getBoundingClientRect();
  if (rect.width > 0) {
    const viewportLeft = vv?.offsetLeft ?? 0;
    const viewportRight = viewportLeft + (vv?.width ?? window.innerWidth);
    const minLeft = Math.min(rect.right, Math.max(rect.left, viewportLeft + margin));
    const maxRight = Math.max(minLeft, Math.min(rect.right, viewportRight - margin));
    const availableWidth = Math.max(0, Math.floor(maxRight - minLeft));
    if (availableWidth > 0) {
      const maxWidthPx = `${availableWidth}px`;
      menu.style.maxWidth = maxWidthPx;
      setMaxWidth(maxWidthPx);
      if (anchor) {
        const anchorRect = anchor.getBoundingClientRect();
        if (anchorRect.width > 0) {
          if (align === 'right') {
            menu.style.right = '0px';
          } else {
            menu.style.left = '0px';
            menu.style.right = 'auto';
          }
          const menuW = Math.min(menu.offsetWidth, availableWidth);
          if (align === 'right') {
            const rightEdge = Math.min(Math.max(anchorRect.right, minLeft + menuW), maxRight);
            const offsetPx = `${Math.round(rect.right - rightEdge)}px`;
            menu.style.right = offsetPx;
            setOffset(offsetPx);
          } else if (align === 'center') {
            const centeredLeft = anchorRect.left + anchorRect.width / 2 - menuW / 2;
            const leftEdge = Math.max(Math.min(centeredLeft, maxRight - menuW), minLeft);
            const offsetPx = `${Math.round(leftEdge - rect.left)}px`;
            menu.style.left = offsetPx;
            setOffset(offsetPx);
          } else {
            const leftEdge = Math.max(Math.min(anchorRect.left, maxRight - menuW), minLeft);
            const offsetPx = `${Math.round(leftEdge - rect.left)}px`;
            menu.style.left = offsetPx;
            setOffset(offsetPx);
          }
        }
      }
    }
  }
  const above = rect.top - viewportTop - gap - margin;
  const below = viewportBottom - rect.bottom - gap - margin;
  if (menu.offsetHeight > above && below > above) {
    setDropDown(true);
    setMaxHeight(`${Math.max(Math.floor(below), 0)}px`);
  } else {
    setDropDown(false);
    setMaxHeight(`${Math.max(Math.floor(above), 0)}px`);
  }
}

function clampModelMenuToViewport(): void {
  updateModelMenuPosition();
}

function clampPermissionMenuToViewport(): void {
  clampToolbarPopupToViewport({
    menu: menuElement(permDropdownRef.value),
    anchor: permPillRef.value,
    align: 'left',
    setOffset: (value) => { permissionMenuLeft.value = value; },
    setMaxWidth: (value) => { permissionMenuMaxWidth.value = value; },
    setMaxHeight: (value) => { permissionMenuMaxHeight.value = value; },
    setDropDown: (value) => { permMenuDropDown.value = value; },
  });
}

function clampCtxCardToViewport(): void {
  clampToolbarPopupToViewport({
    menu: menuElement(ctxCardRef.value),
    anchor: ctxBtnRef.value,
    align: 'center',
    setOffset: (value) => { ctxCardLeft.value = value; },
    setMaxWidth: (value) => { ctxCardMaxWidth.value = value; },
    setMaxHeight: (value) => { ctxCardMaxHeight.value = value; },
    setDropDown: (value) => { ctxCardDropDown.value = value; },
  });
}

function onViewportResize(): void {
  closeDropdown();
  closePermDropdown();
  closeCtxCard();
}

function addModelMenuViewportListeners(): void {
  window.addEventListener('resize', onViewportResize);
  window.visualViewport?.addEventListener('resize', onViewportResize);
}

function removeModelMenuViewportListeners(): void {
  window.removeEventListener('resize', onViewportResize);
  window.visualViewport?.removeEventListener('resize', onViewportResize);
}

watch([dropdownOpen, permDropdownOpen, ctxCardOpen], ([modelOpen, permOpen, ctxOpen]) => {
  if (modelOpen || permOpen || ctxOpen) addModelMenuViewportListeners();
  else removeModelMenuViewportListeners();
});

watch(ctxCardOpen, async (open) => {
  if (!open) return;
  ctxCardDropDown.value = false;
  ctxCardLeft.value = '';
  ctxCardMaxWidth.value = '';
  ctxCardMaxHeight.value = '';
  await nextTick();
  clampCtxCardToViewport();
});

watch(dropdownOpen, async (open) => {
  if (!open) return;
  updateModelMenuPosition();
  await nextTick();
  modelDropdownRef.value?.el?.focus();
});

watch(permDropdownOpen, async (open) => {
  if (!open) return;
  permMenuDropDown.value = false;
  permissionMenuMaxWidth.value = '';
  permissionMenuMaxHeight.value = '';
  await nextTick();
  clampPermissionMenuToViewport();
});

watch(
  [
    thinkingSuffix,
    permissionDescriptionWidth,
    () => status.value?.model,
    () => models.value?.length,
    () => recentModelsSnapshot.value.length,
    locale,
    fontScale,
  ],
  () => {
    if (dropdownOpen.value) void nextTick(clampModelMenuToViewport);
    if (permDropdownOpen.value) void nextTick(clampPermissionMenuToViewport);
  },
);

onUnmounted(() => {
  removeModelMenuViewportListeners();
});

const nativeMenuHost = useComposerNativeMenuHost();
const nativeMenuId = `composer-${++composerMenuSequence}`;
const nativePermissionItems = computed<NativeMenuItem[]>(() => PERM_MODES.map(option => ({
  kind: 'item', id: option.mode, label: t(option.labelKey), description: t(option.descKey), icon: option.icon,
  selected: option.mode === status.value?.permission,
  ...(option.mode === 'manual' ? {} : { tone: option.mode === 'auto' ? 'danger' as const : 'warning' as const }),
})));
const nativePermissionMenu = nativeMenuHost?.register({
  id: `${nativeMenuId}-permission`, width: 220, autoWidth: true, placement: 'top-start',
  items: () => nativePermissionItems.value,
  onSelect: id => { if (PERM_MODES.some(option => option.mode === id)) choosePermission(id as PermissionMode); },
});
const nativeModelMenu = nativeMenuHost?.register({
  id: `${nativeMenuId}-models`, width: 240, maxHeight: 480, placement: 'top-end',
  items: () => [],
  modelMenu: () => quickModelMenuPayload.value,
  onSelect: () => {},
  onModelAction: onQuickModelAction,
});
if (nativePermissionMenu !== undefined) watch(nativePermissionMenu.open, open => { permDropdownOpen.value = open; });
if (nativeModelMenu !== undefined) watch(nativeModelMenu.open, open => { dropdownOpen.value = open; });
watch(permDropdownOpen, open => { if (!open) nativePermissionMenu?.close(); });
watch(dropdownOpen, open => { if (!open) nativeModelMenu?.close(); });
watchEffect(() => { if (nativePermissionMenu?.open.value) nativePermissionMenu.refresh(); });
watchEffect(() => { if (nativeModelMenu?.open.value) nativeModelMenu.refresh(); });
watch(() => client.activeSessionId.value, () => { closeDropdown(); closePermDropdown(); });
</script>

<template>
  <div
    class="composer"
    :class="{ 'drag-over': isDragOver, expanded }"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <BrowserReferenceDetails :state="browserDetails.state.value" @resolve="browserDetails.finish" />
    <MediaLightbox
      v-if="previewMedia"
      :media="previewMedia"
      :origin-img="previewAttachmentImg"
      :images="previewImages"
      :index="previewIndex"
      @close="closeMediaAttachment"
    />
    <div v-if="runningSendTipVisible && !isSideChat" class="composer-tip" role="status">
      <Icon name="info" size="sm" class="composer-tip-icon" aria-hidden="true" />
      <span class="composer-tip-text">{{ t('composer.runningSteerTipLead') }}<button type="button" class="composer-tip-link" @click="openRunningSendSettings">{{ t('composer.runningSteerTipSettings') }}</button>{{ t('composer.runningSteerTipTail') }}</span>
      <IconButton
        class="composer-tip-close"
        size="sm"
        :label="t('composer.runningSteerTipDismiss')"
        :tooltip="t('composer.runningSteerTipDismiss')"
        @click="dismissRunningSendTip"
      >
        <Icon name="close" size="sm" />
      </IconButton>
    </div>
    <div class="composer-card" :class="{ 'labels-collapsed': toolbarLabelsCollapsed, 'has-media': activeMediaEntries.length > 0 }">
      <ComposerMediaRail
        v-if="activeMediaEntries.length > 0"
        :entries="activeMediaEntries"
        @activate="openMediaAttachment"
        @mention="mentionMediaAttachment"
        @remove="removeMediaAttachment"
        @reorder="reorderMediaAttachment"
      />
      <div class="cin-wrap">
        <SlashMenu
          v-if="slashOpen && !isMobile"
          ref="slashMenuRef"
          :items="slashItems"
          :ranges="slashRanges"
          :active-index="slashActive"
          :query="slashQuery"
          @select="selectSlashCommand"
          @hover="slashActive = $event"
        />

        <MentionMenu
          v-if="mentionOpen && !isMobile"
          ref="mentionMenuRef"
          :items="mentionItems"
          :active-index="mentionActive"
          :loading="mentionLoading"
          :query="mentionQuery"
          :submenu-title="mentionSubmenuTitle"
          @select="selectMentionItem"
          @hover="mentionNavigate"
          @back="leaveMentionSessionMenu"
        />

        <Transition name="ui-menu-pop">
          <div v-if="addMenuOpen && !isMobile" ref="addMenuRef" class="add-menu" @click.stop @keydown="onAddMenuKeydown">
            <div ref="addScrollRef" class="am-scroll" role="menu" @scroll="onAddMenuScroll">
              <div v-for="item in addItems" :key="item.id" class="am-entry">
                <button
                  type="button"
                  class="am-row"
                  role="menuitem"
                  @mousedown.prevent
                  @click="selectAddItem(item)"
                >
                  <span class="am-icon"><Icon :name="item.icon" size="sm" /></span>
                  <span class="am-name">{{ t(item.nameKey) }}</span>
                  <span v-if="item.descKey" class="am-desc">{{ t(item.descKey) }}</span>
                </button>
                <ComposerScreenshotShortcut
                  v-if="item.id === 'screenshot' && props.onConfigureScreenshotShortcut"
                  class="am-shortcut"
                  :keys="item.shortcutKeys ?? []"
                  :unavailable="props.screenshotShortcutUnavailable"
                  :failure-reason="props.screenshotShortcutFailureReason"
                  @configure="onConfigureScreenshotShortcut"
                />
                <Kbd v-else-if="item.shortcutKeys?.length" class="am-shortcut" :keys="item.shortcutKeys" />
              </div>
            </div>
            <div v-if="addThumb" class="scroll-thumb" :style="{ top: `${addThumb.top}px`, height: `${addThumb.height}px` }" />
          </div>
        </Transition>

        <div class="input-row">
          <div
            ref="editorHostRef"
            class="ph"
            :data-empty="text.length === 0"
            :data-wm="workMode ? 'true' : 'false'"
          ></div>
          <span :id="commandArgumentDescriptionId" class="composer-sr-only" role="status">{{ commandArgumentDescription }}</span>
          <span :id="promptPredictionA11yId" class="composer-sr-only" role="status">{{ promptPredictionA11yText }}</span>
          <Tooltip :text="expanded ? t('composer.collapseTitle') : t('composer.expandTitle')">
          <button
            v-if="expanded || isGrown"
            class="expand-btn"
            type="button"
            :aria-label="expanded ? t('composer.collapseTitle') : t('composer.expandTitle')"
            @click="toggleExpand"
          >
            <Icon v-if="expanded" name="collapse" size="sm" />
            <Icon v-else name="expand" size="sm" />
          </button>
          </Tooltip>
        </div>
      </div>

      <input
        v-if="hasUpload"
        ref="fileInputRef"
        type="file"
        multiple
        class="file-input-hidden"
        @change="handleFileInputChange"
      />

      <div ref="toolbarRef" class="toolbar">
        <div ref="menuMeasureRef" class="menu-measure" aria-hidden="true">
          <span class="pd-desc" />
        </div>

        <div class="toolbar-left">
          <IconButton
            v-if="isSideChat && hasUpload"
            class="composer-attach"
            size="md"
            :label="t('composer.addFilesDesc')"
            :tooltip="t('composer.addFilesDesc')"
            @mousedown.prevent
            @click.stop="onAddFiles"
          >
            <Icon name="attachment" />
          </IconButton>
          <IconButton
            v-else-if="!isSideChat"
            class="composer-attach"
            size="md"
            :label="t('composer.addMenu')"
            :tooltip="t('composer.addMenu')"
            aria-haspopup="menu"
            :aria-expanded="addMenuOpen"
            @mousedown.prevent
            @click.stop="toggleAddMenu"
          >
            <Icon name="plus" />
          </IconButton>

          <Tooltip v-if="status && !isSideChat" :text="toolbarLabelsCollapsed ? permLabel : null">
            <span
              ref="permPillRef"
              class="perm-pill"
              :class="['perm-' + status.permission, { open: permDropdownOpen }]"
              role="button"
              tabindex="0"
              :aria-label="permLabel"
              @click.stop="togglePermDropdown"
              @keydown.enter="togglePermDropdown"
              @keydown.space.prevent="togglePermDropdown"
            >
              <Icon class="perm-pill-icon" :name="permIcon" size="md" />
              <span class="perm-pill-label">{{ permLabel }}</span>
            </span>
          </Tooltip>

          <Transition name="ui-menu-pop">
            <Menu
              v-if="permDropdownOpen && status && (!nativePermissionMenu?.available || isMobile)"
              ref="permDropdownRef"
              class="perm-dropdown"
              :class="{ 'flip-down': permMenuDropDown }"
              :style="permissionMenuStyle"
              @click.stop
            >
              <MenuItem
                v-for="opt in PERM_MODES"
                :key="opt.mode"
                class="pd-row"
                :class="{ 'is-current': opt.mode === status.permission }"
                :active="opt.mode === status.permission"
                role="menuitemradio"
                :aria-checked="opt.mode === status.permission"
                @click="choosePermission(opt.mode)"
              >
                <span class="pd-icon"><Icon :name="opt.icon" size="md" :style="{ color: opt.color }" /></span>
                <span class="pd-info">
                  <span class="pd-name" :style="{ color: opt.color }">{{ t(opt.labelKey) }}</span>
                  <span class="pd-desc">{{ t(opt.descKey) }}</span>
                </span>
                <span class="pd-check"><Icon v-if="opt.mode === status.permission" name="check" size="sm" style="color: var(--color-accent)" /></span>
              </MenuItem>
            </Menu>
          </Transition>

          <span v-if="swarmOn && !isSideChat" class="swarm-chip">
            <Tooltip :text="t('status.swarmTooltip')">
              <Icon class="swarm-ic" name="sparkles" size="md" />
              <span class="swarm-label">{{ t('status.swarmLabel') }}</span>
            </Tooltip>
            <IconButton
              class="swarm-x"
              size="sm"
              :label="t('status.swarmDismiss')"
              :tooltip="t('status.swarmDismiss')"
              @mousedown.prevent
              @click.stop="void client.toggleSwarmMode()"
            >
              <Icon name="close" size="sm" />
            </IconButton>
          </span>

          <span v-if="towerOn && towerExperimentEnabled && !isSideChat" class="tower-chip">
            <Icon class="tower-ic" name="tower" size="md" />
            <span class="tower-label">{{ t('status.towerLabel') }}</span>
            <IconButton
              class="tower-x"
              size="sm"
              :label="t('status.towerDismiss')"
              :tooltip="t('status.towerDismiss')"
              @mousedown.prevent
              @click.stop="void client.toggleTowerMode()"
            >
              <Icon name="close" size="sm" />
            </IconButton>
          </span>

        </div>

        <div ref="toolbarRightRef" class="toolbar-right">
          <Tooltip :text="ctxCardOpen ? null : ctxTooltip">
            <template v-if="status && !hideContext && !isSideChat">
              <button
                v-if="contextInspectorEnabled"
                ref="ctxBtnRef"
                type="button"
                class="ctx-group ctx-trigger"
                :class="{ open: ctxCardOpen }"
                aria-haspopup="dialog"
                :aria-expanded="ctxCardOpen"
                :aria-label="ctxTooltip"
                @click.stop="toggleCtxCard"
                @keydown="onCtxCardKeydown"
              >
                <ContextRing :pct="pct" :indeterminate="compacting" />
              </button>
              <span
                v-else
                class="ctx-group"
                role="img"
                tabindex="0"
                :aria-label="ctxTooltip"
              >
                <ContextRing :pct="pct" :indeterminate="compacting" />
              </span>
            </template>
          </Tooltip>

          <Tooltip v-if="status && !isSideChat && hostSetupId" :text="modelPillCollapsed ? t('login.configureHostModelsAction') : null">
          <button
            type="button"
            class="model-pill login-pill"
            :class="{ 'icon-only': modelPillCollapsed, 'model-gone': modelPillGone }"
            :aria-label="modelPillCollapsed ? t('login.configureHostModelsAction') : undefined"
            @click.stop="openHostSetup"
          >
            <Icon v-if="modelPillCollapsed" name="bolt" size="md" />
            <template v-else>
              <Icon name="bolt" size="sm" />
              <span ref="mpNameRef" class="mp-name">{{ t('login.configureHostModelsAction') }}</span>
            </template>
          </button>
          </Tooltip>
          <Tooltip v-else-if="status && !isSideChat && (gateVerdict === 'ok' || (gateVerdict === 'upgrade' && currentModel))" :text="modelPillCollapsed ? modelIconLabel : null">
          <button
            ref="modelPillRef"
            type="button"
            class="model-pill"
            :class="{ open: dropdownOpen, 'icon-only': modelPillCollapsed, 'model-gone': modelPillGone }"
            aria-haspopup="menu"
            :aria-expanded="dropdownOpen"
            :aria-label="modelPillCollapsed ? modelIconLabel : undefined"
            @click.stop="toggleDropdown"
          >
            <Icon v-if="modelPillCollapsed" name="model" size="md" />
            <template v-else>
              <span ref="mpNameRef" class="mp-name">{{ status.model }}</span>
              <span v-if="thinkingSuffix" class="think-suffix">{{ thinkingSuffix }}</span>
              <Icon class="cv" name="chevron-down" size="sm" />
            </template>
          </button>
          </Tooltip>
          <Tooltip v-else-if="status && !isSideChat && (showPickModel || (gateVerdict === 'upgrade' && !currentModel))" :text="modelPillCollapsed ? t('login.pickModelAction') : null">
          <button
            ref="modelPillRef"
            type="button"
            class="model-pill"
            :class="{ open: dropdownOpen, 'icon-only': modelPillCollapsed, 'model-gone': modelPillGone }"
            aria-haspopup="menu"
            :aria-expanded="dropdownOpen"
            :aria-label="modelPillCollapsed ? t('login.pickModelAction') : undefined"
            @click.stop="toggleDropdown"
          >
            <Icon v-if="modelPillCollapsed" name="model" size="md" />
            <template v-else>
              <Icon name="model" size="sm" />
              <span ref="mpNameRef" class="mp-name">{{ t('login.pickModelAction') }}</span>
              <Icon class="cv" name="chevron-down" size="sm" />
            </template>
          </button>
          </Tooltip>
          <Tooltip v-else-if="status && !isSideChat && showConfigureModel" :text="modelPillCollapsed ? t('login.configureModelsAction') : null">
          <button
            type="button"
            class="model-pill login-pill"
            :class="{ 'icon-only': modelPillCollapsed, 'model-gone': modelPillGone }"
            :aria-label="modelPillCollapsed ? t('login.configureModelsAction') : undefined"
            @click.stop="emit('configureModel')"
          >
            <Icon v-if="modelPillCollapsed" name="bolt" size="md" />
            <template v-else>
              <Icon name="bolt" size="sm" />
              <span ref="mpNameRef" class="mp-name">{{ t('login.configureModelsAction') }}</span>
            </template>
          </button>
          </Tooltip>
          <!-- Signed out / no models — the pill slot becomes the sign-in entry
               (deep-links into the settings account tab). It plays the model
               pill's role in the collapse: its name is the same valve, and it
               sheds to its bare icon (then yields entirely) on the same stages. -->
          <Tooltip v-else-if="status && !isSideChat && showSignIn" :text="modelPillCollapsed ? t('login.action') : null">
          <button
            type="button"
            class="model-pill login-pill"
            :class="{ 'icon-only': modelPillCollapsed, 'model-gone': modelPillGone }"
            :aria-label="modelPillCollapsed ? t('login.action') : undefined"
            @click.stop="emit('login')"
          >
            <Icon v-if="modelPillCollapsed" name="log-in" size="md" />
            <template v-else>
              <Icon name="log-in" size="sm" />
              <span ref="mpNameRef" class="mp-name">{{ t('login.action') }}</span>
            </template>
          </button>
          </Tooltip>
          <span v-if="statusNote" class="status-note">{{ statusNote }}</span>
          <Tooltip v-if="stopButtonVisible" :text="t(interruptArmed ? 'composer.interruptConfirm' : 'composer.interruptTitle')">
            <button
              class="stop"
              :class="{ 'is-armed': interruptArmed }"
              :aria-label="t(interruptArmed ? 'composer.interruptConfirm' : 'composer.interrupt')"
              @click="emit('interrupt')"
            >
              <span v-if="interruptArmed" class="stop-esc" aria-hidden="true">ESC</span>
              <Icon v-else name="stop" size="sm" />
            </button>
          </Tooltip>
          <Tooltip :text="sendLabel">
          <button
            class="send"
            :class="{ 'is-starting': starting }"
            :aria-label="sendLabel"
            :disabled="starting || !canSend"
            @click="handleSubmit()"
          >
            <Spinner v-if="starting" size="sm" />
            <Icon v-else name="send" size="sm" />
          </button>
          </Tooltip>
        </div>

        <Transition name="ui-menu-pop">
          <ModelQuickMenu
            v-if="dropdownOpen && status && (!nativeModelMenu?.available || isMobile)"
            ref="modelDropdownRef"
            class="model-dropdown"
            :style="modelMenuStyle"
            :models="quickModelMenuPayload.models"
            :recent-models="quickModelMenuPayload.recentModels"
            :provider-models="quickModelMenuPayload.providerModels"
            :providers="quickModelMenuPayload.providers"
            :active-provider="quickModelMenuPayload.activeProvider"
            :active-provider-label="quickModelMenuPayload.activeProviderLabel"
            :current-model-id="quickModelMenuPayload.currentModelId"
            :current-effort="quickModelMenuPayload.currentEffort"
            :max-height="webModelMenuMaxHeight"
            @click.stop
            @select-model="(modelId, effort) => onQuickModelAction({ type: 'select-model', modelId, ...(effort === undefined ? {} : { effort }) })"
            @select-effort="(effort) => onQuickModelAction({ type: 'select-effort', effort })"
            @select-provider="(providerId) => onQuickModelAction({ type: 'select-provider', providerId })"
            @dismiss="closeDropdown"
          />
        </Transition>

        <Transition name="ui-menu-pop">
          <Menu
            v-if="ctxCardOpen && status && !isSideChat"
            ref="ctxCardRef"
            role="dialog"
            class="ctx-card"
            :class="{ 'flip-down': ctxCardDropDown }"
            :style="ctxCardStyle"
            :aria-label="t('inspector.title')"
            @click.stop
            @keydown="onCtxCardKeydown"
          >
            <div class="ctx-card-head">
              <span class="ctx-card-title">{{ t('inspector.title') }}</span>
            </div>

            <ContextSummaryBody
              :snapshot="ctxSnapshot"
              :ctx-used="status.ctxUsed"
              :ctx-max="status.ctxMax"
              :loading="ctxLoading"
              :error="ctxError"
              :can-compact="canCompactContext"
              :compact-phase="compactPhase"
              :can-open-detail="canOpenContextDetail"
              show-divider
              @compact="handleCompactFromCard"
              @open-detail="handleOpenContextDetail"
            />
          </Menu>
        </Transition>
      </div>
  </div>

  <!-- Optional footer (empty-session workspace picker) — a sibling of the
       card, so the attachment can tuck under the complete card shell. -->
  <div v-if="$slots.footer" class="composer-footer">
    <slot name="footer" />
  </div>
  <!-- Full-window drop target affordance: shown while files are dragged anywhere
       over the app (document-level listeners in useAttachmentUpload). Pure CSS
       show/hide — a Vue <Transition> can strand an invisible node when the drag
       ends before the enter transition starts. -->
  <div class="drop-overlay" :class="{ show: isDragOver }" aria-hidden="true">
    <div class="drop-card">
      <Icon name="file-plus" size="lg" />
      <span>{{ t('composer.dropToAttach') }}</span>
    </div>
  </div>

  <!-- Mobile menu sheets: the slash / mention / add popups as grab-handle
       bottom sheets (the inline popups' viewport clamp is unreliable under
       the iOS software keyboard). Teleported to <body> — the composer card's
       container-type would otherwise capture the sheet's fixed positioning.
       Each sheet's search box edits the same /token or @token as the
       composer's text, so filtering and selection semantics are shared. -->
  <Teleport to="body">
    <BottomSheet
      :model-value="isMobile && slashOpen"
      :title="t('composer.slashSheetTitle')"
      @update:model-value="onSlashSheetClose"
    >
      <div class="msheet-search">
        <Input
          ref="slashSearchRef"
          v-model="slashSheetQuery"
          :placeholder="t('composer.slashSearchPlaceholder')"
          autocomplete="off"
          spellcheck="false"
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          :aria-expanded="!!menuAriaControls"
          :aria-controls="menuAriaControls"
          :aria-activedescendant="menuAriaActiveDescendant"
          @keydown="handleKeydown"
          @compositionstart="handleCompositionStart"
          @compositionend="handleCompositionEnd"
        />
      </div>
      <SlashMenu
        layout="sheet"
        :items="slashItems"
        :ranges="slashRanges"
        :active-index="slashActive"
        :query="slashSheetQuery"
        @select="selectSlashCommand"
        @hover="slashActive = $event"
      />
    </BottomSheet>
  </Teleport>
  <Teleport to="body">
    <BottomSheet
      :model-value="isMobile && mentionOpen"
      :title="t('composer.mentionSheetTitle')"
      @update:model-value="onMentionSheetClose"
    >
      <div class="msheet-search">
        <Input
          ref="mentionSearchRef"
          v-model="mentionSheetQuery"
          :placeholder="t('composer.mentionSearchPlaceholder')"
          autocomplete="off"
          spellcheck="false"
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          :aria-expanded="!!menuAriaControls"
          :aria-controls="menuAriaControls"
          :aria-activedescendant="menuAriaActiveDescendant"
          @keydown="handleKeydown"
          @compositionstart="handleCompositionStart"
          @compositionend="handleCompositionEnd"
        />
      </div>
      <MentionMenu
        layout="sheet"
        :items="mentionItems"
        :active-index="mentionActive"
        :loading="mentionLoading"
        :query="mentionQuery"
        :submenu-title="mentionSubmenuTitle"
        @select="selectMentionItem"
        @hover="mentionNavigate"
        @back="leaveMentionSessionMenu"
      />
    </BottomSheet>
  </Teleport>
  <Teleport to="body">
    <BottomSheet
      :model-value="isMobile && addMenuOpen"
      @update:model-value="onAddSheetClose"
    >
      <div ref="addSheetRef" class="msheet-add" role="menu" @keydown="onAddMenuKeydown">
        <div v-for="item in addItems" :key="item.id" class="am-entry">
          <button
            type="button"
            class="am-row"
            role="menuitem"
            @click="selectAddItem(item)"
          >
            <span class="am-icon"><Icon :name="item.icon" size="sm" /></span>
            <span class="am-name">{{ t(item.nameKey) }}</span>
            <span v-if="item.descKey" class="am-desc">{{ t(item.descKey) }}</span>
          </button>
          <ComposerScreenshotShortcut
            v-if="item.id === 'screenshot' && props.onConfigureScreenshotShortcut"
            class="am-shortcut"
            :keys="item.shortcutKeys ?? []"
            :unavailable="props.screenshotShortcutUnavailable"
            :failure-reason="props.screenshotShortcutFailureReason"
            @configure="onConfigureScreenshotShortcut"
          />
          <Kbd v-else-if="item.shortcutKeys?.length" class="am-shortcut" :keys="item.shortcutKeys" />
        </div>
      </div>
    </BottomSheet>
  </Teleport>
</div>
</template>

<style scoped>
.composer {
  padding: 7px var(--dock-inline-right, 16px) 12px var(--dock-inline-left, 16px);
  background: transparent;
  transition: background 0.12s;
}

.composer.drag-over {
  background: var(--color-accent-soft);
}

.drop-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--color-bg) 72%, transparent);
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transition:
    opacity var(--duration-base) ease,
    visibility var(--duration-base);
}
.drop-overlay.show {
  opacity: 1;
  visibility: visible;
}
.drop-card {
  padding: var(--space-4) var(--space-6);
}

.composer-tip {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 var(--space-1) var(--space-2);
  padding: var(--space-1-5) var(--space-2) var(--space-1-5) var(--space-3);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-xs);
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
  animation: composer-tip-in var(--duration-base) var(--ease-out);
}
.composer-tip-icon {
  flex: none;
  color: var(--color-accent);
}
.composer-tip-text {
  flex: 1;
  min-width: 0;
}
.composer-tip-link {
  border: 0;
  padding: 0 2px;
  background: none;
  color: var(--color-accent);
  font: inherit;
  font-weight: var(--weight-medium);
  cursor: pointer;
}
.composer-tip-link:hover {
  color: var(--color-accent-hover);
  text-decoration: underline;
}
.composer-tip-link:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
  border-radius: var(--radius-xs);
}
.composer-tip-close {
  flex: none;
}
@keyframes composer-tip-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .composer-tip {
    animation: none;
  }
}

.composer-card {
  --composer-control-size: var(--space-8);
  --composer-send-size: var(--composer-control-size);
  --composer-control-inset: var(--space-2);
  --composer-valve-floor: 4em;
  --composer-valve-expand-margin: 3.4em;
  position: relative;
  border: var(--p-hairline) solid var(--color-composer-line);
  border-radius: var(--radius-composer);
  corner-shape: var(--corner-shape-composer);
  background: var(--color-composer-bg);
  box-shadow: var(--shadow-input);
  user-select: none;
  container-type: inline-size;
}
.composer-card::after {
  content: '';
  position: absolute;
  inset: 0;
  border: inherit;
  border-color: var(--color-composer-focus-line);
  border-radius: var(--radius-composer);
  corner-shape: var(--corner-shape-composer);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--duration-slow) var(--ease-in-out);
}
.composer-card:focus-within::after {
  opacity: 1;
}

.file-input-hidden {
  display: none;
}

.cin-wrap {
  position: relative;
  padding: 14px 16px 8px;
}
.composer-card.has-media .cin-wrap {
  padding-top: var(--p-composer-media-inset);
}

.input-row {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.expand-btn {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 0;
  transition: background 0.12s, color 0.12s;
}

.expand-btn:hover {
  background: var(--panel2);
  color: var(--color-text);
}

.expand-btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.ph {
  --ph-leading: 1.5;
  --ph-line-height: calc(var(--content-font-size) * var(--ph-leading));
  color: var(--color-text-quaternary);
  caret-color: var(--color-text);
  position: relative;
  flex: 1;
  border: none;
  outline: none;
  font-family: var(--font-ui);
  font-size: var(--content-font-size);
  text-autospace: normal;
  background: transparent;
  min-height: 36px;
  max-height: calc(var(--app-height, 100dvh) / 4);
  overflow-y: auto;
  scrollbar-width: none;
  line-height: var(--ph-leading);
  margin-bottom: 6px;
  user-select: text;
}

.ph::-webkit-scrollbar {
  display: none;
}

.ph:not([data-empty='true']) {
  color: var(--color-text);
}

.ph :deep(.ProseMirror) {
  outline: none;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  min-height: inherit;
}

.ph :deep(.ProseMirror p) {
  margin: 0;
}

.ph :deep(.ProseMirror p:first-child) {
  text-indent: var(--wm-pill-inline-reserve, 0px);
  padding-top: var(--wm-pill-block-reserve, 0px);
}

.ph :deep(.mention-pill),
.ph :deep(.attachment-pill),
.ph :deep(.quote-pill) {
  text-indent: 0;
}

.ph :deep(img.ProseMirror-separator) {
  display: inline !important;
  border: none !important;
  margin: 0 !important;
}

.ph :deep(.ProseMirror-trailingBreak:not(:only-child)) {
  display: none;
}

.ph :deep(.mention-pill.ProseMirror-selectednode) {
  color: var(--color-text);
}

.composer-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

.ph :deep(.composer-command-token) {
  color: var(--color-text-muted);
  font-weight: var(--weight-ui-strong);
}

.ph :deep(.composer-placeholder-overlay[data-command-argument='true']) {
  color: var(--color-text-faint);
}

.ph :deep(.composer-placeholder-overlay[data-command-argument='true'][data-needs-separator='true']) {
  margin-left: var(--space-1);
}

.ph :deep(.wm-pill) {
  --wm-pill-lane: inline;
  position: absolute;
  z-index: var(--z-raised);
  top: 0;
  left: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  vertical-align: top;
  height: var(--ph-line-height);
  margin-left: calc(-1 * var(--space-05));
  margin-right: var(--space-1-5);
  padding: 0 calc((var(--ph-line-height) - var(--wm-x-size)) / 2) 0 var(--space-2);
  border: none;
  border-radius: var(--radius-full);
  background: var(--color-selected);
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  line-height: var(--ph-line-height);
  white-space: nowrap;
  user-select: none;
}

.ph :deep(.wm-icon) {
  display: inline-flex;
}

.ph :deep(.wm-x) {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: var(--wm-x-size);
  height: var(--wm-x-size);
  padding: 0;
  border: var(--p-hairline) solid transparent;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}
.ph :deep(.wm-x:hover) {
  background: var(--color-hover);
  color: var(--color-text);
}
.ph :deep(.wm-x:focus-visible) {
  outline: none;
  box-shadow: var(--p-focus-ring);
  background: var(--color-hover);
  color: var(--color-text);
}
.ph :deep(.wm-x)::before {
  content: '';
  position: absolute;
  inset: calc(-1 * var(--wm-x-ring));
}

.ph[data-wm='true'] :deep(.ProseMirror) {
  padding-left: var(--space-05);
}

.ph :deep(.composer-placeholder-overlay) {
  position: absolute;
  z-index: 1;
  top: 0;
  left: 0;
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--color-text-faint);
  pointer-events: none;
  user-select: none;
}

.ph :deep(.composer-placeholder-overlay[hidden]) {
  display: none;
}

.ph :deep(.composer-placeholder-overlay kbd) {
  vertical-align: top;
  margin-top: max(0px, calc((var(--ph-line-height) - var(--kbd-height)) / 2));
}

@supports (text-box: trim-both cap alphabetic) {
  .ph :deep(.composer-placeholder-overlay kbd) {
    display: inline-block;
    padding-top: calc((var(--kbd-height) - 1cap) / 2 - var(--p-hairline));
    text-align: center;
    text-box: trim-both cap alphabetic;
  }
}

.composer.expanded .ph {
  min-height: calc(var(--app-height, 100dvh) * 0.7);
  max-height: calc(var(--app-height, 100dvh) * 0.7);
}

.model-pill.model-gone { display: none; }

.composer-attach {
  width: var(--composer-control-size);
  height: var(--composer-control-size);
  border-radius: var(--radius-full);
  flex: none;
}

.add-menu {
  position: absolute;
  bottom: calc(100% + var(--space-2));
  left: 0;
  right: 0;
  z-index: var(--z-dropdown);
  background: var(--color-menu-bg-frost);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-menu);
  padding: var(--space-1-5) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--menu-rows-seam);
  font-family: var(--font-ui);
  transform-origin: bottom left;
}
.am-scroll {
  max-height: var(--p-add-menu-h);
  margin: 0 calc(-1 * var(--menu-row-hug));
  padding: 0 var(--menu-row-hug);
  overflow-y: auto;
  scrollbar-width: none;
  display: flex;
  flex-direction: column;
  gap: var(--menu-rows-seam);
}
.am-scroll::-webkit-scrollbar { display: none; }
.scroll-thumb {
  position: absolute;
  right: var(--menu-scrollbar-edge);
  width: var(--menu-scrollbar-width);
  border-radius: var(--radius-full);
  background: var(--color-menu-scrollbar);
  transition: background var(--duration-base) var(--ease-out);
  pointer-events: none;
  z-index: var(--z-raised);
}
.add-menu:hover .scroll-thumb {
  background: var(--color-menu-scrollbar-hover);
}

.msheet-search {
  padding: 0 var(--space-4) var(--space-2);
}
.msheet-add {
  display: flex;
  flex-direction: column;
  gap: var(--menu-rows-seam);
  padding: 0 var(--menu-row-hug);
  font-family: var(--font-ui);
}
.am-entry {
  display: flex;
  align-items: center;
  margin: 0 calc(-1 * var(--menu-row-hug));
  border-radius: var(--radius-menu-row);
  transition: background var(--duration-base) var(--ease-out);
}
.am-entry:hover:not(:has(.am-shortcut button:hover)) { background: var(--color-hover); }
.am-row {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: var(--menu-row-gap-icon);
  padding: var(--menu-row-padding-block) var(--menu-row-padding-inline);
  border: none;
  border-radius: var(--radius-menu-row);
  background: none;
  cursor: pointer;
  font-size: var(--text-base);
  color: var(--color-text);
  text-align: left;
  transition: background var(--duration-base) var(--ease-out);
}
.am-row:focus-visible { background: var(--color-selected); outline: none; }
@media (hover: none) {
  .am-row {
    padding-top: var(--menu-row-touch-padding-block);
    padding-bottom: var(--menu-row-touch-padding-block);
  }
}
.am-entry:hover:not(:has(.am-shortcut button:hover)) .am-icon,
.am-row:focus-visible .am-icon { color: var(--color-text); }
.am-icon {
  flex: none;
  width: var(--p-ic-sm);
  display: flex;
  justify-content: center;
  color: var(--color-text-muted);
  transition: color var(--duration-base) var(--ease-out);
}
.am-name {
  flex: none;
  font-weight: var(--weight-medium);
}
.am-desc {
  min-width: 0;
  margin-left: var(--space-1);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.am-shortcut {
  flex: none;
  margin-right: var(--menu-row-padding-inline);
  color: var(--color-text-muted);
}

.status-note {
  flex: none;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
}

.send {
  width: var(--composer-send-size);
  height: var(--composer-send-size);
  border-radius: var(--radius-full);
  background: var(--color-send-bg);
  color: var(--color-send-icon);
  border: none;
  box-shadow: var(--shadow-send);
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: background var(--duration-slow) var(--ease-out), transform var(--duration-fast) var(--ease-out), box-shadow var(--duration-slow) var(--ease-out);
  position: relative;
}

.send:hover:not(:disabled) {
  background: var(--color-send-bg-hover);
  box-shadow: var(--shadow-send-hover);
}

.send:active {
  transform: scale(0.92);
}

.send:disabled {
  cursor: not-allowed;
  background: var(--color-send-bg-disabled);
  color: var(--color-send-icon-disabled);
  opacity: var(--opacity-send-disabled);
}

.send:disabled:active {
  transform: none;
}

.send.is-starting:disabled {
  background: var(--color-send-bg);
  color: var(--color-send-icon);
}
.send.is-starting :deep(.ui-spinner) {
  color: var(--color-send-icon);
}

.send.is-starting :deep(.ui-spinner__track) {
  stroke: color-mix(in srgb, var(--color-send-icon) 32%, transparent);
}

.send svg {
  flex: none;
  width: var(--composer-send-icon-size);
  height: var(--composer-send-icon-size);
}

.stop {
  width: var(--composer-send-size);
  height: var(--composer-send-size);
  border-radius: var(--radius-full);
  background: var(--color-subtle);
  color: var(--color-stop-glyph);
  border: none;
  box-shadow: var(--shadow-xs);
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.16s ease, color 0.16s ease, transform 0.12s ease;
}
.stop.is-armed {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}
.stop:hover {
  background: var(--color-danger);
  color: var(--color-text-on-accent);
}
.stop:active {
  transform: scale(0.92);
}
.stop svg {
  flex: none;
  width: var(--composer-send-icon-size);
  height: var(--composer-send-icon-size);
}
.stop-esc {
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: var(--weight-semibold);
  letter-spacing: 0.02em;
  line-height: 1;
  transform: scale(0.72);
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-1) var(--composer-control-inset) var(--composer-control-inset);
  position: relative;
}

.menu-measure {
  position: absolute;
  width: max-content;
  height: 0;
  overflow: hidden;
  visibility: hidden;
  pointer-events: none;
}

.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}
.toolbar-left { flex: none; overflow: hidden; }
.toolbar-right {
  flex: 1 1 auto;
  justify-content: flex-end;
}

.perm-pill,
.swarm-chip,
.tower-chip,
.model-pill {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: var(--composer-control-size);
  padding: 0 var(--space-3);
  border: var(--p-hairline) solid transparent;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  transition: background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}
.perm-pill {
  font-size: var(--text-sm);
}
.perm-pill::after,
.swarm-chip::after,
.tower-chip::after,
.model-pill::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: var(--radius-full);
  background: var(--color-hover);
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
  pointer-events: none;
}
.perm-pill:hover::after,
.swarm-chip:hover::after,
.tower-chip:hover::after,
.model-pill:hover::after {
  opacity: 1;
}
.perm-pill.open,
.model-pill.open {
  background: var(--color-accent-soft);
}
.swarm-chip,
.tower-chip {
  cursor: default;
}
.swarm-x,
.tower-x {
  margin-right: calc(var(--composer-control-size) / 2 - var(--space-3) - var(--icon-button-sm) / 2);
  color: inherit;
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
}
.swarm-chip .swarm-x,
.tower-chip .tower-x {
  border-radius: var(--radius-full);
}
.swarm-chip:hover .swarm-x,
.swarm-x:focus-visible,
.tower-chip:hover .tower-x,
.tower-x:focus-visible {
  opacity: 1;
}
@media (hover: none) {
  .toolbar-left {
    padding-right: var(--space-2);
  }
  .swarm-chip,
  .tower-chip {
    margin-right: calc((var(--touch-target-min) - var(--icon-button-sm)) / 2 - var(--space-1));
  }
  .swarm-x,
  .tower-x {
    opacity: 1;
    position: relative;
  }
  .swarm-x::before,
  .tower-x::before {
    content: '';
    position: absolute;
    inset: calc(-1 * (var(--touch-target-min) - var(--icon-button-sm)) / 2);
  }
}

.perm-pill.perm-manual {
  color: var(--color-text-muted);
}
.perm-pill.perm-yolo {
  color: var(--color-warning);
}
.perm-pill.perm-auto {
  color: var(--color-danger);
}
.perm-pill-icon {
  flex: none;
}

.perm-pill,
.swarm-chip,
.tower-chip {
  flex: none;
  padding-left: var(--space-2);
}
.swarm-ic,
.swarm-x,
.tower-ic,
.tower-x {
  flex: none;
}

.labels-collapsed .perm-pill {
  width: var(--composer-control-size);
  height: var(--composer-control-size);
  padding: 0;
  justify-content: center;
  flex: none;
}
.labels-collapsed .perm-pill-label { display: none; }
.labels-collapsed .swarm-chip,
.labels-collapsed .tower-chip {
  position: relative;
  width: var(--composer-control-size);
  height: var(--composer-control-size);
  padding: 0;
  justify-content: center;
  flex: none;
}
.labels-collapsed .swarm-label,
.labels-collapsed .tower-label { display: none; }
.labels-collapsed .swarm-ic,
.labels-collapsed .tower-ic { transition: opacity var(--duration-base) var(--ease-out); }
.labels-collapsed .swarm-chip:hover .swarm-ic,
.labels-collapsed .tower-chip:hover .tower-ic { opacity: 0; }
.labels-collapsed .swarm-x,
.labels-collapsed .tower-x {
  position: absolute;
  inset: 0;
  width: auto;
  height: auto;
  margin-right: 0;
}
@media (hover: none) {
  .labels-collapsed .swarm-chip,
  .labels-collapsed .tower-chip {
    width: var(--touch-target-min);
    height: var(--touch-target-min);
  }
  .labels-collapsed .swarm-chip:hover .swarm-ic,
  .labels-collapsed .tower-chip:hover .tower-ic { opacity: 1; }
  .labels-collapsed .swarm-x,
  .labels-collapsed .tower-x {
    inset: 0;
    width: auto;
    height: auto;
    opacity: 1;
    background: transparent;
  }
  .labels-collapsed .swarm-x::before,
  .labels-collapsed .tower-x::before {
    inset: auto;
    top: 0;
    right: 0;
    width: var(--p-ic-md);
    height: var(--p-ic-md);
    border-radius: var(--radius-full);
    background: var(--color-selected);
  }
  .labels-collapsed .swarm-x :deep(svg),
  .labels-collapsed .tower-x :deep(svg) {
    position: absolute;
    top: calc(var(--space-1-5) / 2);
    right: calc(var(--space-1-5) / 2);
    width: calc(var(--p-ic-md) - var(--space-1-5));
    height: calc(var(--p-ic-md) - var(--space-1-5));
  }
}

.ctx-group {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 2px 0;
  border-radius: var(--radius-xs);
}
.ctx-group:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
.ctx-trigger {
  display: inline-flex;
  justify-content: center;
  gap: var(--space-1);
  padding: var(--space-1);
  border: 0;
  background: transparent;
  border-radius: var(--radius-full);
  cursor: pointer;
  transition: background var(--duration-base) var(--ease-out);
}
.ctx-trigger:hover {
  background: var(--color-hover);
}
.ctx-trigger.open {
  background: var(--color-accent-soft);
}
.ctx-trigger:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}

.ctx-card {
  position: absolute;
  bottom: calc(100% + var(--space-1));
  right: calc(var(--composer-control-inset) + var(--composer-send-size) + var(--space-1));
  z-index: var(--z-dropdown);
  width: 268px;
  max-width: calc(100vw - var(--space-8));
  padding: var(--space-3);
  gap: var(--space-2);
  transform-origin: bottom center;
  font-family: var(--font-ui);
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.ctx-card.flip-down {
  top: calc(100% + var(--space-1));
  bottom: auto;
  transform-origin: top center;
}

.ctx-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.ctx-card-title {
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  color: var(--color-text);
}

.model-pill {
  gap: var(--space-1);
  line-height: var(--leading-normal);
  overflow: hidden;
  flex: 0 1 auto;
  min-width: 0;
  max-width: 320px;
  transition:
    background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
}
.model-pill:active {
  transform: scale(0.97);
}
.model-pill:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.model-pill .mp-name {
  flex: 0 8 auto;
  font-weight: var(--weight-medium);
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.model-pill .think-suffix {
  color: var(--color-accent);
  font-weight: var(--weight-medium);
  flex: none;
}
.model-pill .cv {
  color: var(--color-text-quaternary);
  flex: none;
  transition:
    transform var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}
.model-pill:hover .cv,
.model-pill.open .cv {
  color: var(--color-text-muted);
}
.model-pill.open .cv {
  transform: rotate(180deg);
}

.model-pill.icon-only {
  width: var(--composer-control-size);
  height: var(--composer-control-size);
  padding: 0;
  justify-content: center;
  flex: none;
}

.model-pill.login-pill {
  color: var(--color-accent);
}
.model-pill.login-pill .mp-name {
  color: var(--color-accent);
}

.model-dropdown {
  position: absolute;
  bottom: calc(100% + var(--space-2));
  right: calc(var(--composer-control-inset) + var(--composer-send-size) + var(--space-1));
  z-index: var(--z-dropdown);
  transform-origin: bottom right;
}

.add-menu,
.model-dropdown,
.perm-dropdown,
.ctx-card {
  --menu-pop-shift: 2px;
}
.perm-dropdown.flip-down,
.ctx-card.flip-down {
  --menu-pop-shift: -2px;
}

.perm-dropdown {
  position: absolute;
  bottom: calc(100% + var(--space-1));
  left: var(--composer-control-inset);
  z-index: var(--z-dropdown);
  min-width: min(220px, 100%);
  width: max-content;
  max-width: 100%;
  box-sizing: border-box;
  padding: var(--space-1);
  gap: 1px;
  transform-origin: bottom left;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.perm-dropdown.flip-down {
  top: calc(100% + var(--space-1));
  bottom: auto;
  transform-origin: top left;
}

.pd-row {
  display: grid;
  grid-template-columns: var(--p-ic-md) minmax(0, var(--composer-menu-desc-width, max-content)) var(--p-ic-sm);
  column-gap: 7px;
  row-gap: 2px;
  align-items: start;
  padding: 6px 7px;
  border-radius: var(--radius-dropdown-row);
}
.pd-row.is-current { background: var(--color-hover); }

.pd-icon {
  grid-column: 1;
  grid-row: 1;
  width: var(--p-ic-md);
  min-height: 1lh;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: var(--leading-tight);
}
.pd-row .pd-icon :deep(svg) {
  width: var(--p-ic-md);
  height: var(--p-ic-md);
  color: inherit;
}

.pd-check {
  grid-column: 3;
  grid-row: 1;
  width: var(--p-ic-sm);
  min-height: 1lh;
  color: var(--color-accent);
  font-size: var(--text-base);
  font-weight: var(--weight-medium);
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: var(--leading-tight);
}
.pd-row .pd-check :deep(svg) {
  width: var(--p-ic-sm);
  height: var(--p-ic-sm);
  color: inherit;
}

.pd-info {
  display: contents;
}

.pd-name {
  grid-column: 2;
  grid-row: 1;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
}

.pd-desc {
  grid-column: 2;
  grid-row: 2;
  width: var(--composer-menu-desc-width, auto);
  max-width: 100%;
  overflow-wrap: break-word;
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-caption);
  color: var(--color-text-faint);
  line-height: var(--leading-tight);
}

@media (max-width: 640px) {
  .composer {
    padding:
      9px
      var(--dock-inline-right, max(12px, var(--safe-right)))
      max(24px, var(--safe-bottom))
      var(--dock-inline-left, max(12px, var(--safe-left)));
  }
  .composer-card {
    --composer-control-size: 36px;
    --composer-mobile-input-size: 16px;
    max-width: 100%;
  }
  .input-row {
    gap: 6px;
    min-width: 0;
  }
  .send {
    width: var(--composer-send-size);
    height: var(--composer-send-size);
    min-width: var(--composer-send-size);
    padding: 0;
    border-radius: var(--radius-full);
    font-size: 0;
    align-self: flex-end;
    position: relative;
  }
  .stop {
    width: var(--composer-send-size);
    height: var(--composer-send-size);
    min-width: var(--composer-send-size);
    padding: 0;
    border-radius: var(--radius-full);
    font-size: 0;
    align-self: flex-end;
    position: relative;
  }

  .ph :deep(.wm-pill) {
    height: calc(var(--composer-mobile-input-size) * 1.5);
    line-height: calc(var(--composer-mobile-input-size) * 1.5);
    padding-right: calc((var(--composer-mobile-input-size) * 1.5 - var(--wm-x-size)) / 2);
  }

  .model-dropdown {
    right: var(--composer-control-inset);
    left: auto;
  }

  .ph {
    font-size: var(--composer-mobile-input-size);
  }
  .model-pill,
  .attach-btn {
    font-size: var(--text-base);
  }
  .toolbar {
    gap: 6px;
    min-width: 0;
  }
  .toolbar-left,
  .toolbar-right {
    min-width: 0;
  }
  .model-pill {
    max-width: min(52vw, 220px);
  }
  .model-pill .mp-name {
    max-width: min(40vw, 170px);
  }
  .pd-name {
    font-size: var(--text-base);
  }
  .pd-desc {
    font-size: var(--text-xs);
  }
}

@media (hover: none) {
  .ph[data-wm='true'] :deep(.ProseMirror) {
    padding-top: var(--space-3);
  }
  .ph :deep(.wm-pill) {
    --wm-pill-lane: block;
    display: flex;
    width: max-content;
    margin-right: 0;
    margin-bottom: var(--space-3);
    padding-right: calc((var(--touch-target-min) - var(--wm-x-size)) / 2);
  }
  .ph :deep(.wm-x)::before {
    inset: calc((var(--wm-x-size) - var(--touch-target-min)) / 2);
  }
  .ph[data-wm='true'] {
    min-height: calc(36px + var(--space-3));
  }
}

@media (max-width: 640px) and (hover: none) {
  .send,
  .stop,
  .attach-btn,
  .expand-btn,
  .model-pill {
    position: relative;
  }
  .send::before,
  .stop::before,
  .attach-btn::before,
  .expand-btn::before,
  .model-pill::before {
    content: "";
    position: absolute;
    inset: -6px;
  }
  .expand-btn::before {
    inset: -11px;
  }
  .perm-pill {
    height: var(--touch-target-min);
  }
  .labels-collapsed .perm-pill {
    width: var(--touch-target-min);
    height: var(--touch-target-min);
  }
}
</style>

<style scoped src="../lib/drop-card.css"></style>
