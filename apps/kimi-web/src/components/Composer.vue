<!-- apps/kimi-web/src/components/Composer.vue -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import SlashMenu from './SlashMenu.vue';
import MentionMenu from './MentionMenu.vue';
import type { SlashCommand } from '../lib/slashCommands';
import { filterCommands, parseSlash } from '../lib/slashCommands';
import type { FileItem } from './MentionMenu.vue';

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
  queued?: string[];
  searchFiles?: (q: string) => Promise<FileItem[]>;
  /** If undefined, attach button is hidden and paste/drag are no-ops. */
  uploadImage?: (file: Blob, name?: string) => Promise<{ fileId: string; name: string; mediaType: string } | null>;
}>(), {
  running: false,
  queued: () => [],
  searchFiles: undefined,
  uploadImage: undefined,
});

const placeholder = computed(() => t('composer.placeholder'));

const emit = defineEmits<{
  submit: [payload: { text: string; attachments: { fileId: string }[] }];
  command: [cmd: string];
  interrupt: [];
  unqueue: [index: number];
  editQueued: [index: number];
}>();

const { t } = useI18n();

// ---------------------------------------------------------------------------
// Textarea
// ---------------------------------------------------------------------------

const text = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);

function autosize(): void {
  const el = textareaRef.value;
  if (!el) return;
  el.style.height = 'auto';
  const next = Math.max(40, Math.min(200, el.scrollHeight));
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

const sendLabel = computed(() => props.running ? t('composer.queue') : t('composer.send'));
const hasUpload = computed(() => !!props.uploadImage);
</script>

<template>
  <div
    class="composer"
    :class="{ 'drag-over': isDragOver }"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <!-- Queued message strip -->
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
          :title="t('composer.editQueued')"
          @click="editQueued(i, msg)"
        >{{ msg }}</button>
        <button class="queue-rm" :title="t('composer.remove')" @click="emit('unqueue', i)">
          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5" xmlns="http://www.w3.org/2000/svg"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
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
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" xmlns="http://www.w3.org/2000/svg">
            <circle cx="8" cy="8" r="6" stroke-opacity="0.25"/>
            <path d="M8 2 A6 6 0 0 1 14 8" stroke-linecap="round">
              <animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.8s" repeatCount="indefinite"/>
            </path>
          </svg>
        </span>
        <!-- Error indicator -->
        <span v-else-if="att.error" class="att-err-icon" :title="t('composer.uploadFailed')">
          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5" xmlns="http://www.w3.org/2000/svg"><circle cx="6" cy="6" r="5"/><line x1="6" y1="3.5" x2="6" y2="6.5"/><circle cx="6" cy="8.5" r="0.5" fill="currentColor"/></svg>
        </span>
        <!-- Remove button -->
        <button class="att-rm" :title="t('composer.removeNamed', { name: att.name })" @click="removeAttachment(att.localId)">
          <svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.5" xmlns="http://www.w3.org/2000/svg"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
        </button>
      </div>
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

      <div class="cin">
        <textarea
          ref="textareaRef"
          v-model="text"
          class="ph"
          :placeholder="placeholder"
          rows="1"
          @keydown="handleKeydown"
          @input="handleInput"
        />

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

        <!-- Attach button (paperclip icon) -->
        <button
          v-if="hasUpload"
          class="attach-btn"
          :title="t('composer.attachImage')"
          type="button"
          @click="openFilePicker"
        >
          <!-- Line-SVG paperclip / image glyph -->
          <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
            <rect x="2" y="3" width="12" height="10" rx="1.5"/>
            <circle cx="5.5" cy="6.5" r="1"/>
            <polyline points="2,13 5.5,9 8,11.5 10.5,8.5 14,13"/>
          </svg>
        </button>

        <button v-if="running" class="interrupt" :title="t('composer.interruptTitle')" @click="emit('interrupt')">{{ t('composer.interrupt') }}</button>
        <button class="send" @click="handleSubmit">{{ sendLabel }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.composer {
  border-top: 1px solid var(--line);
  padding: 8px 16px 12px;
  background: #fff;
  transition: background 0.12s;
}

.composer.drag-over {
  background: var(--soft);
  border-top-color: var(--bd);
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
.queue-text:hover {
  color: var(--blue);
}

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
}

.cin {
  display: flex;
  align-items: center;
  gap: 9px;
  border: 1px solid var(--line);
  background: #fff;
  padding: 9px 11px;
  border-radius: 4px;
}

.cin:focus-within {
  border-color: var(--bd);
}


.ph {
  color: var(--muted);
  flex: 1;
  border: none;
  outline: none;
  resize: none;
  font-family: var(--mono);
  font-size: 12.5px;
  background: transparent;
  min-height: 40px;
  max-height: 200px;
  overflow-y: auto;
  line-height: 1.5;
}

.ph:not(:placeholder-shown) {
  color: var(--ink);
}

/* Attach button */
.attach-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  padding: 4px;
  cursor: pointer;
  color: var(--muted);
  border-radius: 3px;
  flex-shrink: 0;
}

.attach-btn:hover {
  color: var(--blue);
  background: var(--soft);
}

.interrupt {
  background: none;
  color: var(--err);
  border: 1px solid var(--err);
  padding: 4px 10px;
  font-family: var(--mono);
  font-size: 11.5px;
  cursor: pointer;
  border-radius: 3px;
  flex-shrink: 0;
}

.interrupt:hover {
  background: #fef2f2;
}

.send {
  background: var(--blue);
  color: #fff;
  border: none;
  padding: 5px 13px;
  font-family: var(--mono);
  font-size: 11.5px;
  cursor: pointer;
  border-radius: 3px;
  flex-shrink: 0;
}

.send:hover {
  background: var(--blue2);
}

/* ---- Mobile composer (prototype): round attach + rounded panel input +
       round blue send with a soft shadow. The .cin container loses its border
       and acts as a flex row; the textarea itself becomes the pill input. ---- */
@media (max-width: 640px) {
  .composer {
    padding: 9px 12px max(24px, env(safe-area-inset-bottom));
  }
  .cin {
    gap: 9px;
    padding: 0;
    border: none;
    background: none;
    align-items: flex-end;
  }
  .cin:focus-within { border: none; }

  /* Attach → 40px round */
  .attach-btn {
    width: 40px;
    height: 40px;
    padding: 0;
    border-radius: 50%;
    color: var(--muted);
    align-self: flex-end;
  }
  .attach-btn:hover { background: none; }

  /* Input → rounded panel pill */
  .ph {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 22px;
    padding: 10px 15px;
    min-height: 42px;
    box-sizing: border-box;
    line-height: 1.4;
  }

  /* Send → 42px round blue with shadow */
  .send {
    width: 42px;
    height: 42px;
    min-width: 42px;
    padding: 0;
    border-radius: 50%;
    font-size: 0; /* hide the text label; the arrow glyph below shows instead */
    background: var(--blue);
    box-shadow: 0 3px 10px rgba(21, 101, 192, 0.28);
    align-self: flex-end;
    position: relative;
  }
  .send::after {
    content: "↑";
    font-size: 17px;
    line-height: 1;
    color: #fff;
  }
  .interrupt {
    min-height: 42px;
    padding: 8px 12px;
    align-self: flex-end;
  }
}

/* ===================== Modern theme ===================== */
/* Refined (NOT big-radius) inputs: a cleaner ~10px squared input + a rounded-rect
   send, with restrained pill controls. Higher specificity than the mobile media
   query so it wins at every width. Touch targets stay >=40px. */
:global(html[data-theme="modern"]) .cin {
  border-radius: 10px;
  border-color: var(--line);
  background: #fff;
  box-shadow: 0 1px 2px rgba(20, 23, 28, 0.04);
  align-items: center;
  padding: 8px 10px;
  gap: 9px;
}
:global(html[data-theme="modern"]) .cin:focus-within {
  border-color: var(--bd);
  box-shadow: 0 0 0 3px rgba(21, 101, 192, 0.10);
}
/* Input itself: drop the mobile pill back to a clean squared field. */
:global(html[data-theme="modern"]) .ph {
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 0;
  min-height: 40px;
  box-sizing: border-box;
  /* Compact prose size; sans font-family is applied globally in style.css (a
     scoped :global() rule didn't reliably win the cascade for font-family). */
  font-size: 12.5px;
}
/* Attach → small rounded square (not a fat round). */
:global(html[data-theme="modern"]) .attach-btn {
  width: 40px;
  height: 40px;
  padding: 0;
  border-radius: 9px;
  align-self: center;
}
:global(html[data-theme="modern"]) .attach-btn:hover {
  background: var(--soft);
  color: var(--blue);
}
/* Send → rounded-rect, not a fat pill / not a big circle. Keep >=40px height. */
:global(html[data-theme="modern"]) .send {
  width: auto;
  min-width: 0;
  height: 40px;
  padding: 0 16px;
  border-radius: 10px;
  font-size: 11.5px;
  box-shadow: none;
  align-self: center;
}
:global(html[data-theme="modern"]) .send::after { content: none; }
:global(html[data-theme="modern"]) .send:hover { background: var(--blue2); }
:global(html[data-theme="modern"]) .interrupt {
  height: 40px;
  border-radius: 10px;
  align-self: center;
}
/* Queued strip + attach chips: gently squared, not pill. */
:global(html[data-theme="modern"]) .queue-item,
:global(html[data-theme="modern"]) .att-chip {
  border-radius: 8px;
}
</style>
