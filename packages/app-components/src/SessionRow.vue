<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session } from '@moonshot-ai/app-core/client/types';
import { copyTextToClipboard, isDesktop } from '@moonshot-ai/app-core/lib';
import { sessionLink } from '@moonshot-ai/app-composer/model';
import { Badge, Icon, IconButton, Menu, MenuItem, Spinner, StatusDot, Tooltip, useImeComposition } from '@moonshot-ai/app-ui';
import { applySessionEmoji, splitSessionEmoji } from '@moonshot-ai/app-core/lib';
import SessionEmojiPicker from './SessionEmojiPicker.vue';
import WorkspaceIcon from './WorkspaceIcon.vue';
import { track } from '@moonshot-ai/app-client/contracts';
import { configStore, sessionViewsStore } from '@moonshot-ai/app-client/stores';
import { useSessionMentions, useSidebarTabs } from '@moonshot-ai/app-core';
import { sessionDisplayStatus } from '@moonshot-ai/app-core/lib';

const { t } = useI18n();
const { sessionMentions } = useSessionMentions();

const { sidebarTabs } = useSidebarTabs();
const config = computed(() => configStore().config);

const props = withDefaults(
  defineProps<{
    session: Session;
    active: boolean;
    approvalCount?: number;
    questionCount?: number;
    unread?: boolean;
    stateTag?: 'open' | 'done';
    compactPinned?: boolean;
    showPinnedWorkspace?: boolean;
  }>(),
  {
    approvalCount: 0,
    questionCount: 0,
    unread: false,
    stateTag: undefined,
    compactPinned: false,
    showPinnedWorkspace: false,
  },
);

const emit = defineEmits<{
  select: [id: string];
  rename: [id: string, title: string];
  generateTitle: [id: string, done: (title: string | null) => void];
  renameStateChange: [editing: boolean];
  dragstart: [id: string, event: DragEvent];
  archive: [id: string];
  restore: [id: string];
  delete: [id: string];
  fork: [id: string];
  reload: [id: string];
  export: [id: string];
  pin: [id: string];
}>();

const isFlat = computed(() => !props.compactPinned && props.session.cwdLabel !== undefined);
const resolvedPinnedWorkspaceLabel = computed(() => {
  if (!props.compactPinned) return null;
  const label = props.session.workspaceName ?? props.session.cwdLabel;
  return label && label !== '-' ? label : null;
});
const showPinnedSubRow = computed(
  () => props.showPinnedWorkspace && resolvedPinnedWorkspaceLabel.value !== null,
);
const compactWorkspaceTooltip = computed(() => {
  if (!props.compactPinned || props.showPinnedWorkspace || renaming.value) return null;
  return resolvedPinnedWorkspaceLabel.value;
});
const subLabel = computed(() =>
  props.compactPinned
    ? resolvedPinnedWorkspaceLabel.value
    : (props.session.workspaceName ?? props.session.cwdLabel),
);
const showSubRow = computed(() => isFlat.value || showPinnedSubRow.value);
const showSubIcon = computed(() => !props.compactPinned || props.session.hostId !== undefined);
const showCompactPr = computed(
  () => props.compactPinned && !showSubRow.value && !renaming.value && Boolean(props.session.pullRequest),
);
const displayStatus = computed(() =>
  renaming.value
    ? ('idle' as const)
    : sessionDisplayStatus({
        busy: props.session.busy,
        unread: props.unread,
        questionCount: props.questionCount,
        approvalCount: props.approvalCount,
        pendingInteraction: props.session.pendingInteraction,
        lastTurnReason: props.session.lastTurnReason,
      }),
);
const showQuestionBadge = computed(() => displayStatus.value === 'awaiting-question');
const showApprovalBadge = computed(() => displayStatus.value === 'awaiting-approval');
const showAbortedBadge = computed(() => displayStatus.value === 'aborted');
const showBusySpinner = computed(() => displayStatus.value === 'running');
const showUnreadDot = computed(() => displayStatus.value === 'unread');
const hasStatus = computed(() => displayStatus.value !== 'idle');
const hasBadge = computed(
  () => showQuestionBadge.value || showApprovalBadge.value || showAbortedBadge.value,
);

const menuOpen = ref(false);
const menuRef = ref<InstanceType<typeof Menu> | null>(null);
const menuStyle = ref<Record<string, string>>({});

