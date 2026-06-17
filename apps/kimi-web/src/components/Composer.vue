<!-- apps/kimi-web/src/components/Composer.vue -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import SlashMenu from './SlashMenu.vue';
import MentionMenu from './MentionMenu.vue';
import type { SlashCommand } from '../lib/slashCommands';
import { buildSlashItems, filterCommands, parseSlash } from '../lib/slashCommands';
import type { FileItem } from './MentionMenu.vue';
import type { ActivationBadges, ConversationStatus, PermissionMode, QueuedPromptView } from '../types';
import type { AppModel, AppSkill, ThinkingLevel } from '../api/types';
import { modelThinkingAvailability } from '../lib/modelThinking';

// ---------------------------------------------------------------------------
// Attachment state
// ---------------------------------------------------------------------------

interface Attachment {
  /** Unique local id (used as :key) */
  localId: string;
  /** File name */
  name: string;
  /** image or video — drives the chip preview and the content-block type. */
  kind: 'image' | 'video';
  /** Object URL for the thumbnail preview */
  previewUrl: string;
  /** True while uploading */
  uploading: boolean;
  /** Resolved daemon file id (set after upload completes) */
  fileId?: string;
  /** True if upload failed */
  error?: boolean;
}

// ---------------------------------------------------------------------------
// Props & emits
// ---------------------------------------------------------------------------

const props = withDefaults(defineProps<{
  running?: boolean;
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
  queued: () => [],
  searchFiles: undefined,
  uploadImage: undefined,
  models: () => [],
  starredIds: () => [],
  skills: () => [],
});

const placeholder = computed(() =>
  props.goalMode ? t('status.goalPlaceholder') : t('composer.placeholder')
);

const emit = defineEmits<{
  submit: [payload: { text: string; attachments: { fileId: string; kind: 'image' | 'video' }[] }];
  /** Steer the composer text (+ any queued prompts, merged by the parent)
      into the RUNNING turn — TUI ctrl+s. */
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
}>();

const { t } = useI18n();

// ---------------------------------------------------------------------------
// Textarea
// ---------------------------------------------------------------------------

// Unsent-draft persistence: the composer text is kept in localStorage PER
// SESSION, so switching away and back (or a page refresh) restores whatever the
// user was typing for that session. Cleared when the draft is sent/steered.
const DRAFT_PREFIX = 'kimi-web.draft.';
function draftKey(sid: string | undefined): string {
  return DRAFT_PREFIX + (sid && sid.length > 0 ? sid : '__new__');
}
function loadDraft(sid: string | undefined): string {
  try {
    return localStorage.getItem(draftKey(sid)) ?? '';
  } catch {
    return '';
  }
}
function saveDraft(sid: string | undefined, value: string): void {
  try {
    const key = draftKey(sid);
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // localStorage unavailable (private mode / quota) — drafts just don't persist.
  }
}

const text = ref(loadDraft(props.sessionId));
const textareaRef = ref<HTMLTextAreaElement | null>(null);

function autosize(): void {
  const el = textareaRef.value;
  if (!el) return;
  el.style.removeProperty('height');
}

watch(text, (value) => {
  void nextTick(autosize);
  // Persist the live draft for the current session (empty clears the entry).
  saveDraft(props.sessionId, value);
});

// Switching sessions: stash the draft under the OLD session, then load the new
// session's draft into the box.
watch(
  () => props.sessionId,
  (newSid, oldSid) => {
    if (newSid === oldSid) return;
    saveDraft(oldSid, text.value);
    text.value = loadDraft(newSid);
    void nextTick(autosize);
  },
);

// ---------------------------------------------------------------------------
// Sent-message history recall (shell-style ↑/↓). ArrowUp on the first line
// recalls older messages; ArrowDown on the last line walks back toward the live
// draft. Editing the text drops out of history browsing.
// ---------------------------------------------------------------------------
const inputHistory = ref<string[]>([]);
// -1 = browsing nothing (live draft). Otherwise an index into inputHistory.
let historyIndex = -1;
let draftBeforeHistory = '';

function pushInputHistory(entry: string): void {
  const trimmed = entry.trim();
  historyIndex = -1;
  if (!trimmed) return;
  // Skip consecutive duplicates so repeated sends don't pad the history.
  if (inputHistory.value[inputHistory.value.length - 1] === trimmed) return;
  inputHistory.value = [...inputHistory.value, trimmed];
}

function caretAtFirstLine(): boolean {
  const el = textareaRef.value;
  if (!el) return false;
  const pos = el.selectionStart ?? 0;
  // No newline before the caret → it sits on the first visual line.
  return el.value.lastIndexOf('\n', pos - 1) === -1;
}

function applyHistoryText(value: string): void {
  text.value = value;
  void nextTick(() => {
    const el = textareaRef.value;
    if (!el) return;
    autosize();
    const pos = value.length;
    el.setSelectionRange(pos, pos);
  });
}

function recallOlder(): void {
  if (inputHistory.value.length === 0) return;
  if (historyIndex === -1) {
    draftBeforeHistory = text.value;
    historyIndex = inputHistory.value.length - 1;
  } else if (historyIndex > 0) {
    historyIndex -= 1;
  } else {
    return; // already at the oldest entry
  }
  applyHistoryText(inputHistory.value[historyIndex]!);
}

function recallNewer(): void {
  if (historyIndex === -1) return;
  if (historyIndex < inputHistory.value.length - 1) {
    historyIndex += 1;
    applyHistoryText(inputHistory.value[historyIndex]!);
  } else {
    historyIndex = -1;
    applyHistoryText(draftBeforeHistory);
  }
}

