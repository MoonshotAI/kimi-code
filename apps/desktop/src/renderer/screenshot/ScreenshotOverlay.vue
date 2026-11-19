<script setup lang="ts">
import { Button, Icon, IconButton, Kbd, SegmentedControl, Tooltip, useImeComposition } from '@moonshot-ai/app-ui';
import type { IconName } from '@moonshot-ai/app-client/icons';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ScreenshotEditor } from './editor';
import { exportScreenshot } from './export';
import { bindingKeyNames } from '@moonshot-ai/app-core/lib';
import ScreenshotLoupe from './ScreenshotLoupe.vue';
import { LatestFrameScheduler } from './latest-frame';
import {
  MIN_SELECTION_SIZE,
  candidateAtPoint,
  displayRect,
  drawRect,
  moveRect,
  resizeRect,
  sourcePoint,
  sourceRect,
  subtractRects,
  toolbarPosition,
  type ResizeHandle,
} from './geometry';
import type {
  Point,
  Rect,
  ScreenshotOutputAction,
  ScreenshotBridge,
  ScreenshotOverlayContext,
  ScreenshotTool,
  ScreenshotToolStyle,
} from './types';

interface DecodedFrame {
  captureId: string;
  bitmap: ImageBitmap | null;
}

const STRINGS = {
  zh: {
    writeComment: '写评论',
    close: '退出截图',
    move: '移动选区',
    comment: '补充希望 Kimi 关注的内容（可选）',
    add: '添加到对话',
    addHint: 'Enter 添加 · Shift+Enter 换行',
    copy: '复制',
    save: '保存',
    pin: '贴图',
    reselectConfirm: '再次右键可重新框选，当前标注将被删除',
    undo: '撤销',
    redo: '重做',
    deleteSelected: '删除选中标注',
    clearAnnotations: '清空全部标注',
    imageOnly: '本次操作仅生成图片，再点一次继续',
    failed: '截图处理失败，请重试',
    select: '选择',
    rect: '矩形',
    ellipse: '椭圆',
    line: '直线',
    arrow: '箭头',
    pen: '画笔',
    text: '文字',
    number: '标号',
    mosaic: '马赛克',
    pixelSize: '色块大小',
    fill: '填充',
    width: '线宽',
    fontSize: '字号',
  },
  en: {
    writeComment: 'Add comment',
    close: 'Cancel screenshot',
    move: 'Move selection',
    comment: 'Add what Kimi should focus on (optional)',
    add: 'Add to conversation',
    addHint: 'Enter to add · Shift+Enter for new line',
    copy: 'Copy',
    save: 'Save',
    pin: 'Pin',
    reselectConfirm: 'Right-click again to reselect. Current annotations will be deleted',
    undo: 'Undo',
    redo: 'Redo',
    deleteSelected: 'Delete selected annotations',
    clearAnnotations: 'Clear all annotations',
    imageOnly: 'This action outputs only the image. Click again to continue.',
    failed: 'Could not process the screenshot. Try again.',
    select: 'Select',
    rect: 'Rectangle',
    ellipse: 'Ellipse',
    line: 'Line',
    arrow: 'Arrow',
    pen: 'Pen',
    text: 'Text',
    number: 'Number',
    mosaic: 'Pixelate',
    pixelSize: 'Block size',
    fill: 'Fill',
    width: 'Width',
    fontSize: 'Font size',
  },
} as const;

const TOOL_KEYS: Array<{ tool: ScreenshotTool; icon: IconName }> = [
  { tool: 'select', icon: 'pointer' },
  { tool: 'rect', icon: 'shape-square' },
  { tool: 'arrow', icon: 'arrow-up-right' },
  { tool: 'pen', icon: 'pencil' },
  { tool: 'text', icon: 'typography' },
  { tool: 'number', icon: 'list-numbers' },
  { tool: 'mosaic', icon: 'grid-dots' },
];

const TOOL_BINDINGS: Record<ScreenshotTool, string> = {
  select: 'v', rect: 'r', ellipse: 'o', line: 'l', arrow: 'a', pen: 'p', text: 't', number: 'n', mosaic: 'm',
};

function hintKeys(binding: string): string[] {
  return bindingKeyNames(binding);
}

const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#1783ff', '#af52de', '#ffffff'];
const bridge = window.shotBridge;
const context = ref<ScreenshotOverlayContext | null>(null);
const i18n = useI18n();
const frameReady = ref(false);
const frameRef = ref<HTMLImageElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const toolbarRef = ref<HTMLElement | null>(null);
const selection = ref<Rect | null>(null);
const phase = ref<'select' | 'edit'>('select');
const tool = ref<ScreenshotTool>('select');
const lineMode = ref<'arrow' | 'line'>('arrow');
const shapeMode = ref<'rect' | 'ellipse'>('rect');
const selectedTool = ref<ScreenshotTool | null>(null);
const propertyTool = computed(() => tool.value === 'select' ? selectedTool.value ?? 'select' : tool.value);
const style = ref<ScreenshotToolStyle>({ color: COLORS[0]!, width: 4, fill: false, fontSize: 24, pixelSize: 16 });
const comment = ref('');
const { handleCompositionStart, handleCompositionEnd, resetComposition, isComposingKeyEvent } = useImeComposition();
const manipulatingSelection = ref(false);
const toolbarSize = ref({ width: 552, height: 42, rowHeight: 42 });
const toolbarAnchor = ref<Point | null>(null);
let toolbarObserver: ResizeObserver | null = null;
const showProperties = computed(() => propertyTool.value !== 'select');
const canUndo = ref(false);
const canRedo = ref(false);
const hasAnyAnnotations = ref(false);
const busy = ref(false);
const message = ref('');
const pointer = ref<Point | null>(null);
const previewEnabled = ref(true);
let editor: ScreenshotEditor | null = null;
let frameBitmap: DecodedFrame | null = null;
let readingSelectionStyle = false;
let wheelDistance = 0;
let lastWheelTime = 0;
let removeClearListener: (() => void) | null = null;
let removeContextListener: (() => void) | null = null;
let removeCandidatesListener: (() => void) | null = null;
let removePointerLeaveListener: (() => void) | null = null;
let removePreviewListener: (() => void) | null = null;
let drawingSelection: { anchor: Point; offset: Point; pointer: Point; start: Point; altKey: boolean; shiftKey: boolean; hasDragged: boolean; window: Rect | null } | null = null;
const dragging = ref(false);
const spacePressed = ref(false);
let movingSelection: { start: Point; initial: Rect } | null = null;
let resizingSelection: { handle: ResizeHandle; start: Point; pointer: Point; initial: Rect; aspectRatio: number; altKey: boolean; shiftKey: boolean } | null = null;
let armedImageOnlyAction: ScreenshotOutputAction | null = null;
let reselectArmed = false;