function onDocClick(e: MouseEvent): void {
  const target = e.target as Node;
  if (menuRef.value?.el?.contains(target)) return;
  closeMenu();
}

async function openMenu(): Promise<void> {
  closePicker();
  menuOpen.value = true;
  setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
  window.addEventListener('resize', closeMenu);
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

const emojiSplit = computed(() => splitSessionEmoji(props.session.title));
const displayText = computed(() => {
  const e = emojiSplit.value.emoji;
  return e ? props.session.title.slice(e.length) : props.session.title;
});
const titleRef = ref<HTMLElement | null>(null);
const titleInnerRef = ref<HTMLElement | null>(null);
function onTitleEnter(): void {
  const box = titleRef.value;
  const inner = titleInnerRef.value;
  if (box === null || inner === null) return;
  const over = inner.scrollWidth - box.clientWidth;
  if (over <= 2) {
    box.classList.remove('scrollable');
    return;
  }
  const fade = parseFloat(getComputedStyle(box).getPropertyValue('--sb-fade'));
  const distance = over + (Number.isFinite(fade) ? fade : 0) + 8;
  box.style.setProperty('--sb-scroll-d', `${-distance}px`);
  box.style.setProperty('--sb-scroll-dur', `${Math.round(distance * 25)}ms`);
  box.classList.add('scrollable');
}
const pickerOpen = ref(false);
const pickerVia = ref<'menu' | 'icon'>('menu');
const pickerRef = ref<InstanceType<typeof SessionEmojiPicker> | null>(null);
const pickerStyle = ref<Record<string, string>>({});
let pickerAnchor: HTMLElement | null = null;

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
  setTimeout(() => document.addEventListener('mousedown', onPickerDocClick), 0);
  window.addEventListener('keydown', onPickerKeydown, true);
  window.addEventListener('resize', closePicker);
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
  if (pickerAnchor?.contains(target)) return;
  closePicker();
}

function onPickerKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
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
  pickerVia.value = 'icon';
  const me = e as MouseEvent;
  void openPicker(me.currentTarget as HTMLElement, pointRect(me), 'left', me.clientX || undefined);
}

function openPickerFromMenu(e: Event): void {
  pickerVia.value = 'menu';
  const anchor = menuRef.value?.el;
  const me = e as MouseEvent;
  const rect = pointRect(me) ?? anchor?.getBoundingClientRect();
  closeMenu();
  void openPicker(anchor, rect, 'left', me.clientX || undefined);
}

function applyEmoji(emoji: string | null, method?: 'random'): void {
  closePicker();
  if (emoji === emojiSplit.value.emoji) return;
  const newTitle = applySessionEmoji(props.session.title, emoji);
  if (newTitle && newTitle !== props.session.title) {
    track('session_emoji_changed', {
      action: emoji === null ? 'remove' : method === 'random' ? 'random' : 'set',
      via: pickerVia.value,
    });
    emit('rename', props.session.id, newTitle);
  }
}

const renaming = ref(false);
const renameValue = ref('');
const renameInputRef = ref<HTMLInputElement | null>(null);
const renameWrapRef = ref<HTMLElement | null>(null);
const generatingTitle = ref(false);
let beforeGenTitle = '';
let lastGenFilledTitle: string | null = null;
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
function finishRename(): void {
  if (!renaming.value) return;
  const newTitle = renameValue.value.trim();
  if (newTitle && newTitle !== lastGenFilledTitle && newTitle !== props.session.title) {
    emit('rename', props.session.id, newTitle);
  }
  renaming.value = false;
}
function commitRename(): void {
  if (generatingTitle.value) return;
  finishRename();
}
function onRenameEnter(e: KeyboardEvent): void {
  if (isComposingKeyEvent(e)) return;
  if (generatingTitle.value) return;
  finishRename();
}
function onRenameEscape(e: KeyboardEvent): void {
  if (isComposingKeyEvent(e)) return;
  cancelRename();
}
function cancelRename(): void {
  generatingTitle.value = false;
  renaming.value = false;
}

function onGlobalPointerDown(e: PointerEvent): void {
  const wrap = renameWrapRef.value;
  if (wrap === null || !(e.target instanceof Node) || wrap.contains(e.target)) return;
  if (generatingTitle.value) {
    generatingTitle.value = false;
    renaming.value = false;
    return;
  }
  finishRename();
}
watch(renaming, (editing) => {
  if (editing) document.addEventListener('pointerdown', onGlobalPointerDown, true);
  else document.removeEventListener('pointerdown', onGlobalPointerDown, true);
});
onUnmounted(() => document.removeEventListener('pointerdown', onGlobalPointerDown, true));

