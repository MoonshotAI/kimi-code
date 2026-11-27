<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Button, Icon, IconButton, Tooltip } from '@moonshot-ai/app-ui';
import { iconSvg } from '@moonshot-ai/app-client/icons';
import { browserControlDuration, type BrowserControlActivity, type BrowserControlActivityKind, type BrowserControlDialogs, type BrowserControlPointer, type BrowserControlSurface, type BrowserControlSurfaceBridge } from '../../../shared/browser-control';
import type { BrowserDialogRecord } from '../../../shared/browser-dialogs';
import { browserDialogRecordIcon } from '../../lib/browserDialogRecords';

const bridge = (window as { kimiBrowserControl?: BrowserControlSurfaceBridge }).kimiBrowserControl;
const surface = ref<BrowserControlSurface | null>(null);
const pointer = ref<{ x: number; y: number; kind: BrowserControlPointer['kind']; instant: boolean } | null>(null);
const pressed = ref(false);
const blocked = ref(false);
let blockedTimer: ReturnType<typeof setTimeout> | undefined;
const clock = ref(Date.now());
const viewport = ref({ width: innerWidth, height: innerHeight });
const rings = ref<{ id: number; x: number; y: number }[]>([]);
let nextRing = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let resetLabel: ReturnType<typeof setTimeout> | undefined;
let offSurface: (() => void) | undefined;
let offPointer: (() => void) | undefined;
let offActivity: (() => void) | undefined;
let offResizing: (() => void) | undefined;
let offDialogs: (() => void) | undefined;
const records = ref<BrowserDialogRecord[]>([]);
const seenRecords = ref<ReadonlySet<string>>(new Set());
const popoverOpen = ref(false);
const recordKey = (record: BrowserDialogRecord): string => `${record.id}:${record.settledAt}`;
const newestRecords = computed(() => [...records.value].reverse());
const unseenCount = computed(() => records.value.filter(record => !seenRecords.value.has(recordKey(record))).length);
const dialogLabels = computed(() => surface.value?.labels.dialogs);
const RESIZE_SETTLE_MS = 150;
const resizing = ref(false);
let resizingTimer: ReturnType<typeof setTimeout> | undefined;
const TITLE_LINGER_MS = 1000;
const TARGET_VISIBLE_MS = 600;
const activity = ref<{ id?: number; kind: BrowserControlActivityKind; target?: string; rect?: { x: number; y: number; width: number; height: number } } | null>(null);
const scans = ref<number[]>([]);
const scannedActivities: number[] = [];
let nextScan = 0;
let targetShownAt = 0;
let activityEnding = false;
let activityTimer: ReturnType<typeof setTimeout> | undefined;
let targetTimer: ReturnType<typeof setTimeout> | undefined;
const cursorSvg = iconSvg('browser-pointer', 'lg');
const elapsed = computed(() => surface.value?.labels.elapsed.replace('{time}', browserControlDuration(surface.value.startedAt, clock.value)) ?? '');
const statusTitle = computed(() => {
  const labels = surface.value?.labels;
  const current = activity.value;
  let title = labels?.running ?? '';
  if (labels && current) {
    const name = labels.activities[current.kind];
    title = current.target ? labels.activityTarget.replace('{activity}', name).replace('{target}', current.target) : name;
  }
  const controller = surface.value?.controller;
  return controller === undefined ? title : `${controller} · ${title}`;
});
const targetStyle = computed(() => {
  const rect = activity.value?.rect;
  if (!rect) return undefined;
  const left = Math.max(0, rect.x), top = Math.max(0, rect.y);
  const width = Math.min(viewport.value.width, rect.x + rect.width) - left, height = Math.min(viewport.value.height, rect.y + rect.height) - top;
  return width > 0 && height > 0 ? { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` } : undefined;
});
const edgeStyle = computed(() => {
  if (!surface.value) return undefined;
  const [top, right, bottom, left] = surface.value.insets;
  return { top: `${top}px`, right: `${right}px`, bottom: `${bottom}px`, left: `${left}px`, borderRadius: surface.value.corners.map(radius => `${radius}px`).join(' ') };
});
const pointerLabel = computed(() => {
  const labels = surface.value?.labels;
  return pointer.value?.kind === 'type' ? labels?.typing : pointer.value?.kind === 'key' ? labels?.key : pointer.value?.kind === 'scroll' ? labels?.scrolling : labels?.pointer;
});
const pointerStyle = computed(() => pointer.value ? {
  transform: `translate(${pointer.value.x}px, ${pointer.value.y}px)`,
  transitionDuration: pointer.value.instant || surface.value?.reducedMotion ? '0ms' : undefined,
} : {});

function resize(): void { viewport.value = { width: innerWidth, height: innerHeight }; pointer.value = null; rings.value = []; pressed.value = false; }

function markRecordsSeen(): void {
  seenRecords.value = new Set(records.value.map(recordKey));
}

function togglePopover(): void {
  popoverOpen.value = !popoverOpen.value;
  if (popoverOpen.value) markRecordsSeen();
}

function receiveDialogs(event: BrowserControlDialogs): void {
  if (!surface.value || event.browserId !== surface.value.browserId || event.revision !== surface.value.revision) return;
  records.value = event.records;
  if (popoverOpen.value) markRecordsSeen();
  if (records.value.length === 0) popoverOpen.value = false;
}

function recordAnswer(record: BrowserDialogRecord): string {
  const labels = dialogLabels.value;
  return labels ? labels.answeredBy.replace('{outcome}', labels.outcomes[record.outcome]).replace('{answerer}', labels.answerers[record.answerer]) : '';
}

function recordTime(record: BrowserDialogRecord): string {
  return new Date(record.settledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function downloadAction(record: BrowserDialogRecord, action: 'show' | 'move'): void {
  if (surface.value) bridge?.downloadAction({ browserId: surface.value.browserId, revision: surface.value.revision, recordId: record.id, action });
}

function blockScroll(event: Event): void {
  if (event.target instanceof Element && event.target.closest('.control-popover')) return;
  event.preventDefault();
  warnBlocked(event);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && popoverOpen.value) { popoverOpen.value = false; return; }
  warnBlocked(event);
}

function warnBlocked(event?: Event): void {
  if (event?.target instanceof Element && event.target.closest('.control-toolbar')) return;
  blocked.value = true;
  clearTimeout(blockedTimer);
  blockedTimer = setTimeout(() => { blocked.value = false; }, 1000);
}

function receivePointer(event: BrowserControlPointer): void {
  if (!surface.value || event.browserId !== surface.value.browserId || event.revision !== surface.value.revision) return;
  if (event.kind === 'blocked') { warnBlocked(); return; }
  if (event.kind === 'reset') { pointer.value = null; rings.value = []; pressed.value = false; return; }
  if (typeof event.x === 'number' && typeof event.y === 'number') {
    pointer.value = { x: event.x, y: event.y, kind: event.kind, instant: pointer.value === null || event.drag === true };
  } else if (pointer.value) pointer.value = { ...pointer.value, kind: event.kind };
  if (event.kind === 'down' && pointer.value) {
    pressed.value = true;
  } else if (event.kind === 'up') {
    pressed.value = false;
    if (pointer.value) rings.value.push({ id: ++nextRing, x: pointer.value.x, y: pointer.value.y });
    if (rings.value.length > 8) rings.value.shift();
  }
  clearTimeout(resetLabel);
  resetLabel = setTimeout(() => { if (pointer.value && !pressed.value) pointer.value.kind = 'move'; }, 2500);
}

function clearActivity(): void {
  clearTimeout(activityTimer);
  clearTimeout(targetTimer);
  activity.value = null;
  activityEnding = false;
}

function resetActivity(): void {
  clearActivity();
  scans.value = [];
  scannedActivities.length = 0;
}

function clearTarget(): void {
  if (activity.value?.rect) activity.value = { ...activity.value, rect: undefined };
}

function receiveActivity(event: BrowserControlActivity): void {
  if (!surface.value || event.browserId !== surface.value.browserId || event.revision !== surface.value.revision) return;
  clearTimeout(activityTimer);
  clearTimeout(targetTimer);
  if (event.activity === null) {
    activityEnding = true;
    activityTimer = setTimeout(clearActivity, TITLE_LINGER_MS);
    const remaining = TARGET_VISIBLE_MS - (Date.now() - targetShownAt);
    if (remaining > 0) targetTimer = setTimeout(clearTarget, remaining);
    else clearTarget();
    return;
  }
  const continued = !activityEnding && activity.value !== null && activity.value.id === event.id && activity.value.kind === event.activity;
  activityEnding = false;
  if (event.scan && event.id !== undefined && !scannedActivities.includes(event.id)) {
    scannedActivities.push(event.id);
    if (scannedActivities.length > 32) scannedActivities.shift();
    scans.value = [...scans.value.slice(-2), ++nextScan];
  }
  if (event.rect && !(continued && activity.value?.rect)) targetShownAt = Date.now();
  activity.value = { id: event.id, kind: event.activity, target: event.target, rect: event.rect };
}

function hideEdgeWhileResizing(): void {
  resizing.value = true;
  clearTimeout(resizingTimer);
  resizingTimer = setTimeout(() => { resizing.value = false; }, RESIZE_SETTLE_MS);
}

function takeOver(): void {
  if (surface.value) bridge?.takeOver(surface.value.browserId, surface.value.revision);
}

onMounted(() => {
  offSurface = bridge?.onSurface(next => {
    if (next?.revision !== surface.value?.revision || !next) { pointer.value = null; rings.value = []; pressed.value = false; blocked.value = false; clearTimeout(blockedTimer); resetActivity(); records.value = []; seenRecords.value = new Set(); popoverOpen.value = false; }
    surface.value = next;
    clock.value = Date.now();
    if (next) document.documentElement.dataset.colorScheme = next.colorScheme;
  });
  offPointer = bridge?.onPointer(receivePointer);
  offActivity = bridge?.onActivity(receiveActivity);
  offResizing = bridge?.onResizing(hideEdgeWhileResizing);
  offDialogs = bridge?.onDialogs(receiveDialogs);
  window.addEventListener('resize', resize);
  window.addEventListener('keydown', onKeydown);
  timer = setInterval(() => { clock.value = Date.now(); }, 1000);
  bridge?.ready();
});
onUnmounted(() => { window.removeEventListener('resize', resize); window.removeEventListener('keydown', onKeydown); offSurface?.(); offPointer?.(); offActivity?.(); offResizing?.(); offDialogs?.(); clearTimeout(resizingTimer); clearTimeout(activityTimer); clearTimeout(targetTimer); clearInterval(timer); clearTimeout(resetLabel); clearTimeout(blockedTimer); });
</script>

<template>
  <div v-if="surface" class="control-surface" :class="{ reduced: surface.reducedMotion, resizing }" @pointerdown="warnBlocked" @contextmenu.prevent="warnBlocked" @wheel="blockScroll" @touchmove="blockScroll">
    <div class="control-bloom" aria-hidden="true"><div class="control-edge control-band" :style="edgeStyle"><i class="control-spectrum" /></div></div>
    <div class="control-edge control-line" :style="edgeStyle" aria-hidden="true"><i class="control-spectrum" /></div>
    <div v-for="scan in scans" :key="scan" class="control-scan" aria-hidden="true" @animationend="scans = scans.filter(item => item !== scan)" />
    <div v-if="targetStyle" class="control-target" :style="targetStyle" aria-hidden="true" />
    <div v-for="ring in rings" :key="ring.id" class="control-ring" :style="{ left: `${ring.x}px`, top: `${ring.y}px` }" aria-hidden="true" @animationend="rings = rings.filter(item => item.id !== ring.id)" />
    <div v-if="pointer" class="control-pointer" :class="{ pressed }" :style="pointerStyle" aria-hidden="true">
      <span v-if="pressed" class="control-held-ring" />
      <span class="control-arrow" v-html="cursorSvg" />
      <span class="control-pointer-label" :style="{ left: `${Math.max(4, Math.min(pointer.x + 16, viewport.width - 128)) - pointer.x}px`, top: pointer.y > viewport.height - 56 ? '-28px' : undefined }">{{ pointerLabel }}</span>
    </div>
    <div class="control-toolbar" :class="{ blocked }" role="toolbar" :aria-label="statusTitle">
      <div class="control-status"><span class="control-title">{{ statusTitle }}</span><span class="control-elapsed">{{ elapsed }}</span></div>
      <section v-if="popoverOpen && dialogLabels && records.length > 0" class="control-popover" role="dialog" :aria-label="dialogLabels.title">
        <header class="control-popover-head"><span>{{ dialogLabels.title }}</span><span class="control-popover-count">{{ records.length }}</span></header>
        <ul class="control-records">
          <li v-for="record in newestRecords" :key="record.id" class="control-record" :class="`is-${record.outcome}`">
            <span class="control-record-icon" aria-hidden="true"><Icon :name="browserDialogRecordIcon(record.kind)" size="sm" /></span>
            <div class="control-record-body">
              <div class="control-record-title"><span>{{ dialogLabels.kinds[record.kind] }}</span><time>{{ recordTime(record) }}</time></div>
              <div v-if="record.origin" class="control-record-origin">{{ record.origin }}</div>
              <div class="control-record-answer">{{ recordAnswer(record) }}</div>
              <div v-if="record.message" class="control-record-message">{{ record.message }}</div>
              <div v-if="record.text !== undefined" class="control-record-message">{{ JSON.stringify(record.text) }}</div>
              <div v-for="file in record.files ?? []" :key="file" class="control-record-path">{{ file }}</div>
              <div v-if="record.downloadId && record.outcome === 'saved'" class="control-record-actions">
                <Button variant="secondary" size="sm" @click="downloadAction(record, 'show')">{{ dialogLabels.showInFolder }}</Button>
                <Button variant="ghost" size="sm" @click="downloadAction(record, 'move')">{{ dialogLabels.move }}</Button>
              </div>
            </div>
          </li>
        </ul>
      </section>
      <div class="control-actions">
        <span v-if="dialogLabels && records.length > 0" class="control-records-button">
          <IconButton size="sm" :label="dialogLabels.button" :tooltip="dialogLabels.button" :aria-expanded="popoverOpen" @click="togglePopover"><Icon name="bell" size="md" /></IconButton>
          <span v-if="unseenCount > 0" class="control-records-badge" aria-hidden="true">{{ unseenCount > 99 ? '99+' : unseenCount }}</span>
        </span>
        <Tooltip :text="surface.labels.takeoverHint" placement="top">
          <Button class="control-takeover" variant="ghost" size="sm" @click="takeOver"><span class="control-takeover-label"><Icon name="hand" size="lg" />{{ surface.labels.takeover }}</span></Button>
        </Tooltip>
      </div>
    </div>
  </div>
</template>

<style>
html, body, #app { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent !important; }
</style>
<style scoped>
.control-surface { position: absolute; inset: 0; overflow: hidden; user-select: none; touch-action: none; animation: control-appear var(--duration-slow) var(--ease-out); }
.control-bloom, .control-edge { position: absolute; inset: 0; pointer-events: none; }
.control-bloom { filter: blur(var(--browser-control-glow-blur)); opacity: var(--browser-control-glow-bloom); transition: opacity var(--duration-slow) var(--ease-out); }
.control-edge { overflow: hidden; mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0); }
.control-band { padding: var(--browser-control-glow-band); }
.control-line { padding: var(--browser-control-glow-line); opacity: var(--browser-control-glow-core); transition: opacity var(--duration-slow) var(--ease-out); }
.resizing :is(.control-bloom, .control-line) { opacity: 0; transition: none; }
.control-spectrum { position: absolute; left: 50%; top: 50%; width: 200vmax; aspect-ratio: 1; background: var(--browser-control-glow-spectrum); transform: translate(-50%, -50%); animation: control-spectrum var(--browser-control-glow-duration) linear infinite; }
.control-toolbar { position: absolute; bottom: var(--space-5); left: 50%; transform: translateX(-50%); max-width: calc(100% - var(--space-8)); display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-4); border: var(--p-hairline) solid var(--color-line); border-radius: var(--radius-full); background: var(--color-surface-raised); color: var(--color-text); box-shadow: var(--shadow-menu); }
.control-status { display: flex; flex-direction: column; gap: var(--space-05); padding-left: var(--space-1); min-width: 0; white-space: nowrap; }
.control-title { overflow: hidden; text-overflow: ellipsis; font-size: var(--ui-c1); font-weight: 500; line-height: 1.4; }
.control-elapsed { font-size: var(--ui-c1); color: var(--color-text-muted); font-variant-numeric: tabular-nums; line-height: 1.4; }
.control-actions { display: flex; align-items: center; gap: var(--space-1); border-left: var(--p-hairline) solid var(--color-line); padding-left: var(--space-2); flex: none; }
.control-records-button { position: relative; display: inline-flex; }
.control-records-badge { position: absolute; top: calc(var(--space-1) * -1); right: calc(var(--space-1) * -1); min-width: var(--space-4); height: var(--space-4); padding: 0 var(--space-1); box-sizing: border-box; display: inline-grid; place-items: center; border-radius: var(--radius-full); background: var(--color-accent); color: var(--color-bg); font-size: var(--ui-c1); font-weight: 500; line-height: 1; font-variant-numeric: tabular-nums; pointer-events: none; }
.control-popover { position: absolute; bottom: calc(100% + var(--space-2)); left: 50%; transform: translateX(-50%); width: min(var(--browser-control-popover-width), calc(100vw - var(--space-8))); max-height: min(var(--browser-control-popover-max-height), calc(100vh - var(--space-5) * 2 - var(--browser-control-button-height) * 2)); display: flex; flex-direction: column; border: var(--p-hairline) solid var(--color-line); border-radius: var(--radius-lg); background: var(--color-surface-raised); box-shadow: var(--shadow-menu); overflow: hidden; user-select: text; cursor: auto; }
.control-popover-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: var(--space-2) var(--space-3); border-bottom: var(--p-hairline) solid var(--color-line); font-size: var(--ui-b2); font-weight: 500; }
.control-popover-count { color: var(--color-text-muted); font-variant-numeric: tabular-nums; }
.control-records { margin: 0; padding: var(--space-1); list-style: none; overflow: auto; overscroll-behavior: contain; }
.control-record { display: flex; gap: var(--space-2); padding: var(--space-2); border-radius: var(--radius-md); }
.control-record + .control-record { border-top: var(--p-hairline) solid var(--color-line); border-radius: 0; }
.control-record-icon { flex: none; display: inline-grid; place-items: center; width: var(--space-6); height: var(--space-6); border-radius: var(--radius-sm); background: var(--color-accent-soft); color: var(--color-accent); }
.control-record.is-blocked .control-record-icon, .control-record.is-too-large .control-record-icon, .control-record.is-denied .control-record-icon { background: var(--color-danger-soft); color: var(--color-danger); }
.control-record-body { display: flex; flex-direction: column; gap: var(--space-05); min-width: 0; flex: 1; font-size: var(--ui-c1); line-height: 1.4; }
.control-record-title { display: flex; justify-content: space-between; gap: var(--space-2); font-size: var(--ui-b2); font-weight: 500; color: var(--color-text); }
.control-record-title time { flex: none; font-weight: 400; font-size: var(--ui-c1); color: var(--color-text-muted); font-variant-numeric: tabular-nums; }
.control-record-origin, .control-record-answer { color: var(--color-text-muted); overflow-wrap: anywhere; }
.control-record-message { color: var(--color-text); white-space: pre-wrap; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.control-record-path { font-family: var(--font-mono); color: var(--color-text); overflow-wrap: anywhere; word-break: break-all; }
.control-record-actions { display: flex; flex-wrap: wrap; gap: var(--space-1); margin-top: var(--space-1); }
.control-takeover { min-height: var(--browser-control-button-height); border-radius: var(--radius-full); background: var(--color-surface); color: var(--color-text); }
.control-takeover-label { display: inline-flex; align-items: center; gap: var(--space-1); font-size: var(--ui-b2); font-weight: 500; }
.control-pointer { position: absolute; left: 0; top: 0; pointer-events: none; transition: transform var(--duration-base) var(--ease-out); }
.control-arrow { filter: var(--browser-control-pointer-shadow); display: block; transform: translate(calc(var(--space-2) * -.5), calc(var(--space-05) * -1)); }
.control-arrow :deep(svg) { display: block; width: var(--browser-control-pointer-width); height: var(--browser-control-pointer-height); overflow: visible; }
.control-pointer-label { max-width: var(--browser-control-pointer-label-width); overflow: hidden; text-overflow: ellipsis; position: absolute; top: var(--space-6); left: var(--space-4); padding: var(--space-1) var(--space-2); border-radius: var(--radius-full); background: var(--color-text-strong); color: var(--color-bg); font-size: var(--ui-c1); line-height: 1.4; white-space: nowrap; }
.control-ring, .control-held-ring { position: absolute; width: var(--browser-control-ring-size); height: var(--browser-control-ring-size); border: var(--browser-control-ring-width) solid var(--color-accent); border-radius: var(--radius-full); background: var(--browser-control-ring-fill); box-shadow: var(--browser-control-ring-shadow); pointer-events: none; }
.control-held-ring { left: 0; top: 0; animation: control-hold var(--duration-base) var(--ease-out) forwards; }
.control-ring { animation: control-click calc(var(--duration-slow) * 3) var(--ease-out) forwards; }
.control-target { position: absolute; border: var(--browser-control-ring-width) solid var(--color-accent); border-radius: var(--radius-sm); background: var(--browser-control-target-fill); box-shadow: var(--browser-control-ring-shadow); pointer-events: none; animation: control-target var(--duration-base) var(--ease-out); }
.control-scan { position: absolute; left: 0; right: 0; top: 0; height: var(--browser-control-scan-height); border-bottom: var(--browser-control-edge) solid var(--browser-control-scan-edge); background: linear-gradient(to bottom, transparent, var(--browser-control-scan-fill)); pointer-events: none; animation: control-scan var(--browser-control-scan-duration) var(--ease-in-out) forwards; }
.control-toolbar.blocked { border-color: var(--color-danger); color: var(--color-danger); animation: control-blocked calc(var(--duration-slow) * 2) var(--ease-out) 2; }
@keyframes control-blocked { 50% { background: var(--color-danger-soft); box-shadow: var(--shadow-menu), 0 0 0 var(--browser-control-ring-width) var(--color-danger-bd); } }
@keyframes control-hold { from { transform: translate(-50%, -50%) scale(.4); } to { transform: translate(-50%, -50%) scale(1); } }
@keyframes control-appear { from { opacity: 0; } }
@keyframes control-spectrum { to { transform: translate(-50%, -50%) rotate(360deg); } }
@keyframes control-click { from { transform: translate(-50%, -50%) scale(1); opacity: 1; } to { transform: translate(-50%, -50%) scale(2); opacity: 0; } }
@keyframes control-target { from { opacity: 0; } to { opacity: 1; } }
@keyframes control-scan { from { transform: translateY(-100%); opacity: 1; } 85% { opacity: 1; } to { transform: translateY(100vh); opacity: 0; } }
@keyframes control-click-reduced { from { transform: translate(-50%, -50%); opacity: 1; } to { transform: translate(-50%, -50%); opacity: 0; } }
.reduced .control-spectrum { animation: none; }
.reduced .control-ring { animation-name: control-click-reduced; }
.reduced .control-held-ring { animation: none; transform: translate(-50%, -50%); }
.reduced .control-target { animation: none; }
.reduced .control-scan { bottom: 0; height: auto; border-bottom: 0; background: var(--browser-control-scan-fill); animation-name: ui-fade-out; }
.reduced .control-toolbar.blocked { animation: none; background: var(--color-danger-soft); }
@media (max-width: 280px) { .control-toolbar { flex-direction: column; } .control-status { align-items: center; } .control-actions { border-left: 0; padding-left: 0; } }
@media (max-width: 340px) { .control-toolbar { gap: var(--space-2); padding-inline: var(--space-2); max-width: calc(100% - var(--space-4)); } }
</style>