const s = computed(() => STRINGS[context.value?.locale ?? 'en']);
const ratioX = computed(() => context.value === null ? 1 : context.value.sourceSize.width / context.value.displaySize.width);
const ratioY = computed(() => context.value === null ? 1 : context.value.sourceSize.height / context.value.displaySize.height);
const sourceBounds = computed(() => ({ x: 0, y: 0, width: context.value?.sourceSize.width ?? 1, height: context.value?.sourceSize.height ?? 1 }));
const selectionDisplay = computed(() => selection.value === null ? null : displayRect(selection.value, ratioX.value, ratioY.value));
const hoverRect = computed(() => {
  const ctx = context.value;
  const point = pointer.value;
  if (ctx === null || point === null || !frameReady.value || !previewEnabled.value || phase.value !== 'select' || selection.value !== null) return null;
  if (dragging.value) return drawingSelection?.window ?? null;
  return candidateAtPoint(ctx.windows, point);
});
const hoverStyle = computed(() => {
  const rect = hoverRect.value;
  return rect === null ? {} : { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` };
});
const toolbarStyle = computed(() => {
  const rect = selectionDisplay.value;
  const ctx = context.value;
  if (rect === null || ctx === null) return {};
  const anchor = toolbarAnchor.value;
  const point = toolbarPosition(rect, ctx.displaySize, toolbarSize.value, anchor === null ? undefined : {
    x: rect.x + anchor.x * rect.width,
    y: rect.y + anchor.y * rect.height,
  });
  return {
    left: `${point.x}px`, top: `${point.y}px`,
  };
});
const selectionStyle = computed(() => {
  const rect = selectionDisplay.value;
  return rect === null ? {} : { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` };
});
const selectionSizeText = computed(() => {
  const rect = selectionDisplay.value ?? hoverRect.value;
  return rect === null ? '' : `${Math.round(rect.width)} × ${Math.round(rect.height)} pt`;
});
const dimRects = computed(() => {
  const ctx = context.value;
  if (ctx === null || !frameReady.value || !previewEnabled.value) return [];
  if (selectionDisplay.value === null && pointer.value === null) return [];
  const bounds = { x: 0, y: 0, ...ctx.displaySize };
  const rect = selectionDisplay.value ?? hoverRect.value;
  return subtractRects(bounds, rect === null ? [] : [rect]);
});

function pointFromEvent(event: PointerEvent): Point {
  return { x: event.clientX, y: event.clientY };
}

const pointerFrames = new LatestFrameScheduler<{ point: Point; altKey: boolean; shiftKey: boolean }>((current) => {
  if (!frameReady.value) return;
  pointer.value = current.point;
  updateDrawing(sourcePoint(current.point, ratioX.value, ratioY.value), current);
});

function updatePointer(point: Point): void {
  pointerFrames.cancel();
  if (!frameReady.value) return;
  pointer.value = point;
}

function queuePointer(event: PointerEvent): void {
  pointerFrames.schedule({ point: pointFromEvent(event), altKey: event.altKey, shiftKey: event.shiftKey });
}

function onRootPointerMove(event: PointerEvent): void {
  if (frameReady.value && context.value !== null && pointer.value === null) {
    if (previewEnabled.value) bridge?.pointerEnter(context.value.captureId);
    pointer.value = pointFromEvent(event);
  }
  if (movingSelection !== null) {
    updateMove(event);
    return;
  }
  if (resizingSelection !== null) {
    updateResize(event);
    return;
  }
  if (phase.value !== 'select') return;
  queuePointer(event);
}

function rebaseDrawing(altKey: boolean, shiftKey: boolean): void {
  const drag = drawingSelection;
  const rect = selection.value;
  if (drag === null || rect === null) return;
  const east = drag.pointer.x + drag.offset.x >= drag.anchor.x;
  const south = drag.pointer.y + drag.offset.y >= drag.anchor.y;
  const corner = { x: rect.x + (east ? rect.width : 0), y: rect.y + (south ? rect.height : 0) };
  drag.anchor = {
    x: rect.x + (altKey ? rect.width / 2 : east ? 0 : rect.width),
    y: rect.y + (altKey ? rect.height / 2 : south ? 0 : rect.height),
  };
  drag.offset = { x: corner.x - drag.pointer.x, y: corner.y - drag.pointer.y };
  drag.altKey = altKey;
  drag.shiftKey = shiftKey;
}

function updateDrawing(current: Point, modifiers: { altKey: boolean; shiftKey: boolean }): void {
  const drag = drawingSelection;
  if (drag === null) return;
  if (!drag.hasDragged) {
    drag.altKey = modifiers.altKey;
    drag.shiftKey = modifiers.shiftKey;
    if (Math.hypot((current.x - drag.start.x) / ratioX.value, (current.y - drag.start.y) / ratioY.value) < MIN_SELECTION_SIZE) return;
    drag.hasDragged = true;
    selection.value = { x: drag.start.x, y: drag.start.y, width: 0, height: 0 };
  }
  if (drag.altKey !== modifiers.altKey || drag.shiftKey !== modifiers.shiftKey) rebaseDrawing(modifiers.altKey, modifiers.shiftKey);
  if (spacePressed.value && selection.value !== null) {
    const previous = selection.value;
    const moved = moveRect(previous, { x: current.x - drag.pointer.x, y: current.y - drag.pointer.y }, sourceBounds.value);
    const delta = { x: moved.x - previous.x, y: moved.y - previous.y };
    drag.anchor = { x: drag.anchor.x + delta.x, y: drag.anchor.y + delta.y };
    drag.offset = { x: drag.offset.x + delta.x - current.x + drag.pointer.x, y: drag.offset.y + delta.y - current.y + drag.pointer.y };
    selection.value = moved;
  } else {
    selection.value = drawRect(drag.anchor, { x: current.x + drag.offset.x, y: current.y + drag.offset.y }, sourceBounds.value, {
      centered: drag.altKey, aspectRatio: drag.shiftKey ? ratioX.value / ratioY.value : undefined,
    });
  }
  drag.pointer = current;
}

