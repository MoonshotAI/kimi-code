<!-- apps/web/src/components/PinnedSessionList.vue -->
<!-- The pinned section above all workspace groups: every pinned session across
     workspaces, in pure recency order (updatedAt desc — no manual ordering,
     no attention tiering; the facade owns the order). Rows are the shared
     SessionRow (always the flat-style variant — this section is itself a flat
     list). Drag vocabulary: drag a session row IN to pin it (drop anywhere in
     the section — position carries no ordering meaning), drag a pinned row
     OUT to its home workspace group / the flat list to unpin (that half lives
     in Sidebar/WorkspaceGroup). State and persistence live in the client —
     this component renders the list and forwards every intent back up. -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session } from '../types';
import type { SessionListRowMeasure } from '@moonshot-ai/app-core/lib';
import { SESSION_ROW_DRAG_MIME } from '@moonshot-ai/app-core/lib';
import {
  loadPinnedCollapsed,
  isNoopGesture,
  measureSessionsListRows,
  pinnedRowsDefaultHeight,
  pinnedRowsKeyboardTarget,
  pinnedRowsMaxHeight,
  pinnedRowsMinHeight,
  pinnedRowsResizeCeiling,
  pinnedSectionResizable,
  safeGetString,
  savePinnedCollapsed,
  sessionsListMinHeight,
  STORAGE_KEYS,
} from '@moonshot-ai/app-core/lib';
import { useAppearance } from '@moonshot-ai/app-core';
import { useResizable } from '@moonshot-ai/app-client/composables';
import SessionRow from './SessionRow.vue';
import { Icon, IconButton } from '@moonshot-ai/app-ui';

const { t } = useI18n();

const props = defineProps<{
  sessions: Session[];
  activeId: string;
  pendingBySession: Record<string, { approvals: number; questions: number }>;
  unreadBySession: Record<string, boolean>;
  /** Status view passes 'open' so pinned rows carry the same state tag as the
   *  open tab; the flat/grouped views leave it unset (no tag). */
  stateTag?: 'open' | 'done';
  /** Session being locate-flashed by the search dialog (null when idle) — the
   *  matching row pulses an accent wash so the eye lands on it. */
  flashSessionId?: string | null;
}>();

const emit = defineEmits<{
  selectSession: [sessionId: string];
  renameSession: [id: string, title: string];
  /** Gen Title (✨ in the rename input): force-regenerate via the daemon. */
  generateSessionTitle: [id: string, done: (title: string | null) => void];
  archiveSession: [id: string];
  forkSession: [id: string];
  exportSession: [id: string];
  pinSession: [id: string];
  /** A session row was dropped into the section (pin it). */
  dropPin: [id: string];
  /** A pinned row started/ended being dragged. Sidebar broadcasts the drag to
   *  the workspace groups so only the session's home workspace accepts the
   *  drop-back (unpin). */
  sessionDragStart: [id: string, workspaceId: string];
  sessionDragEnd: [];
}>();

// Section collapse: the pinned block is pinned above the scrolling workspace
// list, so a long pinned set would eat the sidebar — the user can fold it
// away. Persisted (UI-only state, like the workspace fold in Sidebar).
const collapsed = ref(loadPinnedCollapsed());

function toggleCollapsed(): void {
  collapsed.value = !collapsed.value;
  savePinnedCollapsed(collapsed.value);
}

// Feedback for a new pin: Sidebar calls this from its pin / drop-pin handlers
// so the new row shows up where the user can see it. Deliberately NOT a
// sessions-length watcher: first load fetches only each workspace's first
// page and the missing pinned rows arrive in a later backfill, and that
// growth must not clear a persisted fold.
function expand(): void {
  if (!collapsed.value) return;
  collapsed.value = false;
  savePinnedCollapsed(false);
}
defineExpose({ expand });

// Height split between the pinned rows and the session list below. While the
// pinned content fits in a few rows the section keeps its natural height and
// no handle renders (the CSS 40vh cap governs); past the threshold
// (pinnedSectionResizable, lib/pinnedSectionLayout) a drag handle appears
// under the rows and the rows container is capped by the draggable height,
// persisted per device like the sidebar width. The list below simply takes
// the space that remains (Sidebar's .sessions is flex:1).
const resizable = computed(() => !collapsed.value && pinnedSectionResizable(props.sessions.length));

// The drag cap tracks the viewport: a one-time innerHeight read would go stale
// on window resize (same reactive-window pattern as the terminal panel height
// in App.vue).
const viewportHeight = ref(window.innerHeight);

function onWindowResize(): void {
  viewportHeight.value = window.innerHeight;
}

onMounted(() => window.addEventListener('resize', onWindowResize));
onBeforeUnmount(() => window.removeEventListener('resize', onWindowResize));