function onGenTitle(): void {
  if (generatingTitle.value) return;
  generatingTitle.value = true;
  beforeGenTitle = renameValue.value;
  lastGenFilledTitle = null;
  renameValue.value = '';
  emit('generateTitle', props.session.id, (title) => {
    generatingTitle.value = false;
    if (!renaming.value) return;
    renameValue.value = title ?? beforeGenTitle;
    lastGenFilledTitle = title;
    void nextTick(() => {
      try {
        renameInputRef.value?.focus();
        renameInputRef.value?.select();
      } catch {
        // jsdom may not implement focus/select
      }
    });
  });
}

watch(renaming, (editing) => {
  emit('renameStateChange', editing);
});

async function onRowContextMenu(e: MouseEvent): Promise<void> {
  if (renaming.value) return;
  e.preventDefault();
  e.stopPropagation();
  if (menuOpen.value) closeMenu();
  await openMenu();
  positionMenuAtCursor(e);
}

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

type CopyTarget = 'id' | 'link';
const copied = ref<CopyTarget | null>(null);
const copyFailed = ref<CopyTarget | null>(null);
async function copyFromMenu(target: CopyTarget): Promise<void> {
  const ok = await copyTextToClipboard(target === 'id' ? props.session.id : sessionLink(props.session.id));
  copied.value = ok ? target : null;
  copyFailed.value = ok ? null : target;
  setTimeout(() => {
    copied.value = null;
    copyFailed.value = null;
    closeMenu();
  }, 1500);
}

function copyLabel(target: CopyTarget, idleLabel: string): string {
  if (copyFailed.value === target) return t('sidebar.copyFailed');
  return copied.value === target ? t('sidebar.copied') : idleLabel;
}

function forkRow(): void {
  closeMenu();
  emit('fork', props.session.id);
}

function reloadRow(): void {
  closeMenu();
  emit('reload', props.session.id);
}

function exportRow(): void {
  closeMenu();
  emit('export', props.session.id);
}

function togglePinRow(): void {
  closeMenu();
  emit('pin', props.session.id);
}

function toggleUnreadRow(): void {
  closeMenu();
  if (props.unread) sessionViewsStore().clearUnread(props.session.id);
  else sessionViewsStore().markManualUnread(props.session.id);
}

function startArchive(): void {
  closeMenu();
  emit('archive', props.session.id);
}

function startRestore(): void {
  closeMenu();
  emit('restore', props.session.id);
}

function startDelete(): void {
  closeMenu();
  emit('delete', props.session.id);
}

defineExpose({ closeMenu });

function openPullRequest(): void {
  const url = props.session.pullRequest?.url;
  if (url) window.open(url, '_blank', 'noopener');
}
</script>

