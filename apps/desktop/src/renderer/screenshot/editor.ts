import {
  Canvas,
  Ellipse,
  FabricObject,
  IText,
  Line,
  Path,
  PencilBrush,
  Rect as FabricRect,
  Textbox,
  type TPointerEventInfo,
} from 'fabric';
import type { Rect, ScreenshotFrame, ScreenshotTool, ScreenshotToolStyle } from './types';

const ANNOTATION_SELECTION_COLOR = '#4a90e2';

type AnnotationKind = ScreenshotTool;

interface AnnotationData {
  annotationId: string;
  annotationKind: AnnotationKind;
}

interface CommonSnapshot {
  id: string;
  kind: AnnotationKind;
  left: number;
  top: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  angle: number;
  stroke: string;
  fill: string;
  strokeWidth: number;
  opacity: number;
  originX: FabricObject['originX'];
  originY: FabricObject['originY'];
}

interface ShapeSnapshot extends CommonSnapshot {
  kind: 'rect' | 'ellipse';
}

interface LineSnapshot extends CommonSnapshot {
  kind: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface ArrowSnapshot extends CommonSnapshot {
  kind: 'arrow';
  start: { x: number; y: number };
  end: { x: number; y: number };
  headSize: number;
}

interface PathSnapshot extends CommonSnapshot {
  kind: 'pen';
  path: Array<Array<string | number>>;
}

interface TextSnapshot extends CommonSnapshot {
  kind: 'text';
  text: string;
  fontSize: number;
}

interface NumberSnapshot extends CommonSnapshot {
  kind: 'number';
  number: number;
  fontSize: number;
}

interface MosaicSnapshot extends CommonSnapshot {
  kind: 'mosaic';
  pixelSize: number;
}

export type AnnotationSnapshot = ShapeSnapshot | LineSnapshot | ArrowSnapshot | PathSnapshot | TextSnapshot | NumberSnapshot | MosaicSnapshot;

interface EditorSnapshot {
  objects: AnnotationSnapshot[];
}

interface ScreenshotEditorOptions {
  frame: ScreenshotFrame;
  sourceWidth: number;
  sourceHeight: number;
  displayWidth: number;
  displayHeight: number;
  onHistoryChange: (state: { canUndo: boolean; canRedo: boolean }) => void;
  onSelectionChange: (selection: { tool: ScreenshotTool; style: ScreenshotToolStyle } | null) => void;
}

function dataFor(object: FabricObject): AnnotationData | null {
  const value = object.get('data') as Partial<AnnotationData> | undefined;
  if (value === undefined || typeof value.annotationId !== 'string' || typeof value.annotationKind !== 'string') return null;
  return value as AnnotationData;
}

function commonSnapshot(object: FabricObject, data: AnnotationData): CommonSnapshot {
  return {
    id: data.annotationId,
    kind: data.annotationKind,
    left: object.left,
    top: object.top,
    width: object.width,
    height: object.height,
    scaleX: object.scaleX,
    scaleY: object.scaleY,
    angle: object.angle,
    stroke: typeof object.stroke === 'string' ? object.stroke : '#ff3b30',
    fill: typeof object.fill === 'string' ? object.fill : 'transparent',
    strokeWidth: object.strokeWidth,
    opacity: object.opacity,
    originX: object.originX,
    originY: object.originY,
  };
}

function serializeObject(object: FabricObject): AnnotationSnapshot | null {
  const data = dataFor(object);
  if (data === null) return null;
  const common = commonSnapshot(object, data);
  if (object instanceof ScreenshotNumber) return { ...common, kind: 'number', number: object.number, fontSize: object.fontSize };
  if (object instanceof ScreenshotMosaic) return { ...common, kind: 'mosaic', pixelSize: object.pixelSize };
  if (data.annotationKind === 'line' && object instanceof Line) {
    return { ...common, kind: 'line', x1: object.x1, y1: object.y1, x2: object.x2, y2: object.y2 };
  }
  if (data.annotationKind === 'arrow' && object instanceof ScreenshotArrow) {
    const points = (object.get('data') as AnnotationData & { start?: { x: number; y: number }; end?: { x: number; y: number } });
    return {
      ...common,
      kind: 'arrow',
      start: points.start ?? { x: 0, y: 0 },
      end: points.end ?? { x: common.width, y: common.height },
      headSize: object.headSize,
    };
  }
  if (data.annotationKind === 'pen' && object instanceof Path) {
    return { ...common, kind: data.annotationKind, path: object.path as Array<Array<string | number>> };
  }
  if (data.annotationKind === 'text' && object instanceof IText) {
    return { ...common, kind: 'text', text: object.text, fontSize: object.fontSize };
  }
  if (data.annotationKind === 'rect' || data.annotationKind === 'ellipse') {
    return { ...common, kind: data.annotationKind };
  }
  return null;
}

function applyCommon(object: FabricObject, snapshot: CommonSnapshot): FabricObject {
  object.set({
    left: snapshot.left,
    top: snapshot.top,
    scaleX: snapshot.scaleX,
    scaleY: snapshot.scaleY,
    angle: snapshot.angle,
    stroke: snapshot.stroke,
    fill: snapshot.fill,
    strokeWidth: snapshot.strokeWidth,
    opacity: snapshot.opacity,
    originX: snapshot.originX,
    originY: snapshot.originY,
    strokeUniform: true,
    data: { annotationId: snapshot.id, annotationKind: snapshot.kind },
  });
  return object;
}

const NUMBER_BACKGROUNDS: Record<string, string> = {
  '#ff3b30': '#dc3028',
  '#ff9500': '#b35f00',
  '#ffcc00': '#907300',
  '#34c759': '#23843a',
  '#00c7be': '#00837d',
  '#1783ff': '#1672e0',
  '#af52de': '#9b42ce',
  '#ffffff': '#737373',
};

class ScreenshotNumber extends FabricObject {
  constructor(readonly number: number, public fontSize: number, color: string) {
    super({ width: fontSize * 1.7, height: fontSize * 1.7, fill: color, strokeWidth: 0, originX: 'center', originY: 'center', objectCaching: false });
  }