const pinnedRootEl = ref<HTMLElement | null>(null);
const pinnedRowsEl = ref<HTMLElement | null>(null);

// The session-list scroller (Sidebar's .sessions): the pinned root's parent
// is the fixed .sessions-head, whose next sibling is the list.
function sessionsListEl(): HTMLElement | null {
  return (pinnedRootEl.value?.parentElement?.nextElementSibling as HTMLElement | null) ?? null;
}

// Budget (px) shared by the pinned rows and the session list — the sum of the
// two rendered heights, which is invariant to the split: growing the rows cap
// shrinks the list by exactly that amount. The drag cap subtracts the list's
// minimum keep from it (pinnedRowsMaxHeight), so a short window's fixed
// sidebar chrome can never let the rows squeeze the list away. Undefined
// until measured / while the rows are unmounted (section folded); the plain
// viewport cap governs then.
const splitBudget = ref<number | undefined>(undefined);

function measureSplitBudget(): void {
  const rows = pinnedRowsEl.value;
  const sessions = sessionsListEl();
  if (!rows || !sessions) {
    splitBudget.value = undefined;
    return;
  }
  splitBudget.value = rows.getBoundingClientRect().height + sessions.getBoundingClientRect().height;
}

// Rendered metrics of the SESSION list: the first VISIBLE .se row's height,
// the vertical span to the THIRD visible row's bottom edge, and the
// container's bottom padding. They feed the list's minimum keep
// (sessionsListMinHeight) — the span tier naturally includes grouped mode's
// workspace headers, which a bare row height × 3 would miss. Keeps the last
// good row measurement when the list renders no rows (empty states).
const sessionRowHeight = ref<number | null>(null);
const sessionsRowSpan = ref<number | null>(null);
const sessionsPaddingY = ref<number | null>(null);

function measureSessionList(): void {
  const sessions = sessionsListEl();
  if (!sessions) return;
  // Collapsed groups keep their rows MOUNTED (height:0 + overflow:hidden for
  // the fold transition), so DOM presence ≠ visible — flag those rows and let
  // measureSessionsListRows skip them when picking the first/third row. Rects
  // are read only for visible rows, and only up to the third one — no per-row
  // getBoundingClientRect loop.
  const rows = sessions.querySelectorAll('.se');
  const measures: SessionListRowMeasure[] = [];
  let visibleCount = 0;
  for (let i = 0; i < rows.length && visibleCount < 3; i++) {
    const row = rows.item(i) as HTMLElement;
    if (row.closest('.group-sessions.collapsed') !== null) {
      measures.push({ visible: false, height: 0, viewportBottom: 0 });
      continue;
    }
    visibleCount += 1;
    const rect = row.getBoundingClientRect();
    measures.push({ visible: true, height: rect.height, viewportBottom: rect.bottom });
  }
  // The list's top padding is 0, so the border-box top IS the content top;
  // the span is measured in content coordinates (the scroll offset would
  // otherwise shrink it by scrollTop).
  const measured = measureSessionsListRows(measures, sessions.getBoundingClientRect().top, sessions.scrollTop);
  if (measured.firstRowHeight !== null) sessionRowHeight.value = measured.firstRowHeight;
  sessionsRowSpan.value = measured.spanToThirdRow;
  // Read the live padding instead of assuming --space-3, so a spacing-scale
  // retune can't fork the keep from the stylesheet.
  const pad = Number.parseFloat(globalThis.getComputedStyle(sessions).paddingBottom);
  sessionsPaddingY.value = Number.isFinite(pad) ? pad : null;
}

// Any chrome change above the list (window resize, status tabs, font scale)
// shifts the list's box — observing it keeps the budget current. Split drags
// fire it too, but the sum is invariant there, so the cap stays stable. The
// display switch (grouped ↔ flat) REPLACES the rows (single-line ↔ two-line)
// without moving that box, so a childList+subtree MutationObserver covers
// what the ResizeObserver can't — subtree because grouped rows live inside
// each WorkspaceGroup's wrapper, and a group's first session inserts deep;
// class watching because a workspace fold toggles .group-sessions.collapsed
// in place, adding and removing no node. The callback only re-measures the
// list (a few row rects and one padding), so the per-mutation cost stays
// trivial.
let budgetObserver: ResizeObserver | null = null;
let sessionsMutationObserver: MutationObserver | null = null;

// A workspace fold animates .group-sessions' height (WorkspaceGroup's fold
// transition): the class-flip mutation fires at the animation's START while
// the groups below are still sliding, and nothing fires at its end — the
// span would keep the start-of-animation positions. Re-measure once when the
// height transition settles (never per frame; transitionend bubbles, so one
// delegated listener on the scroller covers every group).
function onSessionsTransitionEnd(event: TransitionEvent): void {
  if (event.propertyName !== 'height') return;
  if (!(event.target as HTMLElement).classList.contains('group-sessions')) return;
  measureSessionList();
}

