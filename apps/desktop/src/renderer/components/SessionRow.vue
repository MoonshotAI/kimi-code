<!-- apps/web/src/components/SessionRow.vue -->
<!-- A single session row: status dot + title + time + attention pill + hover -->
<!-- actions (pin / archive). There is no kebab button — the full menu only -->
<!-- opens on right-click, anchored to the cursor. -->
<!-- Inline rename (dblclick) and the emoji icon affordance (hover wash + -->
<!-- picker, see SessionEmojiPicker) live here. -->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session } from '../types';
import { copyTextToClipboard } from '@moonshot-ai/app-core/lib';
import { Badge, Icon, IconButton, Menu, MenuItem, Spinner, Tooltip, useImeComposition } from '@moonshot-ai/app-ui';
import { applySessionEmoji, splitSessionEmoji } from '@moonshot-ai/app-core/lib';
import SessionEmojiPicker from './SessionEmojiPicker.vue';
import { sessionRowStatus } from './sessionRowStatus';

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
  /** Rename-mode transitions — parents disable row dragging while editing so
      a drag gesture over the input selects text instead of moving the row. */
  renameStateChange: [editing: boolean];
  archive: [id: string];
  fork: [id: string];
  export: [id: string];
  pin: [id: string];
}>();

// Full, absolute timestamp shown on hover (the row's `time` is a short relative
// string like "2h"/"1d" — see formatTime in useKimiWebClient).
function formatFullTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fullTime = computed(() =>
  props.session.updatedAt ? formatFullTime(props.session.updatedAt) : props.session.time,
);

// Flat-style variant, keyed off the facade projecting cwdLabel: used by the
// sidebar's flat list AND always by the pinned section (itself a flat list,
// regardless of view mode); only the grouped workspace rows leave cwdLabel
// undefined. Differences: no leading status slot — the title is left-aligned —
// and the first line's right side shows the session's status (pills, spinner,
// unread dot) INSTEAD of the time. The time only renders when there is
// nothing to report. The flag logic lives in sessionRowStatus.ts.
const isFlat = computed(() => props.session.cwdLabel !== undefined);
const rowStatus = computed(() =>
  sessionRowStatus({
    busy: props.session.busy,
    unread: props.unread,
    renaming: renaming.value,
    questionCount: props.questionCount,
    approvalCount: props.approvalCount,
    pendingInteraction: props.session.pendingInteraction,
    lastTurnReason: props.session.lastTurnReason,
  }),
);
const showQuestionBadge = computed(() => rowStatus.value.showQuestionBadge);
const showApprovalBadge = computed(() => rowStatus.value.showApprovalBadge);
const showAbortedBadge = computed(() => rowStatus.value.showAbortedBadge);
const showBusySpinner = computed(() => rowStatus.value.showBusySpinner);
const flatHasStatus = computed(() => rowStatus.value.hasStatus);

// Right-click menu — the row's only menu (there is no kebab button; the hover
// actions are one-shot pin / archive buttons).
const menuOpen = ref(false);
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
// Fixed-position style for the teleported menu, anchored to the cursor.
const menuStyle = ref<Record<string, string>>({});

function onDocClick(e: MouseEvent): void {
  const target = e.target as Node;
  if (menuRef.value?.el?.contains(target)) return;
  closeMenu();
}

// Open the (teleported) menu and arm dismissal; the caller then anchors it to
// the cursor (positionMenuAtCursor). The menu is rendered through a body
// teleport so ancestor `overflow: hidden` (notably the collapsing
// `.group-sessions` list) can't clip it.
async function openMenu(): Promise<void> {
  closePicker();
  menuOpen.value = true;
  // Defer so the current click doesn't immediately close the menu.
  setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
  window.addEventListener('resize', closeMenu);
  // Wait for the teleported menu to mount so its size can be measured.
  await nextTick();
}
function closeMenu(): void {
  menuOpen.value = false;
  document.removeEventListener('mousedown', onDocClick);
  window.removeEventListener('resize', closeMenu);
}