<template>
  <div
    class="se"
    :class="{
      on: active,
      flat: isFlat,
      'compact-pinned': compactPinned,
      'has-sub': showSubRow,
      'has-compact-pr': showCompactPr,
      'has-badge': hasBadge,
    }"
    @click="emit('select', session.id)"
    @contextmenu="onRowContextMenu"
    @dragstart="emit('dragstart', session.id, $event)"
    @mouseenter="onTitleEnter"
  >
    <div class="row">
      <Tooltip :text="compactWorkspaceTooltip">
        <div class="row-main">
          <span v-if="!isFlat" class="lead">
            <Icon v-if="compactPinned" class="lead-icon" name="message" />
          </span>

          <div class="left">
            <div
              v-if="renaming"
              ref="renameWrapRef"
              class="rename-wrap"
              :class="{ generating: generatingTitle }"
              @click.stop
            >
              <input
                ref="renameInputRef"
                v-model="renameValue"
                class="rename-input"
                :readonly="generatingTitle"
                @keydown.enter.stop="onRenameEnter"
                @keydown.esc.stop="onRenameEscape"
                @compositionstart="handleCompositionStart"
                @compositionend="handleCompositionEnd"
                @blur="commitRename"
              />
              <span v-if="generatingTitle" class="gen-dots" aria-hidden="true"><i /><i /><i /></span>
              <Tooltip v-if="config?.autoSessionTitle !== false" :text="t('sidebar.genTitle')">
                <IconButton
                  class="gen-title-btn"
                  size="sm"
                  :label="t('sidebar.genTitle')"
                  :disabled="generatingTitle"
                  @mousedown.prevent.stop
                  @click.stop="onGenTitle"
                >
                  <Icon name="gen-title" />
                </IconButton>
              </Tooltip>
            </div>
            <span v-else ref="titleRef" class="t" @dblclick.stop="startRename"><span ref="titleInnerRef" class="t-inner"><button
              v-if="emojiSplit.emoji"
              type="button"
              class="emoji"
              :aria-label="t('sidebar.setEmoji')"
              @click.stop="openPickerFromRow"
              @dblclick.stop
            >{{ emojiSplit.emoji }}</button>{{ displayText }}</span></span>
          </div>
        </div>
      </Tooltip>

      <button
        v-if="showCompactPr && session.pullRequest"
        type="button"
        class="pr compact-pr"
        :class="`pr--${session.pullRequest.state}`"
        :aria-label="`PR #${session.pullRequest.number}`"
        @click.stop="openPullRequest"
      >
        <Icon :name="session.pullRequest.state === 'merged' ? 'git-merge' : 'git-pull-request'" size="sm" />
        <span>#{{ session.pullRequest.number }}</span>
      </button>

      <span v-if="!renaming" class="act">
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
        <span v-if="!hasStatus" class="ts">{{ session.time }}</span>
        <span v-else-if="showBusySpinner || showUnreadDot" class="st">
          <Spinner v-if="showBusySpinner" size="sm" />
          <StatusDot v-else status="unread" data-testid="session-unread" />
        </span>
        <span v-if="!renaming" class="ha">
          <template v-if="stateTag === 'done'">
            <Tooltip :text="t('sidebar.reopen')">
              <IconButton
                class="reopen-btn"
                size="sm"
                :label="t('sidebar.reopen')"
                @click.stop="startRestore"
              >
                <Icon name="undo" />
              </IconButton>
            </Tooltip>
          </template>
          <template v-else>
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
            <Tooltip :text="sidebarTabs ? t('sidebar.complete') : t('sidebar.archive')">
              <IconButton
                :class="sidebarTabs ? 'complete-btn' : 'archive-btn'"
                size="sm"
                :label="sidebarTabs ? t('sidebar.complete') : t('sidebar.archive')"
                @click.stop="startArchive"
              >
                <Icon :name="sidebarTabs ? 'state-done' : 'archive'" />
              </IconButton>
            </Tooltip>
          </template>
        </span>
      </span>
    </div>

    <div v-if="showSubRow" class="sub" :class="{ 'sub--pinned': compactPinned }">
      <WorkspaceIcon v-if="showSubIcon" class="sub-icon" :host-id="session.hostId" size="sm" status="none" />
      <Tooltip v-if="showPinnedSubRow && !renaming" :text="subLabel">
        <span class="sub-text">{{ subLabel }}</span>
      </Tooltip>
      <span v-else class="sub-text">{{ subLabel }}</span>
      <!-- PR association (v2 git domain): a small tag at the second line's
           right edge; click opens the PR (system browser / new tab). Open PRs
           stand out in success green, merged in purple, closed stays neutral. -->
      <button
        v-if="session.pullRequest && !(compactPinned && renaming)"
        type="button"
        class="pr"
        :class="`pr--${session.pullRequest.state}`"
        :aria-label="`PR #${session.pullRequest.number}`"
        @click.stop="openPullRequest"
      >
        <Icon :name="session.pullRequest.state === 'merged' ? 'git-merge' : 'git-pull-request'" size="sm" />
        <span>#{{ session.pullRequest.number }}</span>
      </button>
    </div>

    <!-- Right-click dropdown — teleported to <body> and position:fixed so it
         escapes the `overflow: hidden` on the collapsing `.group-sessions` list. -->
    <Teleport to="body">
      <Transition name="ui-menu-pop">
        <Menu ref="menuRef" v-if="menuOpen" class="menu ui-menu-floating" :style="menuStyle" @click.stop>
        <MenuItem @click="openPickerFromMenu">
          <Icon name="emoji" size="sm" />
          {{ t('sidebar.setEmoji') }}
        </MenuItem>
        <MenuItem @click="toggleUnreadRow">
          <Icon name="mail" size="sm" />
          {{ t(unread ? 'sidebar.markRead' : 'sidebar.markUnread') }}
        </MenuItem>
        <MenuItem @click="forkRow">
          <Icon name="git-fork" size="sm" />
          {{ t('sidebar.fork') }}
        </MenuItem>
        <MenuItem v-if="stateTag !== 'done'" @click="reloadRow">
          <Icon name="refresh" size="sm" />
          {{ t('sidebar.reload') }}
        </MenuItem>
        <MenuItem v-if="stateTag !== 'done'" @click="togglePinRow">
          <Icon :name="session.pinned ? 'unpin' : 'pin'" size="sm" />
          {{ session.pinned ? t('sidebar.unpin') : t('sidebar.pin') }}
        </MenuItem>
        <MenuItem v-if="stateTag === 'done'" @click="startRestore">
          <Icon name="undo" size="sm" />
          {{ t('sidebar.reopen') }}
        </MenuItem>
        <MenuItem v-else @click="startArchive">
          <Icon :name="sidebarTabs ? 'state-done' : 'archive'" size="sm" />
          {{ sidebarTabs ? t('sidebar.markDone') : t('sidebar.archive') }}
        </MenuItem>
        <MenuItem @click="startRename">
          <Icon name="pencil" size="sm" />
          {{ t('sidebar.rename') }}
        </MenuItem>
        <MenuItem separator />
        <MenuItem :danger="copyFailed === 'id'" @click="copyFromMenu('id')">
          <Icon name="copy" size="sm" />
          {{ copyLabel('id', t('sidebar.copySessionId')) }}
        </MenuItem>
        <MenuItem v-if="isDesktop && sessionMentions" :danger="copyFailed === 'link'" @click="copyFromMenu('link')">
          <Icon name="link" size="sm" />
          {{ copyLabel('link', t('sidebar.copySessionLink')) }}
        </MenuItem>
        <MenuItem @click="exportRow">
          <Icon name="download" size="sm" />
          {{ t('sidebar.export') }}
        </MenuItem>
        <MenuItem separator />
        <MenuItem danger @click="startDelete">
          <Icon name="trash" size="sm" />
          {{ t('sidebar.delete') }}
        </MenuItem>
        </Menu>
      </Transition>
    </Teleport>

    <!-- Emoji picker — teleported like the right-click menu so the collapsing
         `.group-sessions` list's `overflow: hidden` can't clip it. -->
    <Teleport to="body">
      <Transition name="ui-menu-pop">
        <SessionEmojiPicker
          v-if="pickerOpen"
          ref="pickerRef"
          class="picker ui-menu-floating"
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
.se.on {
  background: var(--sb-selected, var(--color-selected));
  color: var(--color-text);
}

