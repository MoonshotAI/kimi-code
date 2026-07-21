<!-- apps/kimi-web/src/components/chat/Composer.vue -->
<script setup lang="ts">
import { measureNaturalWidth, prepareWithSegments } from '@chenglou/pretext';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import SlashMenu from './SlashMenu.vue';
import MentionMenu from './MentionMenu.vue';
import { buildSlashItems, parseSlash, SKILL_COMMAND_PREFIX } from '../../lib/slashCommands';
import { formatTokens } from '../../lib/formatTokens';
import type { FileItem } from './MentionMenu.vue';
import type { ActivationBadges, ConversationStatus, PermissionMode, QueuedPromptView } from '../../types';
import type { AppGoal, AppModel, AppSkill, ThinkingLevel } from '../../api/types';
import {
  commitLevel,
  effectiveThinkingLevel,
  effortLabel,
  isThinkingOn,
  modelThinkingAvailability,
  segmentsFor,
} from '../../lib/modelThinking';
import { useInputHistory } from '../../composables/useInputHistory';
import { useSlashMenu } from '../../composables/useSlashMenu';
import { useMentionMenu } from '../../composables/useMentionMenu';
import { useComposerDraft } from '../../composables/useComposerDraft';
import { useAttachmentUpload, type Attachment } from '../../composables/useAttachmentUpload';
import { openFileAttachment } from '../../lib/openFileAttachment';
import type { PromptAttachment } from '../../composables/useKimiWebClient';
import Spinner from '../ui/Spinner.vue';
import Button from '../ui/Button.vue';
import IconButton from '../ui/IconButton.vue';
import Icon from '../ui/Icon.vue';
import ContextRing from '../ui/ContextRing.vue';
import Tooltip from '../ui/Tooltip.vue';
import AttachmentChip from './AttachmentChip.vue';

// ---------------------------------------------------------------------------
// Props & emits
// ---------------------------------------------------------------------------

const props = withDefaults(defineProps<{
  running?: boolean;
  /** True while the empty-composer first prompt is being created + submitted.
   *  Disables the textarea and swaps the send button for a spinner. */
  starting?: boolean;
  /** Active session id — scopes the persisted unsent draft (per session). */
  sessionId?: string;
  queued?: QueuedPromptView[];
  searchFiles?: (q: string) => Promise<FileItem[]>;
  /** If undefined, attach button is hidden and paste/drag are no-ops. */
  uploadImage?: (file: Blob, name?: string) => Promise<{ fileId: string; name: string; mediaType: string } | null>;
  /** Status data (model, context, permission) — drives the bottom toolbar. */
  status?: ConversationStatus;
  thinking?: ThinkingLevel;
  planMode?: boolean;
  swarmMode?: boolean;
  goalMode?: boolean;
  goal?: AppGoal | null;
  activationBadges?: ActivationBadges;
  /** Available models for the quick-switch dropdown. */
  models?: AppModel[];
  /** Starred model ids shown at the top of the quick-switch dropdown. */
  starredIds?: string[];
  /** Session skills shown in the `/` menu (after the built-in commands). */
  skills?: AppSkill[];
  /** Hide the context-usage indicator (used on the empty-session landing page). */
  hideContext?: boolean;
}>(), {
  running: false,
  starting: false,
  queued: () => [],
  searchFiles: undefined,
  uploadImage: undefined,
  models: () => [],
  starredIds: () => [],
  skills: () => [],
});

const placeholder = computed(() =>
  props.starting
    ? t('composer.starting')
    : props.running
      ? t('composer.placeholderRunning')
      : props.goalMode
        ? t('status.goalPlaceholder')
        : t('composer.placeholder')
);

const emit = defineEmits<{
  submit: [payload: { text: string; attachments: PromptAttachment[] }];
  /** Steer the composer text (+ any queued prompts, merged by the parent)
      into the RUNNING turn — TUI ctrl+s. */
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
}>();

const { t, locale } = useI18n();

// ---------------------------------------------------------------------------
// Textarea + per-session draft persistence — see useComposerDraft.
// ---------------------------------------------------------------------------
const { text, textareaRef, autosize, loadForEdit, clearDraft } = useComposerDraft({
  sessionId: () => props.sessionId,
});

// ---------------------------------------------------------------------------
// Expanded editor — a taller, multi-line composing mode. While expanded, Enter
// inserts a newline instead of sending (send via the button or Cmd/Ctrl+Enter);
// it auto-collapses after a successful send. See handleKeydown / handleSubmit.
// ---------------------------------------------------------------------------
const expanded = ref(false);
function toggleExpand(): void {
  expanded.value = !expanded.value;
  // Re-fit the textarea after the min/max-height swap between modes, then
  // recompute growth against the *post-toggle* resting height. Without this,
  // collapsing would keep the isGrown measured against the expanded 70vh
  // min-height, hiding the toggle even though the collapsed draft is still
  // multi-line. (This does not affect the expanded state itself — once
  // expanded, it stays at 70vh until toggled back or sent.)
  void nextTick(() => {
    autosize();
    recomputeGrown();
    // Return focus to the textarea so the user can keep typing right away;
    // otherwise focus stays on the toggle button and the next Enter would
    // activate it again instead of inserting a newline.
    textareaRef.value?.focus();
  });
}

// Collapse the expanded editor after a successful send/steer and re-fit the
// textarea once the 70vh min-height is gone. On image-only sends the text is
// already empty, so the draft watcher never re-runs autosize — without this,
// the textarea keeps the inline height measured at 70vh and the collapsed cap
// (1/4 viewport) leaves an oversized empty box until the next keystroke.
function collapseAndRefit(): void {
  if (!expanded.value) return;
  expanded.value = false;
  void nextTick(autosize);
}

// The expand toggle is hidden at the resting height and only appears once the
// box has grown past it (multi-line content) — keeps the empty composer
// uncluttered. While expanded it always shows so the user can collapse back.
//
// The resting height equals the textarea's computed `min-height` (set in
// style.css). We read it from the element instead of hard-coding.
const RESTING_HEIGHT_FALLBACK_PX = 36;
function restingHeightPx(el: HTMLTextAreaElement): number {
  if (typeof getComputedStyle === 'undefined') return RESTING_HEIGHT_FALLBACK_PX;
  const min = Number.parseFloat(getComputedStyle(el).minHeight);
  return Number.isFinite(min) && min > 0 ? min : RESTING_HEIGHT_FALLBACK_PX;
}
const isGrown = ref(false);
function recomputeGrown(): void {
  const el = textareaRef.value;
  isGrown.value = !!el && el.scrollHeight > restingHeightPx(el);
}
watch(text, () => {
  // Registered after useComposerDraft's autosize watcher, so the inline height
  // already reflects the latest content when this reads scrollHeight.
  void nextTick(recomputeGrown);
});

// The component instance is reused across session switches (it is not keyed by
// session), so reset the per-session expanded preference when the active
// session changes. Without this, expanding in one chat would leave the next
// session's draft stuck in the tall editor with Enter inserting newlines.
watch(() => props.sessionId, () => {
  expanded.value = false;
});

// ---------------------------------------------------------------------------
// Sent-message history recall (shell-style ↑/↓). See useInputHistory for the
// implementation; the composer keeps the keydown orchestration (which also
// juggles the slash and mention menus).
// ---------------------------------------------------------------------------
const history = useInputHistory({ text, textareaRef, autosize, sessionId: () => props.sessionId });