onMounted(() => {
  void nextTick(() => {
    measureSplitBudget();
    measureSessionList();
    const sessions = sessionsListEl();
    if (typeof ResizeObserver === 'function' && sessions) {
      budgetObserver = new ResizeObserver(measureSplitBudget);
      budgetObserver.observe(sessions);
    }
    if (typeof MutationObserver === 'function' && sessions) {
      sessionsMutationObserver = new MutationObserver(measureSessionList);
      sessionsMutationObserver.observe(sessions, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
    }
    sessions?.addEventListener('transitionend', onSessionsTransitionEnd);
  });
});
onBeforeUnmount(() => {
  budgetObserver?.disconnect();
  sessionsMutationObserver?.disconnect();
  sessionsListEl()?.removeEventListener('transitionend', onSessionsTransitionEnd);
});

// The cap is written imperatively, never via a bound style: Vue rewrites every
// bound style key on each patch, so an unrelated mid-drag re-render would
// clobber the live drag value with the stale pre-drag one (the same rule as
// --preview-w / --terminal-h in App.vue). During a drag useResizable's
// applyLive writes each frame straight to the DOM; the committed height
// re-applies once on pointerup via the watch below.
//
// liveRowsHeight tracks the per-frame drag value (null off-gesture): on the
// applyLive path the committed rowsHeight only updates on pointerup, so the
// handle's aria-valuenow reads the live value to follow the drag.
const liveRowsHeight = ref<number | null>(null);

function applyRowsHeightLive(height: number): void {
  liveRowsHeight.value = height;
  // A frame past the gesture's start point = a real adjustment: freeze the
  // cap as user-chosen so the end-of-drag commit actually persists.
  if (gestureStartHeight !== null && height !== gestureStartHeight) {
    userAdjusted.value = true;
  }
  pinnedRowsEl.value?.style.setProperty('max-height', `${height}px`);
}

// Natural height (px) of the rows content, maintained by
// updateRowsScrollState below (null before measurement / while folded). A
// resize gesture never targets positions past it — see the max getter.
const contentHeight = ref<number | null>(null);
// Rendered heights (px) of the first TWO pinned rows, same maintenance. The
// drag floor sums the real boxes (pinnedRowsMinHeight): the second row can
// be taller (approval/question badges, a PR pill), and rows track the font
// scale — a fixed default-scale px would do neither.
const firstRowHeights = ref<(number | null)[]>([]);
// True while a pointer gesture runs (set/cleared by the handle's pointerdown
// and the gesture-end watch). Deliberately NOT reactive: the max getter only
// reads it mid-gesture, where no watcher needs to re-fire on the flip.
let gestureActive = false;

// Has the user EXPLICITLY chosen a cap? True from the start when a persisted
// preference exists; flips true mid-gesture on the first frame with real
// displacement and on a real keyboard step — never on a plain click, a
// net-zero gesture, or an automatic bounds clamp. While false the cap keeps
// following the viewport's 40vh default (see the viewportHeight watch) and
// the persist gate below holds back every storage write, so an unchosen
// value can neither freeze nor leak into the next session.
const userAdjusted = ref(safeGetString(STORAGE_KEYS.sidebarPinnedHeight) !== null);

// The two bounds every resize path shares: the floor (two full rows at the
// current font scale) and the layout cap (viewport/budget). Both bounds
// computations take the floor as a parameter so min ≤ max always holds — a
// short window at a large font scale must never invert them. The list's keep
// is likewise measured (three session rows at the current scale/mode plus
// the list's bottom padding).
const rowsMinHeight = computed(() => pinnedRowsMinHeight(firstRowHeights.value));
const sessionsKeep = computed(() =>
  sessionsListMinHeight(sessionsRowSpan.value, sessionsPaddingY.value, sessionRowHeight.value),
);
const layoutCap = computed(() =>
  pinnedRowsMaxHeight(viewportHeight.value, splitBudget.value, rowsMinHeight.value, sessionsKeep.value),
);

const {
  width: rowsHeight,
  dragging: resizeDragging,
  cursor: resizeCursor,
  clamp: clampRowsHeight,
  setWidth: setRowsHeight,
  onPointerDown: onResizePointerDown,
} = useResizable({
  storageKey: STORAGE_KEYS.sidebarPinnedHeight,
  defaultWidth: pinnedRowsDefaultHeight(window.innerHeight),
  // A getter so the floor tracks font-scale changes after the handle mounts.
  min: () => rowsMinHeight.value,
  // Getters so the cap keeps tracking window resizes and sidebar chrome
  // changes after the handle mounts. While a gesture runs the ceiling also
  // narrows to the content's natural height: positions past it render
  // nothing (the rows box is max-height-capped), so the separator, the
  // persisted cap and aria-valuenow would diverge from what is on screen.
  // Off-gesture the plain layout cap governs — the committed value must
  // never be auto-pulled-down just because the content shrank.
  max: () => {
    if (!gestureActive) return layoutCap.value;
    return pinnedRowsResizeCeiling(layoutCap.value, contentHeight.value, rowsMinHeight.value);
  },
  axis: 'y',
  applyLive: applyRowsHeightLive,
  // Hold back every write while the cap is still the untouched default.
  persist: () => userAdjusted.value,
});

// Unadjusted only: the cap tracks the viewport's 40vh default in BOTH
// directions (a taller window grows the section again), session-only. The
// composable's own bound watchers keep governing the adjusted state.
// layoutCap is a trigger too: on a viewport/chrome change this watch can run
// BEFORE the ResizeObserver refreshes splitBudget, and the fresh default
// would clamp against the stale cap — re-applying when the cap settles lets
// the default catch up (same for a font-scale shrink).
watch([viewportHeight, layoutCap], () => {
  if (userAdjusted.value) return;
  rowsHeight.value = clampRowsHeight(pinnedRowsDefaultHeight(viewportHeight.value));
});

// A drag starts from the rows' RENDERED height, not the stored/default cap:
// right after the handle appears, the content can be shorter than the resting
// 40vh cap, and dragging from the stale cap would first cross an invisible
// dead zone and then jump. The re-anchor is only the gesture's START basis:
// gestureCommittedHeight remembers the pre-gesture cap so a plain click
// (no effective displacement) can restore it — useResizable skips its
// end-of-drag commit then, so a click moves neither the session cap nor the
// persisted one.
let gestureCommittedHeight: number | null = null;
let gestureStartHeight: number | null = null;
// Pre-gesture in-memory adjustment flag, restored by the zero-displacement
// branch below instead of re-deriving it from storage: with storage
// unwritable (private mode / quota) a real adjustment lives ONLY in memory,
// and re-reading storage would silently drop it.
let gestureStartAdjusted = false;

function onResizeHandlePointerDown(event: PointerEvent): void {
  const el = pinnedRowsEl.value;
  if (el) {
    // Refresh the list's keep at the gesture start — a flat/grouped switch
    // changes the session row height without moving any observed box.
    measureSessionList();
    gestureActive = true;
    gestureCommittedHeight = rowsHeight.value;
    gestureStartAdjusted = userAdjusted.value;
    gestureStartHeight = clampRowsHeight(el.getBoundingClientRect().height);
    rowsHeight.value = gestureStartHeight;
  }
  onResizePointerDown(event);
}

watch(resizeDragging, (dragging) => {
  if (dragging) return;
  // Gesture over — clear the flag FIRST so the restore below clamps against
  // the plain layout cap, not the gesture's content ceiling.
  gestureActive = false;
  // No effective displacement (a click, a zero-delta move, a drag back to
  // the exact start, or a downward drag with the content already at the
  // ceiling): restore the pre-gesture cap AND the pre-gesture adjustment
  // flag, so the gesture counts as nothing — the cap keeps following the
  // viewport unless an earlier real adjustment already froze it. The flag
  // is the in-memory one booked at the gesture start: with storage
  // unwritable (private mode / quota) that is the only place a real
  // adjustment lives.
  const live = liveRowsHeight.value;
  if (gestureCommittedHeight !== null && isNoopGesture(gestureStartHeight, live)) {
    rowsHeight.value = clampRowsHeight(gestureCommittedHeight);
    userAdjusted.value = gestureStartAdjusted;
  }
  gestureCommittedHeight = null;
  gestureStartHeight = null;
  liveRowsHeight.value = null;
});

// The handle stays mounted while a drag is in progress even when the section
// drops below the threshold mid-drag (e.g. another window unpins or archives
// a row): unmounting the element that holds pointer capture would orphan the
// gesture. The gate closes — and the cap is stripped — once the drag ends.
const handleVisible = computed(() => resizable.value || resizeDragging.value);

// Applies the committed cap while the gate is open and strips it when the
// gate closes (few rows again / the section is folded), where the CSS 40vh
// cap of the natural-height layout governs instead.
watch(
  [pinnedRowsEl, handleVisible, rowsHeight],
  ([el, active, height]) => {
    if (!el) return;
    if (active) el.style.setProperty('max-height', `${height}px`);
    else el.style.removeProperty('max-height');
  },
  { immediate: true },
);

// Keyboard model for role="separator" (§08): focusable, value exposed, and
// ↑/↓ resize in steps (⇧ = larger) — ArrowDown grows the section (it extends
// downward, the opposite of the bottom terminal panel's handle). The step
// anchors to the rows' RENDERED height like the pointer path: right after
// the handle appears the content can be shorter than the resting cap, and
// stepping the stale cap would change nothing visibly while aria-valuenow
// claims otherwise. The target is clamped to BOTH bounds (the content's
// natural height above, the two-row floor below) before the no-op check, so
// a key press that would move nothing is exactly that — nothing. Unlike the
// pointer gesture a real step is an explicit adjustment, so the stepped
// value commits (persists) immediately.
function onResizeKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  measureSessionList(); // same refresh as the pointer gesture start
  const el = pinnedRowsEl.value;
  const ceiling = pinnedRowsResizeCeiling(
    layoutCap.value,
    el?.scrollHeight ?? null,
    rowsMinHeight.value,
  );
  const base = el ? clampRowsHeight(el.getBoundingClientRect().height) : rowsHeight.value;
  const step = (event.key === 'ArrowDown' ? 1 : -1) * (event.shiftKey ? 48 : 16);
  const target = pinnedRowsKeyboardTarget(base, step, ceiling, rowsMinHeight.value);
  // Clamped to where the separator already is — a true no-op: do NOT mark
  // the cap as user-chosen and do NOT commit (a zero-displacement key press
  // must never disable the follow-the-viewport default).
  if (target === base) return;
  // An explicit step IS an adjustment: freeze the cap as user-chosen before
  // the commit so the persist gate lets it through.
  userAdjusted.value = true;
  setRowsHeight(target);
}

