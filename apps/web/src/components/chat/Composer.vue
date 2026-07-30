<!-- apps/kimi-web/src/components/chat/Composer.vue -->
<script setup lang="ts">
import { measureNaturalWidth, prepareWithSegments } from '@chenglou/pretext';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import SlashMenu from './SlashMenu.vue';
import MentionMenu from './MentionMenu.vue';
import { buildSlashItems, parseSlash, SKILL_COMMAND_PREFIX } from '../../lib/slashCommands';
import { formatTokens } from '../../lib/formatTokens';
import type { IconName } from '../../lib/icons';
import type { FileItem } from './MentionMenu.vue';
import type { ActivationBadges, ConversationStatus, PermissionMode, QueuedPromptView, ToolMedia } from '../../types';
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
import { openUpgrade } from '../../lib/upgrade';
import type { ManagedMembership, PromptAttachment } from '../../composables/useKimiWebClient';
import AttachmentChip from './AttachmentChip.vue';
import MediaLightbox from './MediaLightbox.vue';
import MediaThumb from './MediaThumb.vue';
import { Button, ContextRing, Icon, IconButton, SegmentedControl, Spinner, Tooltip } from '@moonshot-ai/web-ui';

// ---------------------------------------------------------------------------
// Props & emits
// ---------------------------------------------------------------------------