function onRootPointerEnter(event: PointerEvent): void {
  if (!frameReady.value || context.value === null) return;
  if (previewEnabled.value) bridge?.pointerEnter(context.value.captureId);
  if (phase.value === 'select') queuePointer(event);
}

function onRootPointerLeave(): void {
  pointerFrames.cancel();
  if (!dragging.value) pointer.value = null;
}

function onSelectionPointerDown(event: PointerEvent): void {
  if (!frameReady.value || phase.value !== 'select' || event.button !== 0) return;
  previewEnabled.value = true;
  pointerFrames.flushPending();
  updatePointer(pointFromEvent(event));
  const window = hoverRect.value;
  bridge?.bandStart(context.value!.captureId);
  const start = sourcePoint(pointFromEvent(event), ratioX.value, ratioY.value);
  drawingSelection = { anchor: start, start, pointer: start, offset: { x: 0, y: 0 }, altKey: event.altKey, shiftKey: event.shiftKey, hasDragged: false, window };
  dragging.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onSelectionPointerUp(event: PointerEvent): void {
  if (drawingSelection === null) return;
  pointerFrames.flushPending();
  updateDrawing(sourcePoint(pointFromEvent(event), ratioX.value, ratioY.value), event);
  const clicked = !drawingSelection.hasDragged;
  const candidate = drawingSelection.window;
  dragging.value = false;
  drawingSelection = null;
  const current = pointFromEvent(event);
  updatePointer(current);
  if (clicked) {
    selection.value = candidate === null ? null : sourceRect(candidate, ratioX.value, ratioY.value);
  }
  if (selection.value !== null && selection.value.width >= MIN_SELECTION_SIZE && selection.value.height >= MIN_SELECTION_SIZE) {
    enterEdit(clicked ? current : null);
  } else {
    selection.value = null;
    bridge?.bandEnd(context.value!.captureId);
  }
}

function enterEdit(anchor: Point | null = null, keyboard = false): void {
  const value = context.value;
  const canvas = canvasRef.value;
  if (selection.value === null || value === null || canvas === null || !frameReady.value) return;
  try {
    if (editor === null) {
      editor = new ScreenshotEditor(canvas, {
        frame: frameRef.value!,
        sourceWidth: value.sourceSize.width,
        sourceHeight: value.sourceSize.height,
        displayWidth: value.displaySize.width,
        displayHeight: value.displaySize.height,
        onHistoryChange: (state) => {
          canUndo.value = state.canUndo;
          canRedo.value = state.canRedo;
          hasAnyAnnotations.value = editor?.hasAnnotations() ?? false;
        },
        onSelectionChange: (selected) => {
          wheelDistance = 0;
          selectedTool.value = selected?.tool ?? null;
          if (selected !== null) {
            readingSelectionStyle = true;
            style.value = selected.style;
            readingSelectionStyle = false;
          }
        },
      });
    } else editor.resize(value.sourceSize.width, value.sourceSize.height, value.displaySize.width, value.displaySize.height);
  } catch {
    bridge?.failed(value.captureId, 'editor-init');
    return;
  }
  const rect = selectionDisplay.value!;
  toolbarAnchor.value = anchor === null ? null : {
    x: Math.max(0, Math.min(1, (anchor.x - rect.x) / rect.width)),
    y: Math.max(0, Math.min(1, (anchor.y - rect.y) / rect.height)),
  };
  phase.value = 'edit';
  editor?.setSelection(selection.value);
  editor?.setTool(tool.value);
  editor?.setStyle(style.value);
  decodeFrameInBackground(value);
  if (keyboard) void nextTick(() => toolbarRef.value?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }));
}

function decodeFrameInBackground(value: ScreenshotOverlayContext): void {
  if (frameBitmap?.captureId === value.captureId || typeof createImageBitmap !== 'function') return;
  const pending: DecodedFrame = { captureId: value.captureId, bitmap: null };
  frameBitmap = pending;
  void fetch(value.frameUrl)
    .then((response) => response.ok ? response.blob() : Promise.reject(new Error('frame-unavailable')))
    .then((blob) => createImageBitmap(blob))
    .then((bitmap) => {
      if (frameBitmap !== pending) {
        bitmap.close();
        return;
      }
      pending.bitmap = bitmap;
      editor?.setFrame(bitmap);
    })
    .catch(() => undefined);
}

function releaseFrameBitmap(): void {
  const bitmap = frameBitmap?.bitmap ?? null;
  frameBitmap = null;
  if (bitmap === null) return;
  if (frameRef.value !== null) editor?.setFrame(frameRef.value);
  bitmap.close();
}

function reselect(force = false): void {
  if (!force && editor?.hasAnnotations() === true && !reselectArmed) {
    reselectArmed = true;
    message.value = s.value.reselectConfirm;
    return;
  }
  reselectArmed = false;
  if (context.value !== null && phase.value === 'edit') bridge?.bandEnd(context.value.captureId);
  editor?.clear();
  selection.value = null;
  phase.value = 'select';
  toolbarAnchor.value = null;
  tool.value = 'select';
  message.value = '';
}

function onSelectionPointerCancel(): void {
  pointerFrames.cancel();
  if (drawingSelection !== null) {
    selection.value = null;
    if (context.value !== null) bridge?.bandEnd(context.value.captureId);
  }
  dragging.value = false;
  drawingSelection = null;
}