onUnmounted(() => {
  document.removeEventListener('mousedown', onDocClick);
  document.removeEventListener('mousedown', onPickerDocClick);
  window.removeEventListener('keydown', onPickerKeydown, true);
  window.removeEventListener('resize', closeMenu);
  window.removeEventListener('resize', closePicker);
});

// Emoji picker — picking rewrites the title's leading emoji cluster (app-core
// splitSessionEmoji) through the ordinary rename path.
const emojiSplit = computed(() => splitSessionEmoji(props.session.title));
/** Title text after the emoji button — the stored separator + text, byte-for-byte. */
const displayText = computed(() => {
  const e = emojiSplit.value.emoji;
  return e ? props.session.title.slice(e.length) : props.session.title;
});
const pickerOpen = ref(false);
const pickerRef = ref<InstanceType<typeof SessionEmojiPicker> | null>(null);
const pickerStyle = ref<Record<string, string>>({});
/** Element the picker is anchored to — its own clicks toggle, so outside-click ignores it. */
let pickerAnchor: HTMLElement | null = null;

// Pointer-anchored: transform origin tracks the click even after clamping.
// Keyboard "clicks" (clientX/Y = 0) fall back to the trigger rect's `side` corner.
function positionPicker(r: DOMRect, side: 'left' | 'right', originX?: number): void {
  const panel = pickerRef.value?.el;
  const gap = 4;
  const margin = 8;
  const panelH = panel?.offsetHeight ?? 0;
  const panelW = panel?.offsetWidth ?? 0;
  let top = r.bottom + gap;
  let flipped = false;
  if (top + panelH > window.innerHeight - margin) {
    top = Math.max(margin, r.top - panelH - gap);
    flipped = true;
  }
  const wantLeft = originX ?? (side === 'left' ? r.left : r.right - panelW);
  const left = Math.max(margin, Math.min(wantLeft, window.innerWidth - panelW - margin));
  const originXPart =
    originX === undefined ? side : `${Math.round(Math.min(Math.max(originX - left, 0), panelW))}px`;
  pickerStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    transformOrigin: `${originXPart} ${flipped ? 'bottom' : 'top'}`,
    '--menu-pop-shift': flipped ? '2px' : '-2px',
  };
}

async function openPicker(
  anchor: HTMLElement | undefined,
  rect?: DOMRect,
  side: 'left' | 'right' = 'left',
  originX?: number,
): Promise<void> {
  const r = rect ?? anchor?.getBoundingClientRect();
  if (!r) return;
  if (pickerOpen.value) {
    closePicker();
    return;
  }
  closeMenu();
  pickerAnchor = anchor ?? null;
  pickerOpen.value = true;
  // Defer so the opening click doesn't immediately close the panel.
  setTimeout(() => document.addEventListener('mousedown', onPickerDocClick), 0);
  // Window capture, consumed: the top layer owns Escape — ahead of the side
  // panel (document capture) and the conversation interrupt (document bubble).
  window.addEventListener('keydown', onPickerKeydown, true);
  window.addEventListener('resize', closePicker);
  // Wait for the teleported panel to mount so its size can be measured.
  await nextTick();
  positionPicker(r, side, originX);
}

function closePicker(): void {
  pickerOpen.value = false;
  pickerAnchor = null;
  document.removeEventListener('mousedown', onPickerDocClick);
  window.removeEventListener('keydown', onPickerKeydown, true);
  window.removeEventListener('resize', closePicker);
}

function onPickerDocClick(e: MouseEvent): void {
  const target = e.target as Node;
  if (pickerRef.value?.el?.contains(target)) return;
  // The trigger's own click toggles the picker — leave it for openPicker,
  // otherwise the mousedown closes and the click immediately reopens.
  if (pickerAnchor?.contains(target)) return;
  closePicker();
}

function onPickerKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  // An Escape that only cancels an IME candidate in the search box must not
  // close the picker (the picker's own guard covers Safari's isComposing=false).
  if (pickerRef.value?.isComposingKeyEvent(e)) return;
  e.preventDefault();
  e.stopPropagation();
  closePicker();
}

function pointRect(e: MouseEvent): DOMRect | undefined {
  return e.clientX || e.clientY ? new DOMRect(e.clientX, e.clientY, 0, 0) : undefined;
}

function openPickerFromRow(e: Event): void {
  e.stopPropagation();
  const me = e as MouseEvent;
  void openPicker(me.currentTarget as HTMLElement, pointRect(me), 'left', me.clientX || undefined);
}

function openPickerFromMenu(e: Event): void {
  // The menu only opens at the cursor (right-click): anchor the picker to the
  // click point (or, as a keyboard fallback, the menu's rect captured before
  // closeMenu unmounts it).
  const anchor = menuRef.value?.el;
  const me = e as MouseEvent;
  const rect = pointRect(me) ?? anchor?.getBoundingClientRect();
  closeMenu();
  void openPicker(anchor, rect, 'left', me.clientX || undefined);
}

function applyEmoji(emoji: string | null): void {
  closePicker();
  // Re-picking the current icon is a no-op — even for stored titles whose
  // prefix isn't in the normalized `emoji + space` shape, don't rewrite them.
  if (emoji === emojiSplit.value.emoji) return;
  const newTitle = applySessionEmoji(props.session.title, emoji);
  // Never PATCH an empty title (the title was emoji-only and the emoji is removed).
  if (newTitle && newTitle !== props.session.title) emit('rename', props.session.id, newTitle);
}

// Inline rename
const renaming = ref(false);
const renameValue = ref('');
const renameInputRef = ref<HTMLInputElement | null>(null);
// IME guard: Enter that only confirms a composition candidate must not commit.
const { handleCompositionStart, handleCompositionEnd, isComposingKeyEvent } = useImeComposition();
async function startRename(): Promise<void> {
  closeMenu();
  closePicker();
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
  // Skip no-op renames (Enter/blur with the title untouched, or changed only
  // by surrounding whitespace): the PATCH would still bump the session's
  // updated_at and reshuffle the sidebar ordering.
  if (newTitle && newTitle !== props.session.title) emit('rename', props.session.id, newTitle);
  renaming.value = false;
}
function onRenameEnter(e: KeyboardEvent): void {
  if (isComposingKeyEvent(e)) return;
  commitRename();
}
function onRenameEscape(e: KeyboardEvent): void {
  // An Escape that only dismisses the IME candidate panel must not cancel
  // the rename (same guard as the emoji picker's Escape handling).
  if (isComposingKeyEvent(e)) return;
  cancelRename();
}
function cancelRename(): void {
  renaming.value = false;
}

// Row dragging (pin / reorder) hijacks the drag gesture over the rename
// input — the parents' draggable containers turn off `draggable` for the
// duration so drag-selecting text works while editing.
watch(renaming, (editing) => emit('renameStateChange', editing));

// Right-click opens the same menu anchored to the cursor (the workspace
// row's contextmenu vocabulary) — except over the inline rename input,
// where the native text-editing menu stays.
async function onRowContextMenu(e: MouseEvent): Promise<void> {
  if (renaming.value) return;
  e.preventDefault();
  e.stopPropagation();
  if (menuOpen.value) closeMenu();
  await openMenu();
  positionMenuAtCursor(e);
}