  override _render(ctx: CanvasRenderingContext2D): void {
    const fill = typeof this.fill === 'string' ? this.fill : '#ff3b30';
    const color = NUMBER_BACKGROUNDS[fill.toLowerCase()] ?? fill;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, this.width / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 ${this.fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(this.number), 0, 0, this.width * 0.8);
  }
}

class ScreenshotMosaic extends FabricObject {
  private pixels: HTMLCanvasElement | null = null;
  private cachedPixelSize = 0;

  constructor(private readonly frame: ScreenshotFrame, public pixelSize: number) {
    super({ strokeWidth: 0, fill: 'transparent', originX: 'left', originY: 'top', objectCaching: false });
  }

  override _render(ctx: CanvasRenderingContext2D): void {
    const width = this.frame instanceof HTMLImageElement ? this.frame.naturalWidth : this.frame.width;
    const height = this.frame instanceof HTMLImageElement ? this.frame.naturalHeight : this.frame.height;
    if (width === 0 || height === 0) return;
    if (this.pixels === null || this.cachedPixelSize !== this.pixelSize) {
      this.pixels ??= document.createElement('canvas');
      this.pixels.width = Math.max(1, Math.ceil(width / this.pixelSize));
      this.pixels.height = Math.max(1, Math.ceil(height / this.pixelSize));
      this.pixels.getContext('2d')!.drawImage(this.frame, 0, 0, this.pixels.width, this.pixels.height);
      this.cachedPixelSize = this.pixelSize;
    }
    const center = this.getCenterPoint();
    const scaledWidth = this.getScaledWidth();
    const scaledHeight = this.getScaledHeight();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.pixels,
      (center.x - scaledWidth / 2) * this.pixels.width / width,
      (center.y - scaledHeight / 2) * this.pixels.height / height,
      scaledWidth * this.pixels.width / width, scaledHeight * this.pixels.height / height,
      -this.width / 2, -this.height / 2, this.width, this.height);
  }
}

class ScreenshotArrow extends FabricObject {
  private readonly localStart: { x: number; y: number };
  private readonly localEnd: { x: number; y: number };
  private readonly localFirst: { x: number; y: number };
  private readonly localSecond: { x: number; y: number };