// ---------------------------------------------------------------------------
// Slash-command menu — see useSlashMenu for the implementation. The composer
// keeps the keydown orchestration (arrow keys / Enter / Escape) because it also
// juggles the mention menu and history recall.
// ---------------------------------------------------------------------------
const {
  open: slashOpen,
  items: slashItems,
  active: slashActive,
  update: updateSlashMenu,
  select: selectSlashCommand,
} = useSlashMenu({
  text,
  textareaRef,
  autosize,
  skills: () => props.skills,
  emitCommand: (cmd) => emit('command', cmd),
  historyPush: (entry) => history.push(entry),
  clearDraft,
});

// ---------------------------------------------------------------------------
// @-mention menu — see useMentionMenu for the implementation. The composer
// keeps the keydown orchestration because it also juggles the slash menu and
// history recall.
// ---------------------------------------------------------------------------
const {
  open: mentionOpen,
  items: mentionItems,
  active: mentionActive,
  loading: mentionLoading,
  update: updateMentionMenu,
  select: selectMentionItem,
} = useMentionMenu({
  text,
  textareaRef,
  autosize,
  searchFiles: () => props.searchFiles,
});

// ---------------------------------------------------------------------------
// Input event handler — updates both menus
// ---------------------------------------------------------------------------

function handleInput(): void {
  // Manual typing leaves history-browsing mode — the text is now a fresh draft.
  history.resetBrowsing();
  updateSlashMenu();
  updateMentionMenu();
}

// ---------------------------------------------------------------------------
// Attachments — see useAttachmentUpload. The composer keeps handleSubmit /
// handleSteer (which read the attachments to build the payload) and the
// `hasUpload` toolbar flag.
// ---------------------------------------------------------------------------
const {
  attachments,
  previewAttachment,
  fileInputRef,
  isDragOver,
  removeAttachment,
  openAttachmentPreview,
  closeAttachmentPreview,
  openFilePicker,
  handleFileInputChange,
  handleDragOver,
  handleDragLeave,
  handleDrop,
  clearAfterSubmit,
  loadAttachments,
} = useAttachmentUpload({ uploadImage: () => props.uploadImage, sessionId: () => props.sessionId });

// Silence noUnusedLocals: fileInputRef is used as a template ref (ref="fileInputRef").
void fileInputRef;

onMounted(() => {
  // Fit the box to a restored draft on first render, and reflect its grown
  // state so the expand toggle shows for an already-long draft.
  if (text.value) {
    void nextTick(() => {
      autosize();
      recomputeGrown();
    });
  }
});

onUnmounted(() => {
  document.removeEventListener('mousedown', onModesDocClick);
  clearCompositionEndTimer();
});

// ---------------------------------------------------------------------------
// Submit / keydown
// ---------------------------------------------------------------------------

// loadForEdit comes from useComposerDraft (it lives next to the text state).
function focus(): void {
  // preventScroll keeps the pane from jumping if the composer is already in view
  // or if focus is triggered during an animation/transition.
  textareaRef.value?.focus({ preventScroll: true });
}
function loadAttachmentsForEdit(atts: { fileId?: string; kind: 'image' | 'video' | 'file'; url: string; name?: string }[]): void {
  loadAttachments(atts);
}
defineExpose({ loadForEdit, loadAttachmentsForEdit, focus });

// Build the wire-bound attachment payload: images/videos only need the fileId,
// while file parts also carry name/mediaType/size for the daemon's file shape.
function toPromptAttachment(a: Attachment): PromptAttachment {
  return { fileId: a.fileId!, kind: a.kind, name: a.name, mediaType: a.mediaType, size: a.size };
}

// Chip primary action: media opens the lightbox preview; a generic file opens
// in a new tab (browser-renderable types) or downloads, once its upload has
// completed and produced a daemon file id.
function onAttachmentActivate(att: Attachment): void {
  if (att.kind === 'file') {
    if (att.fileId !== undefined) void openFileAttachment(att.fileId, att.name, att.mediaType);
    return;
  }
  openAttachmentPreview(att);
}

function handleSubmit(): void {
  const trimmed = text.value.trim();

  // An upload is still in flight — submitting now would silently send the
  // message WITHOUT the image. Keep the text + chips (the chip shows its
  // uploading spinner); the user submits again in a moment.
  if (attachments.value.some((a) => a.uploading)) return;

  // Allow submission with images even when text is empty
  const readyAttachments = attachments.value.filter((a) => !a.uploading && !a.error && a.fileId);

  if (!trimmed && readyAttachments.length === 0) return;

  // Record for ↑/↓ recall before the slash branch so commands (with or without
  // args) are recallable too, not just plain messages. `push` ignores empty /
  // whitespace, so an image-only send adds nothing.
  history.push(trimmed);

  // If it's a known slash command, keep the optional tail as command input
  // instead of submitting it as normal chat text. This covers `/goal <task>`,
  // `/swarm <task>`, `/btw <question>`, slash skills with args, and bare
  // commands such as `/model`. A hand-typed bare skill name (`/deploy`) also
  // resolves to its prefixed menu entry (`/skill:deploy`), mirroring the TUI.
  if (trimmed) {
    const parsed = parseSlash(trimmed);
    const known = parsed
      ? buildSlashItems(props.skills).some(
          (item) => item.name === parsed.cmd || item.name === `/${SKILL_COMMAND_PREFIX}${parsed.cmd.slice(1)}`,
        )
      : false;
    if (parsed && known) {
      text.value = '';
      clearDraft();
      slashOpen.value = false;
      collapseAndRefit();
      emit('command', parsed.arg ? `${parsed.cmd} ${parsed.arg}` : parsed.cmd);
      return;
    }
  }

  const payload = {
    text: trimmed,
    attachments: readyAttachments.map((a) => toPromptAttachment(a)),
  };

  // Revoke object URLs and drop the submitted attachments.
  previewAttachment.value = null;
  clearAfterSubmit();

  text.value = '';
  clearDraft();
  slashOpen.value = false;
  mentionOpen.value = false;
  collapseAndRefit();
  emit('submit', payload);
}

/**
 * Steer (TUI ctrl+s): push the current text — and the parent merges any queued
 * prompts — straight into the running turn. With an empty composer it still
 * fires when something is queued, so "queue a few thoughts, then ctrl+s" works.
 */