function beginResize(event: PointerEvent, handle: ResizeHandle): void {
  if (selection.value === null || event.button !== 0) return;
  pointerFrames.cancel();
  manipulatingSelection.value = true;
  event.stopPropagation();
  const start = sourcePoint(pointFromEvent(event), ratioX.value, ratioY.value);
  resizingSelection = { handle, start, pointer: start, initial: { ...selection.value }, aspectRatio: selection.value.width / selection.value.height, altKey: event.altKey, shiftKey: event.shiftKey };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function updateResize(event: PointerEvent): void {
  updateResizeAt(sourcePoint(pointFromEvent(event), ratioX.value, ratioY.value), event);
}

function updateResizeAt(current: Point, modifiers: { altKey: boolean; shiftKey: boolean }): void {
  const drag = resizingSelection;
  if (drag === null || selection.value === null) return;
  if (drag.altKey !== modifiers.altKey || drag.shiftKey !== modifiers.shiftKey) {
    drag.initial = { ...selection.value };
    drag.start = drag.pointer;
    drag.altKey = modifiers.altKey;
    drag.shiftKey = modifiers.shiftKey;
  }
  const delta = { x: current.x - drag.start.x, y: current.y - drag.start.y };
  selection.value = spacePressed.value
    ? moveRect(drag.initial, delta, sourceBounds.value)
    : resizeRect(drag.initial, drag.handle, delta, sourceBounds.value, { centered: drag.altKey, aspectRatio: drag.shiftKey ? drag.aspectRatio : undefined });
  drag.pointer = current;
  editor?.setSelection(selection.value);
}

function endResize(event?: PointerEvent): void {
  if (event?.type === 'pointerup') updateResize(event);
  resizingSelection = null;
  manipulatingSelection.value = false;
}

function beginMove(event: PointerEvent): void {
  if (selection.value === null || event.button !== 0) return;
  pointerFrames.cancel();
  editor?.canvas.discardActiveObject();
  manipulatingSelection.value = true;
  event.stopPropagation();
  movingSelection = { start: sourcePoint(pointFromEvent(event), ratioX.value, ratioY.value), initial: { ...selection.value } };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function updateMove(event: PointerEvent): void {
  if (movingSelection === null) return;
  const current = sourcePoint(pointFromEvent(event), ratioX.value, ratioY.value);
  selection.value = moveRect(
    movingSelection.initial,
    { x: current.x - movingSelection.start.x, y: current.y - movingSelection.start.y },
    sourceBounds.value,
  );
  if (selection.value !== null) editor?.setSelection(selection.value);
}

function endMove(event?: PointerEvent): void {
  if (event?.type === 'pointerup') updateMove(event);
  movingSelection = null;
  manipulatingSelection.value = false;
}

function onRootPointerDown(event: PointerEvent): void {
  const target = event.target as HTMLElement;
  if (target.closest('.shot__toolbar') || isEditableKeyTarget(target) || editor?.isTextEditing() === true) return;
  if (!spacePressed.value && target.closest('.shot__handle, .shot__move-grip')) return;
  const rect = selectionDisplay.value;
  if (phase.value !== 'edit' || (!spacePressed.value && tool.value !== 'select') || rect === null || event.button !== 0) return;
  if (event.clientX < rect.x || event.clientY < rect.y || event.clientX > rect.x + rect.width || event.clientY > rect.y + rect.height) return;
  if (!spacePressed.value && editor?.hasObjectAtPointer(event)) return;
  event.preventDefault();
  beginMove(event);
}

function onRootMouseDown(event: MouseEvent): void {
  if (movingSelection !== null) event.stopImmediatePropagation();
}

function onContextMenu(event: MouseEvent): void {
  event.preventDefault();
  if (busy.value) return;
  if (editor?.isTextEditing()) editor.cancelTextEditing();
  else if (tool.value !== 'select') chooseTool('select');
  else if (phase.value === 'edit') reselect();
  else cancelCapture();
}

function onWheel(event: WheelEvent): void {
  if (!showProperties.value || busy.value || isEditableKeyTarget(event.target) || editor?.isTextEditing() || event.buttons !== 0 || event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) {
    wheelDistance = 0;
    return;
  }
  event.preventDefault();
  const now = Date.now();
  if (now - lastWheelTime > 200 || Math.sign(wheelDistance) !== Math.sign(event.deltaY)) wheelDistance = 0;
  lastWheelTime = now;
  const distance = event.deltaY * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? 60 : 1);
  wheelDistance += Math.max(-60, Math.min(60, distance));
  if (Math.abs(wheelDistance) < 60) return;
  const delta = wheelDistance < 0 ? 1 : -1;
  wheelDistance += delta * 60;
  if (propertyTool.value === 'text' || propertyTool.value === 'number') style.value.fontSize = Math.max(12, Math.min(72, style.value.fontSize + delta));
  else if (propertyTool.value === 'mosaic') style.value.pixelSize = Math.max(6, Math.min(48, style.value.pixelSize + delta));
  else style.value.width = Math.max(1, Math.min(16, style.value.width + delta));
  void nextTick(commitStyle);
}

function chooseTool(next: ScreenshotTool): void {
  wheelDistance = 0;
  reselectArmed = false;
  message.value = '';
  tool.value = tool.value === next ? 'select' : next;
  if (next === 'line' || next === 'arrow') lineMode.value = next;
  if (next === 'rect' || next === 'ellipse') shapeMode.value = next;
  editor?.setTool(tool.value);
  editor?.setStyle(style.value);
}

function currentTool(next: ScreenshotTool): ScreenshotTool {
  if (next === 'rect') return shapeMode.value;
  if (next === 'arrow') return lineMode.value;
  return next;
}

function chooseShapeMode(value: string): void {
  const next = value === 'ellipse' ? 'ellipse' : 'rect';
  if (tool.value !== next) chooseTool(next);
}

function chooseLineMode(value: string): void {
  const next = value === 'line' ? 'line' : 'arrow';
  if (tool.value !== next) chooseTool(next);
}

function chooseColor(color: string): void {
  style.value.color = color;
  void nextTick(() => editor?.commitStyle());
}

function commitStyle(): void {
  editor?.commitStyle();
}

function undo(): void {
  editor?.undo();
}

function redo(): void {
  editor?.redo();
}

function deleteAnnotations(): void {
  if (busy.value) return;
  if (selectedTool.value === null) editor?.clear();
  else editor?.deleteSelection();
}

function onRootDoubleClick(event: MouseEvent): void {
  if (spacePressed.value || phase.value !== 'edit' || tool.value !== 'select' || editor?.isTextEditing() === true || editor?.hasObjectAtPointer(event)) return;
  const target = event.target as HTMLElement | null;
  if (target !== null && target.closest('.shot__toolbar, .shot__handle, .shot__move-grip') !== null) return;
  const rect = selectionDisplay.value;
  if (rect !== null && event.clientX >= rect.x && event.clientX <= rect.x + rect.width && event.clientY >= rect.y && event.clientY <= rect.y + rect.height) {
    void perform('add');
  }
}

function isEditableKeyTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
}

function onCommentKeydown(event: KeyboardEvent): void {
  if (isComposingKeyEvent(event) || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.key !== 'Enter') return;
  event.preventDefault();
  void perform('add');
}