  constructor(start: { x: number; y: number }, end: { x: number; y: number }, stroke: string, strokeWidth: number, readonly headSize = Math.max(10, strokeWidth * 4)) {
    const heading = Math.atan2(end.y - start.y, end.x - start.x);
    const head = headSize;
    const headAngle = Math.PI / 6;
    const first = {
      x: end.x - head * Math.cos(heading - headAngle),
      y: end.y - head * Math.sin(heading - headAngle),
    };
    const second = {
      x: end.x - head * Math.cos(heading + headAngle),
      y: end.y - head * Math.sin(heading + headAngle),
    };
    const points = [start, end, first, second];
    const minX = Math.min(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxX = Math.max(...points.map((point) => point.x));
    const maxY = Math.max(...points.map((point) => point.y));
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    super({
      left: minX,
      top: minY,
      width,
      height,
      originX: 'left',
      originY: 'top',
      stroke,
      strokeWidth,
      fill: 'transparent',
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
      strokeUniform: true,
      objectCaching: false,
      selectable: false,
      evented: false,
    });
    const center = { x: minX + width / 2, y: minY + height / 2 };
    this.localStart = { x: start.x - center.x, y: start.y - center.y };
    this.localEnd = { x: end.x - center.x, y: end.y - center.y };
    this.localFirst = { x: first.x - center.x, y: first.y - center.y };
    this.localSecond = { x: second.x - center.x, y: second.y - center.y };
  }

  override _render(ctx: CanvasRenderingContext2D): void {
    ctx.beginPath();
    ctx.moveTo(this.localStart.x, this.localStart.y);
    ctx.lineTo(this.localEnd.x, this.localEnd.y);
    ctx.moveTo(this.localEnd.x, this.localEnd.y);
    ctx.lineTo(this.localFirst.x, this.localFirst.y);
    ctx.moveTo(this.localEnd.x, this.localEnd.y);
    ctx.lineTo(this.localSecond.x, this.localSecond.y);
    this._renderPaintInOrder(ctx);
  }
}

function arrowObject(start: { x: number; y: number }, end: { x: number; y: number }, stroke: string, strokeWidth: number, id: string): ScreenshotArrow {
  const arrow = new ScreenshotArrow(start, end, stroke, strokeWidth);
  arrow.set('data', { annotationId: id, annotationKind: 'arrow', start, end });
  return arrow;
}

function restoreObject(snapshot: AnnotationSnapshot, frame: ScreenshotFrame): FabricObject {
  if (snapshot.kind === 'number') return applyCommon(new ScreenshotNumber(snapshot.number, snapshot.fontSize, snapshot.fill), snapshot);
  if (snapshot.kind === 'mosaic') {
    const object = new ScreenshotMosaic(frame, snapshot.pixelSize);
    object.set({ width: snapshot.width, height: snapshot.height });
    return applyCommon(object, snapshot);
  }
  if (snapshot.kind === 'line') {
    return applyCommon(new Line([snapshot.x1, snapshot.y1, snapshot.x2, snapshot.y2]), snapshot);
  }
  if (snapshot.kind === 'arrow') {
    const object = new ScreenshotArrow(snapshot.start, snapshot.end, snapshot.stroke, snapshot.strokeWidth, snapshot.headSize);
    applyCommon(object, snapshot);
    object.set('data', { annotationId: snapshot.id, annotationKind: 'arrow', start: snapshot.start, end: snapshot.end });
    return object;
  }
  if (snapshot.kind === 'pen') {
    return applyCommon(new Path(snapshot.path as never), snapshot);
  }
  if (snapshot.kind === 'text') {
    return applyCommon(new Textbox(snapshot.text, { fontSize: snapshot.fontSize, width: Math.max(80, snapshot.width) }), snapshot);
  }
  if (snapshot.kind === 'ellipse') {
    return applyCommon(new Ellipse({ rx: snapshot.width / 2, ry: snapshot.height / 2 }), snapshot);
  }
  return applyCommon(new FabricRect({ width: snapshot.width, height: snapshot.height }), snapshot);
}

function snapshotEqual(a: EditorSnapshot, b: EditorSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class ScreenshotEditor {
  readonly canvas: Canvas;
  private tool: ScreenshotTool = 'select';
  private style: ScreenshotToolStyle = { color: '#ff3b30', width: 4, fill: false, fontSize: 24, pixelSize: 16 };
  private selection: Rect | null = null;
  private drawingObject: FabricObject | null = null;
  private drawingStart: { x: number; y: number } | null = null;
  private nextId = 1;
  private restoring = false;
  private history: EditorSnapshot[] = [{ objects: [] }];
  private historyIndex = 0;
  private readonly onHistoryChange: ScreenshotEditorOptions['onHistoryChange'];
  private readonly onSelectionChange: ScreenshotEditorOptions['onSelectionChange'];
  private frame: ScreenshotFrame;

  constructor(element: HTMLCanvasElement, options: ScreenshotEditorOptions) {
    this.frame = options.frame;
    this.onHistoryChange = options.onHistoryChange;
    this.onSelectionChange = options.onSelectionChange;
    this.canvas = new Canvas(element, {
      width: options.sourceWidth,
      height: options.sourceHeight,
      enableRetinaScaling: false,
      selection: true,
      preserveObjectStacking: true,
      fireRightClick: false,
      stopContextMenu: false,
    });
    this.canvas.setDimensions({ width: options.displayWidth, height: options.displayHeight }, { cssOnly: true });
    this.canvas.on('object:added', ({ target }) => this.configureControls(target));
    this.canvas.on('mouse:down', (event) => this.onMouseDown(event));
    this.canvas.on('mouse:move', (event) => this.onMouseMove(event));
    this.canvas.on('mouse:up', () => this.onMouseUp());
    this.canvas.on('path:created', ({ path }) => {
      path.set({
        data: { annotationId: this.id(), annotationKind: 'pen' },
        selectable: false,
        evented: false,
        strokeLineCap: 'round',
        strokeLineJoin: 'round',
      });
      this.commit();
    });
    this.canvas.on('text:editing:exited', ({ target }) => {
      if (!(target instanceof IText)) return;
      if (target.text.trim() === '') this.canvas.remove(target);
      this.commit();
    });
    this.canvas.on('object:modified', () => this.commit());
    this.canvas.on('selection:created', () => this.emitSelection());
    this.canvas.on('selection:updated', () => this.emitSelection());
    this.canvas.on('selection:cleared', () => this.onSelectionChange(null));
    this.updateMode();
  }

  setSelection(selection: Rect): void {
    this.selection = selection;
    this.canvas.clipPath = new FabricRect({
      left: selection.x,
      top: selection.y,
      width: selection.width,
      height: selection.height,
      originX: 'left',
      originY: 'top',
      absolutePositioned: true,
    });
    this.canvas.requestRenderAll();
  }

  setFrame(frame: ScreenshotFrame): void {
    this.frame = frame;
  }

  setTool(tool: ScreenshotTool): void {
    this.tool = tool;
    this.canvas.discardActiveObject();
    this.updateMode();
  }

  setStyle(style: ScreenshotToolStyle): void {
    this.style = { ...style };
    const active = this.canvas.getActiveObjects();
    if (active.length === 0) {
      this.updateBrush();
      return;
    }
    for (const object of active) {
      const data = dataFor(object);
      const center = object.getRelativeCenterPoint();
      if (data?.annotationKind === 'text' && object instanceof IText) {
        object.set({ fill: style.color, fontSize: style.fontSize });
      } else if (object instanceof ScreenshotNumber) {
        object.fontSize = style.fontSize;
        object.set({ fill: style.color, width: style.fontSize * 1.7, height: style.fontSize * 1.7 });
      } else if (object instanceof ScreenshotMosaic) {
        object.pixelSize = style.pixelSize;
      } else {
        object.set({ stroke: style.color, strokeWidth: style.width });
        if (data?.annotationKind === 'rect' || data?.annotationKind === 'ellipse') {
          object.set({ fill: style.fill ? `${style.color}33` : 'transparent' });
        }
      }
      object.setPositionByOrigin(center, 'center', 'center');
      object.setCoords();
    }
    this.canvas.requestRenderAll();
  }

  commitStyle(): void {
    this.commit();
  }

  deleteSelection(): boolean {
    const active = this.canvas.getActiveObjects();
    if (active.length === 0) return false;
    this.canvas.remove(...active);
    this.canvas.discardActiveObject();
    this.canvas.requestRenderAll();
    this.commit();
    return true;
  }

  clear(): void {
    this.canvas.remove(...this.canvas.getObjects());
    this.canvas.discardActiveObject();
    this.commit();
  }

  reset(): void {
    this.restoring = true;
    this.canvas.discardActiveObject();
    this.canvas.remove(...this.canvas.getObjects());
    this.canvas.clipPath = undefined;
    this.selection = null;
    this.drawingStart = null;
    this.drawingObject = null;
    this.history = [{ objects: [] }];
    this.historyIndex = 0;
    this.nextId = 1;
    this.tool = 'select';
    this.canvas.setDimensions({ width: 1, height: 1 });
    this.restoring = false;
    this.updateMode();
    this.emitHistory();
  }

  resize(sourceWidth: number, sourceHeight: number, displayWidth: number, displayHeight: number): void {
    this.canvas.setDimensions({ width: sourceWidth, height: sourceHeight });
    this.canvas.setDimensions({ width: displayWidth, height: displayHeight }, { cssOnly: true });
  }

  hasAnnotations(): boolean {
    return this.canvas.getObjects().length > 0;
  }

  hasObjectAtPointer(event: MouseEvent): boolean {
    return this.canvas.findTarget(event).target !== undefined;
  }

  nudgeSelection(deltaX: number, deltaY: number): boolean {
    const active = this.canvas.getActiveObjects();
    if (active.length === 0) return false;
    for (const object of active) {
      object.set({ left: object.left + deltaX, top: object.top + deltaY });
      object.setCoords();
    }
    this.canvas.requestRenderAll();
    this.commit();
    return true;
  }

  undo(): void {
    if (this.historyIndex === 0) return;
    this.historyIndex -= 1;
    this.restore(this.history[this.historyIndex]!);
  }

  redo(): void {
    if (this.historyIndex >= this.history.length - 1) return;
    this.historyIndex += 1;
    this.restore(this.history[this.historyIndex]!);
  }

  annotationCanvas(selection: Rect): HTMLCanvasElement {
    this.canvas.discardActiveObject();
    this.canvas.requestRenderAll();
    return this.canvas.toCanvasElement(1, {
      left: selection.x,
      top: selection.y,
      width: selection.width,
      height: selection.height,
    });
  }

  isTextEditing(): boolean {
    return this.canvas.getActiveObjects().some((object) => object instanceof IText && object.isEditing);
  }

  cancelTextEditing(): boolean {
    const text = this.canvas.getActiveObjects().find((object): object is IText => object instanceof IText && object.isEditing);
    if (text === undefined) return false;
    text.exitEditing();
    if (text.text.trim() === '') this.canvas.remove(text);
    this.canvas.discardActiveObject();
    this.canvas.requestRenderAll();
    this.commit();
    return true;
  }

  dispose(): void {
    void this.canvas.dispose();
  }

  private id(): string {
    const value = `annotation-${this.nextId}`;
    this.nextId += 1;
    return value;
  }

  private configureControls(object: FabricObject): void {
    const ratio = this.canvas.getWidth() / (parseFloat(this.canvas.upperCanvasEl.style.width) || this.canvas.getWidth());
    object.set({
      cornerColor: '#ffffff', cornerStrokeColor: ANNOTATION_SELECTION_COLOR, borderColor: ANNOTATION_SELECTION_COLOR,
      cornerStyle: 'rect', cornerSize: 8 * ratio, transparentCorners: false,
      borderScaleFactor: ratio, padding: 3 * ratio, lockRotation: true,
      strokeUniform: true,
    });
    object.setControlsVisibility({ mtr: false });
    object.drawBorders = function(ctx, options, styleOverride): void {
      ctx.save();
      ctx.lineWidth = 3 * ratio;
      FabricObject.prototype.drawBorders.call(this, ctx, options, { ...styleOverride, borderColor: '#ffffff' });
      ctx.lineWidth = ratio;
      FabricObject.prototype.drawBorders.call(this, ctx, options, { ...styleOverride, borderColor: ANNOTATION_SELECTION_COLOR });
      ctx.restore();
    };
  }

  private updateMode(): void {
    this.canvas.isDrawingMode = this.tool === 'pen';
    this.canvas.selection = false;
    this.canvas.skipTargetFind = this.tool !== 'select';
    for (const object of this.canvas.getObjects()) {
      object.set({ selectable: this.tool === 'select', evented: this.tool === 'select' });
    }
    this.updateBrush();
    this.canvas.defaultCursor = this.tool === 'select' ? 'move' : 'crosshair';
    this.canvas.requestRenderAll();
  }

  private emitSelection(): void {
    const object = this.canvas.getActiveObjects()[0];
    const kind = object === undefined ? undefined : dataFor(object)?.annotationKind;
    if (object === undefined || kind === undefined) {
      this.onSelectionChange(null);
      return;
    }
    const color = kind === 'text' || kind === 'number' ? object.fill : object.stroke;
    this.onSelectionChange({
      tool: kind,
      style: {
        color: typeof color === 'string' ? color.slice(0, 7) : this.style.color,
        width: kind === 'text' || kind === 'number' || kind === 'mosaic' ? this.style.width : object.strokeWidth,
        fill: kind === 'rect' || kind === 'ellipse' ? object.fill !== null && object.fill !== 'transparent' : this.style.fill,
        fontSize: object instanceof IText || object instanceof ScreenshotNumber ? object.fontSize : this.style.fontSize,
        pixelSize: object instanceof ScreenshotMosaic ? object.pixelSize : this.style.pixelSize,
      },
    });
  }

  private updateBrush(): void {
    if (this.tool !== 'pen') return;
    const brush = new PencilBrush(this.canvas);
    brush.color = this.style.color;
    brush.width = this.style.width;
    this.canvas.freeDrawingBrush = brush;
  }

  private insideSelection(x: number, y: number): boolean {
    const selection = this.selection;
    return selection !== null && x >= selection.x && y >= selection.y && x <= selection.x + selection.width && y <= selection.y + selection.height;
  }

  private onMouseDown(event: TPointerEventInfo): void {
    if (this.tool === 'select' || this.tool === 'pen') return;
    const point = event.scenePoint;
    if (!this.insideSelection(point.x, point.y)) return;
    if (this.tool === 'number') {
      const number = Math.max(0, ...this.canvas.getObjects().filter((object): object is ScreenshotNumber => object instanceof ScreenshotNumber).map((object) => object.number)) + 1;
      const marker = new ScreenshotNumber(number, this.style.fontSize, this.style.color);
      marker.set({ left: point.x, top: point.y, selectable: false, evented: false, data: { annotationId: this.id(), annotationKind: 'number' } });
      this.canvas.add(marker);
      this.commit();
      return;
    }
    this.drawingStart = { x: point.x, y: point.y };
    if (this.tool === 'text') {
      const text = new Textbox('', {
        left: point.x,
        top: point.y,
        originX: 'left',
        originY: 'top',
        width: Math.max(120, this.style.fontSize * 6),
        fontSize: this.style.fontSize,
        fill: this.style.color,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
        data: { annotationId: this.id(), annotationKind: 'text' },
      });
      text.setControlsVisibility({ mtr: false });
      this.canvas.add(text);
      this.canvas.setActiveObject(text);
      text.enterEditing();
      text.selectAll();
      this.canvas.requestRenderAll();
      this.drawingStart = null;
      return;
    }
    const common = {
      left: point.x,
      top: point.y,
      width: 1,
      height: 1,
      stroke: this.style.color,
      strokeWidth: this.style.width,
      fill: 'transparent',
      originX: 'left' as const,
      originY: 'top' as const,
      selectable: false,
      evented: false,
      strokeUniform: true,
      data: { annotationId: this.id(), annotationKind: this.tool },
    };
    if (this.tool === 'mosaic') {
      this.drawingObject = new ScreenshotMosaic(this.frame, this.style.pixelSize);
      this.drawingObject.set({ left: point.x, top: point.y, width: 1, height: 1, selectable: false, evented: false, data: common.data });
    } else if (this.tool === 'ellipse') {
      this.drawingObject = new Ellipse({ ...common, rx: 0.5, ry: 0.5 });
    } else if (this.tool === 'line' || this.tool === 'arrow') {
      this.drawingObject = new Line([point.x, point.y, point.x, point.y], {
        stroke: common.stroke,
        strokeWidth: common.strokeWidth,
        selectable: common.selectable,
        evented: common.evented,
        strokeUniform: common.strokeUniform,
        data: common.data,
      });
    } else {
      this.drawingObject = new FabricRect({
        ...common,
        fill: this.style.fill ? `${this.style.color}33` : 'transparent',
      });
    }
    this.canvas.add(this.drawingObject);
  }

  private onMouseMove(event: TPointerEventInfo): void {
    if (this.drawingObject === null || this.drawingStart === null) return;
    const selection = this.selection;
    if (selection === null) return;
    let point = {
      x: Math.max(selection.x, Math.min(event.scenePoint.x, selection.x + selection.width)),
      y: Math.max(selection.y, Math.min(event.scenePoint.y, selection.y + selection.height)),
    };
    if (this.drawingObject instanceof Line && event.e.shiftKey) {
      const deltaX = point.x - this.drawingStart.x;
      const deltaY = point.y - this.drawingStart.y;
      const distance = Math.hypot(deltaX, deltaY);
      const angle = Math.round(Math.atan2(deltaY, deltaX) / (Math.PI / 4)) * (Math.PI / 4);
      point = {
        x: this.drawingStart.x + Math.cos(angle) * distance,
        y: this.drawingStart.y + Math.sin(angle) * distance,
      };
      point.x = Math.max(selection.x, Math.min(point.x, selection.x + selection.width));
      point.y = Math.max(selection.y, Math.min(point.y, selection.y + selection.height));
    }
    const left = Math.min(this.drawingStart.x, point.x);
    const top = Math.min(this.drawingStart.y, point.y);
    const width = Math.max(1, Math.abs(point.x - this.drawingStart.x));
    const height = Math.max(1, Math.abs(point.y - this.drawingStart.y));
    if (this.drawingObject instanceof Line) {
      this.drawingObject.set({ x2: point.x, y2: point.y });
    } else if (this.drawingObject instanceof Ellipse) {
      this.drawingObject.set({ left, top, rx: width / 2, ry: height / 2, width, height });
    } else {
      this.drawingObject.set({ left, top, width, height });
    }
    this.drawingObject.setCoords();
    this.canvas.requestRenderAll();
  }

  private onMouseUp(): void {
    const object = this.drawingObject;
    const start = this.drawingStart;
    this.drawingObject = null;
    this.drawingStart = null;
    if (object === null || start === null) return;
    if (object instanceof Line) {
      const length = Math.hypot(object.x2 - object.x1, object.y2 - object.y1);
      if (length < 3) {
        this.canvas.remove(object);
        return;
      }
      if (this.tool === 'arrow') {
        const end = { x: object.x2, y: object.y2 };
        const data = dataFor(object);
        this.canvas.remove(object);
        this.canvas.add(arrowObject(start, end, this.style.color, this.style.width, data?.annotationId ?? this.id()));
      }
    } else if (object.width < 3 || object.height < 3) {
      this.canvas.remove(object);
      return;
    }
    this.commit();
  }

  private snapshot(): EditorSnapshot {
    return { objects: this.canvas.getObjects().map(serializeObject).filter((value): value is AnnotationSnapshot => value !== null) };
  }

  private commit(): void {
    if (this.restoring) return;
    const next = this.snapshot();
    const current = this.history[this.historyIndex]!;
    if (snapshotEqual(next, current)) return;
    this.history = [...this.history.slice(0, this.historyIndex + 1), next].slice(-100);
    this.historyIndex = this.history.length - 1;
    this.emitHistory();
  }

  private restore(snapshot: EditorSnapshot): void {
    this.restoring = true;
    this.canvas.discardActiveObject();
    this.canvas.remove(...this.canvas.getObjects());
    for (const object of snapshot.objects) this.canvas.add(restoreObject(object, this.frame));
    this.restoring = false;
    this.updateMode();
    this.emitHistory();
  }

  private emitHistory(): void {
    this.onHistoryChange({ canUndo: this.historyIndex > 0, canRedo: this.historyIndex < this.history.length - 1 });
  }
}