function handleSteer(): void {
  if (!props.running) return;
  if (attachments.value.some((a) => a.uploading)) return;

  const trimmed = text.value.trim();
  const readyAttachments = attachments.value.filter((a) => !a.uploading && !a.error && a.fileId);
  if (!trimmed && readyAttachments.length === 0 && props.queued.length === 0) return;

  const payload = {
    text: trimmed,
    attachments: readyAttachments.map((a) => toPromptAttachment(a)),
  };
  clearAfterSubmit();
  history.push(trimmed);
  text.value = '';
  clearDraft();
  slashOpen.value = false;
  mentionOpen.value = false;
  collapseAndRefit();
  emit('steer', payload);
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

function handleKeydown(e: KeyboardEvent): void {
  if (isComposingKeyEvent(e)) return;

  // Close dropdowns on Escape
  if (e.key === 'Escape') {
    if (dropdownOpen.value) {
      e.preventDefault();
      closeDropdown();
      return;
    }
    if (permDropdownOpen.value) {
      e.preventDefault();
      closePermDropdown();
      return;
    }
  }

  // Slash menu navigation
  if (slashOpen.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      slashActive.value = (slashActive.value + 1) % slashItems.value.length;
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      slashActive.value = (slashActive.value - 1 + slashItems.value.length) % slashItems.value.length;
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const item = slashItems.value[slashActive.value];
      if (item) selectSlashCommand(item);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      slashOpen.value = false;
      return;
    }
  }

  // Mention menu navigation
  if (mentionOpen.value && !mentionLoading.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      mentionActive.value = (mentionActive.value + 1) % Math.max(1, mentionItems.value.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      mentionActive.value = (mentionActive.value - 1 + Math.max(1, mentionItems.value.length)) % Math.max(1, mentionItems.value.length);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const item = mentionItems.value[mentionActive.value];
      if (item) selectMentionItem(item);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      mentionOpen.value = false;
      return;
    }
  }

  // Ctrl+S / Cmd+S — steer into the running turn (TUI parity)
  if (e.key === 's' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
    if (props.running) {
      e.preventDefault();
      handleSteer();
    }
    return;
  }

  // History recall (shell-style ↑/↓) — see useInputHistory for the machinery.
  //
  // Disabled entirely in the expanded editor: that mode is for composing long
  // multi-line text, so the arrows always move the caret within the draft and
  // never jump to a previous message.
  //
  // ENTERING history: a plain ArrowUp only recalls when the caret is at the
  // very start of the text, so editing a multi-line draft with the arrows
  // still works — ArrowUp moves the caret within the draft until it reaches
  // the top, instead of jumping to a previous message mid-navigation.
  // ONCE BROWSING, the arrows walk history directly, regardless of where the
  // caret landed — a recalled multi-line entry leaves the caret at its end, and
  // the old "must be at the start" gate then trapped it there, so further
  // ArrowUp did nothing ("only one step back"). Walking freely while browsing
  // fixes that; typing exits history (handleInput resets browsing), after which
  // the arrows move the caret normally again.
  if (!expanded.value && !slashOpen.value && !mentionOpen.value && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
    const browsing = history.isBrowsing();
    if (e.key === 'ArrowUp' && history.hasHistory() && (browsing || history.caretAtTextStart())) {
      e.preventDefault();
      history.recallOlder();
      return;
    }
    if (e.key === 'ArrowDown' && browsing) {
      e.preventDefault();
      history.recallNewer();
      return;
    }
  }

  // Normal Enter / Shift+Enter
  if (e.key === 'Enter' && !e.shiftKey) {
    // Expanded editor: Enter inserts a newline; Cmd/Ctrl+Enter sends.
    // (Clicking the send button always sends.) Shift+Enter already falls
    // through to the default newline above, so behavior matches either way.
    if (expanded.value && !(e.metaKey || e.ctrlKey)) {
      return;
    }
    e.preventDefault();
    handleSubmit();
  }
}

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------

// Send is always "send" — while running it enqueues (handled upstream by
// sendPrompt). Interrupt lives on a separate Stop button so the two can never
// be confused.
const sendLabel = computed(() => t('composer.send'));
const hasUpload = computed(() => !!props.uploadImage);

// ---------------------------------------------------------------------------
// Bottom toolbar — split into individual controls
// ---------------------------------------------------------------------------

const dropdownOpen = ref(false);
const permDropdownOpen = ref(false);
const toolbarRef = ref<HTMLElement | null>(null);

function toggleDropdown(): void {
  dropdownOpen.value = !dropdownOpen.value;
  if (dropdownOpen.value) {
    permDropdownOpen.value = false;
    closeModes();
    document.addEventListener('click', onDocClick, true);
  } else {
    document.removeEventListener('click', onDocClick, true);
  }
}

function closeDropdown(): void {
  dropdownOpen.value = false;
  if (!permDropdownOpen.value) {
    document.removeEventListener('click', onDocClick, true);
  }
}

function togglePermDropdown(): void {
  permDropdownOpen.value = !permDropdownOpen.value;
  if (permDropdownOpen.value) {
    dropdownOpen.value = false;
    closeModes();
    document.addEventListener('click', onDocClick, true);
  } else {
    document.removeEventListener('click', onDocClick, true);
  }
}

function closePermDropdown(): void {
  permDropdownOpen.value = false;
  if (!dropdownOpen.value) {
    document.removeEventListener('click', onDocClick, true);
  }
}

function onDocClick(e: MouseEvent): void {
  if (toolbarRef.value && !toolbarRef.value.contains(e.target as Node)) {
    closeDropdown();
    closePermDropdown();
  }
}

onUnmounted(() => {
  document.removeEventListener('click', onDocClick, true);
});

// Clamped to 0–100: ctxUsed can momentarily exceed ctxMax (estimates), and
// ctxMax can be 0 before the first status fetch — both broke the ring. ceil
// (not round) so a session under 0.5% usage still shows a sliver of arc —
// Math.round floored it to an empty, "no data"-looking ring.
const pct = computed(() => {
  const max = props.status?.ctxMax ?? 0;
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.ceil(((props.status?.ctxUsed ?? 0) / max) * 100)));
});

const ctxTooltip = computed(() => {
  const used = formatTokens(props.status?.ctxUsed ?? 0);
  const max = formatTokens(props.status?.ctxMax ?? 0);
  return t('status.ctxTooltip', { used, max, pct: pct.value });
});

const showCompact = computed(() => pct.value >= 80);

// Thinking toggle
// Identity is the model id — display/model names can collide across providers.
const currentModel = computed(() =>
  props.models?.find((m) => m.id === props.status?.modelId),
);
const thinkingAvailability = computed(() => modelThinkingAvailability(currentModel.value));
const thinkingSegments = computed(() => segmentsFor(currentModel.value));
// The client resolves the level per model (the model's stored pick when still
// declared, else the catalog default), so what arrives here is valid for the
// active model and highlights its segment. An undeclared level can only appear
// transiently, before the catalog loads, and simply highlights no segment.
const thinkingLevel = computed(() => effectiveThinkingLevel(currentModel.value, props.thinking));
const activeThinkingSegment = computed(() => {
  const segs = thinkingSegments.value;
  return segs.includes(thinkingLevel.value) ? thinkingLevel.value : '';
});
const thinkingOn = computed(() => isThinkingOn(thinkingLevel.value));
// Single-segment (always-on boolean) or unsupported models can't be changed.
const thinkingReadonly = computed(
  () => thinkingAvailability.value === 'unsupported' || thinkingSegments.value.length <= 1,
);
// Footer-style suffix: effort models show the concrete level; boolean models
// keep the plain "thinking" tag; off shows nothing.
const thinkingSuffix = computed(() => {
  if (!thinkingOn.value) return '';
  const hasEfforts = (currentModel.value?.supportEfforts?.length ?? 0) > 0;
  const level = thinkingLevel.value;
  if (hasEfforts && level !== 'on') return t('composer.thinkingSuffixEffort', { level });
  return t('composer.thinkingSuffix');
});
function setThinkingSegment(draft: string): void {
  if (thinkingReadonly.value) return;
  emit('setThinking', commitLevel(currentModel.value, draft));
}
function thinkingSegmentLabel(segment: string): string {
  if (segment === 'on') return t('status.thinkingOn');
  if (segment === 'off') return t('status.thinkingOff');
  return effortLabel(segment);
}

// Plan toggle
const planOn = computed(() => props.planMode === true);
const swarmOn = computed(() => props.swarmMode === true);
const goalStatus = computed(() => props.goal?.status ?? props.activationBadges?.goal?.status ?? null);
const goalActive = computed(() => goalStatus.value !== null && goalStatus.value !== 'complete');
const goalArmed = computed(() => goalActive.value || props.goalMode === true);
const goalCanPause = computed(() => goalStatus.value === 'active');
const goalCanResume = computed(() => goalStatus.value === 'paused' || goalStatus.value === 'blocked');