// Cursor anchor (right-click): open at the pointer, flipping up / left when
// the menu would leave the viewport.
function positionMenuAtCursor(e: MouseEvent): void {
  const menu = menuRef.value?.el;
  const margin = 8;
  const menuH = menu?.offsetHeight ?? 0;
  const menuW = menu?.offsetWidth ?? 0;
  let top = e.clientY;
  let flippedY = false;
  if (top + menuH > window.innerHeight - margin) {
    top = Math.max(margin, e.clientY - menuH);
    flippedY = true;
  }
  let left = e.clientX;
  let flippedX = false;
  if (left + menuW > window.innerWidth - margin) {
    left = Math.max(margin, e.clientX - menuW);
    flippedX = true;
  }
  menuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    transformOrigin: `${flippedY ? 'bottom' : 'top'} ${flippedX ? 'right' : 'left'}`,
    '--menu-pop-shift': flippedY ? '2px' : '-2px',
  };
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

// Export this session as a ZIP
function exportRow(): void {
  closeMenu();
  emit('export', props.session.id);
}

// Pin/unpin — moves the session into/out of the pinned sidebar section. The
// state change + persistence live in the client; the row only emits the intent.
function togglePinRow(): void {
  closeMenu();
  emit('pin', props.session.id);
}

// Archive — no confirm; App.vue (archiveSessionWithToast) archives directly
// and shows the undo toast. The row only emits the intent.
function startArchive(): void {
  closeMenu();
  emit('archive', props.session.id);
}

// Expose closeMenu so the parent can close on outside-click.
defineExpose({ closeMenu });

// Flat-style second line: open the session's associated PR in a new tab /
// the system browser (desktop routes window.open externally — the same
// pattern as lib/upgrade.ts).
function openPullRequest(): void {
  const url = props.session.pullRequest?.url;
  if (url) window.open(url, '_blank', 'noopener');
}
</script>

