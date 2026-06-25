<!-- apps/kimi-web/src/components/SessionRow.vue -->
<!-- A single session row: status dot + title + time + attention pill + kebab. -->
<!-- Inline rename (dblclick) and delete-confirm live here. -->
<script setup lang="ts">
import { nextTick, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session } from '../types';
import { copyTextToClipboard } from '../lib/clipboard';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    session: Session;
    active: boolean;
    /** Pending permission requests waiting for the user's approval. */
    approvalCount?: number;
    /** Pending askUserQuestion prompts waiting for the user's answer. */
    questionCount?: number;
    /** A background turn finished here that the user hasn't opened — blue dot. */
    unread?: boolean;
  }>(),
  { approvalCount: 0, questionCount: 0, unread: false },
);

const emit = defineEmits<{
  select: [id: string];
  rename: [id: string, title: string];
  archive: [id: string];
  fork: [id: string];
}>();

// Kebab menu
const menuOpen = ref(false);
const kebabRef = ref<HTMLButtonElement | null>(null);
const menuRef = ref<HTMLElement | null>(null);

function onDocClick(e: MouseEvent): void {
  const target = e.target as Node;
  if (menuRef.value?.contains(target) || kebabRef.value?.contains(target)) return;
  closeMenu();
}

function toggleMenu(e: Event): void {
  e.stopPropagation();
  if (!menuOpen.value) {
    menuOpen.value = true;
    // Defer so the current click doesn't immediately close the menu.
    setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
  } else {
    closeMenu();
  }
}
function closeMenu(): void {
  menuOpen.value = false;
  document.removeEventListener('mousedown', onDocClick);
}

onUnmounted(() => document.removeEventListener('mousedown', onDocClick));

// Inline rename
const renaming = ref(false);
const renameValue = ref('');
const renameInputRef = ref<HTMLInputElement | null>(null);
async function startRename(): Promise<void> {
  closeMenu();
  renaming.value = true;
  renameValue.value = props.session.title;
  await nextTick();
  try {
    renameInputRef.value?.focus();
    renameInputRef.value?.select();
  } catch {
    // jsdom may not implement focus/select
  }
}
function commitRename(): void {
  const newTitle = renameValue.value.trim();
  if (newTitle) emit('rename', props.session.id, newTitle);
  renaming.value = false;
}
function cancelRename(): void {
  renaming.value = false;
}

// Copy session ID
const copiedId = ref(false);
const copyFailed = ref(false);
async function copySessionId(): Promise<void> {
  const ok = await copyTextToClipboard(props.session.id);
  copiedId.value = ok;
  copyFailed.value = !ok;
  // Keep the menu open briefly so the result text is visible, then close.
  setTimeout(() => {
    copiedId.value = false;
    copyFailed.value = false;
    closeMenu();
  }, 1500);
}

// Fork this session into a new child session
function forkRow(): void {
  closeMenu();
  emit('fork', props.session.id);
}

// Archive confirm
const confirming = ref(false);
function startArchive(): void {
  closeMenu();
  confirming.value = true;
}
function confirmArchive(): void {
  emit('archive', props.session.id);
  confirming.value = false;
}
function cancelArchive(): void {
  confirming.value = false;
}

// Expose closeMenu so the parent can close on outside-click.
defineExpose({ closeMenu, cancelArchive });
</script>