// Modes selector (plan / goal / swarm) — the popover that replaces the bare
// "plan" pill. Plan/Swarm are real client toggles; goal reflects agent-driven
// state and focuses its card when active.
const modesOpen = ref(false);
const modesRef = ref<HTMLElement | null>(null);
const modesMenuRef = ref<HTMLElement | null>(null);
// The menu is position:fixed (so no composer stacking context can paint over
// it); these coords anchor it just above the pill, computed on open.
const modesMenuStyle = ref<Record<string, string>>({});
const anyModeActive = computed(() => planOn.value || swarmOn.value || goalArmed.value);
function closeModes(): void {
  modesOpen.value = false;
  document.removeEventListener('mousedown', onModesDocClick);
}
function onModesDocClick(e: MouseEvent): void {
  const t = e.target as Node;
  if (modesRef.value?.contains(t) || modesMenuRef.value?.contains(t)) return;
  closeModes();
}
function toggleModes(): void {
  if (modesOpen.value) {
    closeModes();
    return;
  }
  // Keep the toolbar menus mutually exclusive so they never overlap.
  closeDropdown();
  closePermDropdown();
  const r = modesRef.value?.getBoundingClientRect();
  if (r) {
    modesMenuStyle.value = {
      left: `${Math.round(r.left)}px`,
      bottom: `${Math.round(window.innerHeight - r.top + 8)}px`,
    };
  }
  modesOpen.value = true;
  setTimeout(() => document.addEventListener('mousedown', onModesDocClick), 0);
}
// Permission modes
const PERM_MODES: { mode: PermissionMode; color: string; labelKey: string; descKey: string }[] = [
  { mode: 'manual', color: 'var(--dim)', labelKey: 'status.permissionManual', descKey: 'status.permissionManualDesc' },
  { mode: 'yolo', color: 'var(--color-warning)', labelKey: 'status.permissionYolo', descKey: 'status.permissionYoloDesc' },
  { mode: 'auto', color: 'var(--color-danger)', labelKey: 'status.permissionAuto', descKey: 'status.permissionAutoDesc' },
];
const MODE_DESC_KEYS = ['status.planDesc', 'status.swarmDesc', 'status.goalDesc'] as const;

const menuMeasureRef = ref<HTMLElement | null>(null);
const permissionDescriptionWidth = ref('');
const modeDescriptionWidth = ref('');
function menuDescStyle(width: string): Record<string, string> {
  const style: Record<string, string> = {};
  if (width) style['--composer-menu-desc-width'] = width;
  return style;
}
const permissionMenuStyle = computed<Record<string, string>>(() => menuDescStyle(permissionDescriptionWidth.value));
const modeMenuMeasureStyle = computed<Record<string, string>>(() => menuDescStyle(modeDescriptionWidth.value));
const modesMenuInlineStyle = computed<Record<string, string>>(() => ({
  ...modesMenuStyle.value,
  ...modeMenuMeasureStyle.value,
}));
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
  const modeWidth = Math.max(
    0,
    ...MODE_DESC_KEYS.map((key) => measureTextWidth(t(key), style)),
  );
  permissionDescriptionWidth.value = permissionWidth > 0 ? `${Math.ceil(permissionWidth)}px` : '';
  modeDescriptionWidth.value = modeWidth > 0 ? `${Math.ceil(modeWidth)}px` : '';
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

watch(locale, scheduleMenuDescriptionMeasure, { immediate: true });

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
  emit('setPermission', mode);
  closePermDropdown();
}

const permInfo = computed(() => PERM_MODES.find((p) => p.mode === props.status?.permission));
const permLabel = computed(() => (permInfo.value ? t(permInfo.value.labelKey) : ''));

// ---------------------------------------------------------------------------
// Model dropdown — current provider models + thinking + more
// ---------------------------------------------------------------------------

const currentProvider = computed(() => {
  return currentModel.value?.provider ?? '';
});

const providerModels = computed(() => {
  if (!currentProvider.value || !props.models?.length) return [];
  return props.models.filter((m) => m.provider === currentProvider.value);
});

const starredSet = computed(() => new Set(props.starredIds ?? []));
function isStarred(modelId: string): boolean {
  return starredSet.value.has(modelId);
}
const starredOtherModels = computed(() => {
  if (!props.models?.length) return [];
  return props.models.filter(
    (m) => isStarred(m.id) && m.provider !== currentProvider.value,
  );
});

function selectModel(modelId: string): void {
  emit('selectModel', modelId);
  closeDropdown();
}
</script>