<template>
  <div class="se" :class="{ on: active, flat: isFlat }" @click="emit('select', session.id)" @contextmenu="onRowContextMenu">
    <div class="row">
      <!-- Leading status slot (in the gutter left of the title): a spinner
           while the session runs, otherwise an unread blue dot. Fixed width
           so the title start never shifts. Grouped rows only — the flat-style
           rows (flat list, pinned section) drop the slot (left-aligned) and
           move status right. -->
      <span v-if="!isFlat" class="lead" aria-hidden="true">
        <Spinner v-if="session.busy" size="sm" />
        <span v-else-if="unread" class="unread-dot" />
      </span>

      <div class="left">
        <!-- Inline rename input -->
        <input
          v-if="renaming"
          ref="renameInputRef"
          v-model="renameValue"
          class="rename-input"
          @click.stop
          @keydown.enter.stop="onRenameEnter"
          @keydown.esc.stop="onRenameEscape"
          @compositionstart="handleCompositionStart"
          @compositionend="handleCompositionEnd"
          @blur="commitRename"
        />
        <span v-else class="t" @dblclick.stop="startRename"><button
          v-if="emojiSplit.emoji"
          type="button"
          class="emoji"
          :aria-label="t('sidebar.setEmoji')"
          @click.stop="openPickerFromRow"
          @dblclick.stop
        >{{ emojiSplit.emoji }}</button>{{ displayText }}</span>
      </div>

      <!-- Trailing action slot: the status cluster (pills + flat-mode
           indicator) or the relative time sits in flow and sets the slot
           width; the hover actions (pin + archive) are absolutely positioned
           over it and swapped via a cross-fade (opacity + visibility, never
           display:none), so the slot width is identical in hover and rest and
           nothing reflows — see design-system §07 "Session row".
           Pending tags: "Answer" = an askUserQuestion is waiting; "Approve" =
           a permission request is waiting; "Aborted" = quiet session whose
           last main turn died on an error (a manually stopped turn is the
           user's own doing and never raises the tag; hidden while input is
           pending). The list-level interaction fact is the fallback for
           sessions whose detailed pending lists aren't loaded. Flat mode: the
           pills anchor to the row's right edge and the hover actions fade IN
           as the pills fade OUT — the two never co-exist (grouped rows keep
           pills visible on hover, status there lives in the lead slot). -->
      <span class="act">
        <Tooltip :text="t('workspace.awaitingAnswerTitle')">
          <Badge
            v-if="showQuestionBadge"
            variant="info"
            size="sm"
          >
            {{ t('workspace.awaitingAnswer') }}
          </Badge>
        </Tooltip>
        <Tooltip :text="t('workspace.awaitingPermissionTitle')">
          <Badge
            v-if="showApprovalBadge"
            variant="warning"
            size="sm"
          >
            {{ t('workspace.awaitingPermission') }}
          </Badge>
        </Tooltip>
        <Tooltip :text="t('workspace.abortedTitle')">
          <Badge
            v-if="showAbortedBadge"
            variant="danger"
            size="sm"
          >
            {{ t('workspace.aborted') }}
          </Badge>
        </Tooltip>
        <!-- Flat-style rows (flat list, pinned section): status replaces the
             time on the right of the first line (the time only renders when
             nothing is reported). Grouped rows always show the time. The
             spinner yields to attention pills (showBusySpinner): a session
             waiting for approval/answer never shows both. -->
        <span v-if="!isFlat || !flatHasStatus" class="ts">{{ session.time }}</span>
        <span v-else-if="showBusySpinner || unread" class="st">
          <Spinner v-if="showBusySpinner" size="sm" />
          <span v-else class="unread-dot" />
        </span>
        <span v-if="!renaming" class="ha">
          <Tooltip :text="session.pinned ? t('sidebar.unpin') : t('sidebar.pin')">
            <IconButton
              class="pin-btn"
              size="sm"
              :label="session.pinned ? t('sidebar.unpin') : t('sidebar.pin')"
              @click.stop="togglePinRow"
            >
              <Icon :name="session.pinned ? 'unpin' : 'pin'" />
            </IconButton>
          </Tooltip>
          <Tooltip :text="t('sidebar.archive')">
            <IconButton
              class="archive-btn"
              size="sm"
              :label="t('sidebar.archive')"
              @click.stop="startArchive"
            >
              <Icon name="archive" />
            </IconButton>
          </Tooltip>
        </span>
      </span>
    </div>

    <!-- Flat-style second line (rendered only when the facade projects cwdLabel
         — the flat list and, always, the pinned section): folder icon + the
         session's working directory name. Grouped rows never set cwdLabel and
         stay single-line. The closed-folder glyph + one-rung-stronger muted
         color keep the icon legible at 14px (the open-folder's thin back-flap
         washed out — same recipe as .gh-folder). -->
    <div v-if="session.cwdLabel !== undefined" class="sub">
      <Icon class="sub-icon" name="folder-closed" size="sm" />
      <span class="sub-text">{{ session.cwdLabel }}</span>
      <!-- PR association (v2 git domain): a quiet chip at the second line's
           right edge; click opens the PR (system browser / new tab). Open PRs
           stand out in success green, merged/closed stay faint. -->
      <button
        v-if="session.pullRequest"
        type="button"
        class="pr"
        :class="`pr--${session.pullRequest.state}`"
        :aria-label="`PR #${session.pullRequest.number}`"
        @click.stop="openPullRequest"
      >
        <Icon name="git-pull-request" size="sm" />
        <span>#{{ session.pullRequest.number }}</span>
      </button>
    </div>

    <!-- Right-click dropdown — teleported to <body> and position:fixed so it
         escapes the `overflow: hidden` on the collapsing `.group-sessions` list. -->
    <Teleport to="body">
      <Transition name="menu-pop">
        <Menu ref="menuRef" v-if="menuOpen" class="menu" :style="menuStyle" @click.stop>
        <MenuItem :danger="copyFailed" @click="copySessionId">
          <Icon name="copy" size="sm" />
          {{
            copyFailed
              ? t('sidebar.copyFailed')
              : copiedId
                ? t('sidebar.copied')
                : t('sidebar.copySessionId')
          }}
        </MenuItem>
        <MenuItem separator />
        <MenuItem @click="startRename">
          <Icon name="pencil" size="sm" />
          {{ t('sidebar.rename') }}
        </MenuItem>
        <MenuItem @click="openPickerFromMenu">
          <Icon name="emoji" size="sm" />
          {{ t('sidebar.setEmoji') }}
        </MenuItem>
        <MenuItem @click="forkRow">
          <Icon name="git-fork" size="sm" />
          {{ t('sidebar.fork') }}
        </MenuItem>
        <MenuItem @click="exportRow">
          <Icon name="download" size="sm" />
          {{ t('sidebar.export') }}
        </MenuItem>
        <MenuItem @click="togglePinRow">
          <Icon :name="session.pinned ? 'unpin' : 'pin'" size="sm" />
          {{ session.pinned ? t('sidebar.unpin') : t('sidebar.pin') }}
        </MenuItem>
        <MenuItem @click="startArchive">
          <Icon name="archive" size="sm" />
          {{ t('sidebar.archive') }}
        </MenuItem>
        <MenuItem separator />
        <div class="menu-time">{{ fullTime }}</div>
        </Menu>
      </Transition>
    </Teleport>

    <!-- Emoji picker — teleported like the right-click menu so the collapsing
         `.group-sessions` list's `overflow: hidden` can't clip it. -->
    <Teleport to="body">
      <Transition name="menu-pop">
        <SessionEmojiPicker
          v-if="pickerOpen"
          ref="pickerRef"
          class="picker"
          :style="pickerStyle"
          :current="emojiSplit.emoji"
          :removable="emojiSplit.rest.length > 0"
          @click.stop
          @pick="applyEmoji"
        />
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.se {
  /* --sb-* vars come from .side in Sidebar.vue: the title starts at
     --sb-pad-x + --sb-gutter + --sb-gap, exactly under the workspace name.
     The row is an inset pill: the .sessions container's --sb-inset padding +
     the row's own padding land the leading slot at --sb-pad-x, aligned with
     the workspace header. --se-pad-x is the row's right padding as a var so
     the hover cluster can anchor to it instead of a magic offset. */
  --se-pad-x: var(--space-2);
  display: block;
  margin: 0;
  padding: 8px var(--se-pad-x);
  border-radius: var(--radius-sm);
  font-family: var(--font-ui);
  color: var(--color-text);
  cursor: pointer;
  position: relative;
}
.se:hover { background: var(--sb-hover, var(--color-hover)); color: var(--color-text); }
/* Selected: neutral fill (NOT accent-tinted — selection reads as "where I
   am", the accent stays reserved for actions and status). */