// The separator position assistive tech should hear: the live value while
// dragging, else the rows' rendered height (the committed cap can exceed the
// content — the visual separator sits at the smaller of the two).
const separatorPosition = computed(() => {
  if (liveRowsHeight.value !== null) return liveRowsHeight.value;
  const content = contentHeight.value;
  return content === null ? rowsHeight.value : Math.min(rowsHeight.value, content);
});

// Scroll-linked edge veils on the rows scroller — the same seam language as
// the session list's (Sidebar's .sessions-head / .side-footer): a soft fade
// at an edge, shown only while more row content exists beyond that edge.
// When the content fits the cap nothing is scrollable and both stay off.
const rowsScrolled = ref(false);
const rowsCanScrollDown = ref(false);

function updateRowsScrollState(el = pinnedRowsEl.value): void {
  if (!el) return;
  contentHeight.value = el.scrollHeight;
  // The first two .pin-row wrappers' boxes — rows are uniform except that a
  // later row can be taller (badges / PR pill), so measure both. onUpdated
  // re-runs this after EVERY render, so the array is replaced only on a real
  // change: a fresh identity each pass would retrigger dependents
  // (rowsMinHeight → layoutCap → re-render) in an update loop.
  const next = [el.children.item(0), el.children.item(1)].map((child) =>
    child ? (child as HTMLElement).getBoundingClientRect().height : null,
  );
  if (
    next.length !== firstRowHeights.value.length ||
    next.some((height, index) => height !== firstRowHeights.value[index])
  ) {
    firstRowHeights.value = next;
  }
  rowsScrolled.value = el.scrollTop > 0;
  rowsCanScrollDown.value = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
}