<template>
  <div
    class="composer"
    :class="{ 'drag-over': isDragOver, expanded }"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <!-- Attachment chips (above the input row) -->
    <div v-if="attachments.length > 0" class="att-strip">
      <AttachmentChip
        v-for="att in attachments"
        :key="att.localId"
        :kind="att.kind"
        :name="att.name"
        :url="att.previewUrl"
        :file-id="att.fileId"
        :media-type="att.mediaType"
        :size="att.size"
        :uploading="att.uploading"
        :error="att.error"
        removable
        :remove-label="t('composer.removeNamed', { name: att.name })"
        @activate="onAttachmentActivate(att)"
        @remove="removeAttachment(att.localId)"
      />
    </div>

    <div v-if="previewAttachment" class="att-lightbox" @click.self="closeAttachmentPreview">
      <div class="att-lightbox-card">
        <Tooltip :text="t('model.close')">
          <button type="button" class="att-lightbox-close" @click="closeAttachmentPreview">✕</button>
        </Tooltip>
        <video
          v-if="previewAttachment.kind === 'video'"
          class="att-lightbox-media"
          :src="previewAttachment.previewUrl"
          controls
          playsinline
        />
        <img v-else class="att-lightbox-media" :src="previewAttachment.previewUrl" :alt="previewAttachment.name" />
        <div class="att-lightbox-name">{{ previewAttachment.name }}</div>
      </div>
    </div>

    <!-- Main composer card -->
    <div class="composer-card">
      <!-- Input row with popup menus -->
      <div class="cin-wrap">
        <!-- Slash menu (above textarea) -->
        <SlashMenu
          v-if="slashOpen"
          :items="slashItems"
          :active-index="slashActive"
          @select="selectSlashCommand"
          @hover="slashActive = $event"
        />

        <!-- Mention menu (above textarea) -->
        <MentionMenu
          v-if="mentionOpen"
          :items="mentionItems"
          :active-index="mentionActive"
          :loading="mentionLoading"
          @select="selectMentionItem"
          @hover="mentionActive = $event"
        />

        <div class="input-row">
          <textarea
            ref="textareaRef"
            v-model="text"
            class="ph"
            :placeholder="placeholder"
            :disabled="starting"
            rows="1"
            @keydown="handleKeydown"
            @compositionstart="handleCompositionStart"
            @compositionend="handleCompositionEnd"
            @input="handleInput"
          />
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
        </div>
      </div>

      <!-- Hidden file input (no accept filter — any file type can be attached) -->
      <input
        v-if="hasUpload"
        ref="fileInputRef"
        type="file"
        multiple
        class="file-input-hidden"
        @change="handleFileInputChange"
      />

      <!-- Bottom toolbar — split into individual controls -->
      <div ref="toolbarRef" class="toolbar">
        <div ref="menuMeasureRef" class="menu-measure" aria-hidden="true">
          <span class="pd-desc" />
        </div>

        <!-- Left: attach + permission + plan -->
        <div class="toolbar-left">
          <IconButton
            v-if="hasUpload"
            size="md"
            :label="t('composer.attachFile')"
            @click="openFilePicker"
          >
            <Icon name="attachment" />
          </IconButton>

          <!-- Permission pill — click to open dropdown -->
          <span
            v-if="status"
            class="perm-pill"
            :class="['perm-' + status.permission, { open: permDropdownOpen }]"
            role="button"
            tabindex="0"
            @click.stop="togglePermDropdown"
            @keydown.enter="togglePermDropdown"
            @keydown.space.prevent="togglePermDropdown"
          >{{ permLabel }}</span>

          <!-- Permission dropdown — anchored to the toolbar left side -->
          <div
            v-if="permDropdownOpen && status"
            class="perm-dropdown"
            :style="permissionMenuStyle"
            role="menu"
            @click.stop
          >
            <button
              v-for="opt in PERM_MODES"
              :key="opt.mode"
              class="pd-row"
              :class="{ 'is-current': opt.mode === status.permission }"
              role="menuitem"
              @click="choosePermission(opt.mode)"
            >
              <span class="pd-check"><Icon v-if="opt.mode === status.permission" name="check" size="sm" /></span>
              <span class="pd-info">
                <span class="pd-name" :style="{ color: opt.color }">{{ t(opt.labelKey) }}</span>
                <span class="pd-desc">{{ t(opt.descKey) }}</span>
              </span>
            </button>
          </div>

          <!-- Modes selector (plan / goal / swarm) — replaces the plan pill. -->
          <div v-if="status" ref="modesRef" class="modes">
            <button
              type="button"
              class="mode-pill"
              :class="{ on: anyModeActive, open: modesOpen }"
              @click.stop="toggleModes"
            >
              <span class="mode-label">{{ t('status.modesLabel') }}</span>
              <span v-if="planOn" class="mode-tag">{{ t('status.planLabel') }}</span>
              <span v-if="swarmOn" class="mode-tag">{{ t('status.swarmLabel') }}</span>
              <span v-if="goalArmed" class="mode-tag">{{ t('status.goalLabel') }}</span>
            </button>

            <div v-if="modesOpen" ref="modesMenuRef" class="modes-menu" :style="modesMenuInlineStyle" role="menu">
              <!-- Plan — functional client toggle -->
              <button type="button" class="mode-row" :class="{ on: planOn }" role="menuitem" @click="emit('togglePlan')">
                <span class="mode-row-icon"><Icon name="file-edit" size="sm" /></span>
                <span class="mode-row-info">
                  <span class="mode-row-name">{{ t('status.planLabel') }}</span>
                  <span class="mode-row-desc">{{ t('status.planDesc') }}</span>
                </span>
                <span class="mode-switch" :class="{ on: planOn }"><span class="mode-knob" /></span>
              </button>
              <!-- Swarm — functional client toggle -->
              <button type="button" class="mode-row" :class="{ on: swarmOn }" role="menuitem" @click="emit('toggleSwarm')">
                <span class="mode-row-icon"><Icon name="sparkles" size="sm" /></span>
                <span class="mode-row-info">
                  <span class="mode-row-name">{{ t('status.swarmLabel') }}</span>
                  <span class="mode-row-desc">{{ t('status.swarmDesc') }}</span>
                </span>
                <span class="mode-switch" :class="{ on: swarmOn }"><span class="mode-knob" /></span>
              </button>
              <!-- Goal — lifecycle controls when active; switch is on when active or armed. -->
              <div class="mode-row mode-row-goal" :class="{ on: goalActive || props.goalMode }">
                <button
                  type="button"
                  class="mode-row-main"
                  role="menuitem"
                  @click="goalActive ? emit('focusGoal') : emit('toggleGoal')"
                >
                  <span class="mode-row-icon"><Icon name="target" size="sm" /></span>
                  <span class="mode-row-info">
                    <span class="mode-row-name">{{ t('status.goalLabel') }}</span>
                    <span class="mode-row-desc">{{ t('status.goalDesc') }}</span>
                  </span>
                  <span v-if="!goalActive" class="mode-switch" :class="{ on: props.goalMode }"><span class="mode-knob" /></span>
                </button>
                <div v-if="goalActive" class="mode-row-actions">
                  <Button
                    v-if="goalCanPause"
                    size="sm"
                    variant="secondary"
                    class="mode-row-action"
                    @click="emit('controlGoal', 'pause')"
                  >
                    <Icon name="pause" size="sm" />
                    <span>{{ t('status.goalPause') }}</span>
                  </Button>
                  <Button
                    v-if="goalCanResume"
                    size="sm"
                    variant="primary"
                    class="mode-row-action"
                    @click="emit('controlGoal', 'resume')"
                  >
                    <Icon name="play" size="sm" />
                    <span>{{ t('status.goalResume') }}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="danger-soft"
                    class="mode-row-action"
                    @click="emit('controlGoal', 'cancel')"
                  >
                    <Icon name="close" size="sm" />
                    <span>{{ t('status.goalCancel') }}</span>
                  </Button>
                </div>
              </div>
            </div>
          </div>

        </div>

        <!-- Right: ctx + model -->
        <div class="toolbar-right">
          <!-- Compact chip when context is high -->
          <button v-if="showCompact" class="compact-chip" @click.stop="emit('compact')">/compact</button>

          <!-- Context meter — circular ring only; the full usage (used/max/pct)
               lives in the tooltip. The ring is aria-hidden, so the trigger
               exposes those numbers via aria-label; focusable so keyboard and
               switch-control users reach the same tooltip hover users see. -->
          <Tooltip :text="ctxTooltip">
            <span
              v-if="status && !hideContext"
              class="ctx-group"
              role="img"
              tabindex="0"
              :aria-label="ctxTooltip"
            >
              <ContextRing :pct="pct" />
            </span>
          </Tooltip>

          <!-- Model pill — click to open quick-switch dropdown -->
          <span
            v-if="status"
            class="model-pill"
            :class="{ open: dropdownOpen }"
            role="button"
            tabindex="0"
            @click.stop="toggleDropdown"
            @keydown.enter="toggleDropdown"
            @keydown.space.prevent="toggleDropdown"
          >
            <b>{{ status.model }}</b>
            <span v-if="thinkingSuffix" class="think-suffix">{{ thinkingSuffix }}</span>
            <Icon class="cv" name="chevron-down" size="sm" />
          </span>
          <Tooltip v-if="running" :text="t('composer.interruptTitle')">
            <button
              class="stop"
              :aria-label="t('composer.interrupt')"
              @click="emit('interrupt')"
            >
              <Icon name="stop" size="sm" />
            </button>
          </Tooltip>
          <button
            class="send"
            :class="{ 'is-starting': starting }"
            :aria-label="sendLabel"
            :disabled="starting"
            @click="handleSubmit()"
          >
            <Spinner v-if="starting" size="sm" />
            <Icon v-else name="send" size="sm" />
          </button>
        </div>

        <!-- Model dropdown — current provider models + controls + more -->
        <div v-if="dropdownOpen && status" class="model-dropdown" role="menu" @click.stop>
          <!-- Starred models from other providers -->
          <div v-if="starredOtherModels.length > 0" class="md-section">{{ t('status.starredModels') }}</div>
          <button
            v-for="m in starredOtherModels"
            :key="m.id"
            class="md-row"
            :class="{ 'is-current': m.id === status.modelId }"
            role="menuitem"
            @click="selectModel(m.id)"
          >
            <span class="md-check"><Icon v-if="m.id === status.modelId" name="check" size="sm" /></span>
            <span class="md-name">{{ m.displayName ?? m.model }}</span>
            <span class="md-provider">{{ m.provider }}</span>
            <Icon class="md-star" name="star" size="sm" />
          </button>

          <div v-if="starredOtherModels.length > 0" class="md-divider" />

          <!-- Current provider models -->
          <div v-if="providerModels.length > 0" class="md-section">{{ currentProvider }}</div>
          <button
            v-for="m in providerModels"
            :key="m.id"
            class="md-row"
            :class="{ 'is-current': m.id === status.modelId }"
            role="menuitem"
            @click="selectModel(m.id)"
          >
            <span class="md-check"><Icon v-if="m.id === status.modelId" name="check" size="sm" /></span>
            <span class="md-name">{{ m.displayName ?? m.model }}</span>
            <Icon v-if="isStarred(m.id)" class="md-star" name="star" size="sm" />
          </button>

          <div v-if="providerModels.length > 0" class="md-divider" />

          <!-- Thinking level — segmented control. Effort models show every
               declared level; boolean models show On/Off; unsupported shows a note. -->
          <div class="md-thinking" :class="{ 'is-readonly': thinkingReadonly }">
            <span class="md-name">{{ t('status.thinkingLabel') }}</span>
            <span
              v-if="thinkingAvailability === 'unsupported'"
              class="md-note"
            >{{ t('status.modeNotSupported') }}</span>
            <div
              v-else
              class="effort-segments"
              role="group"
              :aria-label="t('status.thinkingLabel')"
            >
              <button
                v-for="seg in thinkingSegments"
                :key="seg"
                type="button"
                class="effort-seg"
                :class="{ 'is-active': seg === activeThinkingSegment }"
                :disabled="thinkingReadonly"
                @click="setThinkingSegment(seg)"
              >{{ thinkingSegmentLabel(seg) }}</button>
            </div>
          </div>

          <div class="md-divider" />
          <div class="md-cache-note">{{ t('status.cacheNote') }}</div>

          <div class="md-divider" />

          <!-- More models → open full picker -->
          <button class="md-row md-row-more" role="menuitem" @click="closeDropdown(); emit('pickModel');">
            <span class="md-name">{{ t('status.moreModels') }}</span>
          </button>
        </div>
      </div>
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

