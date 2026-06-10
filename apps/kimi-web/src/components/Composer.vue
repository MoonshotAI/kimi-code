<!-- apps/kimi-web/src/components/Composer.vue -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import SlashMenu from './SlashMenu.vue';
import MentionMenu from './MentionMenu.vue';
import type { SlashCommand } from '../lib/slashCommands';
import { filterCommands, parseSlash } from '../lib/slashCommands';
import type { FileItem } from './MentionMenu.vue';
import type { ConversationStatus, PermissionMode, QueuedPromptView } from '../types';
import type { AppModel, ThinkingLevel } from '../api/types';

// ---------------------------------------------------------------------------
// Attachment state
// ---------------------------------------------------------------------------

interface Attachment {
  /** Unique local id (used as :key) */
  localId: string;
  /** File name */
  name: string;
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
  queued?: QueuedPromptView[];
  searchFiles?: (q: string) => Promise<FileItem[]>;
  /** If undefined, attach button is hidden and paste/drag are no-ops. */
  uploadImage?: (file: Blob, name?: string) => Promise<{ fileId: string; name: string; mediaType: string } | null>;
  /** Status data (model, context, permission) — drives the bottom toolbar. */
  status?: ConversationStatus;
  thinking?: ThinkingLevel;
  planMode?: boolean;
  /** Available models for the quick-switch dropdown. */
  models?: AppModel[];
}>(), {
  running: false,
  queued: () => [],
  searchFiles: undefined,
  uploadImage: undefined,
  models: () => [],
});

const placeholder = computed(() => t('composer.placeholder'));

const emit = defineEmits<{
  submit: [payload: { text: string; attachments: { fileId: string }[] }];
  command: [cmd: string];
  interrupt: [];
  unqueue: [index: number];
  editQueued: [index: number];
  setPermission: [mode: PermissionMode];
  setThinking: [level: ThinkingLevel];
  togglePlan: [];
  compact: [];
  pickModel: [];
  selectModel: [modelId: string];
}>();

const { t } = useI18n();

// ---------------------------------------------------------------------------
// Textarea
// ---------------------------------------------------------------------------

const text = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const isFocused = ref(false);

function autosize(): void {
  const el = textareaRef.value;
  if (!el) return;
  el.style.height = 'auto';
  // Two lines tall by default (~56px); grows up to ~180px as the user types.
  const next = Math.max(56, Math.min(180, el.scrollHeight));
  el.style.height = `${next}px`;
}

watch(text, () => void nextTick(autosize));

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
    slashItems.value = filterCommands(val);
    slashActive.value = 0;
    slashOpen.value = slashItems.value.length > 0;
  } else {
    slashOpen.value = false;
  }
}

function selectSlashCommand(item: SlashCommand): void {
  slashOpen.value = false;
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
  updateSlashMenu();
  updateMentionMenu();
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

const attachments = ref<Attachment[]>([]);
const fileInputRef = ref<HTMLInputElement | null>(null);
const isDragOver = ref(false);

let localIdCounter = 0;
function nextLocalId(): string {
  return `att_${++localIdCounter}`;
}

function revokeAttachment(att: Attachment): void {
  try { URL.revokeObjectURL(att.previewUrl); } catch { /* ignore */ }
}

async function addFiles(files: File[]): Promise<void> {
  if (!props.uploadImage) return;
  const imageFiles = files.filter((f) => f.type.startsWith('image/'));
  if (imageFiles.length === 0) return;

  for (const file of imageFiles) {
    const localId = nextLocalId();
    const previewUrl = URL.createObjectURL(file);
    const att: Attachment = { localId, name: file.name, previewUrl, uploading: true };
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
  if (att) revokeAttachment(att);
  attachments.value = attachments.value.filter((a) => a.localId !== localId);
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
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const blob = item.getAsFile();
      if (blob) addBlob(blob, blob.name || `paste-${Date.now()}.${item.type.split('/')[1] ?? 'png'}`);
    }
  }

  // From FileList (some browsers/OS put screenshots here directly)
  for (const file of Array.from(cd.files)) {
    if (file.type.startsWith('image/')) {
      addBlob(file, file.name);
    }
  }

  if (files.length === 0) return; // No images — let normal text paste proceed unmodified.

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
});