function onRowsScroll(): void {
  updateRowsScrollState();
}

// The box and the content can each change without a scroll event (a drag
// resizes the cap, a new pin grows the content under a fixed cap), so the
// state re-reads on every update and on box resizes. The rows element
// unmounts with the section fold, hence the re-observing watch.
let rowsObserver: ResizeObserver | null = null;

watch(pinnedRowsEl, (el, prev) => {
  if (prev) rowsObserver?.disconnect();
  rowsObserver = null;
  if (el && typeof ResizeObserver === 'function') {
    rowsObserver = new ResizeObserver(() => updateRowsScrollState());
    rowsObserver.observe(el);
  }
  if (el) {
    updateRowsScrollState(el);
  } else {
    contentHeight.value = null;
    firstRowHeights.value = [];
    rowsScrolled.value = false;
    rowsCanScrollDown.value = false;
  }
});
onUpdated(() => updateRowsScrollState());
onBeforeUnmount(() => rowsObserver?.disconnect());

// A font-scale change resizes every row WITHOUT moving the rows' (capped)
// border box, so neither the ResizeObserver above nor a re-render fires and
// the measurements would go stale (handle draggable past the content end at
// a smaller scale, unreachable content at a larger one, a lying
// aria-valuemax). Subscribe to the appearance singleton and re-measure once
// the new sizes apply.
const { fontScale } = useAppearance();
watch(fontScale, () => {
  void nextTick(() => {
    updateRowsScrollState();
    measureSessionList();
  });
});

// Row dragging exists for the drag-OUT (unpin) gesture — there is no
// in-section reorder (the section renders in recency order). We only track
// the dragged row for the fade + the drag broadcast to workspace groups.
const draggingId = ref<string | null>(null);

// A row in inline-rename mode suspends dragging on its wrapper, so a drag
// gesture over the input selects text instead of moving the row.
const renamingSessionId = ref<string | null>(null);