// ---------------------------------------------------------------------------
// Slash-command menu
// ---------------------------------------------------------------------------

const slashOpen = ref(false);
const slashItems = ref<SlashCommand[]>([]);
const slashActive = ref(0);

function updateSlashMenu(): void {
  const val = text.value;
  // Only show if the value starts with / and has no space yet (single token)
  if (val.startsWith('/') && !val.includes(' ')) {
    // Built-in commands + the active session's skills (shown as /<skill-name>).
    slashItems.value = filterCommands(val, buildSlashItems(props.skills));
    slashActive.value = 0;
    slashOpen.value = slashItems.value.length > 0;
  } else {
    slashOpen.value = false;
  }
}

function selectSlashCommand(item: SlashCommand): void {
  slashOpen.value = false;
  if (item.acceptsInput) {
    text.value = `${item.name} `;
    void nextTick(() => {
      const el = textareaRef.value;
      if (!el) return;
      const pos = text.value.length;
      el.setSelectionRange(pos, pos);
      el.focus();
      autosize();
    });
    return;
  }
  text.value = '';
  emit('command', item.name);
}

// ---------------------------------------------------------------------------
// @-mention menu
// ---------------------------------------------------------------------------

const mentionOpen = ref(false);
const mentionItems = ref<FileItem[]>([]);
const mentionActive = ref(0);
const mentionLoading = ref(false);

// Debounce timer for mention search
let mentionTimer: ReturnType<typeof setTimeout> | null = null;

/** Find the @token under the cursor in the current text value. Returns null if none. */
function getMentionToken(): { token: string; start: number; end: number } | null {
  const val = text.value;
  const pos = textareaRef.value?.selectionStart ?? val.length;
  // Walk backwards from cursor to find the start of a @token
  let start = pos - 1;
  while (start >= 0 && !/\s/.test(val[start]!)) {
    start--;
  }
  start++;
  const tokenPart = val.slice(start, pos);
  if (!tokenPart.startsWith('@')) return null;
  // The end of the token is where the cursor is (or after the next space)
  return { token: tokenPart.slice(1), start, end: pos };
}

function updateMentionMenu(): void {
  const mt = getMentionToken();
  if (!mt || !props.searchFiles) {
    mentionOpen.value = false;
    return;
  }
  const query = mt.token;
  if (mentionTimer !== null) clearTimeout(mentionTimer);
  mentionTimer = setTimeout(async () => {
    mentionLoading.value = true;
    mentionOpen.value = true;
    mentionActive.value = 0;
    try {
      const results = await props.searchFiles!(query);
      mentionItems.value = results;
    } catch {
      mentionItems.value = [];
    } finally {
      mentionLoading.value = false;
    }
  }, 200);
}

function selectMentionItem(item: FileItem): void {
  const mt = getMentionToken();
  if (!mt) return;
  const val = text.value;
  // Replace @query token with the file path
  text.value = val.slice(0, mt.start) + item.path + val.slice(mt.end);
  mentionOpen.value = false;
  void nextTick(() => {
    const el = textareaRef.value;
    if (!el) return;
    const newPos = mt.start + item.path.length;
    el.setSelectionRange(newPos, newPos);
    el.focus();
    autosize();
  });
}

// ---------------------------------------------------------------------------
// Input event handler — updates both menus
// ---------------------------------------------------------------------------