.se.on {
  background: var(--sb-selected, var(--color-selected));
  color: var(--color-text);
}

.row {
  display: flex;
  align-items: center;
  gap: var(--sb-gap, 6px);
  min-width: 0;
  /* Row height is font-driven: title line-height (13×1.25≈16px) + 2×5px
     .se padding ≈ 26px. The hover actions are absolutely positioned (see .act)
     so they never contribute to row height and can't cause hover jitter. */
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
.unread-dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--color-accent);
}

/* The title dissolves (mask-image fade) before it reaches the hover cluster —
   no opaque plate behind the buttons. Zone-based: a 16px tail fade at rest
   (text-overflow: clip), widening to a 34px transparent plateau on hover
   (design-system §07 "Session row"). */
.t {
  --sb-fade: 0px;
  --sb-fade-len: 16px;
  color: inherit;
  font-size: var(--ui-font-size-sm);
  font-weight: 450;
  line-height: var(--leading-tight);
  user-select: none;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: clip;
  white-space: nowrap;
  -webkit-mask-image: linear-gradient(to right, var(--color-text-strong) calc(100% - var(--sb-fade) - var(--sb-fade-len)), transparent calc(100% - var(--sb-fade)));
  mask-image: linear-gradient(to right, var(--color-text-strong) calc(100% - var(--sb-fade) - var(--sb-fade-len)), transparent calc(100% - var(--sb-fade)));
}
.se:hover .t {
  --sb-fade: 34px;
  --sb-fade-len: 26px;
}
/* With a badge the title tail never reaches the hover cluster — keep the rest-state fade. */
.se:has(.ui-badge):hover .t {
  --sb-fade: 0px;
  --sb-fade-len: 16px;
}