// Revoke all object URLs and remove global listener on unmount
onUnmounted(() => {
  document.removeEventListener('paste', handleDocumentPaste);
  for (const att of attachments.value) {
    revokeAttachment(att);
  }
});

// ---------------------------------------------------------------------------
// Submit / keydown
// ---------------------------------------------------------------------------

/**
 * Load a queued message back into the textarea for editing, then ask the parent
 * to remove it from the queue. If the textarea already has content, prepend the
 * queued text so the user doesn't lose what they were typing.
 */
function editQueued(index: number, msg: string): void {
  const current = text.value;
  text.value = current ? `${msg}\n${current}` : msg;
  emit('editQueued', index);
  void nextTick(() => {
    const el = textareaRef.value;
    if (!el) return;
    el.focus();
    const pos = msg.length;
    el.setSelectionRange(pos, pos);
    autosize();
  });
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

  // If it's a slash command (no space → treat as command trigger)
  if (trimmed) {
    const parsed = parseSlash(trimmed);
    if (parsed && !parsed.arg) {
      // pure command with no extra text
      text.value = '';
      slashOpen.value = false;
      emit('command', parsed.cmd);
      return;
    }
  }

  const payload = {
    text: trimmed,
    attachments: readyAttachments.map((a) => ({ fileId: a.fileId! })),
  };

  // Revoke object URLs for submitted attachments
  for (const att of attachments.value) {
    revokeAttachment(att);
  }
  attachments.value = [];

  text.value = '';
  slashOpen.value = false;
  mentionOpen.value = false;
  emit('submit', payload);
}

function handleKeydown(e: KeyboardEvent): void {
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
const pct = computed(() => Math.round(((props.status?.ctxUsed ?? 0) / (props.status?.ctxMax ?? 1)) * 100) || 0);

const ctxTooltip = computed(() => {
  const used = (props.status?.ctxUsed ?? 0).toLocaleString();
  const max = (props.status?.ctxMax ?? 0).toLocaleString();
  return t('status.ctxTooltip', { used, max, pct: pct.value });
});

const showCompact = computed(() => pct.value >= 80);

// Thinking toggle
const thinkingOn = computed(() => (props.thinking ?? 'off') !== 'off');
function toggleThinking(): void {
  emit('setThinking', thinkingOn.value ? 'off' : 'high');
}

// Plan toggle
const planOn = computed(() => props.planMode === true);

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
  const name = props.status?.model ?? '';
  const match = props.models?.find(
    (m) => m.id === name || m.model === name || m.displayName === name,
  );
  return match?.provider ?? '';
});