async function perform(action: ScreenshotOutputAction): Promise<void> {
  const frame = frameRef.value;
  const currentSelection = selection.value;
  const ctx = context.value;
  if (bridge === undefined || frame === null || currentSelection === null || ctx === null || editor === null || busy.value) return;
  if (action !== 'add' && comment.value.trim() !== '' && armedImageOnlyAction !== action) {
    armedImageOnlyAction = action;
    message.value = s.value.imageOnly;
    return;
  }
  armedImageOnlyAction = null;
  message.value = '';
  busy.value = true;
  try {
    const output = await exportScreenshot(frameBitmap?.bitmap ?? frame, editor, currentSelection);
    const result = await bridge.perform({
      captureId: ctx.captureId,
      action,
      displayId: ctx.displayId,
      pngBytes: output.bytes,
      width: output.width,
      height: output.height,
      comment: action === 'add' ? comment.value.trim() : '',
    });
    if (context.value?.captureId === ctx.captureId && result.status === 'error') message.value = s.value.failed;
  } catch {
    if (context.value?.captureId === ctx.captureId) message.value = s.value.failed;
  } finally {
    if (context.value?.captureId === ctx.captureId) busy.value = false;
  }
}

function handleKey(event: KeyboardEvent): void {
  if (isComposingKeyEvent(event)) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    cancelCapture();
    return;
  }
  const modifier = event.metaKey || event.ctrlKey;
  if (editor?.isTextEditing() === true || isEditableKeyTarget(event.target)) {
    if (modifier && !event.altKey && context.value !== null) {
      const commands: Record<string, Parameters<ScreenshotBridge['editText']>[1]> = {
        a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: event.shiftKey ? 'redo' : 'undo', y: 'redo',
      };
      const command = commands[event.key.toLowerCase()];
      if (command !== undefined) {
        event.preventDefault();
        bridge?.editText(context.value.captureId, command);
      }
    }
    return;
  }
  if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof HTMLButtonElement) return;
  if (event.key === ' ') {
    if (frameReady.value && !modifier && !busy.value) {
      event.preventDefault();
      setSpacePressed(true);
    }
    return;
  }
  if (event.key === 'Alt' || event.key === 'Shift') {
    updateGestureModifiers(event);
    return;
  }
  if (dragging.value || manipulatingSelection.value) return;
  if (modifier && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) editor?.redo();
    else editor?.undo();
    return;
  }
  if (modifier && (event.key.toLowerCase() === 'y')) {
    event.preventDefault();
    editor?.redo();
    return;
  }
  if (modifier && event.key.toLowerCase() === 'c' && phase.value === 'edit') {
    event.preventDefault();
    void perform('copy');
    return;
  }
  if (modifier && event.key.toLowerCase() === 's' && phase.value === 'edit') {
    event.preventDefault();
    void perform('save');
    return;
  }
  if (modifier && event.key.toLowerCase() === 't' && phase.value === 'edit') {
    event.preventDefault();
    void perform('pin');
    return;
  }
  if (event.key === 'Enter' && !modifier && !event.altKey && !event.shiftKey && phase.value === 'edit') {
    event.preventDefault();
    void perform('add');
    return;
  }
  if (event.key === 'Enter' && !modifier && !event.altKey && !event.shiftKey && hoverRect.value !== null && context.value !== null) {
    event.preventDefault();
    bridge?.bandStart(context.value.captureId);
    selection.value = sourceRect(hoverRect.value, ratioX.value, ratioY.value);
    enterEdit(pointer.value, true);
    return;
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && phase.value === 'edit') {
    if (editor?.deleteSelection() === true) event.preventDefault();
    return;
  }
  if (phase.value === 'edit' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    const delta = {
      x: event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
      y: event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0,
    };
    if (editor?.nudgeSelection(delta.x, delta.y) !== true && selection.value !== null) {
      selection.value = moveRect(selection.value, delta, {
        x: 0,
        y: 0,
        width: context.value?.sourceSize.width ?? 1,
        height: context.value?.sourceSize.height ?? 1,
      });
      editor?.setSelection(selection.value);
    }
    return;
  }
  const next = (Object.keys(TOOL_BINDINGS) as ScreenshotTool[]).find((candidate) => TOOL_BINDINGS[candidate] === event.key.toLowerCase());
  if (next !== undefined && phase.value === 'edit' && !modifier) {
    event.preventDefault();
    chooseTool(next);
  }
}

function handleKeyUp(event: KeyboardEvent): void {
  if (event.key === ' ') setSpacePressed(false);
  if (event.isComposing || editor?.isTextEditing() === true || isEditableKeyTarget(event.target)) return;
  if (event.key === 'Alt' || event.key === 'Shift') updateGestureModifiers(event);
}

function updateGestureModifiers(modifiers: { altKey: boolean; shiftKey: boolean }): void {
  pointerFrames.flushPending();
  if (drawingSelection !== null) updateDrawing(drawingSelection.pointer, modifiers);
  if (resizingSelection !== null) updateResizeAt(resizingSelection.pointer, modifiers);
}

function setSpacePressed(pressed: boolean): void {
  if (pressed === spacePressed.value) return;
  pointerFrames.flushPending();
  if (drawingSelection !== null) rebaseDrawing(drawingSelection.altKey, drawingSelection.shiftKey);
  if (resizingSelection !== null && selection.value !== null) {
    resizingSelection.initial = { ...selection.value };
    resizingSelection.start = resizingSelection.pointer;
  }
  spacePressed.value = pressed;
}

function resetGesture(): void {
  setSpacePressed(false);
  onSelectionPointerCancel();
  endResize();
  endMove();
}

function onLostPointerCapture(event: PointerEvent): void {
  if (drawingSelection === null && movingSelection === null && resizingSelection === null) return;
  if (event.buttons === 0) {
    onSelectionPointerUp(event);
    updateResize(event);
    endResize();
    updateMove(event);
    endMove();
  } else resetGesture();
}

function onFocusIn(event: FocusEvent): void {
  if (isEditableKeyTarget(event.target)) setSpacePressed(false);
}

function onToolbarClick(event: MouseEvent): void {
  if (event.detail === 0) return;
  const button = (event.target as HTMLElement).closest('button');
  if (button !== null && button === document.activeElement) button.blur();
}