<template>
  <div class="se" :class="{ on: active }" @click="emit('select', session.id)">
    <div class="row">
      <!-- Leading status slot (in the gutter left of the title): a spinner
           while the session runs, otherwise an unread blue dot. Fixed width
           so the title start never shifts. It stays put in the archive-confirm
           state too, so the confirm strip aligns with the title and never
           spills past its left boundary. -->
      <span class="lead" aria-hidden="true">
        <svg
          v-if="session.busy"
          class="run-ico"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
        >
          <circle class="run-track" cx="8" cy="8" r="6" stroke-width="2" />
          <path class="run-arc" d="M8 2 A6 6 0 1 1 2 8" stroke-width="2" stroke-linecap="round" />
        </svg>
        <span v-else-if="unread" class="unread-dot" />
      </span>

      <!-- Archive confirm — replaces the title + controls but keeps the lead
           gutter, so it aligns under the title (not the row's left edge). -->
      <div v-if="confirming" class="archive-confirm" @click.stop>
        <span class="archive-label">{{ t('sidebar.archiveConfirm') }}</span>
        <button class="btn-confirm" @click.stop="confirmArchive">{{ t('sidebar.confirm') }}</button>
        <button class="btn-cancel" @click.stop="cancelArchive">{{ t('sidebar.cancel') }}</button>
      </div>

      <template v-else>
        <div class="left">
          <!-- Inline rename input -->
          <input
            v-if="renaming"
            ref="renameInputRef"
            v-model="renameValue"
            class="rename-input"
            @click.stop
            @keydown.enter.stop="commitRename"
            @keydown.esc.stop="cancelRename"
            @blur="commitRename"
          />
          <span v-else class="t" @dblclick.stop="startRename">{{ session.title }}</span>
        </div>

        <span class="ts">{{ session.time }}</span>

        <!-- Pending tags — coloured per kind, shown even when the row isn't
             active. "Answer" = an askUserQuestion is waiting; "Approve" = a
             permission request is waiting. The session's lifecycle status drives
             the same tags as a fallback for background sessions whose pending
             lists aren't loaded yet (status known, counts not). -->
        <span
          v-if="!renaming && (questionCount > 0 || session.status === 'awaitingQuestion')"
          class="tag tag-ask"
          :title="t('workspace.awaitingAnswerTitle')"
        >
          <span class="tag-text">{{ t('workspace.awaitingAnswer') }}</span>
        </span>
        <span
          v-if="!renaming && (approvalCount > 0 || session.status === 'awaitingApproval')"
          class="tag tag-approve"
          :title="t('workspace.awaitingPermissionTitle')"
        >
          <span class="tag-text">{{ t('workspace.awaitingPermission') }}</span>
        </span>
        <!-- Aborted: a distinct, low-key error tag (not collapsed into idle). -->
        <span
          v-if="!renaming && session.status === 'aborted'"
          class="tag tag-aborted"
          :title="t('workspace.abortedTitle')"
        >
          <span class="tag-text">{{ t('workspace.aborted') }}</span>
        </span>

        <!-- Kebab button (visible on hover) -->
        <button
          ref="kebabRef"
          v-if="!renaming"
          class="kebab"
          :class="{ open: menuOpen }"
          :title="t('sidebar.options')"
          @click.stop="toggleMenu($event)"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
            <circle cx="8" cy="3" r="1.3" />
            <circle cx="8" cy="8" r="1.3" />
            <circle cx="8" cy="13" r="1.3" />
          </svg>
        </button>
      </template>
    </div>

    <!-- Kebab dropdown -->
    <div ref="menuRef" v-if="menuOpen" class="menu" @click.stop>
      <button class="menu-item copy-id" :class="{ failed: copyFailed }" @click.stop="copySessionId">
        {{
          copyFailed
            ? t('sidebar.copyFailed')
            : copiedId
              ? t('sidebar.copied')
              : t('sidebar.copySessionId')
        }}
      </button>
      <div class="menu-divider" />
      <button class="menu-item" @click.stop="startRename">{{ t('sidebar.rename') }}</button>
      <button class="menu-item" @click.stop="forkRow">{{ t('sidebar.fork') }}</button>
      <button class="menu-item archive" @click.stop="startArchive">{{ t('sidebar.archive') }}</button>
    </div>
  </div>
</template>

<style scoped>
.se {
  /* --sb-* vars come from .side in Sidebar.vue: the title starts at
     --sb-pad-x + --sb-gutter + --sb-gap, exactly under the workspace name. */
  display: block;
  padding: 7px var(--sb-pad-x, 12px);
  cursor: pointer;
  position: relative;
}
.se:hover { background: var(--panel2); }
.se.on { background: color-mix(in srgb, var(--blue) 7%, transparent); }

.row {
  display: flex;
  align-items: center;
  gap: var(--sb-gap, 6px);
  min-width: 0;
}

.left {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
}

/* Leading status slot — mirrors the workspace header's icon slot (so the title
   aligns under the workspace name) AND carries the running spinner / unread dot.
   Fixed width keeps the title start fixed whether or not an indicator shows. */
.lead {
  width: var(--sb-gutter, 16px);
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.run-ico {
  animation: row-spin 0.8s linear infinite;
}
.run-track { stroke: var(--line); }
.run-arc { stroke: var(--blue); }
@keyframes row-spin {
  to { transform: rotate(360deg); }
}
.unread-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--blue);
}

