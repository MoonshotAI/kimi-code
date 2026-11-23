export type ScreenshotTool =
  | 'select'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'pen'
  | 'text'
  | 'number'
  | 'mosaic';

export type ScreenshotOutputAction = 'add' | 'copy' | 'save' | 'pin';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ScreenshotFrame = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

export interface ScreenshotWindowCandidate extends Rect {
  id: string;
}

export interface ScreenshotOverlayContext {
  captureId: string;
  displayId: string;
  locale: 'en' | 'zh';
  frameUrl: string;
  sourceSize: { width: number; height: number };
  displaySize: { width: number; height: number };
  windows: ScreenshotWindowCandidate[];
  pointer: Point | null;
}

export interface ScreenshotToolStyle {
  color: string;
  width: number;
  fill: boolean;
  fontSize: number;
  pixelSize: number;
}

export interface ScreenshotOutputPayload {
  captureId: string;
  action: ScreenshotOutputAction;
  displayId: string;
  pngBytes: Uint8Array;
  width: number;
  height: number;
  comment: string;
}

export type ScreenshotOutputResult =
  | { status: 'ok' }
  | { status: 'cancelled' }
  | { status: 'error'; reason: string };

export interface ScreenshotBridge {
  platform: string;
  editText: (captureId: string, command: 'selectAll' | 'cut' | 'copy' | 'paste' | 'undo' | 'redo') => void;
  loaded: () => void;
  onContext: (cb: (context: ScreenshotOverlayContext | null) => void) => () => void;
  onWindowCandidates: (cb: (captureId: string, windows: ScreenshotWindowCandidate[]) => void) => () => void;
  perform: (payload: ScreenshotOutputPayload) => Promise<ScreenshotOutputResult>;
  copyColor: (captureId: string, color: string) => Promise<boolean>;
  cancel: (captureId: string) => void;
  bandStart: (captureId: string) => void;
  bandEnd: (captureId: string) => void;
  pointerEnter: (captureId: string) => void;
  ready: (captureId: string) => void;
  failed: (captureId: string, stage: 'frame-decode' | 'editor-init' | 'overlay-init') => void;
  onClearSelection: (cb: (captureId: string) => void) => () => void;
  onPreviewEnabled: (cb: (captureId: string) => void) => () => void;
  onPointerLeave: (cb: (captureId: string) => void) => () => void;
}

export interface PinBridge {
  platform: string;
  resizeFromEdge: (edge: string, deltaX: number, deltaY: number) => void;
  ready: () => void;
  failed: () => void;
  close: () => void;
  resize: (scaleDelta: number) => void;
  move: (deltaX: number, deltaY: number) => void;
}

declare global {
  interface Window {
    shotBridge?: ScreenshotBridge;
    pinBridge?: PinBridge;
  }
}