const props = withDefaults(defineProps<{
  running?: boolean;
  /** Main turn in flight — the Stop button's condition (Esc shares it).
   *  Background-only work keeps Stop hidden; those tasks cancel from the dock. */
  working?: boolean;
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
  /** Daemon auth/provider readiness (GET /auth ready). When explicitly false
      and the catalog is also empty, the model pill slot shows a sign-in
      entry — an empty catalog alone may just be a failed /models fetch. */
  authReady?: boolean;
  /** Whether the managed Kimi account is signed in. A signed-in account never
      gets the sign-in entry, even with no usable models. */
  managedSignedIn?: boolean;
  /** Membership of the signed-in managed account; 'free' swaps the model pill
      slot for the upgrade entry when no models are usable. */
  managedMembership?: ManagedMembership;
  /** Starred model ids shown at the top of the quick-switch dropdown. */
  starredIds?: string[];
  /** Session skills shown in the `/` menu (after the built-in commands). */
  skills?: AppSkill[];
  /** Hide the context-usage indicator (used on the empty-session landing page). */
  hideContext?: boolean;
}>(), {
  running: false,
  working: false,
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
  /** Signed out / no models — the model pill slot becomes a sign-in entry. */
  login: [];
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
  clearAttachments,
  loadAttachments,
} = useAttachmentUpload({ uploadImage: () => props.uploadImage, sessionId: () => props.sessionId });

// Silence noUnusedLocals: fileInputRef is used as a template ref (ref="fileInputRef").
void fileInputRef;

// The strip mirrors the sent bubble's two rows: media drafts as thumbnails,
// everything else as file chips.
type MediaDraft = Attachment & { kind: 'image' | 'video' };
const isMediaDraft = (att: Attachment): att is MediaDraft => att.kind === 'image' || att.kind === 'video';
const mediaDrafts = computed(() => attachments.value.filter(isMediaDraft));
const fileDrafts = computed(() => attachments.value.filter((att) => !isMediaDraft(att)));

// Overflow handling for the capped strip: a count badge while the rows
// scroll, and new attachments auto-scroll into view (removals keep position).
const attScrollRef = ref<HTMLElement | null>(null);
const attScrollContentRef = ref<HTMLElement | null>(null);
const attOverflowing = ref(false);

// Measure the CONTENT wrapper, not the scroll container: the is-overflowing
// bottom padding feeds back into scrollHeight and would latch the badge on.
function updateAttOverflow(): void {
  const el = attScrollRef.value;
  const content = attScrollContentRef.value;
  attOverflowing.value = el !== null && content !== null && content.scrollHeight > el.clientHeight + 1;
}

let attOverflowObserver: ResizeObserver | null = null;
watch(
  attScrollRef,
  (el) => {
    attOverflowObserver?.disconnect();
    attOverflowObserver = null;
    if (el) {
      const observer = new ResizeObserver(updateAttOverflow);
      observer.observe(el);
      attOverflowObserver = observer;
    }
    updateAttOverflow();
  },
  { immediate: true },
);
watch(attachments, () => void nextTick(updateAttOverflow), { deep: true });
onUnmounted(() => attOverflowObserver?.disconnect());

// Reveal the NEWEST attachment on add: media thumbs group above file chips,
// so scroll to the end of whichever group grew — a media add would stay
// hidden above a long file row if we only ever scrolled to the bottom.
const attMediaRowRef = ref<HTMLElement | null>(null);
watch(
  () => [mediaDrafts.value.length, fileDrafts.value.length] as const,
  ([media, files], [prevMedia, prevFiles]) => {
    if (media <= prevMedia && files <= prevFiles) return;
    void nextTick(() => {
      const el = attScrollRef.value;
      if (!el) return;
      if (media > prevMedia && attMediaRowRef.value) {
        el.scrollTop = attMediaRowRef.value.offsetHeight - el.clientHeight;
      } else {
        el.scrollTop = el.scrollHeight;
      }
    });
  },
);

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
// defineExpose lives below the toolbar dropdown refs (see anyPopupOpen).

// Build the wire-bound attachment payload: images/videos only need the fileId,
// while file parts also carry name/mediaType/size for the daemon's file shape.
function toPromptAttachment(a: Attachment): PromptAttachment {
  return { fileId: a.fileId!, kind: a.kind, name: a.name, mediaType: a.mediaType, size: a.size };
}

// Chip primary action: media opens the lightbox preview; a generic file opens
// in a new tab (browser-renderable types) or downloads, once its upload has
// completed and produced a daemon file id. MediaThumb passes its <img> along
// as the image preview's zoom origin.
const previewThumbImg = ref<HTMLImageElement | null>(null);

function onAttachmentActivate(att: Attachment, img?: HTMLImageElement | null): void {
  if (att.kind === 'file') {
    if (att.fileId !== undefined) void openFileAttachment(att.fileId, att.name, att.mediaType);
    return;
  }
  previewThumbImg.value = img ?? null;
  openAttachmentPreview(att);
}

// The pending-attachment preview maps onto the shared MediaLightbox — the
// same modal the sent-message chips open. Local object URLs play directly;
// anything else (edit/queue reloads) needs fileId for the authed fetch.
const previewMedia = computed<ToolMedia | null>(() => {
  const att = previewAttachment.value;
  if (!att || !att.previewUrl) return null;
  return {
    kind: att.kind === 'video' ? 'video' : 'image',
    url: att.previewUrl,
    path: att.name,
    fileId: att.previewUrl.startsWith('blob:') ? undefined : att.fileId,
  };
});

/** True when a submit would do something — mirrors handleSubmit's guard so
 *  the button can show a real disabled state. */
const canSend = computed(
  () =>
    !attachments.value.some((a) => a.uploading) &&
    (text.value.trim() !== '' || attachments.value.some((a) => !a.error && a.fileId)),
);

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
  previewThumbImg.value = null;
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

  // Mention menu navigation. With no items (the bare-@ hint or no-match
  // state) only Escape is handled — Enter/Tab/arrows keep their normal
  // composer behavior so the menu never blocks sending.
  if (mentionOpen.value && !mentionLoading.value) {
    if (e.key === 'Escape') {
      e.preventDefault();
      mentionOpen.value = false;
      return;
    }
    if (mentionItems.value.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionActive.value = (mentionActive.value + 1) % mentionItems.value.length;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionActive.value = (mentionActive.value - 1 + mentionItems.value.length) % mentionItems.value.length;
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const item = mentionItems.value[mentionActive.value];
        if (item) selectMentionItem(item);
        return;
      }
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
const modesOpen = ref(false);
const toolbarRef = ref<HTMLElement | null>(null);
const permPillRef = ref<HTMLElement | null>(null);
const modelPillRef = ref<HTMLElement | null>(null);
const modelMenuRight = ref('');
const modelMenuStyle = computed<Record<string, string>>(() => {
  const style: Record<string, string> = {};
  if (modelMenuRight.value) style.right = modelMenuRight.value;
  return style;
});

// Any transient popup above the composer (model / permission / work-mode
// dropdown, slash or mention menu). ConversationPane reads this to keep its Esc-to-interrupt
// quiet while a popup owns Escape — e.g. a dropdown opened from the toolbar,
// where focus is outside the textarea and its Esc never reaches handleKeydown.
const anyPopupOpen = computed(
  () => dropdownOpen.value || permDropdownOpen.value || modesOpen.value || slashOpen.value || mentionOpen.value,
);

const isEmpty = () => text.value.trim().length === 0 && attachments.value.length === 0;

defineExpose({ loadForEdit, loadAttachmentsForEdit, focus, anyPopupOpen, isEmpty });

function toggleDropdown(): void {
  dropdownOpen.value = !dropdownOpen.value;
  if (dropdownOpen.value) {
    updateModelMenuPosition();
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
    updatePermissionMenuPosition();
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
// Options for the shared SegmentedControl (same control as settings/mobile).
const thinkingOptions = computed(() =>
  thinkingSegments.value.map((seg) => ({ value: seg, label: thinkingSegmentLabel(seg) })),
);

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
const PERM_MODES: { mode: PermissionMode; icon: IconName; color: string; labelKey: string; descKey: string }[] = [
  { mode: 'manual', icon: 'hand', color: 'var(--color-text)', labelKey: 'status.permissionManual', descKey: 'status.permissionManualDesc' },
  { mode: 'yolo', icon: 'shield-question', color: 'var(--color-warning)', labelKey: 'status.permissionYolo', descKey: 'status.permissionYoloDesc' },
  { mode: 'auto', icon: 'full-access', color: 'var(--color-danger)', labelKey: 'status.permissionAuto', descKey: 'status.permissionAutoDesc' },
];
const MODE_DESC_KEYS = ['status.planDesc', 'status.swarmDesc', 'status.goalDesc'] as const;

const menuMeasureRef = ref<HTMLElement | null>(null);
const permissionDescriptionWidth = ref('');
const permissionMenuLeft = ref('');
const modeDescriptionWidth = ref('');
function menuDescStyle(width: string): Record<string, string> {
  const style: Record<string, string> = {};
  if (width) style['--composer-menu-desc-width'] = width;
  return style;
}
const permissionMenuStyle = computed<Record<string, string>>(() => ({
  ...menuDescStyle(permissionDescriptionWidth.value),
  ...(permissionMenuLeft.value ? { left: permissionMenuLeft.value } : {}),
}));
const modeMenuMeasureStyle = computed<Record<string, string>>(() => menuDescStyle(modeDescriptionWidth.value));
const modesMenuInlineStyle = computed<Record<string, string>>(() => ({
  ...modesMenuStyle.value,
  ...modeMenuMeasureStyle.value,
}));

function updatePermissionMenuPosition(): void {
  const anchor = permPillRef.value;
  const toolbar = toolbarRef.value;
  if (!anchor || !toolbar) {
    permissionMenuLeft.value = '';
    return;
  }
  permissionMenuLeft.value = `${Math.round(anchor.getBoundingClientRect().left - toolbar.getBoundingClientRect().left)}px`;
}

function updateModelMenuPosition(): void {
  const anchor = modelPillRef.value;
  const toolbar = toolbarRef.value;
  if (!anchor || !toolbar) {
    modelMenuRight.value = '';
    return;
  }
  modelMenuRight.value = `${Math.round(toolbar.getBoundingClientRect().right - anchor.getBoundingClientRect().right)}px`;
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
const permIcon = computed<IconName>(() => permInfo.value?.icon ?? 'hand');

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

// No models at all (signed out / no provider configured): the model pill slot
// shows a sign-in button instead of a meaningless placeholder pill.
const hasModels = computed(() => (props.models?.length ?? 0) > 0);
// Gate on explicit unreadiness, not just an empty catalog — a failed /models
// fetch must not mislabel a signed-in, ready daemon. A signed-in managed
// account never gets the sign-in entry: a free account (userinfo probe
// rejected with 402) gets the upgrade entry, and any other signed-in state
// just leaves the slot empty.
const noUsableModels = computed(() => props.authReady === false && !hasModels.value);
const showSignIn = computed(() => noUsableModels.value && !(props.managedSignedIn ?? false));
const showUpgrade = computed(
  () => noUsableModels.value && (props.managedSignedIn ?? false) && props.managedMembership === 'free',
);

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

// Keyboard model for the quick-switch menu: focus the current row on open,
// then ArrowUp / ArrowDown cycle through the rows (Esc already closes).
const modelDropdownRef = ref<HTMLElement | null>(null);

watch(dropdownOpen, async (open) => {
  if (!open) return;
  await nextTick();
  const current =
    modelDropdownRef.value?.querySelector<HTMLElement>('.md-row.is-current') ??
    modelDropdownRef.value?.querySelector<HTMLElement>('.md-row');
  current?.focus();
});

function onModelDropdownKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = Array.from(
    modelDropdownRef.value?.querySelectorAll<HTMLElement>('.md-row:not(:disabled)') ?? [],
  );
  if (!rows.length) return;
  event.preventDefault();
  const index = rows.indexOf(document.activeElement as HTMLElement);
  const next =
    event.key === 'ArrowDown' ? (index + 1) % rows.length : (index - 1 + rows.length) % rows.length;
  rows[next]?.focus();
}

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
    <!-- Pending-attachment preview: the same MediaLightbox the sent-message
         chips open. -->
    <MediaLightbox
      v-if="previewMedia"
      :media="previewMedia"
      :origin-img="previewThumbImg"
      @close="
        previewThumbImg = null;
        closeAttachmentPreview();
      "
    />

    <!-- Main composer card -->
    <div class="composer-card">
      <!-- Attachment previews (inside the card, above the input row): media
           renders as MediaThumb thumbnails, files as AttachmentChip pills —
           the same two rows the sent bubble uses. The strip caps at two
           thumbnail rows and scrolls beyond that; clear-all stays pinned to
           the top corner so it never scrolls away. -->
      <div v-if="attachments.length > 0" class="att-strip">
        <div ref="attScrollRef" class="att-scroll" :class="{ 'is-overflowing': attOverflowing }">
          <div ref="attScrollContentRef" class="att-scroll-content">
            <div v-if="mediaDrafts.length > 0" ref="attMediaRowRef" class="att-row att-row-media">
              <MediaThumb
                v-for="att in mediaDrafts"
                :key="att.localId"
                :kind="att.kind"
                :name="att.name"
                :url="att.previewUrl"
                :file-id="att.fileId"
                :uploading="att.uploading"
                :error="att.error"
                removable
                :remove-label="t('composer.removeNamed', { name: att.name })"
                @activate="onAttachmentActivate(att, $event)"
                @remove="removeAttachment(att.localId)"
              />
            </div>
            <div v-if="fileDrafts.length > 0" class="att-row">
              <AttachmentChip
                v-for="att in fileDrafts"
                :key="att.localId"
                kind="file"
                :name="att.name"
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
          </div>
        </div>
        <span v-if="attOverflowing" class="att-more">{{ t('composer.attachmentCount', { n: attachments.length }) }}</span>
        <Tooltip v-if="attachments.length >= 2" :text="t('composer.clearAll')">
          <IconButton class="att-clear" size="sm" :label="t('composer.clearAll')" @click="clearAttachments">
            <Icon name="trash" />
          </IconButton>
        </Tooltip>
      </div>

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
            autocomplete="off"
            spellcheck="false"
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
            class="composer-attach"
            size="md"
            :label="t('composer.attachFile')"
            @click="openFilePicker"
          >
            <Icon name="attachment" />
          </IconButton>

          <!-- Permission pill — click to open dropdown -->
          <span
            v-if="status"
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
            <Icon class="perm-pill-icon" :name="permIcon" size="sm" />
            <span class="perm-pill-label">{{ permLabel }}</span>
          </span>

          <!-- Permission dropdown — left-aligned to its trigger pill. -->
          <Transition name="composer-menu-pop">
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
                <span class="pd-icon" :style="{ color: opt.color }"><Icon :name="opt.icon" size="sm" /></span>
                <span class="pd-info">
                  <span class="pd-name" :style="{ color: opt.color }">{{ t(opt.labelKey) }}</span>
                  <span class="pd-desc">{{ t(opt.descKey) }}</span>
                </span>
                <span class="pd-check"><Icon v-if="opt.mode === status.permission" name="check" size="sm" /></span>
              </button>
            </div>
          </Transition>

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

            <Transition name="composer-menu-pop">
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
            </Transition>
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
          <button
            v-if="status && !showSignIn && !showUpgrade"
            ref="modelPillRef"
            type="button"
            class="model-pill"
            :class="{ open: dropdownOpen }"
            aria-haspopup="menu"
            :aria-expanded="dropdownOpen"
            @click.stop="toggleDropdown"
          >
            <span class="mp-name">{{ status.model }}</span>
            <span v-if="thinkingSuffix" class="think-suffix">{{ thinkingSuffix }}</span>
            <Icon class="cv" name="chevron-down" size="sm" />
          </button>
          <!-- Signed-in free managed account / no usable models — the pill slot
               becomes the upgrade entry (external link). -->
          <button
            v-else-if="status && showUpgrade"
            type="button"
            class="model-pill login-pill"
            @click.stop="openUpgrade()"
          >
            <Icon name="music" size="sm" />
            <span class="mp-name">{{ t('sidebar.upgrade') }}</span>
          </button>
          <!-- Signed out / no models — the pill slot becomes the sign-in entry
               (deep-links into the settings account tab). -->
          <button
            v-else-if="status && showSignIn"
            type="button"
            class="model-pill login-pill"
            @click.stop="emit('login')"
          >
            <Icon name="log-in" size="sm" />
            <span class="mp-name">{{ t('login.action') }}</span>
          </button>
          <Tooltip v-if="working" :text="t('composer.interruptTitle')">
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
            :disabled="starting || !canSend"
            @click="handleSubmit()"
          >
            <Spinner v-if="starting" size="sm" />
            <Icon v-else name="send" size="sm" />
          </button>
        </div>

        <!-- Model dropdown — current provider models + controls + more -->
        <Transition name="composer-menu-pop">
        <div
          v-if="dropdownOpen && status"
          ref="modelDropdownRef"
          class="model-dropdown"
          :style="modelMenuStyle"
          role="menu"
          @click.stop
          @keydown="onModelDropdownKeydown"
        >
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

          <!-- Thinking level — the shared segmented control (same as settings
               and the mobile sheet). Unsupported shows a note; a single fixed
               segment degrades to a static value instead of a dead control. -->
          <div class="md-thinking">
            <span class="md-name">{{ t('status.thinkingLabel') }}</span>
            <span
              v-if="thinkingAvailability === 'unsupported'"
              class="md-note"
            >{{ t('status.modeNotSupported') }}</span>
            <SegmentedControl
              v-else-if="thinkingSegments.length > 1"
              :model-value="activeThinkingSegment"
              :options="thinkingOptions"
              size="xs"
              @update:model-value="setThinkingSegment"
            />
            <span v-else class="md-note">{{ thinkingSegmentLabel(thinkingSegments[0] ?? thinkingLevel) }}</span>
          </div>

          <div class="md-divider" />
          <div class="md-cache-note">{{ t('status.cacheNote') }}</div>

          <div class="md-divider" />

          <!-- More models → open full picker -->
          <button class="md-row md-row-more" role="menuitem" @click="closeDropdown(); emit('pickModel');">
            <span class="md-check md-more-icon"><Icon name="list" size="sm" /></span>
            <span class="md-name">{{ t('status.moreModels') }}</span>
            <Icon class="md-more-arrow" name="chevron-right" size="sm" />
          </button>
        </div>
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
  border: 0.5px dashed var(--color-accent);
  background: var(--color-bg);
  color: var(--color-accent);
  font-size: var(--ui-font-size-lg);
  font-weight: var(--weight-medium);
  box-shadow: var(--shadow-md);
}

/* Main composer card */
.composer-card {
  --composer-control-size: var(--space-8);
  --composer-send-size: var(--composer-control-size);
  --composer-control-inset: var(--space-2);
  position: relative;
  border: 0.5px solid var(--color-composer-line);
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



/* Attachment strip — media thumbs are shared MediaThumb, file chips the
   shared AttachmentChip; this is only the layout inside the card. Capped at
   two thumbnail rows: beyond that the strip scrolls instead of pushing the
   input down. The right margin shifts the scrollbar off the corner, so the
   pinned clear-all button never overlaps it. */
.att-strip {
  position: relative;
  padding: var(--space-3) var(--space-4) 0;
}
.att-scroll {
  max-height: calc(128px + var(--space-2));
  overflow-y: auto;
  margin-right: calc(var(--icon-button-sm) + var(--space-1));
}
.att-scroll-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-right: var(--space-1);
}
/* Overflowing: room at the bottom so the last row can scroll above the
   count badge. */
.att-scroll.is-overflowing {
  padding-bottom: var(--space-6);
}
/* Overflow count badge — pinned to the strip's bottom-left, inert. */
.att-more {
  position: absolute;
  left: var(--space-4);
  bottom: var(--space-1);
  z-index: 1;
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 var(--space-2);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-full);
  background: var(--color-surface-raised);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  box-shadow: var(--shadow-sm);
  pointer-events: none;
}
.att-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.att-row-media {
  gap: var(--space-2);
}
/* Clear-all: the shared IconButton, pinned to the strip's top corner. */
.att-clear {
  position: absolute;
  top: var(--space-3);
  right: var(--space-4);
  z-index: 1;
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
  text-autospace: normal;
  background: transparent;
  min-height: 36px;
  max-height: calc(100vh / 4);
  overflow-y: auto;
  scrollbar-width: none;
  line-height: 1.5;
  margin-bottom: 6px;
  user-select: text;
}

.ph::-webkit-scrollbar {
  display: none;
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
  height: var(--composer-control-size);
  padding: 0 var(--space-2);
  border: 0.5px solid transparent;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-warning);
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  cursor: pointer;
  line-height: 1;
  flex: none;
  transition: background var(--duration-base) var(--ease-out);
}
.compact-chip:hover { background: var(--color-hover); }

/* Keep the shared attachment icon and behavior; only its Composer-local
   geometry joins the full-round 32px control family. */
.composer-attach {
  width: var(--composer-control-size);
  height: var(--composer-control-size);
  border-radius: var(--radius-full);
}

/* Send button — circular icon. Always "send"; while running it enqueues
   (handled upstream). Interrupt is a separate Stop button so the two are never
   confused. Fill/icon/shadow run on the dedicated --color-send-* tokens (the
   production kimiwork neutral recipe, see web-ui style.css). */
.send {
  width: var(--composer-send-size);
  height: var(--composer-send-size);
  border-radius: var(--radius-full);
  background: var(--color-send-bg);
  color: var(--color-send-icon); /* reads on the send fill in light and dark */
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

/* Starting is a working state, not an empty one: the button keeps the active
   send fill (clicks stay blocked) and the spinner arc is recolored to read on
   it. Spinner.vue styles are scoped, so pierce them with :deep(). */
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

/* Stop button — sibling of Send, shown only while running. Neutral wash with
   a red glyph at rest (no border, softened to 72% alpha in dark via
   --color-stop-glyph); fills solid danger on hover. */
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

/* Bottom toolbar */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
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
/* Only the left side clips; clipping the right side would shave the Send
   button's lift shadow (the row is exactly as tall as the 32px circle). */
.toolbar-left { flex: 0 1 auto; overflow: hidden; }
.toolbar-right {
  flex: 1 1 0;
  justify-content: flex-end;
}

/* Quiet, full-round 32px controls. Their chrome appears only on hover/open,
   leaving the circular Send as the toolbar's sole persistent filled action. */
.perm-pill,
.mode-pill,
.model-pill {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: var(--composer-control-size);
  padding: 0 var(--space-3);
  border: 0.5px solid transparent;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-ui);
  font-size: var(--ui-font-size);
  font-weight: var(--weight-medium);
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  transition: background var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}
.perm-pill,
.mode-pill {
  font-size: var(--ui-font-size-sm);
}
/* The hover wash floats over the fill as its own layer so it can fade in and
   out (the dock work pills' recipe — background gradients can't transition). */
.perm-pill::after,
.mode-pill::after,
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
.mode-pill:hover::after,
.model-pill:hover::after {
  opacity: 1;
}
.perm-pill.open,
.mode-pill.open,
.mode-pill.on,
.model-pill.open {
  background: var(--color-accent-soft);
}

/* Permission pill — per-state label colors. */
.perm-pill.perm-manual {
  color: var(--dim);
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

@container (max-width: 620px) {
  .perm-pill {
    width: var(--composer-control-size);
    height: var(--composer-control-size);
    padding: 0;
    justify-content: center;
    flex: none;
  }
  .perm-pill-label { display: none; }
}

/* Context group — circular ring. Focusable for keyboard / switch access to its
   aria-label and tooltip (see template), so it needs a focus ring. */
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

/* Model pill — shares the toolbar-pill base above; these are its extras:
   shrink-wrap with internal truncation, press scale, and the rotating
   chevron that carries the open state. */
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
  flex: 0 1 auto;
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
  flex-shrink: 0;
}
.model-pill .cv {
  color: var(--faint);
  flex: none;
  transition:
    transform var(--duration-base) var(--ease-out),
    color var(--duration-base) var(--ease-out);
}
.model-pill:hover .cv,
.model-pill.open .cv {
  color: var(--dim);
}
.model-pill.open .cv {
  transform: rotate(180deg);
}

/* Sign-in entry (no models) — same pill shape, accent text to read as an
   action rather than a disabled placeholder. */
.model-pill.login-pill {
  flex: none;
  color: var(--color-accent);
}
.model-pill.login-pill .mp-name {
  color: var(--color-accent);
}

/* Model dropdown — runtime positioning aligns it to the trigger pill. */
.model-dropdown {
  position: absolute;
  bottom: calc(100% + 4px);
  right: calc(var(--composer-control-inset) + var(--composer-send-size) + var(--space-1));
  z-index: var(--z-dropdown);
  min-width: 200px;
  background: var(--color-menu-bg);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-menu);
  padding: var(--space-1);
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-family: var(--font-ui);
  transform-origin: bottom right;
}