function onDragStart(id: string, event: DragEvent): void {
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', id);
  draggingId.value = id;
  const workspaceId = props.sessions.find((s) => s.id === id)?.workspaceId;
  if (workspaceId !== undefined) emit('sessionDragStart', id, workspaceId);
}

function onDragEnd(): void {
  draggingId.value = null;
  emit('sessionDragEnd');
}

// The drop-back-to-unpin path removes the dragged row mid-drag; if dragend
// never arrives because the source element is gone, the local drag state
// would stick — reset it once the dragged row is no longer rendered.
watch(
  () => props.sessions,
  (sessions) => {
    if (draggingId.value !== null && !sessions.some((s) => s.id === draggingId.value)) {
      draggingId.value = null;
    }
  },
);

// Drop-in (pin): external session-row drags carry a marker MIME type; during
// dragover only the types list is readable, the id payload comes out on drop.
// Internal drags (a pinned row on its way out) set no marker, so the section
// never accepts its own rows back.
const dropActive = ref(false);

function isSessionRowDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes(SESSION_ROW_DRAG_MIME) ?? false;
}

function onContainerDragOver(event: DragEvent): void {
  if (!isSessionRowDrag(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  dropActive.value = true;
}

function onContainerDrop(event: DragEvent): void {
  dropActive.value = false;
  const droppedId = event.dataTransfer?.getData(SESSION_ROW_DRAG_MIME);
  if (droppedId) emit('dropPin', droppedId);
}

// External drags never fire dragend inside this component — clear the marker
// when the pointer leaves the section instead.
function onContainerDragLeave(event: DragEvent): void {
  if ((event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) return;
  dropActive.value = false;
}
</script>

<template>
  <div
    ref="pinnedRootEl"
    class="pinned"
    :class="{ 'drop-active': dropActive }"
    @dragover="onContainerDragOver"
    @drop="onContainerDrop"
    @dragleave="onContainerDragLeave"
  >
    <div class="pinned-label">
      <span class="pinned-title">{{ t('sidebar.pinned') }}</span>
      <!-- The toggle stays visible while collapsed: a hidden control would
           leave the folded section with no discoverable way back. -->
      <IconButton
        class="pinned-toggle"
        :class="{ 'pinned-toggle--on': collapsed }"
        size="sm"
        :label="collapsed ? t('sidebar.expandPinned') : t('sidebar.collapsePinned')"
        :tooltip="collapsed ? t('sidebar.expandPinned') : t('sidebar.collapsePinned')"
        @click.stop="toggleCollapsed"
      >
        <Icon v-if="collapsed" name="chevron-right" />
        <Icon v-else name="chevron-down" />
      </IconButton>
    </div>
    <!-- The wrapper anchors the scroll-linked edge veils so they overlay the
         rows' edges without scrolling with the content (and never shift
         layout). -->
    <div
      v-if="!collapsed"
      class="pinned-rows-wrap"
      :class="{ scrolled: rowsScrolled, 'more-below': rowsCanScrollDown }"
    >
      <div ref="pinnedRowsEl" class="pinned-rows" @scroll="onRowsScroll">
        <div
          v-for="s in sessions"
          :key="s.id"
          class="pin-row"
          :class="{ dragging: draggingId === s.id }"
          :draggable="renamingSessionId !== s.id"
          @dragstart="onDragStart(s.id, $event)"
          @dragend="onDragEnd"
        >
          <SessionRow
            :session="s"
            :active="s.id === activeId"
            :approval-count="pendingBySession[s.id]?.approvals ?? 0"
            :question-count="pendingBySession[s.id]?.questions ?? 0"
            :unread="unreadBySession[s.id] ?? false"
            :state-tag="props.stateTag"
            :data-session-id="s.id"
            :class="{ 'se-locate-flash': flashSessionId === s.id }"
            @rename-state-change="renamingSessionId = $event ? s.id : null"
            @select="emit('selectSession', $event)"
            @rename="(id, title) => emit('renameSession', id, title)"
            @generate-title="(id, done) => emit('generateSessionTitle', id, done)"
            @archive="emit('archiveSession', $event)"
            @fork="emit('forkSession', $event)"
            @export="emit('exportSession', $event)"
            @pin="emit('pinSession', $event)"
          />
        </div>
      </div>
      <!-- Edge veils: top shows once scrolled away from the first row, bottom
           while more rows exist below. -->
      <span class="pinned-seam pinned-seam--top" aria-hidden="true"></span>
      <span class="pinned-seam pinned-seam--bottom" aria-hidden="true"></span>
    </div>
    <!-- Height-split handle: rendered only while the pinned content overflows
         the compact threshold (see `resizable`) — dragging down grows the
         section, the session list below takes what remains. It stays mounted
         for the duration of an in-progress drag even if the section drops
         below the threshold mid-drag (`handleVisible`), so the pointer
         capture is never orphaned. Negative margins centre the strip on the
         inter-section gap so its appearance shifts nothing. -->
    <div
      v-if="handleVisible"
      class="pinned-resize"
      :class="{ dragging: resizeDragging }"
      :style="{ cursor: resizeCursor }"
      role="separator"
      aria-orientation="horizontal"
      :aria-label="t('sidebar.resizePinnedAria')"
      :aria-valuenow="Math.round(separatorPosition)"
      :aria-valuemin="rowsMinHeight"
      :aria-valuemax="pinnedRowsResizeCeiling(layoutCap, contentHeight, rowsMinHeight)"
      tabindex="0"
      @pointerdown="onResizeHandlePointerDown"
      @keydown="onResizeKeydown"
    >
      <span class="pinned-resize-bar" aria-hidden="true"></span>
    </div>
  </div>
</template>

<style scoped>
/* Section label — mirrors the sidebar's .side-section-label (scoped styles
   don't cross the component boundary), so the pinned caption reads exactly
   like the WORKSPACES one below it: --sb-pad-x leading alignment on the left,
   the list's scrollbar track (--space-1) plus --sb-action-inset on the right
   so the toggle's right edge shares the row buttons' vertical line. */
.pinned-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 calc(var(--space-1) + var(--sb-action-inset)) var(--space-1) var(--space-2);
  font-family: var(--font-ui);
  font-size: var(--text-xs);
  font-weight: var(--weight-section-label);
  text-transform: uppercase;
  color: var(--faint);
  user-select: none;
}
.pinned-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Collapse toggle — mirrors the sidebar's .side-section-toggle (scoped styles
   don't cross the component boundary): faint at rest, revealed on label
   hover/focus-within, and kept visible while the section is folded. */
.pinned-toggle {
  color: var(--faint);
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-out);
}
.pinned-label:hover .pinned-toggle,
.pinned-label:focus-within .pinned-toggle,
.pinned-toggle--on {
  opacity: 1;
}
.pinned-toggle:hover {
  color: var(--dim);
}
.pinned-toggle svg {
  width: 13px;
  height: 13px;
}