.t {
  color: var(--ink);
  font-size: var(--ui-font-size);
  font-weight: 400;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.se.on .t { font-weight: 500; }

.ts { color: var(--muted); font-size: max(9px, calc(var(--ui-font-size) - 3.5px)); flex: none; }
.se:hover .ts { display: none; }

/* Pending tags — small coloured pills, one per kind. "Ask" reuses the Kimi-blue
   accent; "Approve" uses the warn tone so the two read as distinct at a glance.
   Fixed height + matching line-height keeps the text truly vertically centred
   and prevents the pill from visually out-growing the session title. */
.tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  flex: none;
  box-sizing: border-box;
  height: 18px;
  border: 1px solid transparent;
  border-radius: 9px;
  font-size: var(--ui-font-size-xs);
  line-height: 18px;
  padding: 0 6px 0 5px;
  font-family: var(--mono);
  white-space: nowrap;
  vertical-align: middle;
}
.tag svg { flex: none; display: block; }
.tag-text { display: inline-flex; align-items: center; }
.tag-ask {
  background: var(--soft);
  color: var(--blue2);
  border-color: var(--bd);
}
.tag-approve {
  background: color-mix(in srgb, var(--warn) 16%, var(--bg));
  color: var(--warn);
  border-color: color-mix(in srgb, var(--warn) 38%, var(--bg));
}
.tag-aborted {
  background: color-mix(in srgb, var(--err) 12%, var(--bg));
  color: var(--err);
  border-color: color-mix(in srgb, var(--err) 32%, var(--bg));
}

/* Kebab button — hidden until hover. Sits at the RIGHT of the timestamp
   and attention badge so it is the right-most element. */
.kebab {
  display: none;
  flex: none;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px;
  color: var(--muted);
  border-radius: 4px;
}
.se:hover .kebab,
.kebab.open {
  display: inline-flex;
}
.kebab:hover,
.kebab.open { color: var(--ink); background: var(--line2); }

.menu {
  position: absolute;
  right: 10px;
  top: 30px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 4px;
  z-index: 10;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  overflow: hidden;
  min-width: 88px;
}
.menu-item {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 3px);
  color: var(--ink);
  padding: 6px 12px;
}
.menu-item:hover { background: var(--panel2); }
.menu-item.archive { color: var(--err); }
.menu-item.failed { color: var(--err); }

.menu-divider {
  height: 1px;
  background: var(--line);
  margin: 2px 0;
}

.rename-input {
  flex: 1;
  font-family: var(--mono);
  font-size: var(--ui-font-size);
  color: var(--ink);
  background: var(--bg);
  border: 1px solid var(--blue);
  border-radius: 2px;
  padding: 1px 4px;
  outline: none;
  min-width: 0;
}

.archive-confirm {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  font-size: calc(var(--ui-font-size) - 3px);
}
.archive-label {
  color: var(--err);
  /* Match the normal session title (.t) so the confirm text lines up with it
     in size and baseline, not as a smaller note. */
  font-size: var(--ui-font-size);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.btn-confirm {
  background: var(--err);
  color: var(--bg);
  border: none;
  border-radius: 3px;
  padding: 2px 8px;
  cursor: pointer;
  font-family: var(--mono);
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
}
.btn-cancel {
  background: none;
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 2px 8px;
  cursor: pointer;
  font-family: var(--mono);
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
  color: var(--dim);
}
.btn-confirm:hover { opacity: 0.85; }
.btn-cancel:hover { background: var(--panel2); }


</style>