watch(style, (value) => {
  if (!readingSelectionStyle) editor?.setStyle(value);
}, { deep: true, flush: 'sync' });
watch(phase, () => { wheelDistance = 0; });
watch(comment, () => {
  armedImageOnlyAction = null;
});

watch(toolbarRef, (element) => {
  toolbarObserver?.disconnect();
  if (element === null) return;
  toolbarObserver = new ResizeObserver(([entry]) => {
    if (entry === undefined) return;
    const bounds = element.getBoundingClientRect();
    const rowHeight = element.querySelector('.shot__tools')?.getBoundingClientRect().height ?? bounds.height;
    toolbarSize.value = { width: bounds.width, height: bounds.height, rowHeight: Math.min(bounds.height, rowHeight + 1) };
  });
  toolbarObserver.observe(element);
});

function cancelCapture(): void {
  if (context.value !== null) bridge?.cancel(context.value.captureId);
}

async function setContext(value: ScreenshotOverlayContext | null): Promise<void> {
  pointerFrames.cancel();
  context.value = value;
  frameReady.value = false;
  phase.value = 'select';
  selection.value = null;
  pointer.value = null;
  previewEnabled.value = true;
  comment.value = '';
  resetComposition();
  busy.value = false;
  toolbarAnchor.value = null;
  message.value = '';
  tool.value = 'select';
  lineMode.value = 'arrow';
  shapeMode.value = 'rect';
  selectedTool.value = null;
  hasAnyAnnotations.value = false;
  canUndo.value = false;
  canRedo.value = false;
  movingSelection = null;
  resizingSelection = null;
  manipulatingSelection.value = false;
  drawingSelection = null;
  dragging.value = false;
  spacePressed.value = false;
  reselectArmed = false;
  armedImageOnlyAction = null;
  editor?.reset();
  releaseFrameBitmap();
  const frame = frameRef.value;
  frame?.removeAttribute('src');
  if (value === null) return;
  try {
    document.documentElement.lang = value.locale;
    i18n.locale.value = value.locale;
    if (frame === null) throw new Error('overlay-elements-missing');
    frame.src = value.frameUrl;
    await frame.decode();
    if (context.value?.captureId !== value.captureId) return;
    frameReady.value = true;
    if (value.pointer !== null) updatePointer(value.pointer);
    await nextTick();
    if (bridge?.platform !== 'win32') {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }
    if (context.value?.captureId === value.captureId) bridge?.ready(value.captureId);
  } catch {
    if (context.value?.captureId === value.captureId) bridge?.failed(value.captureId, 'frame-decode');
  }
}

onMounted(() => {
  if (bridge === undefined) return;
  removeContextListener = bridge.onContext((value) => {
    void setContext(value).catch(() => {
      if (value !== null && context.value?.captureId === value.captureId) bridge.failed(value.captureId, 'overlay-init');
    });
  });
  removeCandidatesListener = bridge.onWindowCandidates((captureId, windows) => {
    if (context.value?.captureId === captureId) context.value.windows = windows;
  });
  removeClearListener = bridge.onClearSelection((captureId) => {
    if (context.value?.captureId === captureId) {
      resetGesture();
      reselect(true);
      pointer.value = null;
      previewEnabled.value = false;
    }
  });
  removePreviewListener = bridge.onPreviewEnabled((captureId) => {
    if (context.value?.captureId === captureId) previewEnabled.value = true;
  });
  removePointerLeaveListener = bridge.onPointerLeave((captureId) => {
    if (context.value?.captureId === captureId) {
      pointerFrames.cancel();
      pointer.value = null;
    }
  });
  window.addEventListener('keydown', handleKey, true);
  window.addEventListener('keyup', handleKeyUp, true);
  window.addEventListener('blur', resetGesture);
  window.addEventListener('focusin', onFocusIn);
  bridge.loaded();
});

onBeforeUnmount(() => {
  pointerFrames.cancel();
  toolbarObserver?.disconnect();
  removeClearListener?.();
  removeContextListener?.();
  removeCandidatesListener?.();
  removePointerLeaveListener?.();
  removePreviewListener?.();
  window.removeEventListener('keydown', handleKey, true);
  window.removeEventListener('keyup', handleKeyUp, true);
  window.removeEventListener('blur', resetGesture);
  window.removeEventListener('focusin', onFocusIn);
  releaseFrameBitmap();
  editor?.dispose();
});
</script>