/* Full-window drop overlay: pointer-events none — the document-level handlers
   in useAttachmentUpload receive the drop, the overlay is purely visual. */
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
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-6);
  border-radius: var(--radius-lg);
  border: 1.5px dashed var(--color-accent);
  background: var(--color-bg);
  color: var(--color-accent);
  font-size: var(--ui-font-size-lg);
  font-weight: var(--weight-medium);
  box-shadow: var(--shadow-md);
}

/* Main composer card */
.composer-card {
  --composer-send-size: 32px;
  --composer-send-inset: var(--space-2);
  position: relative;
  border: 1px solid var(--line);
  border-radius: calc((var(--composer-send-size) / 2) + var(--composer-send-inset) + var(--space-3));
  corner-shape: superellipse(1.5);
  background: var(--bg);
  box-shadow: var(--shadow-md);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.composer-card:focus-within {
  border-color: var(--color-accent);
  box-shadow: var(--shadow-md), 0 0 0 3px var(--color-accent-soft);
}



/* Attachment strip — the chip itself is the shared AttachmentChip; this is
   only the row layout above the input. */
.att-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 0 6px;
}

.att-lightbox {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(20, 23, 28, 0.62);
}
.att-lightbox-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: min(960px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
}
.att-lightbox-media {
  max-width: 100%;
  max-height: calc(100vh - 96px);
  border-radius: 6px;
  background: var(--bg);
  box-shadow: var(--shadow-xl);
  object-fit: contain;
}
.att-lightbox-name {
  max-width: 100%;
  color: var(--color-text-on-accent);
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 2px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.att-lightbox-close {
  position: absolute;
  top: -14px;
  right: -14px;
  width: 28px;
  height: 28px;
  border: 1px solid rgba(255,255,255,0.45);
  border-radius: 50%;
  background: rgba(20,23,28,0.82);
  color: var(--color-text-on-accent);
  cursor: pointer;
}

/* Hidden file input */
.file-input-hidden {
  display: none;
}

/* Wrapper that establishes a positioning context for the popup menus */
.cin-wrap {
  position: relative;
  padding: 14px 16px 8px;
}

/* Input row */
.input-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

/* Expand toggle — top-right of the textarea */
.expand-btn {
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dim);
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
  color: var(--faint);
  /* Keep the caret at the normal text colour even when the field is empty:
     the empty state sets `color` to `--faint` (so the placeholder feels soft),
     and an unset caret inherits that faint colour and nearly disappears. */
  caret-color: var(--color-text);
  flex: 1;
  border: none;
  outline: none;
  resize: none;
  font-family: var(--font-ui);
  font-size: var(--content-font-size);
  background: transparent;
  min-height: 36px;
  max-height: calc(100vh / 4);
  overflow-y: auto;
  line-height: 1.5;
  margin-bottom: 6px;
}

.ph::placeholder {
  color: var(--muted);
}

.ph:not(:placeholder-shown) {
  color: var(--color-text);
}

/* Expanded editor: a tall composing area at ~70% of the viewport — clearly
   larger than the auto-grow cap, while leaving room for the chat header, the
   bottom toolbar row, and padding so nothing gets clipped. Content beyond it
   scrolls internally. */
.composer.expanded .ph {
  min-height: 70vh;
  max-height: 70vh;
}

/* /compact chip */
.compact-chip {
  background: none;
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
  color: var(--color-warning);
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  padding: 0 4px;
  cursor: pointer;
  height: 19px;
  line-height: 17px;
  flex: none;
}
.compact-chip:hover { background: var(--panel2); }

/* Send button — circular accent icon. Always "send"; while running it enqueues
   (handled upstream). Interrupt is a separate Stop button so the two are never
   confused. */
.send {
  width: var(--composer-send-size);
  height: var(--composer-send-size);
  border-radius: 50%;
  background: var(--color-accent);
  color: var(--color-text-on-accent); /* white on accent — readable in light and dark */
  border: none;
  box-shadow: var(--shadow-xs);
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  margin-left: var(--space-2);
  transition: background 0.25s ease, transform 0.12s ease;
  position: relative;
}

.send:hover {
  background: var(--color-accent-hover);
}

.send:active {
  transform: scale(0.92);
}

.send:disabled {
  cursor: not-allowed;
  opacity: 0.88;
}

.send:disabled:active {
  transform: none;
}

/* Spinner-on-accent: recolor the ring so the arc reads on the accent fill.
   Spinner.vue styles are scoped, so pierce them with :deep(). */
.send.is-starting :deep(.ui-spinner) {
  color: var(--color-text-on-accent);
}

.send.is-starting :deep(.ui-spinner__track) {
  stroke: rgba(255, 255, 255, 0.32);
}

.send svg {
  flex: none;
  width: var(--p-ic-lg);
  height: var(--p-ic-lg);
}

/* Stop button — sibling of Send, shown only while running. Red at rest so the
   destructive action is easy to spot; fills solid danger on hover. Kept softer
   than the accent Send so Send stays the primary action. */
.stop {
  width: var(--composer-send-size);
  height: var(--composer-send-size);
  border-radius: 50%;
  background: var(--color-danger-soft);
  color: var(--color-danger);
  border: 1px solid var(--color-danger-bd);
  box-shadow: var(--shadow-xs);
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  margin-left: var(--space-2);
  transition: background 0.16s ease, color 0.16s ease, border-color 0.16s ease, transform 0.12s ease;
}
.stop:hover {
  background: var(--color-danger);
  color: var(--color-text-on-accent);
  border-color: var(--color-danger);
}
.stop:active {
  transform: scale(0.92);
}
.stop svg {
  flex: none;
  width: var(--p-ic-lg);
  height: var(--p-ic-lg);
}

/* Bottom toolbar */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px var(--composer-send-inset) var(--composer-send-inset);
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
  gap: 2px;
  min-width: 0;
  overflow: hidden;
}

/* Permission pill */
.perm-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: var(--ui-font-size);
  color: var(--color-text);
  cursor: pointer;
  user-select: none;
  transition: background 0.1s, color 0.15s;
  font-family: var(--font-ui);
  font-weight: var(--weight-medium);
}
.perm-pill:hover {
  background: var(--color-surface-sunken);
}
.perm-pill.open {
  background: var(--color-accent-soft);
}
.perm-pill.perm-manual {
  color: var(--dim);
}
.perm-pill.perm-yolo {
  color: var(--color-warning);
}
.perm-pill.perm-auto {
  color: var(--color-danger);
}