.row {
  display: flex;
  align-items: center;
  gap: var(--sb-gap, 6px);
  min-width: 0;
}

.row-main {
  display: flex;
  align-items: center;
  gap: var(--sb-gap, 6px);
  flex: 1;
  min-width: 0;
}

.left {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
}

.lead {
  width: var(--sb-gutter, 16px);
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.lead-icon {
  color: var(--color-text-muted);
}
.se.compact-pinned.has-sub {
  padding: var(--space-1-5) var(--se-pad-x);
}
.se.has-compact-pr:hover .act {
  min-width: calc(2 * var(--icon-button-sm) + 2px - (var(--se-pad-x) - var(--sb-action-inset, 3px)));
}
.ha .complete-btn:hover {
  color: var(--color-success);
}

.t {
  --sb-fade: 0px;
  --sb-fade-len: 16px;
  --sb-fade-l: 0px;
  color: inherit;
  font-size: var(--text-sm);
  font-weight: 450;
  line-height: var(--leading-tight);
  user-select: none;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: clip;
  white-space: nowrap;
  -webkit-mask-image: linear-gradient(to right, transparent, var(--color-text-strong) var(--sb-fade-l), var(--color-text-strong) calc(100% - var(--sb-fade) - var(--sb-fade-len)), transparent calc(100% - var(--sb-fade)));
  mask-image: linear-gradient(to right, transparent, var(--color-text-strong) var(--sb-fade-l), var(--color-text-strong) calc(100% - var(--sb-fade) - var(--sb-fade-len)), transparent calc(100% - var(--sb-fade)));
}
.se:hover .t.scrollable {
  --sb-fade-l: 10px;
}
.t-inner {
  display: block;
  width: max-content;
  min-width: 100%;
  transition: transform 160ms linear;
}
.se:hover .t.scrollable .t-inner {
  transform: translateX(var(--sb-scroll-d, 0px));
  transition-duration: var(--sb-scroll-dur, 0ms);
  transition-delay: 300ms;
}
@media (prefers-reduced-motion: reduce) {
  .se:hover .t.scrollable .t-inner {
    transform: none;
    transition-delay: 0s;
  }
}
.se:hover .t {
  --sb-fade: 34px;
  --sb-fade-len: 26px;
}
.se.has-badge:hover .t {
  --sb-fade: 0px;
  --sb-fade-len: 16px;
}

.t .emoji {
  padding: 0;
  background: transparent;
  border: none;
  cursor: pointer;
}
.t .emoji:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }

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
.sub--pinned {
  margin-top: var(--space-05);
  padding-left: calc(var(--sb-gutter, 16px) + var(--sb-gap, 6px));
}
.sub-icon {
  flex: none;
  color: var(--color-text-muted);
}