<template>
  <main
    class="shot"
    :class="{ 'is-editing': phase === 'edit', 'is-space-moving': spacePressed, 'is-manipulating': manipulatingSelection }"
    @pointerdown.capture="onRootPointerDown"
    @mousedown.capture="onRootMouseDown"
    @pointermove="onRootPointerMove"
    @pointerenter="onRootPointerEnter"
    @pointerleave="onRootPointerLeave"
    @pointerup="endMove"
    @pointercancel="resetGesture"
    @lostpointercapture="onLostPointerCapture"
    @dblclick="onRootDoubleClick"
    @contextmenu="onContextMenu"
    @wheel="onWheel"
  >
    <img v-show="frameReady" ref="frameRef" class="shot__frame" alt="" crossorigin="anonymous" draggable="false" />
    <div
      v-for="(rect, index) in dimRects"
      :key="index"
      class="shot__dim"
      :style="{ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` }"
    />
    <div v-if="hoverRect" class="shot__hover" :style="hoverStyle">
      <span class="shot__size" :class="{ 'is-inside': hoverRect.y < 28 }">{{ selectionSizeText }}</span>
    </div>
    <div
      class="shot__selection-surface"
      :class="{ 'is-active': frameReady && (phase === 'select' || spacePressed) }"
      @pointerdown="onSelectionPointerDown"
      @pointerup="onSelectionPointerUp"
      @pointercancel="onSelectionPointerCancel"
    />
    <canvas ref="canvasRef" class="shot__canvas" />
    <ScreenshotLoupe
      v-if="frameReady && previewEnabled && phase === 'select' && pointer && frameRef && context"
      :context="context"
      :frame="frameRef"
      :pointer="pointer"
      :allow-format-toggle="!dragging"
    />
    <div v-if="selectionDisplay" class="shot__selection" :style="selectionStyle">
      <button
        class="shot__size shot__move-grip"
        :class="{ 'is-inside': selectionDisplay.y < 28 }"
        type="button"
        :aria-label="s.move"
        @pointerdown="beginMove"
        @pointermove="updateMove"
        @pointerup="endMove"
        @pointercancel="endMove"
      >{{ selectionSizeText }}</button>
      <template v-if="phase === 'edit'">
        <button
          v-for="handle in (['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as ResizeHandle[])"
          :key="handle"
          class="shot__handle"
          :class="`shot__handle--${handle}`"
          type="button"
          :aria-label="`${s.select} ${handle}`"
          @pointerdown="beginResize($event, handle)"
          @pointermove="updateResize"
          @pointerup="endResize"
          @pointercancel="endResize"
        />
      </template>
    </div>
    <section
      v-if="phase === 'edit'"
      v-show="!manipulatingSelection"
      ref="toolbarRef"
      class="shot__toolbar"
      :style="toolbarStyle"
      @pointerdown.stop
      @contextmenu.stop.prevent
      @wheel.stop
      @click="onToolbarClick"
    >
      <div class="shot__tools" role="toolbar" :aria-label="s.select">
        <div class="shot__tool-group">
          <IconButton
            v-for="item in TOOL_KEYS"
            :key="item.tool"
            size="sm"
            :class="{ 'is-active': tool === currentTool(item.tool) }"
            :aria-pressed="tool === currentTool(item.tool)"
            :label="item.tool === 'rect' ? `${s.rect} / ${s.ellipse}` : s[item.tool]"
            :tooltip="s[currentTool(item.tool)]"
            :keys="hintKeys(TOOL_BINDINGS[currentTool(item.tool)])"
            @click="chooseTool(currentTool(item.tool))"
          ><Icon :name="item.tool === 'rect' && shapeMode === 'ellipse' ? 'shape-circle' : item.icon" /></IconButton>
        </div>
        <div class="shot__tool-group">
          <IconButton size="sm" :disabled="!canUndo" :label="s.undo" :tooltip="s.undo" :keys="hintKeys('mod+z')" @click="undo"><Icon name="undo" /></IconButton>
          <IconButton size="sm" :disabled="busy || !canRedo" :label="s.redo" :tooltip="s.redo" :keys="hintKeys('shift+mod+z')" @click="redo"><Icon name="redo" /></IconButton>
          <IconButton size="sm" :disabled="busy || (!hasAnyAnnotations && selectedTool === null)" :label="selectedTool === null ? s.clearAnnotations : s.deleteSelected" :tooltip="selectedTool === null ? s.clearAnnotations : s.deleteSelected" :keys="selectedTool === null ? [] : hintKeys('backspace')" @click="deleteAnnotations"><Icon name="trash" /></IconButton>
        </div>
        <div class="shot__tool-group">
          <IconButton size="sm" :disabled="busy" :label="s.close" :tooltip="s.close" :keys="hintKeys('escape')" @click="cancelCapture"><Icon name="close" /></IconButton>
          <IconButton size="sm" :disabled="busy" :label="s.pin" :tooltip="s.pin" :keys="hintKeys('mod+t')" @click="perform('pin')"><Icon name="pin" /></IconButton>
          <IconButton size="sm" :disabled="busy" :label="s.save" :tooltip="s.save" :keys="hintKeys('mod+s')" @click="perform('save')"><Icon name="download" /></IconButton>
          <IconButton size="sm" :disabled="busy" :label="s.copy" :tooltip="s.copy" :keys="hintKeys('mod+c')" @click="perform('copy')"><Icon name="copy" /></IconButton>
        </div>
      </div>
      <div v-if="showProperties" class="shot__properties">
        <SegmentedControl
          v-if="tool === 'rect' || tool === 'ellipse'"
          :model-value="shapeMode"
          :options="[{ value: 'rect', label: s.rect }, { value: 'ellipse', label: s.ellipse }]"
          :aria-label="`${s.rect} / ${s.ellipse}`"
          size="sm"
          @update:model-value="chooseShapeMode"
        />
        <SegmentedControl
          v-if="tool === 'arrow' || tool === 'line'"
          :model-value="lineMode"
          :options="[{ value: 'arrow', label: s.arrow }, { value: 'line', label: s.line }]"
          :aria-label="s.arrow"
          size="sm"
          @update:model-value="chooseLineMode"
        />
        <div v-if="propertyTool !== 'mosaic'" class="shot__colors">
          <button
            v-for="color in COLORS"
            :key="color"
            type="button"
            :class="{ 'is-active': style.color === color }"
            :style="{ backgroundColor: color }"
            :aria-label="color"
            @click="chooseColor(color)"
          />
        </div>
        <label>
          <span>{{ propertyTool === 'text' || propertyTool === 'number' ? s.fontSize : propertyTool === 'mosaic' ? s.pixelSize : s.width }}</span>
          <input v-if="propertyTool === 'text' || propertyTool === 'number'" v-model.number="style.fontSize" type="range" min="12" max="72" @change="commitStyle" />
          <input v-else-if="propertyTool === 'mosaic'" v-model.number="style.pixelSize" type="range" min="6" max="48" @change="commitStyle" />
          <input v-else v-model.number="style.width" type="range" min="1" max="16" @change="commitStyle" />
        </label>
        <label v-if="propertyTool === 'rect' || propertyTool === 'ellipse'" class="shot__check">
          <input v-model="style.fill" type="checkbox" @change="commitStyle" /><span>{{ s.fill }}</span>
        </label>
      </div>
      <div class="shot__comment">
        <textarea id="shot-comment" v-model="comment" rows="1" :disabled="busy" maxlength="20000" :aria-label="s.writeComment" :placeholder="s.comment" @keydown="onCommentKeydown" @compositionstart="handleCompositionStart" @compositionend="handleCompositionEnd" />
      </div>
      <div class="shot__conversation-actions" role="group" :aria-label="s.add">
        <Tooltip :text="s.addHint">
          <Button variant="primary" size="xs" :loading="busy" @click="perform('add')">{{ s.add }}<Kbd class="shot__enter" :keys="['enter']" variant="button" /></Button>
        </Tooltip>
      </div>
      <p v-if="message" class="shot__message" role="status">{{ message }}</p>
    </section>
  </main>
</template>