/* Context group — circular ring. Focusable for keyboard / switch access to its
   aria-label and tooltip (see template), so it needs a focus ring. */
.ctx-group {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 2px 4px;
  border-radius: var(--radius-xs);
}
.ctx-group:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

/* Model pill */
.model-pill {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: var(--ui-font-size);
  line-height: var(--leading-normal);
  color: var(--dim);
  font-family: var(--font-ui);
  font-weight: var(--weight-medium);
  cursor: pointer;
  user-select: none;
  transition: background 0.1s;
  position: relative;
  overflow: hidden;
}
.model-pill:hover {
  background: var(--color-surface-sunken);
  color: var(--color-text);
}
.model-pill.open {
  background: var(--color-accent-soft);
}
.model-pill b {
  font-weight: 500;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  max-width: 280px;
}
.model-pill .think-suffix {
  color: var(--color-accent);
  font-weight: 500;
  flex-shrink: 0;
}
.model-pill .cv {
  color: var(--faint);
  flex: none;
}
.model-pill:hover .cv,
.model-pill.open .cv {
  color: var(--color-accent-hover);
}

/* Model dropdown — anchored to the toolbar right edge */
.model-dropdown {
  position: absolute;
  bottom: calc(100% + 4px);
  right: 10px;
  z-index: var(--z-dropdown);
  min-width: 200px;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-family: var(--font-ui);
}

.md-section {
  padding: 4px 7px 2px;
  font-size: var(--text-xs);
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0;
  font-weight: var(--weight-semibold);
}

.md-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--ui-font-size);
  color: var(--color-text);
  padding: 5px 7px;
  border-radius: 6px;
  text-align: left;
}
.md-row:hover { background: var(--color-surface-sunken); }
.md-row:disabled {
  cursor: default;
  opacity: 0.58;
}
.md-row:disabled:hover { background: none; }
.md-row.is-current { color: var(--color-text); background: var(--color-accent-soft); }
.md-row.is-on { color: var(--color-accent); }
.md-note {
  margin-left: auto;
  color: var(--muted);
  font-size: var(--ui-font-size-xs);
}

.md-row-more {
  color: var(--color-accent);
  font-weight: 500;
}
.md-row-more:hover {
  background: var(--color-accent-soft);
}

.md-check {
  width: 14px;
  flex: none;
  color: var(--color-accent);
  font-weight: 500;
  display: flex;
  justify-content: center;
}

.md-name {
  flex: 1;
}
.md-provider {
  color: var(--muted);
  font-size: var(--ui-font-size-xs);
  flex: none;
}
.md-star {
  color: var(--star);
  flex: none;
  margin-left: auto;
}

.md-divider {
  height: 1px;
  background: var(--line);
  margin: 3px 0;
}

/* Thinking level segmented control — sits inside the model dropdown. */
.md-thinking {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 7px;
  border-radius: var(--radius-sm);
}
.md-thinking .md-name {
  font-family: var(--font-ui);
  font-size: var(--ui-font-size);
  color: var(--color-text);
  flex: none;
}
.md-thinking .md-note {
  margin-left: auto;
}
.effort-segments {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 2px;
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
}
.effort-seg {
  appearance: none;
  border: none;
  background: none;
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--ui-font-size-xs);
  line-height: 1;
  color: var(--color-text-muted);
  padding: 4px 9px;
  border-radius: var(--radius-sm);
  white-space: nowrap;
  transition: background 0.12s, color 0.12s, box-shadow 0.12s;
}
.effort-seg:hover:not(:disabled):not(.is-active) {
  background: var(--color-surface-raised);
  color: var(--color-text);
}
.effort-seg:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
.effort-seg.is-active {
  background: var(--color-accent);
  color: var(--color-text-on-accent);
  box-shadow: var(--shadow-xs);
  font-weight: 500;
}
.effort-seg:disabled {
  cursor: default;
}
.md-thinking.is-readonly .effort-segments {
  opacity: 0.62;
}
.md-cache-note {
  /* width:0 + min-width:100% — the note never widens the shrink-to-fit
     dropdown, but always fills its width and wraps there naturally. */
  width: 0;
  min-width: 100%;
  padding: 2px 7px 4px;
  color: var(--muted);
  font-size: var(--ui-font-size-xs);
  line-height: 1.4;
}
.md-thinking.is-readonly .effort-seg.is-active {
  background: var(--color-surface-raised);
  color: var(--color-text-muted);
  box-shadow: none;
}

/* Permission dropdown — anchored to the toolbar left side */
.perm-dropdown {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 10px;
  z-index: var(--z-dropdown);
  min-width: 220px;
  width: max-content;
  max-width: calc(100vw - var(--space-8));
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.pd-row {
  display: grid;
  grid-template-columns: 14px var(--composer-menu-desc-width, max-content);
  column-gap: 7px;
  row-gap: 2px;
  align-items: start;
  width: 100%;
  background: none;
  border: none;
  cursor: pointer;
  padding: 6px 7px;
  border-radius: 6px;
  text-align: left;
}
.pd-row:hover { background: var(--color-surface-sunken); }
.pd-row.is-current { background: var(--color-accent-soft); }

.pd-check {
  grid-column: 1;
  grid-row: 1;
  width: 14px;
  min-height: 1lh;
  color: var(--color-accent);
  font-size: var(--ui-font-size);
  font-weight: var(--weight-medium);
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: var(--leading-normal);
}

.pd-info {
  display: contents;
}

.pd-name {
  grid-column: 2;
  grid-row: 1;
  font-family: var(--font-ui);
  font-size: var(--ui-font-size);
  font-weight: var(--weight-medium);
  line-height: var(--leading-normal);
}

.pd-desc {
  grid-column: 2;
  grid-row: 2;
  width: var(--composer-menu-desc-width, auto);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--muted);
  line-height: var(--leading-normal);
}

/* Toggle pills (Thinking / Plan) */
/* Modes selector (plan / goal / swarm) — replaces the old plan pill + badges.
   z-index lifts the whole control (incl. its upward-opening menu) above the
   composer input row, which otherwise paints over the menu. */
.modes { position: relative; display: inline-flex; z-index: var(--z-sticky); }
.mode-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 9px;
  border: none;
  background: none;
  border-radius: 6px;
  font-size: var(--ui-font-size);
  font-family: var(--font-ui);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  cursor: pointer;
  user-select: none;
  transition: background 0.1s, color 0.15s;
}
.mode-pill:hover { background: var(--color-surface-sunken); }
.mode-pill.on { background: var(--color-accent-soft); color: var(--color-accent-hover); }
.mode-pill.open { background: var(--color-accent-soft); }
.mode-label { flex: none; }
.mode-tag {
  flex: none;
  font-family: var(--font-ui);
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--color-accent-hover);
  background: var(--bg);
  border: 1px solid var(--color-accent-bd);
  border-radius: 999px;
  padding: 0 6px;
  line-height: 16px;
}
.mode-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-accent); flex: none; }