/* Session-row locate flash (search dialog): identical treatment to the
   grouped rows' flash in WorkspaceGroup — a soft accent overlay fading out
   above the row's resting fill, so nothing snaps when it ends. The class
   lands on SessionRow's root (class fallthrough), which carries this
   component's scope id. */
.se-locate-flash { isolation: isolate; }
.se-locate-flash::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: var(--radius-sm);
  background: var(--color-accent-soft);
  pointer-events: none;
  animation: se-locate-fade var(--duration-flash) var(--ease-out) forwards;
}
@keyframes se-locate-fade {
  from { opacity: 1; }
  to { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .se-locate-flash::before { animation: none; }
}

/* Cap the expanded rows so a long pinned set can't push the workspace list
   (and the footer) out of the column — the labels stay fixed, the rows
   scroll internally. Thin overlay-styled scrollbar mirroring the sidebar's.
   The 40vh cap is the resting/natural-height layout; once the resize handle
   is offered, the draggable cap is written imperatively (inline max-height
   overrides this — see the script's resizable block). The horizontal inset
   lives INSIDE the scroller (paired with the wrapper's negative margins) so
   the rows' right edge and the scrollbar track land exactly where the
   session list's do — .sessions carries the same inset inside its own
   scroll container. Same contract as .sessions: the custom 4px scrollbar is
   classic, so its gutter stays reserved even when the rows fit — the pinned
   rows' right edge never shifts against the session list's. */
.pinned-rows {
  max-height: 40vh;
  overflow-y: auto;
  padding: 0 var(--sb-inset);
  scrollbar-gutter: stable;
}
.pinned-rows::-webkit-scrollbar { width: var(--space-1); }
.pinned-rows::-webkit-scrollbar-track { background: transparent; }
.pinned-rows::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: var(--radius-full);
  transition: background var(--duration-base) var(--ease-out);
}
.pinned-rows:hover::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--color-text) 12%, transparent);
}
.pinned-rows::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--color-text) 25%, transparent);
}

/* Scroll-linked edge veils for the rows scroller — the same seam language as
   the session list's (Sidebar's .sessions-head::after / .side-footer::before):
   a --p-sidebar-seam-h three-layer text-tint wash plus a 0.5px --line
   hairline at the content edge, transparent at rest and fading in only while
   more row content exists beyond that edge (the sessions-head seam gates its
   hairline on the same condition). Absolutely positioned overlays anchored
   by the wrapper — no layout shift, and they never scroll with the content.
   The gradient stacks ride component-local custom properties (a §06-accepted
   edge-veil primitive, same as the sidebar's). */