function handleInput(): void {
  // Manual typing leaves history-browsing mode — the text is now a fresh draft.
  historyIndex = -1;
  updateSlashMenu();
  updateMentionMenu();
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

const attachments = ref<Attachment[]>([]);
const previewAttachment = ref<Attachment | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const isDragOver = ref(false);

let localIdCounter = 0;
function nextLocalId(): string {
  return `att_${++localIdCounter}`;
}

function revokeAttachment(att: Attachment): void {
  try { URL.revokeObjectURL(att.previewUrl); } catch { /* ignore */ }
}

function mediaKind(mime: string): 'image' | 'video' | null {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return null;
}

async function addFiles(files: File[]): Promise<void> {
  if (!props.uploadImage) return;
  const media = files
    .map((file) => ({ file, kind: mediaKind(file.type) }))
    .filter((m): m is { file: File; kind: 'image' | 'video' } => m.kind !== null);
  if (media.length === 0) return;

  for (const { file, kind } of media) {
    const localId = nextLocalId();
    const previewUrl = URL.createObjectURL(file);
    const att: Attachment = { localId, name: file.name, kind, previewUrl, uploading: true };
    attachments.value = [...attachments.value, att];

    // Upload in background; update the attachment when done
    props.uploadImage(file, file.name).then((result) => {
      attachments.value = attachments.value.map((a) =>
        a.localId === localId
          ? { ...a, uploading: false, fileId: result?.fileId, error: result === null }
          : a,
      );
    }).catch(() => {
      attachments.value = attachments.value.map((a) =>
        a.localId === localId ? { ...a, uploading: false, error: true } : a,
      );
    });
  }
}

function removeAttachment(localId: string): void {
  const att = attachments.value.find((a) => a.localId === localId);
  if (previewAttachment.value?.localId === localId) previewAttachment.value = null;
  if (att) revokeAttachment(att);
  attachments.value = attachments.value.filter((a) => a.localId !== localId);
}

function openAttachmentPreview(att: Attachment): void {
  previewAttachment.value = att;
}

function closeAttachmentPreview(): void {
  previewAttachment.value = null;
}

function openFilePicker(): void {
  fileInputRef.value?.click();
}

function handleFileInputChange(e: Event): void {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  void addFiles(files);
  // Reset so re-selecting the same file fires change again
  input.value = '';
}

// Global document-level paste handler — captures Ctrl+V anywhere the composer is mounted.
function handleDocumentPaste(e: ClipboardEvent): void {
  if (!props.uploadImage) return;

  const cd = e.clipboardData;
  if (!cd) return;

  // Collect image files from both .items and .files to cover all browsers/OS.
  const files: File[] = [];
  const seenKeys = new Set<string>();

  const addBlob = (blob: File | Blob, name: string): void => {
    const key = `${blob.size}:${blob.type}:${name}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    const ext = blob.type.split('/')[1] ?? 'png';
    const safeName = name.includes('.') ? name : `paste-${Date.now()}.${ext}`;
    files.push(blob instanceof File ? blob : new File([blob], safeName, { type: blob.type }));
  };

  // From DataTransferItemList
  for (const item of Array.from(cd.items)) {
    if (item.kind === 'file' && mediaKind(item.type)) {
      const blob = item.getAsFile();
      if (blob) addBlob(blob, blob.name || `paste-${Date.now()}.${item.type.split('/')[1] ?? 'png'}`);
    }
  }

  // From FileList (some browsers/OS put screenshots here directly)
  for (const file of Array.from(cd.files)) {
    if (mediaKind(file.type)) {
      addBlob(file, file.name);
    }
  }

  if (files.length === 0) return; // No media — let normal text paste proceed unmodified.

  e.preventDefault();
  void addFiles(files);
}

// Drag-drop handlers
function handleDragOver(e: DragEvent): void {
  if (!props.uploadImage) return;
  const hasFiles = Array.from(e.dataTransfer?.items ?? []).some((item) => item.kind === 'file');
  if (!hasFiles) return;
  e.preventDefault();
  isDragOver.value = true;
}

function handleDragLeave(): void {
  isDragOver.value = false;
}

function handleDrop(e: DragEvent): void {
  isDragOver.value = false;
  if (!props.uploadImage) return;
  e.preventDefault();
  const files = Array.from(e.dataTransfer?.files ?? []);
  void addFiles(files);
}

onMounted(() => {
  document.addEventListener('paste', handleDocumentPaste);
  // Fit the box to a restored draft on first render.
  if (text.value) void nextTick(autosize);
});

// Revoke all object URLs and remove global listener on unmount
onUnmounted(() => {
  document.removeEventListener('paste', handleDocumentPaste);
  document.removeEventListener('mousedown', onModesDocClick);
  for (const att of attachments.value) {
    revokeAttachment(att);
  }
  previewAttachment.value = null;
  clearCompositionEndTimer();
});

// ---------------------------------------------------------------------------
// Submit / keydown
// ---------------------------------------------------------------------------

/** Imperatively load text into the box for editing (used by "edit & resend the
    last message" after an undo, or by the dock queue panel when the user edits
    a queued prompt). Focuses with the caret at the end. */
function loadForEdit(value: string): void {
  text.value = value;
  void nextTick(() => {
    const el = textareaRef.value;
    if (!el) return;
    el.focus();
    const pos = value.length;
    el.setSelectionRange(pos, pos);
    autosize();
  });
}

defineExpose({ loadForEdit });

function handleSubmit(): void {
  const trimmed = text.value.trim();

  // An upload is still in flight — submitting now would silently send the
  // message WITHOUT the image. Keep the text + chips (the chip shows its
  // uploading spinner); the user submits again in a moment.
  if (attachments.value.some((a) => a.uploading)) return;

  // Allow submission with images even when text is empty
  const readyAttachments = attachments.value.filter((a) => !a.uploading && !a.error && a.fileId);

  if (!trimmed && readyAttachments.length === 0) return;

  // If it's a known slash command, keep the optional tail as command input
  // instead of submitting it as normal chat text. This covers `/goal <task>`,
  // `/swarm <task>`, `/btw <question>`, slash skills with args, and bare
  // commands such as `/model`.
  if (trimmed) {
    const parsed = parseSlash(trimmed);
    const known = parsed
      ? buildSlashItems(props.skills).some((item) => item.name === parsed.cmd)
      : false;
    if (parsed && known) {
      text.value = '';
      slashOpen.value = false;
      emit('command', parsed.arg ? `${parsed.cmd} ${parsed.arg}` : parsed.cmd);
      return;
    }
  }

  const payload = {
    text: trimmed,
    attachments: readyAttachments.map((a) => ({ fileId: a.fileId!, kind: a.kind })),
  };

  // Revoke object URLs for submitted attachments
  previewAttachment.value = null;
  for (const att of attachments.value) {
    revokeAttachment(att);
  }
  attachments.value = [];

  pushInputHistory(trimmed);
  text.value = '';
  slashOpen.value = false;
  mentionOpen.value = false;
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
    attachments: readyAttachments.map((a) => ({ fileId: a.fileId!, kind: a.kind })),
  };
  for (const att of attachments.value) {
    revokeAttachment(att);
  }
  attachments.value = [];
  pushInputHistory(trimmed);
  text.value = '';
  slashOpen.value = false;
  mentionOpen.value = false;
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

  // History recall (shell-style ↑/↓).
  //
  // ENTERING history: a plain ArrowUp only recalls when the caret is on the
  // first line, so editing a multi-line draft with the arrows still works.
  // ONCE BROWSING (historyIndex !== -1), the arrows walk history directly,
  // regardless of where the caret landed — a recalled multi-line entry leaves
  // the caret at its end, and the old "must be on the first line" gate then
  // trapped it there, so further ArrowUp did nothing ("only one step back").
  // Walking freely while browsing fixes that; typing exits history (handleInput
  // resets historyIndex), after which the arrows move the caret normally again.
  if (!slashOpen.value && !mentionOpen.value && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
    const browsing = historyIndex !== -1;
    if (e.key === 'ArrowUp' && inputHistory.value.length > 0 && (browsing || caretAtFirstLine())) {
      e.preventDefault();
      recallOlder();
      return;
    }
    if (e.key === 'ArrowDown' && browsing) {
      e.preventDefault();
      recallNewer();
      return;
    }
  }

  // Normal Enter / Shift+Enter
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSubmit();
  }
}

// ---------------------------------------------------------------------------
// Computed
// ---------------------------------------------------------------------------

const sendLabel = computed(() => props.running ? t('composer.interrupt') : t('composer.send'));
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

// Context formatting
const kFmt = (n: number) => `${Math.round(n / 1000)}k`;
// Clamped to 0–100: ctxUsed can momentarily exceed ctxMax (estimates), and
// ctxMax can be 0 before the first status fetch — both broke the ring.
const pct = computed(() => {
  const max = props.status?.ctxMax ?? 0;
  if (max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round(((props.status?.ctxUsed ?? 0) / max) * 100)));
});

const ctxTooltip = computed(() => {
  const used = (props.status?.ctxUsed ?? 0).toLocaleString();
  const max = (props.status?.ctxMax ?? 0).toLocaleString();
  return t('status.ctxTooltip', { used, max, pct: pct.value });
});

const showCompact = computed(() => pct.value >= 80);

// Thinking toggle
const currentModel = computed(() => {
  const raw = props.status?.modelId ?? props.status?.model ?? '';
  return props.models?.find((m) =>
    m.id === raw ||
    m.model === raw ||
    m.displayName === props.status?.model,
  );
});
const thinkingAvailability = computed(() => modelThinkingAvailability(currentModel.value));
const thinkingToggleable = computed(() => thinkingAvailability.value === 'toggle');
const thinkingOn = computed(() => {
  if (thinkingAvailability.value === 'always-on') return true;
  if (thinkingAvailability.value === 'unsupported') return false;
  return (props.thinking ?? 'off') !== 'off';
});
function toggleThinking(): void {
  if (!thinkingToggleable.value) return;
  emit('setThinking', thinkingOn.value ? 'off' : 'high');
}

// Plan toggle
const planOn = computed(() => props.planMode === true);
const swarmOn = computed(() => props.swarmMode === true);
const goalActive = computed(() => props.activationBadges?.goal !== null);
const goalArmed = computed(() => goalActive.value || props.goalMode === true);

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
  { mode: 'yolo', color: 'var(--warn)', labelKey: 'status.permissionYolo', descKey: 'status.permissionYoloDesc' },
  { mode: 'auto', color: 'var(--err)', labelKey: 'status.permissionAuto', descKey: 'status.permissionAutoDesc' },
];

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
    :class="{ 'drag-over': isDragOver }"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <!-- Attachment chips (above the input row) -->
    <div v-if="attachments.length > 0" class="att-strip">
      <div v-for="att in attachments" :key="att.localId" class="att-chip" :class="{ 'att-error': att.error }">
        <!-- Thumbnail (video shows its first frame; an icon overlays it) -->
        <button type="button" class="att-preview" :title="t('composer.previewAttachment', { name: att.name })" @click="openAttachmentPreview(att)">
          <video v-if="att.kind === 'video'" class="att-thumb" :src="att.previewUrl" muted playsinline preload="metadata" />
          <img v-else class="att-thumb" :src="att.previewUrl" :alt="att.name" />
          <span v-if="att.kind === 'video'" class="att-video-badge" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="9" height="9" fill="currentColor"><path d="M5 3.5v9l7-4.5z"/></svg>
          </span>
        </button>
        <!-- Name + status -->
        <span class="att-name">{{ att.name }}</span>
        <!-- Spinner while uploading -->
        <span v-if="att.uploading" class="att-spinner" :aria-label="t('composer.uploading')">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" xmlns="http://www.w3.org/2000/svg">
            <circle cx="8" cy="8" r="6" stroke-opacity="0.25"/>
            <path d="M8 2 A6 6 0 0 1 14 8" stroke-linecap="round">
              <animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.8s" repeatCount="indefinite"/>
            </path>
          </svg>
        </span>
        <!-- Error indicator -->
        <span v-else-if="att.error" class="att-err-icon" :title="t('composer.uploadFailed')">
          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" xmlns="http://www.w3.org/2000/svg"><circle cx="6" cy="6" r="5"/><line x1="6" y1="3.5" x2="6" y2="6.5"/><circle cx="6" cy="8.5" r="0.5" fill="currentColor"/></svg>
        </span>
        <!-- Remove button -->
        <button class="att-rm" :title="t('composer.removeNamed', { name: att.name })" @click="removeAttachment(att.localId)">
          <svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.6" xmlns="http://www.w3.org/2000/svg"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
        </button>
      </div>
    </div>

    <div v-if="previewAttachment" class="att-lightbox" @click.self="closeAttachmentPreview">
      <div class="att-lightbox-card">
        <button type="button" class="att-lightbox-close" :title="t('model.close')" @click="closeAttachmentPreview">✕</button>
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
            rows="1"
            @keydown="handleKeydown"
            @compositionstart="handleCompositionStart"
            @compositionend="handleCompositionEnd"
            @input="handleInput"
          />

          <button
            class="send"
            :class="{ aborting: running }"
            :aria-label="sendLabel"
            :title="running ? t('composer.interruptTitle') : sendLabel"
            @click="running ? emit('interrupt') : handleSubmit()"
          >
            <svg
              class="send-icon"
              :class="{ hidden: running }"
              viewBox="0 0 16 16"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M8 3l6 5.5M8 3L2 8.5M8 3v10" />
            </svg>
            <svg
              class="send-icon"
              :class="{ hidden: !running }"
              viewBox="0 0 16 16"
              width="14"
              height="14"
              fill="currentColor"
              aria-hidden="true"
            >
              <rect x="3" y="3" width="10" height="10" rx="1.5" />
            </svg>
          </button>
        </div>
      </div>

      <!-- Hidden file input -->
      <input
        v-if="hasUpload"
        ref="fileInputRef"
        type="file"
        accept="image/*,video/*"
        multiple
        class="file-input-hidden"
        @change="handleFileInputChange"
      />

      <!-- Bottom toolbar — split into individual controls -->
      <div ref="toolbarRef" class="toolbar">
        <!-- Left: attach + permission + plan -->
        <div class="toolbar-left">
          <button
            v-if="hasUpload"
            class="attach-btn"
            :title="t('composer.attachImage')"
            type="button"
            @click="openFilePicker"
          >
            <svg class="attach-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M8 3v10M3 8h10"/></svg>
          </button>

          <!-- Permission pill — click to open dropdown -->
          <span
            v-if="status"
            class="perm-pill"
            :class="['perm-' + status.permission, { open: permDropdownOpen }]"
            role="button"
            tabindex="0"
            :title="t('status.permissionTooltip')"
            @click.stop="togglePermDropdown"
            @keydown.enter="togglePermDropdown"
            @keydown.space.prevent="togglePermDropdown"
          >{{ permLabel }}</span>

          <!-- Permission dropdown — anchored to the toolbar left side -->
          <div v-if="permDropdownOpen && status" class="perm-dropdown" role="menu" @click.stop>
            <button
              v-for="opt in PERM_MODES"
              :key="opt.mode"
              class="pd-row"
              :class="{ 'is-current': opt.mode === status.permission }"
              role="menuitem"
              @click="choosePermission(opt.mode)"
            >
              <span class="pd-check"><svg v-if="opt.mode === status.permission" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.5 3.5L13 4.5"/></svg></span>
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
              :class="{ on: anyModeActive }"
              :title="t('status.modesTooltip')"
              @click.stop="toggleModes"
            >
              <span class="mode-label">{{ t('status.modesLabel') }}</span>
              <span v-if="planOn" class="mode-tag">{{ t('status.planLabel') }}</span>
              <span v-if="swarmOn" class="mode-tag">{{ t('status.swarmLabel') }}</span>
              <span v-if="goalArmed" class="mode-tag">{{ t('status.goalLabel') }}</span>
            </button>

            <div v-if="modesOpen" ref="modesMenuRef" class="modes-menu" :style="modesMenuStyle">
              <!-- Plan — functional client toggle -->
              <button type="button" class="mode-row" :class="{ on: planOn }" @click="emit('togglePlan')">
                <span class="mode-row-name">{{ t('status.planLabel') }}</span>
                <span class="mode-switch" :class="{ on: planOn }"><span class="mode-knob" /></span>
              </button>
              <!-- Swarm — functional client toggle -->
              <button type="button" class="mode-row" :class="{ on: swarmOn }" @click="emit('toggleSwarm')">
                <span class="mode-row-name">{{ t('status.swarmLabel') }}</span>
                <span class="mode-switch" :class="{ on: swarmOn }"><span class="mode-knob" /></span>
              </button>
              <!-- Goal — lifecycle controls when active; switch is on when active or armed. -->
              <div class="mode-row mode-row-goal" :class="{ on: goalActive || props.goalMode }">
                <button
                  type="button"
                  class="mode-row-main"
                  @click="goalActive ? emit('controlGoal', 'cancel') : emit('toggleGoal')"
                >
                  <span class="mode-row-name">{{ t('status.goalLabel') }}</span>
                  <span v-if="!goalActive" class="mode-switch" :class="{ on: props.goalMode }"><span class="mode-knob" /></span>
                </button>
                <div v-if="goalActive" class="mode-row-actions">
                  <button
                    type="button"
                    class="mode-row-action"
                    @click="emit('controlGoal', 'pause')"
                  >{{ t('status.goalPause') }}</button>
                  <button
                    type="button"
                    class="mode-row-action"
                    @click="emit('controlGoal', 'resume')"
                  >{{ t('status.goalResume') }}</button>
                </div>
              </div>
            </div>
          </div>

        </div>

        <!-- Right: ctx + model -->
        <div class="toolbar-right">
          <!-- Compact chip when context is high -->
          <button v-if="showCompact" class="compact-chip" @click.stop="emit('compact')">/compact</button>

          <!-- Context meter — circular ring + token count -->
          <span v-if="status && !hideContext" class="ctx-group" :title="ctxTooltip">
            <svg class="ctx-ring" viewBox="0 0 20 20" aria-hidden="true">
              <circle
                class="ctx-ring-track"
                cx="10"
                cy="10"
                r="7"
                fill="none"
                stroke-width="2.5"
              />
              <circle
                class="ctx-ring-fill"
                cx="10"
                cy="10"
                r="7"
                fill="none"
                stroke-width="2.5"
                stroke-linecap="round"
                :stroke-dasharray="`${2 * Math.PI * 7}`"
                :stroke-dashoffset="`${2 * Math.PI * 7 * (1 - pct / 100)}`"
              />
            </svg>
            <span class="ctx-num">{{ kFmt(status.ctxUsed) }}/{{ kFmt(status.ctxMax) }}</span>
          </span>

          <!-- Model pill — click to open quick-switch dropdown -->
          <span
            v-if="status"
            class="model-pill"
            :class="{ open: dropdownOpen }"
            role="button"
            tabindex="0"
            :title="t('status.modelTooltip')"
            @click.stop="toggleDropdown"
            @keydown.enter="toggleDropdown"
            @keydown.space.prevent="toggleDropdown"
          >
            <b>{{ status.model }}</b>
            <span v-if="thinkingOn" class="think-suffix">{{ t('composer.thinkingSuffix') }}</span>
            <svg class="cv" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>
          </span>
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
            <span class="md-check"><svg v-if="m.id === status.model || m.model === status.model || m.displayName === status.model" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.5 3.5L13 4.5"/></svg></span>
            <span class="md-name">{{ m.displayName ?? m.model }}</span>
            <span class="md-provider">{{ m.provider }}</span>
            <svg class="md-star" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
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
            <span class="md-check"><svg v-if="m.id === status.model || m.model === status.model || m.displayName === status.model" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.5 3.5L13 4.5"/></svg></span>
            <span class="md-name">{{ m.displayName ?? m.model }}</span>
            <svg v-if="isStarred(m.id)" class="md-star" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
          </button>

          <div v-if="providerModels.length > 0" class="md-divider" />

          <!-- Thinking toggle -->
          <button
            class="md-row md-row-toggle"
            role="menuitem"
            :class="{ 'is-on': thinkingOn, 'is-disabled': !thinkingToggleable }"
            :disabled="!thinkingToggleable"
            @click="toggleThinking()"
          >
            <span class="md-check"><svg v-if="thinkingOn" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.5 3.5L13 4.5"/></svg></span>
            <span class="md-name">{{ t('status.thinkingLabel') }}</span>
            <span v-if="thinkingAvailability === 'always-on'" class="md-note">{{ t('status.planOn') }}</span>
            <span v-else-if="thinkingAvailability === 'unsupported'" class="md-note">{{ t('status.modeNotSupported') }}</span>
          </button>

          <div class="md-divider" />

          <!-- More models → open full picker -->
          <button class="md-row md-row-more" role="menuitem" @click="closeDropdown(); emit('pickModel');">
            <span class="md-name">{{ t('status.moreModels') }}</span>
          </button>
        </div>
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
  background: var(--soft);
}

/* Main composer card */
.composer-card {
  position: relative;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--bg);
  box-shadow: 0 1px 4px rgba(0,0,0,0.04);
  transition: border-color 0.15s, box-shadow 0.15s;
}



/* Attachment strip */
.att-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 0 6px;
}

.att-chip {
  position: relative;
  display: flex;
  align-items: center;
  gap: 5px;
  background: var(--panel2);
  border: 1px solid var(--bd);
  border-radius: 4px;
  padding: 3px 6px 3px 4px;
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--text);
  max-width: 220px;
}

.att-preview {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 3px;
  background: transparent;
  padding: 0;
  cursor: zoom-in;
  flex: none;
}
.att-preview:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}

/* Play glyph over a video thumbnail so it reads as a video, not a still. */
.att-video-badge {
  position: absolute;
  left: 4px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  pointer-events: none;
}

.att-chip.att-error {
  border-color: var(--err);
  color: var(--err);
}

.att-thumb {
  width: 28px;
  height: 28px;
  object-fit: cover;
  border-radius: 2px;
  flex-shrink: 0;
  background: var(--line2);
}

.att-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.att-spinner {
  display: flex;
  align-items: center;
  color: var(--blue);
  flex-shrink: 0;
}

.att-err-icon {
  display: flex;
  align-items: center;
  color: var(--err);
  flex-shrink: 0;
}

.att-rm {
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  padding: 1px;
  cursor: pointer;
  color: var(--muted);
  flex-shrink: 0;
}

.att-rm:hover {
  color: var(--err);
}

.att-lightbox {
  position: fixed;
  inset: 0;
  z-index: 260;
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
  box-shadow: 0 12px 42px rgba(0,0,0,0.22);
  object-fit: contain;
}
.att-lightbox-name {
  max-width: 100%;
  color: #fff;
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
  color: #fff;
  cursor: pointer;
}

/* Hidden file input */
.file-input-hidden {
  display: none;
}

/* Wrapper that establishes a positioning context for the popup menus */
.cin-wrap {
  position: relative;
  padding: 10px 12px 8px;
}

/* Input row */
.input-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.ph {
  color: var(--faint);
  flex: 1;
  border: none;
  outline: none;
  resize: none;
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  background: transparent;
  height: 56px;
  min-height: 56px;
  max-height: 56px;
  overflow-y: auto;
  line-height: 1.5;
  margin-bottom: 6px;
}

.ph::placeholder {
  color: var(--muted);
}

.ph:not(:placeholder-shown) {
  color: var(--ink);
}

/* /compact chip */
.compact-chip {
  background: none;
  border: 1px solid var(--line);
  border-radius: 3px;
  color: var(--warn);
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  padding: 0 4px;
  cursor: pointer;
  height: 19px;
  line-height: 17px;
  flex: none;
}
.compact-chip:hover { background: var(--panel2); }

/* Send button — circular icon (morphs into the abort square while running) */
.send {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--blue);
  color: var(--bg); /* on-accent text — readable in dark + mono-dark */
  border: none;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.25s ease, transform 0.12s ease;
  position: relative;
}

.send:hover {
  background: var(--blue2);
}

.send:active {
  transform: scale(0.92);
}

.send svg {
  flex: none;
}

.send-icon {
  position: absolute;
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.send-icon.hidden {
  opacity: 0;
  transform: scale(0.7);
  pointer-events: none;
}

.send.aborting {
  background: var(--err);
}
.send.aborting:hover {
  background: color-mix(in srgb, var(--err) 85%, #000);
}

/* Bottom toolbar */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px 4px;
  background: color-mix(in srgb, var(--panel2), black 1.5%);
  position: relative;
  border-radius: 0 0 var(--r-md) var(--r-md);
}

.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  overflow: hidden;
}

/* Attach button (pill style, matches permission/plan) */
.attach-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: var(--ui-font-size);
  color: var(--muted);
  cursor: pointer;
  user-select: none;
  transition: background 0.1s, color 0.15s;
  font-family: var(--sans);
  background: none;
  border: none;
  flex-shrink: 0;
  line-height: 1;
}
.attach-icon {
  display: block;
  flex: none;
}

.attach-btn:hover {
  background: var(--soft);
}

/* Permission pill */
.perm-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: var(--ui-font-size);
  color: var(--text);
  cursor: pointer;
  user-select: none;
  transition: background 0.1s, color 0.15s;
  font-family: var(--sans);
}
.perm-pill:hover {
  background: var(--soft);
}
.perm-pill.open {
  background: var(--soft);
}
.perm-pill.perm-manual {
  color: var(--dim);
}
.perm-pill.perm-yolo {
  color: var(--warn);
}
.perm-pill.perm-auto {
  color: var(--err);
}

/* Context group — circular ring + num */
.ctx-group {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 2px 0;
}

.ctx-ring {
  width: 16px;
  height: 16px;
  flex: none;
  transform: rotate(-90deg);
}

.ctx-ring-track {
  stroke: var(--line);
}

.ctx-ring-fill {
  stroke: var(--blue);
  transition: stroke-dashoffset 0.3s ease, stroke 0.3s ease;
}

.ctx-num {
  font-size: var(--ui-font-size);
  color: var(--muted);
  font-family: var(--mono);
  line-height: 16px;
}

/* Model pill */
.model-pill {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: var(--ui-font-size);
  line-height: 16px;
  color: var(--dim);
  cursor: pointer;
  user-select: none;
  transition: background 0.1s;
  position: relative;
  overflow: hidden;
}
.model-pill:hover {
  background: var(--soft);
  color: var(--blue2);
}
.model-pill.open {
  background: var(--soft);
}
.model-pill b {
  font-weight: 500;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  max-width: 280px;
}
.model-pill .think-suffix {
  color: var(--blue);
  font-weight: 500;
  flex-shrink: 0;
}
.model-pill .cv {
  color: var(--faint);
  flex: none;
}
.model-pill:hover .cv,
.model-pill.open .cv {
  color: var(--blue2);
}

/* Model dropdown — anchored to the toolbar right edge */
.model-dropdown {
  position: absolute;
  bottom: calc(100% + 4px);
  right: 10px;
  z-index: 60;
  min-width: 200px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.1);
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.md-section {
  padding: 4px 7px 2px;
  font-size: var(--ui-font-size);
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 500;
}

.md-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  color: var(--text);
  padding: 5px 7px;
  border-radius: 6px;
  text-align: left;
}
.md-row:hover { background: var(--soft); }
.md-row:disabled {
  cursor: default;
  opacity: 0.58;
}
.md-row:disabled:hover { background: none; }
.md-row.is-current { color: var(--ink); }
.md-row.is-on { color: var(--blue); }
.md-note {
  margin-left: auto;
  color: var(--muted);
  font-size: var(--ui-font-size-xs);
}

.md-row-more {
  color: var(--blue);
  font-weight: 500;
}
.md-row-more:hover {
  background: var(--soft);
}

.md-check {
  width: 14px;
  flex: none;
  color: var(--blue);
  font-weight: 700;
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

/* Permission dropdown — anchored to the toolbar left side */
.perm-dropdown {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 10px;
  z-index: 60;
  min-width: 220px;
  max-width: 280px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.1);
  padding: 5px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.pd-row {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  width: 100%;
  background: none;
  border: none;
  cursor: pointer;
  padding: 6px 7px;
  border-radius: 6px;
  text-align: left;
}
.pd-row:hover { background: var(--soft); }
.pd-row.is-current { background: var(--soft); }

.pd-check {
  width: 14px;
  flex: none;
  color: var(--blue);
  font-weight: 700;
  display: flex;
  justify-content: center;
  margin-top: 1px;
}

.pd-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.pd-name {
  font-family: var(--sans);
  font-size: var(--ui-font-size);
  font-weight: 500;
}

.pd-desc {
  font-family: var(--sans);
  font-size: var(--ui-font-size);
  color: var(--muted);
  line-height: 1.4;
}

/* Toggle pills (Thinking / Plan) */
/* Modes selector (plan / goal / swarm) — replaces the old plan pill + badges.
   z-index lifts the whole control (incl. its upward-opening menu) above the
   composer input row, which otherwise paints over the menu. */
.modes { position: relative; display: inline-flex; z-index: 30; }
.mode-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 9px;
  border: none;
  background: none;
  border-radius: 6px;
  font-size: var(--ui-font-size);
  font-family: var(--sans);
  color: var(--text);
  cursor: pointer;
  user-select: none;
  transition: background 0.1s, color 0.15s;
}
.mode-pill:hover { background: var(--soft); }
.mode-pill.on { background: var(--soft); color: var(--blue2); }
.mode-label { flex: none; }
.mode-tag {
  flex: none;
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--blue2);
  background: var(--bg);
  border: 1px solid var(--bd);
  border-radius: 999px;
  padding: 0 6px;
  line-height: 16px;
}
.mode-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--blue); flex: none; }

.modes-menu {
  position: fixed;
  z-index: 200;
  min-width: 220px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 9px;
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.14);
  padding: 4px;
}
.mode-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  background: none;
  border-radius: 6px;
  cursor: pointer;
  font-family: var(--sans);
  text-align: left;
}
.mode-row:hover:not(:disabled) { background: var(--panel2); }
.mode-row:disabled { cursor: not-allowed; opacity: 0.45; }
.mode-row-name { font-size: var(--ui-font-size-sm); color: var(--ink); }
.mode-row-not-supported {
  margin-left: auto;
  font-size: var(--ui-font-size-xs);
  color: var(--muted);
}
.mode-row.on .mode-row-name { color: var(--blue2); font-weight: 600; }
.mode-row-meta { font-family: var(--mono); font-size: calc(var(--ui-font-size) - 3px); color: var(--muted); }
.mode-row:disabled .mode-row-meta { color: var(--faint); }
.mode-switch {
  flex: none;
  width: 34px;
  height: 19px;
  border-radius: 999px;
  background: var(--panel2);
  border: 1px solid var(--line);
  position: relative;
  transition: background 0.15s;
}
.mode-switch.on { background: var(--blue); border-color: var(--blue); }
.mode-knob {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: var(--bg);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  transition: transform 0.15s;
}
.mode-switch.on .mode-knob { transform: translateX(15px); }

.mode-row-goal {
  flex-wrap: wrap;
  cursor: default;
  padding: 0;
  gap: 0;
}
.mode-row-goal:hover { background: transparent; }
.mode-row-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  background: none;
  border-radius: 6px;
  cursor: pointer;
  font-family: var(--sans);
  text-align: left;
}
.mode-row-main:hover { background: var(--panel2); }
.mode-row-goal.on .mode-row-main .mode-row-name { color: var(--blue2); font-weight: 600; }
.mode-row-actions {
  display: flex;
  gap: 6px;
  flex: 1 1 100%;
  justify-content: flex-end;
}
.mode-row-action {
  padding: 3px 8px;
  border-radius: 5px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink);
  font-size: calc(var(--ui-font-size) - 3px);
  cursor: pointer;
}
.mode-row-action:hover:not(:disabled) { background: var(--panel2); }
.mode-row-action:disabled { opacity: 0.5; cursor: default; }
.mode-row-input {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  border-radius: 5px;
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--ink);
  font-size: var(--ui-font-size-xs);
}

/* ---- Mobile composer (prototype): round attach + rounded panel input +
       round blue send with a soft shadow. The .cin container loses its border
       and acts as a flex row; the textarea itself becomes the pill input. ---- */
@media (max-width: 640px) {
  .composer {
    padding:
      9px
      var(--dock-inline-right, max(12px, env(safe-area-inset-right)))
      max(24px, env(safe-area-inset-bottom))
      var(--dock-inline-left, max(12px, env(safe-area-inset-left)));
  }
  .composer-card {
    border-radius: 14px;
    max-width: 100%;
  }
  .input-row {
    gap: 6px;
    min-width: 0;
  }
  /* Send → 36px round (hide the SVG arrow, show only the ::after glyph) */
  .send {
    width: 36px;
    height: 36px;
    min-width: 36px;
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
  .send.aborting::after {
    content: "■";
    /* Fixed icon glyph size — not part of the UI font scale. */
    font-size: 14px;
  }

  /* Mobile toolbar: hide secondary controls; only attach + model stay visible.
     Permission / plan / context live in the MobileSettingsSheet. The /compact
     chip stays: it is the ONLY context-pressure signal on a phone (it appears
     at ≥80% usage) and tapping it triggers compaction directly. */
  .perm-pill,
  .modes,
  .ctx-group {
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
     Single-line-friendly height: 56px desktop default → 44px touch target. */
  .ph {
    /* Pinned at 16px to prevent iOS auto-zoom on focus (not part of UI font scale). */
    font-size: 16px;
    height: 44px;
    min-height: 44px;
    max-height: 44px;
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
  .pd-name {
    font-size: var(--ui-font-size);
  }
  .pd-desc {
    font-size: var(--ui-font-size);
  }
}

/* NOTE: Modern-theme composer overrides live in src/style.css (global), NOT here.
   Scoped `:global(html[data-theme=modern]) .cin` rules did NOT reliably win the
   cascade against the base `.cin` (the input stayed square + mono), so they were
   moved to the global sheet where they apply. */
</style>