.modes-menu {
  position: fixed;
  z-index: var(--z-dropdown);
  min-width: 220px;
  width: max-content;
  max-width: calc(100vw - var(--space-8));
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.mode-row {
  display: grid;
  grid-template-columns: 14px var(--composer-menu-desc-width, max-content);
  column-gap: 7px;
  row-gap: 2px;
  align-items: start;
  width: 100%;
  padding: 6px 7px;
  border: none;
  background: none;
  border-radius: 6px;
  cursor: pointer;
  font-family: var(--font-ui);
  text-align: left;
}
.mode-row:hover:not(:disabled) { background: var(--color-surface-sunken); }
.mode-row:disabled { cursor: not-allowed; opacity: 0.45; }
.mode-row-info {
  display: contents;
}
.mode-row-icon {
  grid-column: 1;
  grid-row: 1;
  width: 14px;
  min-height: 1lh;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: var(--ui-font-size);
  line-height: var(--leading-normal);
}
.mode-row-name {
  grid-column: 2;
  grid-row: 1;
  font-size: var(--ui-font-size);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  line-height: var(--leading-normal);
}
.mode-row-desc {
  grid-column: 2;
  grid-row: 2;
  width: var(--composer-menu-desc-width, auto);
  font-size: var(--text-xs);
  font-weight: var(--weight-medium);
  color: var(--muted);
  line-height: var(--leading-normal);
}
.mode-row-not-supported {
  margin-left: auto;
  font-size: var(--ui-font-size-xs);
  color: var(--muted);
}
.mode-row.on {
  background: var(--color-accent-soft);
}
.mode-row.on .mode-row-name { color: var(--color-accent-hover); }
.mode-row.on .mode-row-icon { color: var(--color-accent-hover); }
.mode-row-meta { font-family: var(--mono); font-size: calc(var(--ui-font-size) - 3px); color: var(--muted); }
.mode-row:disabled .mode-row-meta { color: var(--faint); }
.mode-switch {
  grid-column: 2;
  grid-row: 1;
  justify-self: end;
  width: 34px;
  height: 19px;
  border-radius: 999px;
  background: var(--panel2);
  border: 1px solid var(--line);
  position: relative;
  transition: background 0.15s;
}
.mode-switch.on { background: var(--color-accent); border-color: var(--color-accent); }
.mode-knob {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: var(--bg);
  box-shadow: var(--shadow-xs);
  transition: transform 0.15s;
}
.mode-switch.on .mode-knob { transform: translateX(15px); }

.mode-row-goal {
  --mode-row-icon-col: 14px;
  --mode-row-col-gap: 7px;
  --mode-row-pad-x: 7px;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  cursor: default;
  padding: 0;
  gap: 0;
}
.mode-row-goal:hover { background: transparent; }
.mode-row-goal.on {
  background: var(--color-accent-soft);
}
.mode-row-main {
  display: grid;
  grid-template-columns: var(--mode-row-icon-col) var(--composer-menu-desc-width, max-content);
  column-gap: var(--mode-row-col-gap);
  row-gap: 2px;
  align-items: start;
  width: 100%;
  padding: 6px var(--mode-row-pad-x);
  border: none;
  background: none;
  border-radius: 6px;
  cursor: pointer;
  font-family: var(--font-ui);
  text-align: left;
}
.mode-row-main:hover { background: var(--color-surface-sunken); }
.mode-row-goal.on .mode-row-main .mode-row-name { color: var(--color-accent-hover); }
.mode-row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  justify-content: flex-start;
  padding: 0 var(--mode-row-pad-x) var(--mode-row-pad-x)
    calc(var(--mode-row-pad-x) + var(--mode-row-icon-col) + var(--mode-row-col-gap));
}
.mode-row-action {
  flex: none;
}
.mode-row-action :deep(.ui-button__content) { gap: var(--space-1); }
.mode-row-input {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--color-text);
  font-size: var(--ui-font-size-xs);
}

/* ---- Narrow composer toolbar ----------------------------------------------
   Below a wide desktop the chat column can be narrower than the full toolbar
   needs — with the sidebar open on a small window, and on phones. The desktop
   toolbar shows every control on one row and toolbar-left / toolbar-right are
   overflow:hidden, so without shedding ink the row clips its own content. The
   context ring stays visible at every width (it is the live context-pressure
   signal; the exact numbers live in its tooltip), the model name truncates
   earlier, and the permission label is capped so the ring and the send button
   are never squeezed out. Mobile (≤640px) additionally hides perm / modes via
   the rules below (those live in MobileSettingsSheet there). */
@media (max-width: 980px) {
  /* Model name was budgeted for a wide card (280px); trim it so the ring and
     send button are not squeezed out on a narrow column. */
  .model-pill b {
    max-width: 130px;
  }
  /* Permission label is short (manual/yolo/auto); cap it defensively so a
     longer label can never push the toolbar past its container. */
  .perm-pill {
    max-width: 104px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

/* ---- Mobile composer (prototype): round attach + rounded panel input +
       round blue send with a soft shadow. The .cin container loses its border
       and acts as a flex row; the textarea itself becomes the pill input. ---- */
@media (max-width: 640px) {
  .composer {
    padding:
      9px
      var(--dock-inline-right, max(12px, var(--safe-right)))
      max(24px, var(--safe-bottom))
      var(--dock-inline-left, max(12px, var(--safe-left)));
  }
  .composer-card {
    --composer-send-size: 36px;
    max-width: 100%;
  }
  .input-row {
    gap: 6px;
    min-width: 0;
  }
  /* Send → 36px round (hide the SVG arrow, show only the ::after glyph) */
  .send {
    width: var(--composer-send-size);
    height: var(--composer-send-size);
    min-width: var(--composer-send-size);
    padding: 0;
    border-radius: 50%;
    font-size: 0;
    align-self: flex-end;
    position: relative;
  }
  .send svg {
    display: none;
  }
  .send::after {
    content: "↑";
    /* Fixed icon glyph size — not part of the UI font scale. */
    font-size: 17px;
    line-height: 1;
    color: var(--bg);
  }
  /* Stop → 36px round "■" glyph to match the mobile Send sizing. */
  .stop {
    width: var(--composer-send-size);
    height: var(--composer-send-size);
    min-width: var(--composer-send-size);
    padding: 0;
    border-radius: 50%;
    font-size: 0;
    align-self: flex-end;
    position: relative;
  }
  .stop svg {
    display: none;
  }
  .stop::after {
    content: "■";
    /* Fixed icon glyph size — not part of the UI font scale. */
    font-size: 17px;
    line-height: 1;
  }

  /* Mobile toolbar: hide secondary controls; attach / context ring / model /
     send stay visible. Permission + plan move into the MobileSettingsSheet.
     The context ring stays at every width by design — it is the live
     context-pressure signal on a phone (the exact numbers live in the ring's
     tooltip). The /compact chip also stays so compaction is one tap away at
     ≥80% usage. */
  .perm-pill,
  .modes {
    display: none;
  }

  /* Model dropdown on mobile → anchored right with padding */
  .model-dropdown {
    right: 10px;
    left: auto;
    min-width: 180px;
    max-width: calc(100vw - 24px);
  }

  /* Bump mobile font sizes +2px and pin input at 16px to prevent iOS zoom.
     Height (min 36px / max one quarter of the viewport) is inherited from the
     base .ph rule so the box auto-grows the same way on touch and desktop. */
  .ph {
    /* Pinned at 16px to prevent iOS auto-zoom on focus (not part of UI font scale). */
    font-size: 16px;
  }
  .model-pill,
  .attach-btn {
    font-size: var(--ui-font-size);
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
  .model-pill b {
    max-width: min(40vw, 170px);
  }
  .md-row {
    font-size: var(--ui-font-size);
  }
  .md-section {
    font-size: var(--ui-font-size);
  }
  .md-thinking {
    flex-wrap: wrap;
    row-gap: 6px;
  }
  .md-thinking .effort-segments {
    margin-left: 0;
    width: 100%;
    justify-content: space-between;
  }
  .md-thinking .effort-seg {
    flex: 1;
    padding: 5px 6px;
  }
  .pd-name {
    font-size: var(--ui-font-size);
  }
  .pd-desc {
    font-size: var(--text-xs);
  }
}

/* NOTE: Composer overrides live in src/style.css (global), NOT here. Scoped
   `.cin` rules did NOT reliably win the cascade against the base `.cin` (the
   input stayed square + mono), so they were moved to the global sheet where they
   apply. */
</style>