/* Match SessionRow context menus: grow from the trigger corner and exit faster. */
.composer-menu-pop-enter-active {
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.composer-menu-pop-leave-active {
  transition:
    opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
  pointer-events: none;
}
.composer-menu-pop-enter-from,
.composer-menu-pop-leave-to {
  opacity: 0;
  transform: scale(0.97) translateY(2px);
}

.md-section {
  padding: 4px 9px 2px;
  font-size: var(--text-xs);
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
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
  padding: 5px 9px;
  border-radius: 6px;
  text-align: left;
  transition: background var(--duration-base) var(--ease-out);
}
.md-row:hover { background: var(--color-hover); }
.md-row:hover .md-name { color: var(--color-text-strong); }
.md-row:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.md-row:disabled {
  cursor: default;
  opacity: 0.58;
}
.md-row:disabled:hover { background: none; }
.md-row.is-current { background: var(--color-selected); }
.md-note {
  margin-left: auto;
  color: var(--muted);
  font-size: var(--ui-font-size-xs);
}

.md-row-more .md-more-icon {
  color: var(--dim);
}
.md-row-more .md-more-arrow {
  color: var(--faint);
  flex: none;
  transition: color var(--duration-base) var(--ease-out);
}
.md-row-more:hover .md-more-arrow {
  color: var(--dim);
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
  transition: color var(--duration-base) var(--ease-out);
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
  padding: 6px 9px;
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
/* The shared SegmentedControl styles itself; the row only owns its layout. */
.md-thinking .ui-seg {
  margin-left: auto;
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

/* Permission dropdown — runtime positioning aligns it to the trigger pill. */
.perm-dropdown {
  position: absolute;
  bottom: calc(100% + 4px);
  left: var(--composer-control-inset);
  z-index: var(--z-dropdown);
  min-width: 220px;
  width: max-content;
  max-width: calc(100vw - var(--space-8));
  background: var(--color-menu-bg);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-menu);
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  transform-origin: bottom left;
}

.pd-row {
  display: grid;
  grid-template-columns: var(--p-ic-sm) var(--composer-menu-desc-width, max-content) var(--p-ic-sm);
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
.pd-row:hover { background: var(--color-hover); }
.pd-row.is-current { background: var(--color-hover); }

.pd-icon {
  grid-column: 1;
  grid-row: 1;
  width: var(--p-ic-sm);
  min-height: 1lh;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: var(--leading-tight);
}

.pd-check {
  grid-column: 3;
  grid-row: 1;
  width: var(--p-ic-sm);
  min-height: 1lh;
  color: var(--color-accent);
  font-size: var(--ui-font-size);
  font-weight: var(--weight-medium);
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: var(--leading-tight);
}

.pd-info {
  display: contents;
}

.pd-name {
  grid-column: 2;
  grid-row: 1;
  font-family: var(--font-ui);
  font-size: var(--ui-font-size-sm);
  font-weight: var(--weight-medium);
  line-height: var(--leading-tight);
}

.pd-desc {
  grid-column: 2;
  grid-row: 2;
  width: var(--composer-menu-desc-width, auto);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-caption);
  color: var(--muted);
  line-height: var(--leading-tight);
}

/* Modes selector (plan / goal / swarm) — replaces the old plan pill + badges.
   z-index lifts the whole control (incl. its upward-opening menu) above the
   composer input row, which otherwise paints over the menu. The pill itself
   shares the toolbar-pill base above. */
.modes { position: relative; display: inline-flex; z-index: var(--z-sticky); }
.mode-pill.on { color: var(--color-accent-hover); }
.mode-label { flex: none; }
.mode-tag {
  flex: none;
  font-family: var(--font-ui);
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--color-accent-hover);
  background: var(--bg);
  border: 0.5px solid var(--color-accent-bd);
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
  background: var(--color-menu-bg);
  -webkit-backdrop-filter: var(--p-menu-backdrop);
  backdrop-filter: var(--p-menu-backdrop);
  border: 0.5px solid var(--color-line);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-menu);
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  transform-origin: bottom left;
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
.mode-row:hover:not(:disabled) { background: var(--color-hover); }
.mode-row:hover:not(:disabled) .mode-row-icon,
.mode-row:hover:not(:disabled) .mode-row-name { color: var(--color-text-strong); }
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
  transition: color var(--duration-base) var(--ease-out);
  font-size: var(--ui-font-size);
  line-height: var(--leading-tight);
}
.mode-row-name {
  grid-column: 2;
  grid-row: 1;
  transition: color var(--duration-base) var(--ease-out);
  font-size: var(--ui-font-size-sm);
  font-weight: var(--weight-medium);
  color: var(--color-text);
  line-height: var(--leading-tight);
}
.mode-row-desc {
  grid-column: 2;
  grid-row: 2;
  width: var(--composer-menu-desc-width, auto);
  font-size: var(--text-xs);
  font-weight: var(--weight-caption);
  color: var(--muted);
  line-height: var(--leading-tight);
}
.mode-row-not-supported {
  margin-left: auto;
  font-size: var(--ui-font-size-xs);
  color: var(--muted);
}
.mode-row.on {
  background: var(--color-hover);
}
.mode-row.on .mode-row-name { color: var(--color-text); }
.mode-row.on .mode-row-icon { color: var(--color-text); }
.mode-row-meta { font-family: var(--mono); font-size: calc(var(--ui-font-size) - 3px); color: var(--muted); }
.mode-row:disabled .mode-row-meta { color: var(--faint); }
.mode-switch {
  grid-column: 2;
  grid-row: 1;
  justify-self: end;
  width: 34px;
  height: 19px;
  border-radius: 999px;
  /* Colors mirror the design-system Switch (web-ui Switch.vue): a track that
     stays visible on the menu surface in dark mode, and an always-white knob. */
  background: var(--color-line-strong);
  position: relative;
  transition: background 0.15s;
}
.mode-switch.on { background: var(--color-accent); }
.mode-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: var(--color-text-on-accent);
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
  background: var(--color-hover);
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
.mode-row-main:hover { background: var(--color-hover); }
.mode-row-main:hover .mode-row-icon,
.mode-row-main:hover .mode-row-name { color: var(--color-text-strong); }
.mode-row-goal.on .mode-row-main .mode-row-name { color: var(--color-text); }
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
  border: 0.5px solid var(--line);
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
    --composer-control-size: 36px;
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
    border-radius: var(--radius-full);
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
    border-radius: var(--radius-full);
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
    right: calc(var(--composer-control-inset) + var(--composer-send-size) + var(--space-1));
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
  .model-pill .mp-name {
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
  .md-thinking .ui-seg {
    margin-left: 0;
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