<style scoped>
.shot { position: relative; width: 100%; height: 100%; overflow: hidden; color: var(--shot-toolbar-text); user-select: none; }
.shot__frame, .shot__canvas, .shot__selection-surface { position: absolute; inset: 0; width: 100%; height: 100%; }
.shot__frame { object-fit: fill; pointer-events: none; animation: none; transition: none; transform: none; }
.shot__dim { position: absolute; z-index: 2; background: var(--shot-dim); pointer-events: none; }
.shot__selection, .shot__hover { position: absolute; z-index: 5; border: 1px solid var(--shot-selection); box-shadow: 0 0 0 1px var(--shot-selection-edge); pointer-events: none; }
.shot__selection-surface { z-index: 4; cursor: crosshair; pointer-events: none; }
.shot__selection-surface.is-active { pointer-events: auto; }
.shot.is-space-moving .shot__selection-surface { cursor: grab; }
.shot.is-manipulating.is-space-moving .shot__selection-surface { cursor: grabbing; }
.shot__canvas { pointer-events: none; }
.shot :deep(.canvas-container) { position: absolute !important; inset: 0; z-index: 3; pointer-events: none; }
.shot.is-editing :deep(.canvas-container) { pointer-events: auto; }
.shot__size { position: absolute; top: -28px; left: 0; display: flex; align-items: center; height: 22px; padding: 0 var(--space-2); border: 0; border-radius: var(--radius-sm); background: var(--shot-label-bg); color: var(--shot-selection); font-size: var(--text-xs); font-variant-numeric: tabular-nums; white-space: nowrap; }
.shot__size.is-inside { top: var(--space-2); left: var(--space-2); }
.shot__move-grip { cursor: move; pointer-events: auto; }
.shot__handle { position: absolute; width: 12px; height: 12px; padding: 0; border: 0; background: transparent; pointer-events: auto; }
.shot__handle::after { content: ''; position: absolute; inset: 3px; border: 1px solid var(--shot-selection-edge); background: var(--shot-selection); }
.shot__handle--nw { left: -6px; top: -6px; cursor: nwse-resize; }
.shot__handle--n { left: calc(50% - 6px); top: -6px; cursor: ns-resize; }
.shot__handle--ne { right: -6px; top: -6px; cursor: nesw-resize; }
.shot__handle--e { right: -6px; top: calc(50% - 6px); cursor: ew-resize; }
.shot__handle--se { right: -6px; bottom: -6px; cursor: nwse-resize; }
.shot__handle--s { left: calc(50% - 6px); bottom: -6px; cursor: ns-resize; }
.shot__handle--sw { left: -6px; bottom: -6px; cursor: nesw-resize; }
.shot__handle--w { left: -6px; top: calc(50% - 6px); cursor: ew-resize; }
.shot__toolbar { position: absolute; z-index: 12; display: grid; grid-template-columns: minmax(0, 1fr); width: max-content; max-width: calc(100vw - 20px); max-height: calc(100vh - 20px); overflow: auto; border: var(--p-hairline) solid var(--shot-toolbar-line); border-radius: var(--radius-md); background: var(--shot-toolbar-bg); box-shadow: var(--shadow-menu); color: var(--shot-toolbar-text); }
.shot__tools, .shot__properties { display: flex; align-items: center; flex-wrap: wrap; }
.shot__tools { grid-column: 1 / -1; grid-row: 1; gap: var(--space-2); padding: var(--space-2) var(--space-1); }
.shot__tool-group { position: relative; display: flex; align-items: center; flex-wrap: wrap; max-width: 100%; }
.shot__tool-group + .shot__tool-group::before { content: ''; position: absolute; left: calc(var(--space-1) * -1); top: 50%; width: var(--p-hairline); height: var(--space-4); transform: translateY(-50%); background: var(--shot-toolbar-line); }
.shot__properties { grid-column: 1 / -1; grid-row: 2; padding: var(--space-2); }
.shot__comment { grid-column: 1 / -1; grid-row: 3; }
.shot__properties, .shot__comment, .shot__message { min-width: 0; contain: inline-size; }
.shot__properties, .shot__comment { border-top: var(--p-hairline) solid var(--shot-toolbar-line); }
.shot__toolbar .is-active { background: var(--shot-toolbar-hover); color: var(--shot-toolbar-text); }
.shot__conversation-actions { grid-column: 1 / -1; grid-row: 4; display: flex; align-items: center; justify-content: flex-end; padding: 0 var(--space-2) var(--space-2); }
.shot__enter { margin-left: var(--space-1); }
.shot__properties { gap: var(--space-3); font-size: var(--text-xs); color: var(--shot-toolbar-muted); }
.shot__properties label, .shot__colors { display: flex; align-items: center; gap: var(--space-2); }
.shot__properties input[type='range'] { width: 64px; accent-color: var(--shot-toolbar-text); }
.shot__colors button { width: 16px; height: 16px; padding: 0; border: var(--p-hairline) solid var(--shot-toolbar-line); border-radius: var(--radius-sm); cursor: pointer; }
.shot__colors button.is-active { outline: 1px solid var(--shot-toolbar-text); outline-offset: 2px; }
.shot__check input { accent-color: var(--shot-toolbar-text); }
.shot__comment { padding: var(--space-2); }
.shot__comment textarea { display: block; width: 100%; min-width: 0; field-sizing: content; min-height: calc(1lh + 2 * var(--space-1-5) + 2 * var(--p-hairline)); max-height: calc(4lh + 2 * var(--space-1-5) + 2 * var(--p-hairline)); resize: none; overflow-y: auto; overflow-wrap: anywhere; padding: var(--space-1-5) var(--space-2); border: var(--p-hairline) solid var(--color-line-strong); border-radius: var(--radius-sm); background: var(--color-surface-overlay); box-shadow: var(--shadow-xs); color: var(--color-text); font-family: var(--font-ui); font-size: var(--text-sm); line-height: var(--leading-normal); transition: border-color var(--duration-base) var(--ease-out), box-shadow var(--duration-base) var(--ease-out); }
.shot__comment textarea:placeholder-shown { height: calc(1lh + 2 * var(--space-1-5) + 2 * var(--p-hairline)); }
.shot__comment textarea::placeholder { color: var(--color-text-faint); }
.shot .shot__comment textarea:focus { outline: none; border-color: var(--color-composer-focus-line); box-shadow: var(--shadow-xs); }
.shot__message { grid-column: 1 / -1; grid-row: 5; max-width: 520px; margin: 0; padding: var(--space-2) var(--space-3); color: var(--shot-toolbar-muted); font-size: var(--text-xs); }
.shot button:focus-visible, .shot textarea:focus-visible, .shot input:focus-visible { outline: none; box-shadow: var(--p-focus-ring); }
</style>