const providerModels = computed(() => {
  if (!currentProvider.value || !props.models?.length) return [];
  return props.models.filter((m) => m.provider === currentProvider.value);
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
    <!-- Queued message strip. Items carrying image attachments can't be
         edited (the uploaded files can't be loaded back into the input);
         they show an image badge and an "image ×N" placeholder when the
         prompt has no text. -->
    <div v-if="queued && queued.length > 0" class="queue-strip">
      <span class="queue-label">{{ t('composer.queueLabel') }}</span>
      <div
        v-for="(msg, i) in queued"
        :key="i"
        class="queue-item"
      >
        <button
          class="queue-text"
          type="button"
          :disabled="msg.attachmentCount > 0"
          :title="msg.attachmentCount > 0 ? t('composer.queuedHasImage', { n: msg.attachmentCount }) : t('composer.editQueued')"
          @click="msg.attachmentCount === 0 && editQueued(i, msg.text)"
        >
          <svg v-if="msg.attachmentCount > 0" class="queue-img" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><circle cx="5.5" cy="6.5" r="1.2"/><path d="M2.5 12l3.5-3.5 2.5 2.5 3-3 2 2"/></svg>
          <span class="queue-text-inner" :class="{ placeholder: !msg.text }">{{ msg.text || t('composer.queuedImageOnly', { n: msg.attachmentCount }) }}</span>
        </button>
        <button class="queue-rm" :title="t('composer.remove')" @click="emit('unqueue', i)">
          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" xmlns="http://www.w3.org/2000/svg"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
        </button>
      </div>
    </div>

    <!-- Attachment chips (above the input row) -->
    <div v-if="attachments.length > 0" class="att-strip">
      <div v-for="att in attachments" :key="att.localId" class="att-chip" :class="{ 'att-error': att.error }">
        <!-- Thumbnail -->
        <img class="att-thumb" :src="att.previewUrl" :alt="att.name" />
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

    <!-- Main composer card -->
    <div class="composer-card" :class="{ focused: isFocused }">
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
            @input="handleInput"
            @focus="isFocused = true"
            @blur="isFocused = false"
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
        accept="image/*"
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

          <!-- Plan toggle pill -->
          <span
            v-if="status"
            class="toggle-pill"
            :class="{ on: planOn }"
            role="button"
            tabindex="0"
            :title="t('status.planTooltip')"
            @click="emit('togglePlan')"
            @keydown.enter="emit('togglePlan')"
            @keydown.space.prevent="emit('togglePlan')"
          >{{ t('status.planLabel') }}</span>
        </div>

        <!-- Right: ctx + model -->
        <div class="toolbar-right">
          <!-- Compact chip when context is high -->
          <button v-if="showCompact" class="compact-chip" @click.stop="emit('compact')">/compact</button>

          <!-- Context meter — circular ring + token count -->
          <span v-if="status" class="ctx-group" :title="ctxTooltip">
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
          <!-- Current provider models -->
          <div v-if="providerModels.length > 0" class="md-section">{{ currentProvider }}</div>
          <button
            v-for="m in providerModels"
            :key="m.id"
            class="md-row"
            :class="{ 'is-current': m.id === status.model || m.model === status.model || m.displayName === status.model }"
            role="menuitem"
            @click="selectModel(m.id)"
          >
            <span class="md-check"><svg v-if="m.id === status.model || m.model === status.model || m.displayName === status.model" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.5 3.5L13 4.5"/></svg></span>
            <span class="md-name">{{ m.displayName ?? m.model }}</span>
          </button>

          <div v-if="providerModels.length > 0" class="md-divider" />

          <!-- Thinking toggle -->
          <button
            class="md-row md-row-toggle"
            role="menuitem"
            :class="{ 'is-on': thinkingOn }"
            @click="toggleThinking()"
          >
            <span class="md-check"><svg v-if="thinkingOn" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3.5 3.5L13 4.5"/></svg></span>
            <span class="md-name">{{ t('status.thinkingLabel') }}</span>
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
  padding: 8px 16px 12px;
  background: transparent;
  transition: background 0.12s;
}

.composer.drag-over {
  background: var(--soft);
}

/* Main composer card */
.composer-card {
  border: 1px solid var(--line);
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0,0,0,0.04);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.composer-card.focused {
  border-color: var(--bd);
  box-shadow: 0 2px 12px rgba(21,101,192,0.08), 0 0 0 1px rgba(21,101,192,0.05);
}

/* Queued strip */
.queue-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 4px 0 6px;
}

.queue-label {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  margin-right: 2px;
}

.queue-item {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--panel2);
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 2px 6px 2px 8px;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text);
  max-width: 200px;
}

.queue-text {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text);
  cursor: pointer;
  max-width: 168px;
  text-align: left;
}
.queue-text:hover:not(:disabled) {
  color: var(--blue);
}
.queue-text:disabled {
  cursor: default;
}
.queue-img { flex: none; color: var(--muted); }
.queue-text-inner {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.queue-text-inner.placeholder { color: var(--muted); }

.queue-rm {
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

.queue-rm:hover {
  color: var(--err);
}

/* Attachment strip */
.att-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 0 6px;
}

.att-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  background: var(--panel2);
  border: 1px solid var(--bd);
  border-radius: 4px;
  padding: 3px 6px 3px 4px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text);
  max-width: 220px;
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
  font-size: 12.5px;
  background: transparent;
  min-height: 56px;
  max-height: 200px;
  overflow-y: auto;
  line-height: 1.5;
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
  font-size: 12.5px;
  padding: 0 4px;
  cursor: pointer;
  height: 19px;
  line-height: 17px;
  flex: none;
}
.compact-chip:hover { background: var(--panel2); }