/* Leading emoji (the session icon): an ordinary title character — no
   decoration at rest or on hover. It stays a <button> for a11y; the
   right-click menu's "Set Emoji…" is the discoverable path. */
.t .emoji {
  padding: 0;
  background: transparent;
  border: none;
  cursor: pointer;
}
.t .emoji:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }

/* Flat-mode second line: folder icon + the final directory name, left-aligned
   with the title (flat rows have no leading status slot, so both lines start
   at the row's content edge). Same xs/faint vocabulary as the time; the tail
   mask fade matches the title's rest-state fade (this line never competes
   with the hover cluster, so the fade stays at rest width). Row height stays
   font-driven — the pill just grows a second line. */
.sub {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: var(--space-1) 0 0;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  user-select: none;
}
.sub-icon {
  flex: none;
  color: var(--color-text-muted);
}

/* PR chip at the second line's right edge. State colors follow GitHub: open =
   success green, merged = --color-done purple, closed = quiet faint. */
.pr {
  display: inline-flex;
  align-items: center;
  gap: var(--space-05);
  flex: none;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  line-height: var(--leading-tight);
  cursor: pointer;
}
.pr:hover {
  color: var(--color-text-muted);
}
.pr:focus-visible {
  outline: none;
  border-radius: var(--radius-xs);
  box-shadow: var(--p-focus-ring);
}
.pr--open,
.pr--open:hover {
  color: var(--color-success);
}
.pr--merged,
.pr--merged:hover {
  color: var(--color-done);
}
.sub-text {
  /* flex:1 like the title's .t: the span fills the line, so the 16px tail
     mask only fades text that actually reaches the edge — short directory
     names render in full. */
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: clip;
  -webkit-mask-image: linear-gradient(to right, var(--color-text-strong) calc(100% - 16px), transparent);
  mask-image: linear-gradient(to right, var(--color-text-strong) calc(100% - 16px), transparent);
}

.ts {
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  font-family: var(--font-ui);
  font-weight: 475;
  line-height: var(--leading-tight);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

/* Trailing action slot: the rest-state content (the time, or the flat mode's
   status cluster — pills + spinner/dot) sits in flow and sets the slot width;
   the hover actions (pin + archive) are absolutely positioned over it and
   swapped via a cross-fade, so they contribute neither height (the row stays
   font-driven) nor width changes (min-width reserves a button footprint, the
   title doesn't reflow). The slot stretches to the full row height so the
   cluster centers against the row box itself — not against the time text's
   line box, whose metrics would otherwise dictate the icon's vertical
   position. */
.act {
  position: relative;
  flex: none;
  align-self: stretch;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sb-gap, 6px);
  /* Reserve one button's width so the trailing slot (and thus the title) never
     shifts between the time and the actions, even for short times like "2m". */
  min-width: 26px;
}
/* The cluster spans the slot's full (row) height and flex-centers the buttons,
   so the icons' vertical center IS the row's geometric center, decoupled from
   any text metrics. Anchored to the row's right padding token minus a 3px
   inset — the same inset as the buttons' vertical one ((32px row − 26px
   button) / 2) — so the cluster sits equidistant from the pill's right edge
   and its top/bottom edges. */
.act .ha {
  position: absolute;
  top: 0;
  bottom: 0;
  right: calc(3px - var(--se-pad-x));
  display: inline-flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  visibility: hidden;
  border-radius: var(--radius-sm);
  /* Hide path: fade out first, then flip visibility so the hidden cluster
     stays inert; the show path overrides with an immediate visibility. */
  transition:
    opacity var(--duration-fast) var(--ease-out),
    visibility 0s linear var(--duration-fast);
}
/* The title dissolves (mask fade on .t) before it reaches the cluster, so the
   cluster paints nothing — no plate, no wash — and the hover/selected washes
   never have to be re-composited into a fake solid. */