.pinned-rows-wrap {
  position: relative;
  /* Stretch to the column's full width: the sessions-head horizontal inset
     lives OUTSIDE this wrap, so the veils/hairlines span edge to edge like
     the session list's seams, and the scroller inside owns its own inset
     (see .pinned-rows). */
  margin: 0 calc(var(--sb-inset) * -1);
  --pinned-seam-down: linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 1.5%, transparent), transparent 35%), linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 1%, transparent), transparent 65%), linear-gradient(to bottom, color-mix(in srgb, var(--color-text) 0.75%, transparent), transparent);
  --pinned-seam-up: linear-gradient(to top, color-mix(in srgb, var(--color-text) 1.5%, transparent), transparent 35%), linear-gradient(to top, color-mix(in srgb, var(--color-text) 1%, transparent), transparent 65%), linear-gradient(to top, color-mix(in srgb, var(--color-text) 0.75%, transparent), transparent);
}
.pinned-seam {
  position: absolute;
  left: 0;
  right: 0;
  height: var(--p-sidebar-seam-h);
  pointer-events: none;
  opacity: 0;
  /* Above the rows (their .se boxes are positioned) but below the resize
     handle (--z-dropdown): hovering/dragging the handle paints its bar over
     the bottom veil's edge instead of fighting it. */
  z-index: var(--z-raised);
  transition: opacity var(--duration-slow) var(--ease-out);
}
.pinned-seam--top {
  top: 0;
  border-top: var(--p-hairline) solid var(--line);
  background: var(--pinned-seam-down);
}
.pinned-seam--bottom {
  bottom: 0;
  border-bottom: var(--p-hairline) solid var(--line);
  background: var(--pinned-seam-up);
}
.pinned-rows-wrap.scrolled .pinned-seam--top,
.pinned-rows-wrap.more-below .pinned-seam--bottom {
  opacity: 1;
}

/* Height-split handle between the pinned rows and the session-list label —
   a horizontal twin of the app ResizeHandle: 4px grab strip with a centred
   2px indicator bar, the neutral ramp one step up (f2 hover, f3 drag), never
   accent. Negative margins centre the strip on the inter-section gap, so the
   strip appearing/disappearing at the threshold shifts nothing; the
   horizontal ones stretch it to the column's full width so the indicator bar
   spans exactly the edge veils' / hairline's range (the session list's seams
   share that range — see .pinned-rows-wrap). */
.pinned-resize {
  height: var(--space-1);
  position: relative;
  background: transparent;
  touch-action: none;
  margin: calc(var(--space-05) * -1) calc(var(--sb-inset) * -1);
  /* Above the rows' scroll container so the 2px overhang stays grabbable. */
  z-index: var(--z-dropdown);
}
.pinned-resize-bar {
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  height: var(--space-05);
  translate: 0 -50%;
  background: transparent;
  transition: background var(--duration-fast) var(--ease-out);
}
.pinned-resize:hover .pinned-resize-bar {
  background: var(--color-selected);
}
.pinned-resize.dragging .pinned-resize-bar {
  background: var(--color-line-strong);
}
.pinned-resize:focus-visible {
  outline: none;
  box-shadow: var(--p-focus-ring);
}

/* Drag affordance: the dragged row fades (the workspace group's .dragging),
   and an accent frame marks the section while an external session-row drag
   is over it (Sidebar's .pinned-drag-active vocabulary, no layout shift). */
.pin-row.dragging { opacity: 0.45; }
.pinned.drop-active {
  border-radius: var(--radius-sm);
  box-shadow: inset 0 0 0 1px var(--color-accent);
}

/* Firefox (the engine without ::-webkit-scrollbar) — same contract as
   Sidebar's section label: the label gets the same browser-owned gutter
   environment as the rows' scrollers (overflow + scrollbar-gutter: stable),
   so the toggle's right edge shares the rows' line at any thin width —
   nothing to measure; the label's right padding then drops the Chromium-only
   --space-1 track compensation. The padding/negative-margin pairs reserve
   the focus ring's spread (--p-focus-ring-w) so overflow can't clip it — on
   top always, and on the right only when the font scale shrinks
   --sb-action-inset below the ring (max/min clamp). No left reserve: the
   toggle sits at the label's right end. This block sits after every base
   rule it overrides (the .pinned-label padding shorthand in particular).
   Inert on Chromium. */
@supports not selector(::-webkit-scrollbar) {
  .pinned-label {
    overflow: hidden;
    scrollbar-gutter: stable;
    padding-top: var(--p-focus-ring-w);
    margin-top: calc(var(--p-focus-ring-w) * -1);
    padding-right: max(var(--sb-action-inset), var(--p-focus-ring-w));
    margin-right: min(0px, var(--sb-action-inset) - var(--p-focus-ring-w));
  }
}
</style>