/* Interrupt button */
/* Send button — circular icon */
.send {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--blue);
  color: #fff;
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
  background: #b91c1c;
}

/* Bottom toolbar */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 10px 6px;
  background: var(--panel2);
  position: relative;
  border-radius: 0 0 15px 15px;
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
  font-size: 13px;
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
  font-size: 13px;
  color: var(--dim);
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
  font-size: 13px;
  color: var(--muted);
  font-family: var(--mono);
}

/* Model pill */
.model-pill {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: 13px;
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
  font-size: 11.5px;
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
  font-size: 13px;
  color: var(--text);
  padding: 5px 7px;
  border-radius: 6px;
  text-align: left;
}
.md-row:hover { background: var(--soft); }
.md-row.is-current { color: var(--ink); }
.md-row.is-on { color: var(--blue); }

.md-row-more {
  color: var(--blue);
  font-weight: 500;
}
.md-row-more:hover {
  background: var(--soft);
}

.md-row-info {
  cursor: default;
  pointer-events: none;
}
.md-row-info .md-name {
  font-weight: 500;
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
  font-size: 13.5px;
  font-weight: 500;
}

.pd-desc {
  font-family: var(--sans);
  font-size: 12px;
  color: var(--muted);
  line-height: 1.4;
}

/* Toggle pills (Thinking / Plan) */
.toggle-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--dim);
  cursor: pointer;
  user-select: none;
  transition: background 0.1s, color 0.15s;
  font-family: var(--sans);
}
.toggle-pill:hover {
  background: var(--soft);
}
.toggle-pill.on {
  background: var(--soft);
  color: var(--dim);
}
.toggle-pill.on:hover {
  background: var(--soft);
}

/* ---- Mobile composer (prototype): round attach + rounded panel input +
       round blue send with a soft shadow. The .cin container loses its border
       and acts as a flex row; the textarea itself becomes the pill input. ---- */
@media (max-width: 640px) {
  .composer {
    padding: 9px 12px max(24px, env(safe-area-inset-bottom));
  }
  .composer-card {
    border-radius: 14px;
  }
  .input-row {
    gap: 6px;
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
    font-size: 17px;
    line-height: 1;
    color: #fff;
  }
  .send.aborting::after {
    content: "■";
    font-size: 14px;
  }

  /* Mobile toolbar: hide secondary controls; only attach + model stay visible.
     Permission, plan, context, compact chip move into the model dropdown. */
  .perm-pill,
  .toggle-pill,
  .ctx-group,
  .compact-chip {
    display: none;
  }

  /* Model dropdown on mobile → anchored right with padding */
  .model-dropdown {
    right: 10px;
    left: auto;
    min-width: 180px;
  }

  /* Permission dropdown on mobile → anchored left with padding */
  .perm-dropdown {
    left: 10px;
    right: auto;
    min-width: 200px;
    max-width: calc(100vw - 40px);
  }

  /* Bump mobile font sizes +2px and pin input at 16px to prevent iOS zoom. */
  .ph {
    font-size: 16px;
  }
  .model-pill,
  .attach-btn {
    font-size: 13.5px;
  }
  .model-pill b {
    max-width: 240px;
  }
  .md-row {
    font-size: 13.5px;
  }
  .md-section {
    font-size: 12px;
  }
  .pd-name {
    font-size: 14px;
  }
  .pd-desc {
    font-size: 12.5px;
  }
}

/* NOTE: Modern-theme composer overrides live in src/style.css (global), NOT here.
   Scoped `:global(html[data-theme=modern]) .cin` rules did NOT reliably win the
   cascade against the base `.cin` (the input stayed square + mono), so they were
   moved to the global sheet where they apply. */
</style>