.se:hover .ha {
  opacity: 1;
  visibility: visible;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.act .ts {
  transition: opacity var(--duration-fast) var(--ease-out);
}
.se:hover .act .ts {
  opacity: 0;
  visibility: hidden;
  transition:
    opacity var(--duration-fast) var(--ease-out),
    visibility 0s linear var(--duration-fast);
}

/* Flat mode's right-side status indicator (spinner / unread dot) shares the
   trailing slot with the time and cross-fades out on hover the same way. */
.act .st {
  display: inline-flex;
  align-items: center;
  transition: opacity var(--duration-fast) var(--ease-out);
}
.se:hover .act .st {
  opacity: 0;
  visibility: hidden;
  transition:
    opacity var(--duration-fast) var(--ease-out),
    visibility 0s linear var(--duration-fast);
}

/* The pending pills ride the same cross-fade, flat rows only: hover swaps the
   whole status cluster for the actions, so pills and pin/archive never
   co-exist. Grouped rows keep the pills visible on hover. */
.act .ui-badge {
  transition: opacity var(--duration-fast) var(--ease-out);
}
.se.flat:hover .act .ui-badge {
  opacity: 0;
  visibility: hidden;
  transition:
    opacity var(--duration-fast) var(--ease-out),
    visibility 0s linear var(--duration-fast);
}

/* Fixed + anchored to the cursor via inline style (see positionMenuAtCursor);
   the menu is teleported to <body> so the collapsing list's `overflow: hidden`
   can't clip it. */
.menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
}
/* The emoji picker shares the menu's fixed + teleported placement (anchored by
   positionPicker, either to the right-click point or to the title's emoji). */
.picker {
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--z-dropdown);
}
/* Menu enter/exit — pops out of the trigger corner (the composer model
   dropdown's language): fade + a slight scale, exit a touch faster. The
   origin and the nudge direction come from the positioning code. */
.menu-pop-enter-active {
  transition:
    opacity var(--duration-base) var(--ease-out),
    transform var(--duration-base) var(--ease-out);
}
.menu-pop-leave-active {
  transition:
    opacity var(--duration-fast) var(--ease-out),
    transform var(--duration-fast) var(--ease-out);
  /* The leaving menu lingers for --duration-fast; keep it inert so a second
     click can't hit items whose backing state is already torn down. */
  pointer-events: none;
}
.menu-pop-enter-from,
.menu-pop-leave-to {
  opacity: 0;
  transform: scale(0.97) translateY(var(--menu-pop-shift, -2px));
}
.menu-time {
  padding: 6px 10px;
  color: var(--color-text-faint);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  cursor: default;
  user-select: text;
}

.rename-input {
  flex: 1;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-text);
  background: var(--color-bg);
  border: 0.5px solid var(--color-accent);
  border-radius: var(--radius-xs);
  padding: 1px 4px;
  outline: none;
  min-width: 0;
}

.sessions .se {
  margin: 0;
  border-radius: var(--radius-sm);
  /* Trim the row padding by the container inset so the title still starts at
     the same x as the workspace name (whose header has no inset). The hover
     cluster's right anchoring follows the same var. */
  --se-pad-x: calc(var(--sb-pad-x, 20px) - var(--sb-inset, 12px));
  padding: 8px var(--se-pad-x);
}
/* Flat rows are two-line pills — a hair of air between them keeps the list
   from reading as one dense block (grouped rows stay flush). */
.sessions .se.flat + .se.flat {
  margin-top: var(--space-05);
}
.sessions .se .rename-input { border-radius: var(--radius-sm); font-family: var(--sans); }
</style>