.pr {
  display: inline-flex;
  align-items: center;
  gap: var(--space-05);
  flex: none;
  padding: 1px var(--space-1);
  border: var(--p-hairline) solid var(--color-line);
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken);
  color: var(--color-text-muted);
  font-family: var(--font-ui);
  font-size: var(--text-2xs);
  font-weight: var(--weight-medium);
  line-height: 1;
  cursor: pointer;
}
.pr:hover {
  border-color: var(--color-line-strong);
}
.pr:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}
.pr--open,
.pr--open:hover {
  background: var(--color-success-soft);
  border-color: var(--color-success-bd);
  color: var(--color-success);
}
.pr--merged,
.pr--merged:hover {
  background: var(--color-done-soft);
  border-color: var(--color-done-bd);
  color: var(--color-done);
}
.sub-text {
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

.act {
  position: relative;
  flex: none;
  align-self: stretch;
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sb-gap, 6px);
  min-width: var(--icon-button-sm);
}
.act .ha {
  position: absolute;
  top: 0;
  bottom: 0;
  right: calc(var(--sb-action-inset, 3px) - var(--se-pad-x));
  display: inline-flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  visibility: hidden;
  border-radius: var(--radius-sm);
  transition:
    opacity var(--duration-fast) var(--ease-out),
    visibility 0s linear var(--duration-fast);
}
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

.act .ui-badge {
  transition: opacity var(--duration-fast) var(--ease-out);
}
.se:hover .act .ui-badge {
  opacity: 0;
  visibility: hidden;
  transition:
    opacity var(--duration-fast) var(--ease-out),
    visibility 0s linear var(--duration-fast);
}

.rename-wrap {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  background: var(--color-bg);
  border: var(--p-hairline) solid var(--color-accent);
  border-radius: var(--radius-xs);
}
.rename-input {
  flex: 1;
  font-family: var(--font-ui);
  font-size: var(--text-sm);
  color: var(--color-text);
  background: transparent;
  border: none;
  padding: 1px 4px;
  outline: none;
  min-width: 0;
}
.rename-wrap.generating .rename-input {
  visibility: hidden;
}
.gen-dots {
  position: absolute;
  left: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  gap: 3px;
  pointer-events: none;
}
.gen-dots i {
  width: 3px;
  height: 3px;
  border-radius: var(--radius-full, 50%);
  background: var(--color-accent);
  animation: gen-title-dot 0.9s var(--ease-out) infinite;
}
.gen-dots i:nth-child(2) {
  animation-delay: 0.15s;
}
.gen-dots i:nth-child(3) {
  animation-delay: 0.3s;
}
@keyframes gen-title-dot {
  0%,
  60%,
  100% {
    opacity: 0.3;
    transform: translateX(0);
  }
  30% {
    opacity: 1;
    transform: translateX(2px);
  }
}
.gen-title-btn {
  flex: none;
  margin-right: 1px;
  color: var(--color-accent);
}
.gen-title-btn:hover:not(:disabled) {
  color: var(--color-accent-hover);
  background: transparent;
}

.sessions .se {
  margin: 0;
  border-radius: var(--radius-sm);
  --se-pad-x: calc(var(--sb-pad-x, 20px) - var(--sb-inset, 12px));
  padding: 8px var(--se-pad-x);
}
.sessions .se.flat + .se.flat {
  margin-top: var(--space-05);
}
.sessions .se .rename-input { border-radius: var(--radius-sm); font-family: var(--font-ui); }
</style>

<style src="./lib/anchored-menu.css"></style>
