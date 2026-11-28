// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import ScreenshotOverlay from '../../src/renderer/screenshot/ScreenshotOverlay.vue';
import type { ScreenshotEditor } from '../../src/renderer/screenshot/editor';
import type { ScreenshotBridge, ScreenshotOverlayContext } from '../../src/renderer/screenshot/types';

const { setEditorTool, setEditorStyle, setEditorFrame, commitEditorStyle, isTextEditing, redo, clearAnnotations, deleteSelection, hasAnnotations, hasObjectAtPointer, exportScreenshot } = vi.hoisted(() => ({
  setEditorTool: vi.fn(), isTextEditing: vi.fn(() => false), redo: vi.fn(), deleteSelection: vi.fn(() => true), hasAnnotations: vi.fn(() => false),
  setEditorStyle: vi.fn(), setEditorFrame: vi.fn(), commitEditorStyle: vi.fn(),
  exportScreenshot: vi.fn(),
  hasObjectAtPointer: vi.fn(() => false),
  clearAnnotations: vi.fn(),
}));

let editorOptions: ConstructorParameters<typeof ScreenshotEditor>[1];

vi.mock('../../src/renderer/screenshot/export', () => ({ exportScreenshot }));

vi.mock('../../src/renderer/screenshot/editor', () => ({
  ScreenshotEditor: class {
    constructor(_canvas: HTMLCanvasElement, options: ConstructorParameters<typeof ScreenshotEditor>[1]) {
      editorOptions = options;
    }
    canvas = { discardActiveObject: vi.fn() };
    reset = vi.fn();
    resize = vi.fn();
    clear = clearAnnotations;
    setSelection = vi.fn();
    setTool = setEditorTool;
    setStyle = setEditorStyle;
    setFrame = setEditorFrame;
    commitStyle = commitEditorStyle;
    isTextEditing = isTextEditing;
    redo = redo;
    deleteSelection = deleteSelection;
    hasAnnotations = hasAnnotations;
    hasObjectAtPointer = hasObjectAtPointer;
    dispose = vi.fn();
  },
}));

let app: App;
let host: HTMLDivElement;
let setContext: Parameters<ScreenshotBridge['onContext']>[0];
let setCandidates: Parameters<ScreenshotBridge['onWindowCandidates']>[0];
let leaveScreen: Parameters<ScreenshotBridge['onPointerLeave']>[0];
let clearSelection: Parameters<ScreenshotBridge['onClearSelection']>[0];
let enablePreview: Parameters<ScreenshotBridge['onPreviewEnabled']>[0];
let bridge: ScreenshotBridge;
const context: ScreenshotOverlayContext = {
  captureId: 'capture-1', displayId: '1', locale: 'zh', frameUrl: 'shot://frame/capture-1/1.png',
  sourceSize: { width: 800, height: 600 }, displaySize: { width: 400, height: 300 },
  pointer: { x: 100, y: 100 },
  windows: [{ id: 'top', x: 20, y: 30, width: 200, height: 180 }, { id: 'behind', x: 0, y: 0, width: 400, height: 300 }],
};

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await nextTick();
}

beforeEach(() => {
  let eventTime = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => ++eventTime);
  setEditorTool.mockClear();
  setEditorStyle.mockClear();
  commitEditorStyle.mockClear();
  isTextEditing.mockReset().mockReturnValue(false);
  redo.mockClear();
  deleteSelection.mockClear();
  clearAnnotations.mockClear();
  hasAnnotations.mockReset().mockReturnValue(false);
  hasObjectAtPointer.mockReset().mockReturnValue(false);
  exportScreenshot.mockReset().mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), width: 400, height: 360 });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queueMicrotask(() => cb(0)); return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: vi.fn().mockResolvedValue(undefined) });
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
  bridge = {
    platform: 'darwin',
    editText: vi.fn(),
    loaded: vi.fn(), ready: vi.fn(), failed: vi.fn(), cancel: vi.fn(), bandStart: vi.fn(), bandEnd: vi.fn(), pointerEnter: vi.fn(), perform: vi.fn().mockResolvedValue({ status: 'ok' }), copyColor: vi.fn().mockResolvedValue(true),
    onContext: (cb) => { setContext = cb; return vi.fn(); },
    onWindowCandidates: (cb) => { setCandidates = cb; return vi.fn(); },
    onPointerLeave: (cb) => { leaveScreen = cb; return vi.fn(); },
    onClearSelection: (cb) => { clearSelection = cb; return vi.fn(); },
    onPreviewEnabled: (cb) => { enablePreview = cb; return vi.fn(); },
  };
  window.shotBridge = bridge;
  host = document.createElement('div');
  document.body.append(host);
  app = createApp(ScreenshotOverlay);
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
});

describe('screenshot tools', () => {
  it('hands a decoded Windows frame to the main process even when hidden animation callbacks are suspended', async () => {
    bridge.platform = 'win32';
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    setContext(structuredClone(context));
    await flush();
    expect(bridge.ready).toHaveBeenCalledExactlyOnceWith('capture-1');
    expect(bridge.failed).not.toHaveBeenCalled();
  });

  it('hides the image while empty or decoding and clears it on exit', async () => {
    const frame = host.querySelector<HTMLImageElement>('.shot__frame')!;
    expect(frame.style.display).toBe('none');
    let decoded!: () => void;
    vi.spyOn(frame, 'decode').mockImplementationOnce(() => new Promise((resolve) => { decoded = resolve; }));
    setContext(structuredClone(context));
    await flush();
    expect(frame.style.display).toBe('none');
    expect(bridge.ready).not.toHaveBeenCalled();
    decoded();
    await flush();
    expect(frame.style.display).not.toBe('none');
    expect(bridge.ready).toHaveBeenCalledOnce();
    setContext(null);
    await flush();
    expect(frame.hasAttribute('src')).toBe(false);
    expect(frame.style.display).toBe('none');
    expect(host.querySelector('.shot__dim, .shot__toolbar')).toBeNull();
  });

  it('draws the frame at the logical size of its monitor instead of stretching it over the rounded-up viewport', async () => {
    const scale = 2.924999952316284;
    setContext({ ...structuredClone(context), sourceSize: { width: 5760, height: 3240 }, displaySize: { width: 5760 / scale, height: 3240 / scale } });
    await flush();
    const frame = host.querySelector<HTMLImageElement>('.shot__frame')!;
    expect(Number.parseFloat(frame.style.width)).toBeCloseTo(5760 / scale, 2);
    expect(Number.parseFloat(frame.style.height)).toBeCloseTo(3240 / scale, 2);
  });

  it.each(['zh', 'en'] as const)('clears annotations from the existing trash button while preserving the crop and comment in %s', async (locale) => {
    setContext({ ...structuredClone(context), locale });
    await flush();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    const label = locale === 'zh' ? '清空全部标注' : 'Clear all annotations';
    const selectedLabel = locale === 'zh' ? '删除选中标注' : 'Delete selected annotations';
    const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    expect(button.disabled).toBe(true);
    hasAnnotations.mockReturnValue(true);
    editorOptions.onHistoryChange({ canUndo: true, canRedo: false });
    await flush();
    expect(button.disabled).toBe(false);
    editorOptions.onSelectionChange({ tool: 'arrow', style: { color: '#ff3b30', width: 4, fill: false, fontSize: 24, pixelSize: 16 } });
    await flush();
    expect(button.getAttribute('aria-label')).toBe(selectedLabel);
    button.click();
    expect(deleteSelection).toHaveBeenCalledOnce();
    expect(clearAnnotations).not.toHaveBeenCalled();
    editorOptions.onSelectionChange(null);
    await flush();
    const input = host.querySelector<HTMLTextAreaElement>('#shot-comment')!;
    input.value = 'Keep this comment';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const crop = host.querySelector('.shot__selection')!.getAttribute('style');
    button.click();
    expect(clearAnnotations).toHaveBeenCalledOnce();
    hasAnnotations.mockReturnValue(false);
    editorOptions.onHistoryChange({ canUndo: true, canRedo: false });
    await flush();
    expect(button.disabled).toBe(true);
    expect(input.value).toBe('Keep this comment');
    expect(host.querySelector('.shot__selection')!.getAttribute('style')).toBe(crop);
    expect(bridge.cancel).not.toHaveBeenCalled();
    expect(bridge.perform).not.toHaveBeenCalled();
    hasAnnotations.mockReturnValue(true);
    editorOptions.onHistoryChange({ canUndo: true, canRedo: true });
    await flush();
    expect(button.disabled).toBe(false);
  });

  it.each(['arrow', 'number', 'text', 'mosaic'] as const)('adjusts selected %s gradually using accumulated wheel distance', async (tool) => {
    await enterEdit();
    editorOptions.onSelectionChange({ tool, style: { color: '#ff3b30', width: 4, fill: false, fontSize: 24, pixelSize: 16 } });
    await flush();
    const wheel = (deltaY: number, deltaMode = 0): void => {
      host.querySelector('.shot')!.dispatchEvent(new WheelEvent('wheel', { deltaY, deltaMode, bubbles: true, cancelable: true }));
    };
    setEditorStyle.mockClear();
    for (let i = 0; i < 11; i++) wheel(-5);
    expect(setEditorStyle).not.toHaveBeenCalled();
    wheel(-5);
    const field = tool === 'arrow' ? 'width' : tool === 'mosaic' ? 'pixelSize' : 'fontSize';
    const initial = tool === 'arrow' ? 4 : tool === 'mosaic' ? 16 : 24;
    expect(setEditorStyle).toHaveBeenLastCalledWith(expect.objectContaining({ [field]: initial + 1 }));
    wheel(-1000);
    expect(setEditorStyle).toHaveBeenLastCalledWith(expect.objectContaining({ [field]: initial + 2 }));
    wheel(3, 1);
    expect(setEditorStyle).toHaveBeenLastCalledWith(expect.objectContaining({ [field]: initial + 1 }));
    wheel(1, 2);
    expect(setEditorStyle).toHaveBeenLastCalledWith(expect.objectContaining({ [field]: initial }));
    await flush();
    expect(commitEditorStyle).toHaveBeenCalledTimes(4);
  });

  it('resets partial wheel input after pauses, direction changes, tool changes and selection changes', async () => {
    await enterEdit();
    const selected = { tool: 'arrow' as const, style: { color: '#ff3b30', width: 4, fill: false, fontSize: 24, pixelSize: 16 } };
    editorOptions.onSelectionChange(selected);
    await flush();
    setEditorStyle.mockClear();
    const wheel = (deltaY: number): void => { host.querySelector('.shot')!.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true })); };
    vi.mocked(Date.now).mockReturnValue(1000);
    wheel(-50);
    vi.mocked(Date.now).mockReturnValue(1300);
    wheel(-10);
    expect(setEditorStyle).not.toHaveBeenCalled();
    wheel(50);
    expect(setEditorStyle).not.toHaveBeenCalled();
    wheel(10);
    expect(setEditorStyle).toHaveBeenLastCalledWith(expect.objectContaining({ width: 3 }));
    setEditorStyle.mockClear();
    wheel(-50);
    editorOptions.onSelectionChange({ ...selected, style: { ...selected.style } });
    wheel(-10);
    expect(setEditorStyle).not.toHaveBeenCalled();
    host.querySelector<HTMLButtonElement>('button[aria-label="标号"]')!.click();
    await flush();
    setEditorStyle.mockClear();
    wheel(-50);
    expect(setEditorStyle).not.toHaveBeenCalled();
    wheel(-10);
    expect(setEditorStyle).toHaveBeenLastCalledWith(expect.objectContaining({ fontSize: 25 }));
  });

  it('ignores wheel input during drawing, text editing, horizontal scrolling and pinch zoom', async () => {
    await enterEdit();
    editorOptions.onSelectionChange({ tool: 'arrow', style: { color: '#ff3b30', width: 4, fill: false, fontSize: 24, pixelSize: 16 } });
    await flush();
    setEditorStyle.mockClear();
    for (const options of [{ deltaY: 0 }, { deltaY: -60, deltaX: 80 }, { deltaY: -60, buttons: 1 }, { deltaY: -60, ctrlKey: true }]) {
      host.querySelector('.shot')!.dispatchEvent(new WheelEvent('wheel', { ...options, bubbles: true }));
    }
    isTextEditing.mockReturnValue(true);
    host.querySelector('.shot')!.dispatchEvent(new WheelEvent('wheel', { deltaY: -60, bubbles: true }));
    expect(setEditorStyle).not.toHaveBeenCalled();
    expect(commitEditorStyle).not.toHaveBeenCalled();
  });

  it.each([1, 1.5, 2])('shows logical dimensions in pt for preview and selection at scale %s', async (scale) => {
    setContext({ ...structuredClone(context), sourceSize: { width: 400 * scale, height: 300 * scale } });
    await flush();
    expect(host.querySelector('.shot__hover .shot__size')?.textContent).toBe('200 × 180 pt');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    expect(host.querySelector('.shot__selection .shot__size')?.textContent).toBe('200 × 180 pt');
    expect(host.querySelector('.shot__hover .shot__size')).toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    expect(bridge.perform).toHaveBeenCalledWith(expect.objectContaining({ action: 'add' }));
    expect(exportScreenshot.mock.calls[0]?.[2]).toEqual({ x: 20 * scale, y: 30 * scale, width: 200 * scale, height: 180 * scale });
  });

  it('does not show dimensions on an inactive screen or without a candidate', async () => {
    setContext({ ...structuredClone(context), pointer: null });
    await flush();
    expect(host.querySelector('.shot__size')).toBeNull();
    setContext({ ...structuredClone(context), windows: [] });
    await flush();
    expect(host.querySelector('.shot__size')).toBeNull();
  });

  it('keeps the frame hidden during decoding and after cleanup on every capture', async () => {
    const frame = host.querySelector<HTMLImageElement>('.shot__frame')!;
    expect(frame.style.display).toBe('none');
    for (let attempt = 0; attempt < 2; attempt++) {
      let decoded!: () => void;
      vi.spyOn(frame, 'decode').mockImplementationOnce(() => new Promise<void>((resolve) => { decoded = resolve; }));
      setContext({ ...structuredClone(context), captureId: `capture-${attempt}` });
      await flush();
      expect(frame.style.display).toBe('none');
      expect(host.querySelector('.shot__dim')).toBeNull();
      decoded();
      await flush();
      expect(frame.style.display).toBe('');
      expect(bridge.ready).toHaveBeenLastCalledWith(`capture-${attempt}`);
      setContext(null);
      await flush();
      expect(frame.style.display).toBe('none');
      expect(frame.hasAttribute('src')).toBe(false);
      expect(host.querySelector('.shot__dim, .shot__toolbar')).toBeNull();
    }
  });

  it('does not reveal a frame whose decoding finishes after cancellation', async () => {
    const frame = host.querySelector<HTMLImageElement>('.shot__frame')!;
    let decoded!: () => void;
    vi.spyOn(frame, 'decode').mockImplementationOnce(() => new Promise<void>((resolve) => { decoded = resolve; }));
    setContext(structuredClone(context));
    await flush();
    setContext(null);
    decoded();
    await flush();
    expect(frame.style.display).toBe('none');
    expect(frame.hasAttribute('src')).toBe(false);
    expect(bridge.ready).not.toHaveBeenCalled();
  });

  async function enterEdit(): Promise<void> {
    setContext(structuredClone(context));
    await flush();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
  }

  it.each(['selection', 'editing', 'drawing', 'comment', 'text', 'number', 'mosaic'])('exits with one Escape from %s', async (state) => {
    if (state === 'selection') {
      setContext(structuredClone(context));
      await flush();
    } else await enterEdit();
    if (state === 'drawing') host.querySelector<HTMLButtonElement>('button[aria-label="箭头"]')!.click();
    if (state === 'text') isTextEditing.mockReturnValue(true);
    if (state === 'number') host.querySelector<HTMLButtonElement>('button[aria-label="标号"]')!.click();
    if (state === 'mosaic') host.querySelector<HTMLButtonElement>('button[aria-label="马赛克"]')!.click();
    await flush();
    const target = state === 'comment' ? host.querySelector<HTMLTextAreaElement>('#shot-comment')! : window;
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(bridge.cancel).toHaveBeenCalledExactlyOnceWith('capture-1');
  });

  it('leaves Escape to the input method while composing', async () => {
    await enterEdit();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true }));
    expect(bridge.cancel).not.toHaveBeenCalled();
  });

  it('uses one arrow entry for arrow and line modes and remembers the chosen mode', async () => {
    await enterEdit();
    const arrow = host.querySelector<HTMLButtonElement>('button[aria-label="箭头"]')!;
    expect(arrow).not.toBeNull();
    expect(host.querySelector('button[aria-label="直线"]')).toBeNull();
    arrow.click();
    await flush();
    expect(setEditorTool).toHaveBeenLastCalledWith('arrow');
    const line = [...host.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find((button) => button.textContent?.trim() === '直线')!;
    line.click();
    await flush();
    expect(setEditorTool).toHaveBeenLastCalledWith('line');
    expect(line.getAttribute('aria-selected')).toBe('true');
    line.click();
    await flush();
    expect(setEditorTool).toHaveBeenLastCalledWith('line');
    arrow.click();
    await flush();
    expect(setEditorTool).toHaveBeenLastCalledWith('select');
    arrow.click();
    await flush();
    expect(setEditorTool).toHaveBeenLastCalledWith('line');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    await flush();
    expect(setEditorTool).toHaveBeenLastCalledWith('arrow');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l' }));
    await flush();
    expect(setEditorTool).toHaveBeenLastCalledWith('line');
  });

  it('groups rectangle and ellipse and remembers the mode when returning to the tool', async () => {
    await enterEdit();
    const shape = host.querySelector<HTMLButtonElement>('button[aria-label="矩形 / 椭圆"]')!;
    shape.click();
    await flush();
    expect(setEditorTool).toHaveBeenLastCalledWith('rect');
    const ellipse = [...host.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find((button) => button.textContent?.trim() === '椭圆')!;
    ellipse.click();
    await flush();
    expect(setEditorTool).toHaveBeenLastCalledWith('ellipse');
    expect(shape.getAttribute('aria-pressed')).toBe('true');
    expect(ellipse.getAttribute('aria-selected')).toBe('true');
    ellipse.click();
    await flush();
    expect(setEditorTool).toHaveBeenLastCalledWith('ellipse');
    shape.click();
    await flush();
    expect(setEditorTool).toHaveBeenLastCalledWith('select');
    shape.click();
    await flush();
    expect(setEditorTool).toHaveBeenLastCalledWith('ellipse');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }));
    await flush();
    expect(setEditorTool).toHaveBeenLastCalledWith('rect');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o' }));
    await flush();
    expect(setEditorTool).toHaveBeenLastCalledWith('ellipse');
  });

  it('shows redo and delete on the main toolbar and preserves shortcuts and right-click reselect', async () => {
    await enterEdit();
    for (const label of ['更多工具', '更多操作', '重新框选', '椭圆']) {
      expect(host.querySelector(`button[aria-label="${label}"]`)).toBeNull();
    }
    expect(host.querySelector('button[aria-label="撤销"]')).not.toBeNull();
    expect(host.querySelector('.shot__tools button[aria-label="重做"]')).not.toBeNull();
    expect(host.querySelector('.shot__tools button[aria-label="清空全部标注"]')).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true }));
    expect(redo).toHaveBeenCalledOnce();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
    expect(deleteSelection).toHaveBeenCalledOnce();
    hasAnnotations.mockReturnValue(true);
    host.querySelector('.shot')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    await flush();
    expect(host.querySelector('.shot__message')?.textContent).toBe('再次右键可重新框选，当前标注将被删除');
    expect(host.querySelector('.shot__selection')).not.toBeNull();
    host.querySelector('.shot')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    await flush();
    expect(host.querySelector('.shot__selection, .shot__toolbar')).toBeNull();
  });

  it('enables redo and delete only when available without intercepting button activation', async () => {
    await enterEdit();
    const items = ['重做', '清空全部标注'].map((label) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!);
    expect(items.every((item) => item.disabled)).toBe(true);
    editorOptions.onHistoryChange({ canUndo: false, canRedo: true });
    editorOptions.onSelectionChange({ tool: 'rect', style: { color: '#ff3b30', width: 4, fill: false, fontSize: 24, pixelSize: 16 } });
    await flush();
    expect(items.every((item) => !item.disabled)).toBe(true);
    for (const button of items) {
      for (const key of ['Enter', ' ']) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        button.focus();
        button.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      }
      button.click();
    }
    await flush();
    expect(deleteSelection).toHaveBeenCalledOnce();
    expect(redo).toHaveBeenCalledOnce();
    expect(exportScreenshot).not.toHaveBeenCalled();
    expect(bridge.perform).not.toHaveBeenCalled();
    expect(host.querySelector('[role="menu"]')).toBeNull();
  });

  it('leaves Enter and Space available for the loupe copy button', async () => {
    setContext(structuredClone(context));
    await flush();
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="复制颜色"]')!;
    for (const key of ['Enter', ' ']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      button.focus();
      button.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(bridge.bandStart).not.toHaveBeenCalled();
    expect(bridge.perform).not.toHaveBeenCalled();
    expect(host.querySelector('.shot__toolbar')).toBeNull();
  });

  it.each(['标号', '马赛克'])('switches to %s without losing the selection or comment', async (label) => {
    await enterEdit();
    await flush();
    const input = host.querySelector<HTMLTextAreaElement>('#shot-comment')!;
    input.value = '关注这里';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
    await flush();
    expect(setEditorTool).toHaveBeenLastCalledWith(label === '标号' ? 'number' : 'mosaic');
    expect(host.querySelector<HTMLTextAreaElement>('#shot-comment')?.value).toBe('关注这里');
    expect(host.querySelector('.shot__selection')).not.toBeNull();
  });

  it.each([
    ['MacIntel', 'zh', '添加到对话', 'Enter 添加 · Shift+Enter 换行'],
    ['MacIntel', 'en', 'Add to conversation', 'Enter to add · Shift+Enter for new line'],
    ['Win32', 'zh', '添加到对话', 'Enter 添加 · Shift+Enter 换行'],
    ['Win32', 'en', 'Add to conversation', 'Enter to add · Shift+Enter for new line'],
  ] as const)('shows the add shortcut on %s in %s', async (platform, locale, label, shortcut) => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
    setContext({ ...structuredClone(context), locale });
    await flush();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    const button = host.querySelector<HTMLButtonElement>('.shot__conversation-actions .ui-button')!;
    expect(button.textContent).toBe(`${label}Enter`);
    vi.useFakeTimers();
    try {
      button.focus();
      await vi.advanceTimersByTimeAsync(200);
      await flush();
      expect(document.querySelector('[role="tooltip"]')?.textContent?.trim()).toBe(shortcut);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['plain', 'comment', 'shortcut', 'empty-shortcut'])('adds the image through the same action with %s input', async (mode) => {
    await enterEdit();
    const group = host.querySelector('[role="group"][aria-label="添加到对话"]')!;
    const addButton = group.querySelector<HTMLButtonElement>('button')!;
    const input = host.querySelector<HTMLTextAreaElement>('#shot-comment')!;
    expect(group.querySelectorAll('button')).toHaveLength(1);
    expect(input.tagName).toBe('TEXTAREA');
    expect(input.rows).toBe(1);
    expect(document.activeElement).not.toBe(input);
    expect(host.querySelector('button[aria-label="写评论"]')).toBeNull();
    if (mode === 'comment' || mode === 'shortcut') {
      input.value = '  关注这里  ';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (mode === 'shortcut' || mode === 'empty-shortcut') {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    } else addButton.click();
    await flush();
    expect(bridge.perform).toHaveBeenCalledExactlyOnceWith({
      captureId: 'capture-1', action: 'add', displayId: '1', pngBytes: new Uint8Array([1, 2, 3]), width: 400, height: 360,
      comment: mode === 'plain' || mode === 'empty-shortcut' ? '' : '关注这里',
    });
  });

  it('orders the output actions as close, pin, save, copy', async () => {
    await enterEdit();
    const groups = host.querySelectorAll('.shot__tool-group');
    const labels = [...groups[groups.length - 1]!.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['退出截图', '贴图', '保存', '复制']);
  });

  it('copies the image from the copy icon', async () => {
    await enterEdit();
    host.querySelector<HTMLButtonElement>('button[aria-label="复制"]')!.click();
    await flush();
    expect(bridge.perform).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'copy', comment: '' }));
  });

  it('preserves multiline comments and leaves Shift+Enter available for a newline', async () => {
    await enterEdit();
    const input = host.querySelector<HTMLTextAreaElement>('#shot-comment')!;
    const newline = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(newline);
    expect(newline.defaultPrevented).toBe(false);
    expect(bridge.perform).not.toHaveBeenCalled();
    input.value = '第一行\n第二行\n\n第四行';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(bridge.perform).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'add', comment: input.value }));
  });

  it.each(['ctrlKey', 'metaKey', 'shiftKey', 'altKey'])('does not submit with %s + Enter in the comment or canvas', async (modifier) => {
    await enterEdit();
    const input = host.querySelector<HTMLTextAreaElement>('#shot-comment')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', [modifier]: true, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', [modifier]: true }));
    await flush();
    expect(bridge.perform).not.toHaveBeenCalled();
  });

  it('does not submit while composing or confirming Chinese text', async () => {
    await enterEdit();
    const input = host.querySelector<HTMLTextAreaElement>('#shot-comment')!;
    input.focus();
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(bridge.perform).not.toHaveBeenCalled();
    vi.mocked(Date.now).mockReturnValue(Date.now() + 101);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(bridge.perform).toHaveBeenCalledOnce();
  });

  it.each(['ctrlKey', 'metaKey'])('edits the comment with %s shortcuts without changing the image', async (modifier) => {
    await enterEdit();
    await flush();
    const input = host.querySelector<HTMLTextAreaElement>('#shot-comment')!;
    for (const [key, command, shiftKey] of [
      ['a', 'selectAll', false], ['c', 'copy', false], ['x', 'cut', false], ['v', 'paste', false],
      ['z', 'undo', false], ['z', 'redo', true], ['y', 'redo', false],
    ] as const) {
      const event = new KeyboardEvent('keydown', { key, [modifier]: true, shiftKey, bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(bridge.editText).toHaveBeenLastCalledWith('capture-1', command);
    }
    expect(redo).not.toHaveBeenCalled();
    expect(deleteSelection).not.toHaveBeenCalled();
    expect(bridge.perform).not.toHaveBeenCalled();
    const composing = new KeyboardEvent('keydown', { key: 'a', [modifier]: true, isComposing: true, bubbles: true, cancelable: true });
    input.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);
    expect(bridge.editText).toHaveBeenCalledTimes(7);
  });

  it.each(['zh', 'en'] as const)('keeps preset drawing colors across tools without a system color picker in %s', async (locale) => {
    setContext({ ...structuredClone(context), locale });
    await flush();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    const buttons = [...host.querySelectorAll('.shot__tools button, .shot__conversation-actions button')];
    for (const key of ['r', 'o', 'a', 'l', 'p', 't', 'n']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key }));
      await flush();
      expect([...host.querySelectorAll('.shot__tools button, .shot__conversation-actions button')]).toEqual(buttons);
      expect(host.querySelector('input[type="color"]')).toBeNull();
      const colors = host.querySelectorAll<HTMLButtonElement>('.shot__colors button');
      expect(colors).toHaveLength(8);
      const blue = host.querySelector<HTMLButtonElement>('.shot__colors button[aria-label="#1783ff"]')!;
      blue.click();
      await flush();
      expect(blue.classList.contains('is-active')).toBe(true);
      expect(setEditorStyle).toHaveBeenLastCalledWith(expect.objectContaining({ color: '#1783ff' }));
      expect(commitEditorStyle).toHaveBeenCalled();
    }
    expect(bridge.perform).not.toHaveBeenCalled();
  });

  it.each(['zh', 'en'] as const)('offers block size without color controls for pixelation in %s', async (locale) => {
    setContext({ ...structuredClone(context), locale });
    await flush();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
    await flush();
    expect(setEditorTool).toHaveBeenLastCalledWith('mosaic');
    expect(host.querySelector('.shot__colors, input[type="color"]')).toBeNull();
    expect(host.querySelector('.shot__properties label span')?.textContent).toBe(locale === 'zh' ? '色块大小' : 'Block size');
    const slider = host.querySelector<HTMLInputElement>('input[type="range"]')!;
    slider.value = '32';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(setEditorStyle).toHaveBeenLastCalledWith(expect.objectContaining({ pixelSize: 32 }));
    expect(commitEditorStyle).toHaveBeenCalled();
  });

  it('keeps unused effects removed and hides the loupe during editing', async () => {
    setContext(structuredClone(context));
    await flush();
    expect(host.querySelector('.shot__loupe, .shot__loupe-image')).not.toBeNull();
    expect(host.querySelector('input[type="color"]')).toBeNull();
    await enterEdit();
    expect(host.querySelector('.shot__loupe, .shot__loupe-image')).toBeNull();
    for (const label of ['模糊', '取色', '橡皮擦', '高亮', '直线']) {
      expect(host.querySelector(`button[aria-label="${label}"]`)).toBeNull();
    }
    expect(host.querySelector('button[aria-label="矩形 / 椭圆"]')).not.toBeNull();
    setEditorTool.mockClear();
    for (const key of ['h', 'b', 'e', 'c']) {
      const event = new KeyboardEvent('keydown', { key, cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(setEditorTool).not.toHaveBeenCalled();
    expect(bridge.perform).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  app.unmount();
  host.remove();
  delete window.shotBridge;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('screenshot selection modifiers', () => {
  const point = async (target: Element, type: string, x: number, y: number, modifiers: MouseEventInit = {}): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    target.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true, ...modifiers }));
    await flush();
  };
  const key = async (type: string, value: string, modifiers: KeyboardEventInit = {}, target: EventTarget = window): Promise<KeyboardEvent> => {
    const event = new KeyboardEvent(type, { key: value, bubbles: true, cancelable: true, ...modifiers });
    target.dispatchEvent(event);
    await flush();
    return event;
  };
  const rect = () => {
    const element = host.querySelector<HTMLElement>('.shot__selection')!;
    return { x: parseFloat(element.style.left), y: parseFloat(element.style.top), width: parseFloat(element.style.width), height: parseFloat(element.style.height) };
  };
  const start = async () => {
    setContext(structuredClone(context));
    await flush();
    return host.querySelector('.shot__selection-surface')!;
  };
  const edit = async () => {
    const surface = await start();
    await point(surface, 'pointerdown', 100, 100);
    await point(surface, 'pointermove', 200, 150);
    await point(surface, 'pointerup', 200, 150);
    return host.querySelector('.shot')!;
  };

  it('cancels a pending loupe format toggle when Shift starts a selection gesture', async () => {
    const surface = await start();
    await key('keydown', 'Shift');
    await point(surface, 'pointerdown', 100, 100, { buttons: 1, shiftKey: true });
    await point(surface, 'pointermove', 160, 130, { buttons: 1, shiftKey: true });
    await key('keyup', 'Shift');
    expect(host.querySelector('.shot__loupe-value')?.textContent).toBe('HEX:—');
    await point(surface, 'pointerup', 160, 130, { buttons: 0, shiftKey: true });
  });

  it('coalesces pointer moves and flushes the final drag position on pointerup', async () => {
    bridge.platform = 'win32';
    let next = 0;
    const callbacks = new Map<number, FrameRequestCallback>();
    const request = vi.fn((callback: FrameRequestCallback) => {
      callbacks.set(++next, callback);
      return next;
    });
    vi.stubGlobal('requestAnimationFrame', request);
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => { callbacks.delete(handle); });
    const surface = await start();
    await point(surface, 'pointerdown', 100, 100, { buttons: 1 });
    await point(surface, 'pointermove', 160, 130, { buttons: 1 });
    await point(surface, 'pointermove', 200, 150, { buttons: 1 });
    expect(request).toHaveBeenCalledOnce();
    expect(host.querySelector('.shot__selection')).toBeNull();
    await point(surface, 'pointerup', 200, 150, { buttons: 0 });
    expect(rect()).toEqual({ x: 100, y: 100, width: 100, height: 50 });
    expect(callbacks.size).toBe(0);
  });

  it('applies new modifier keys before a queued pointer move', async () => {
    bridge.platform = 'win32';
    let next = 0;
    const callbacks = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callbacks.set(++next, callback);
      return next;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => { callbacks.delete(handle); });
    const surface = await start();
    await point(surface, 'pointerdown', 100, 100, { buttons: 1 });
    await point(surface, 'pointermove', 160, 130, { buttons: 1 });
    await key('keydown', 'Shift', { shiftKey: true });
    expect(rect()).toEqual({ x: 100, y: 100, width: 60, height: 60 });
    for (const callback of callbacks.values()) callback(0);
    expect(rect()).toEqual({ x: 100, y: 100, width: 60, height: 60 });
    await point(surface, 'pointerup', 160, 130, { buttons: 0, shiftKey: true });
  });

  it('flushes queued pointer moves before Space changes', async () => {
    bridge.platform = 'win32';
    let next = 0;
    const callbacks = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callbacks.set(++next, callback);
      return next;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => { callbacks.delete(handle); });
    const surface = await start();
    await point(surface, 'pointerdown', 100, 100, { buttons: 1 });
    await point(surface, 'pointermove', 160, 130, { buttons: 1 });
    await key('keydown', ' ');
    expect(rect()).toEqual({ x: 100, y: 100, width: 60, height: 30 });
    expect(callbacks.size).toBe(0);
    await point(surface, 'pointermove', 180, 140, { buttons: 1 });
    await key('keyup', ' ');
    expect(rect()).toEqual({ x: 120, y: 110, width: 60, height: 30 });
    expect(callbacks.size).toBe(0);
    await point(surface, 'pointerup', 180, 140, { buttons: 0 });
    expect(rect()).toEqual({ x: 120, y: 110, width: 60, height: 30 });
  });

  it.each(['before', 'after'])('keeps the first drawn selection when capture is lost %s pointerup on every capture', async (order) => {
    for (let capture = 0; capture < 2; capture++) {
      const surface = await start();
      await point(surface, 'pointerdown', 100, 100, { buttons: 1 });
      await point(surface, 'pointermove', 160, 130, { buttons: 1 });
      const events = order === 'before' ? ['lostpointercapture', 'pointerup'] : ['pointerup', 'lostpointercapture'];
      for (const type of events) await point(surface, type, 200, 150, { buttons: 0 });
      expect(rect()).toEqual({ x: 100, y: 100, width: 100, height: 50 });
      expect(host.querySelector('.shot__toolbar')).not.toBeNull();
      await point(surface, 'pointermove', 250, 200);
      expect(rect()).toEqual({ x: 100, y: 100, width: 100, height: 50 });
      expect(bridge.bandEnd).not.toHaveBeenCalled();
      expect(bridge.perform).not.toHaveBeenCalled();
      setContext(null);
      await flush();
    }
  });

  it('confirms a clicked window when capture is lost on release before pointerup', async () => {
    const surface = await start();
    await point(surface, 'pointerdown', 100, 100, { buttons: 1 });
    await point(surface, 'lostpointercapture', 100, 100, { buttons: 0 });
    await point(surface, 'pointerup', 100, 100);
    expect(rect()).toEqual({ x: 20, y: 30, width: 200, height: 180 });
    expect(host.querySelector('.shot__toolbar')).not.toBeNull();
    expect(bridge.bandEnd).not.toHaveBeenCalled();
  });

  it.each(['move', 'resize'])('uses the release position when capture is lost before pointerup during %s', async (gesture) => {
    const root = await edit();
    const target = gesture === 'move' ? root : host.querySelector('button[aria-label="选择 se"]')!;
    const startPoint = gesture === 'move' ? { x: 150, y: 125 } : { x: 200, y: 150 };
    await point(target, 'pointerdown', startPoint.x, startPoint.y, { buttons: 1 });
    await point(target, 'pointermove', startPoint.x + 10, startPoint.y + 10, { buttons: 1 });
    await point(target, 'lostpointercapture', startPoint.x + 30, startPoint.y + 20, { buttons: 0 });
    const expected = gesture === 'move'
      ? { x: 130, y: 120, width: 100, height: 50 }
      : { x: 100, y: 100, width: 130, height: 70 };
    expect(rect()).toEqual(expected);
    await point(target, 'pointerup', startPoint.x + 30, startPoint.y + 20);
    await point(target, 'pointermove', startPoint.x + 40, startPoint.y + 40);
    expect(rect()).toEqual(expected);
    expect(root.classList.contains('is-manipulating')).toBe(false);
  });

  it.each(['pointercancel', 'lostpointercapture', 'blur'])('does not confirm a cancelled drawn selection after %s', async (type) => {
    const surface = await start();
    await point(surface, 'pointerdown', 100, 100, { buttons: 1 });
    await point(surface, 'pointermove', 160, 130, { buttons: 1 });
    if (type === 'blur') window.dispatchEvent(new Event(type));
    else await point(surface, type, 160, 130, { buttons: type === 'lostpointercapture' ? 1 : 0 });
    await point(surface, 'lostpointercapture', 200, 150, { buttons: 0 });
    await point(surface, 'pointerup', 200, 150);
    expect(host.querySelector('.shot__selection, .shot__toolbar')).toBeNull();
    expect(bridge.bandEnd).toHaveBeenCalledExactlyOnceWith('capture-1');
  });

  it.each([
    [{}, { x: 100, y: 100, width: 60, height: 30 }],
    [{ shiftKey: true }, { x: 100, y: 100, width: 60, height: 60 }],
    [{ altKey: true }, { x: 40, y: 70, width: 120, height: 60 }],
    [{ altKey: true, shiftKey: true }, { x: 40, y: 40, width: 120, height: 120 }],
  ] as const)('creates selections with modifiers %j', async (modifiers, expected) => {
    const surface = await start();
    await point(surface, 'pointerdown', 100, 100, modifiers);
    await point(surface, 'pointermove', 160, 130, modifiers);
    expect(rect()).toEqual(expected);
    await point(surface, 'pointerup', 160, 130, modifiers);
    expect(rect()).toEqual(expected);
    expect(host.querySelector('.shot__toolbar')).not.toBeNull();
  });

  it('accepts Space before the mouse is pressed and resumes drawing from the translated origin', async () => {
    const surface = await start();
    expect((await key('keydown', ' ')).defaultPrevented).toBe(true);
    await point(surface, 'pointerdown', 100, 100);
    await point(surface, 'pointermove', 130, 120);
    expect(rect()).toEqual({ x: 130, y: 120, width: 0, height: 0 });
    await key('keyup', ' ');
    await point(surface, 'pointermove', 200, 170);
    await point(surface, 'pointerup', 200, 170);
    expect(rect()).toEqual({ x: 130, y: 120, width: 70, height: 50 });
  });

  it('keeps a square fixed in size while Space moves it against an edge, then resumes without jumping', async () => {
    const surface = await start();
    await point(surface, 'pointerdown', 100, 100, { shiftKey: true });
    await point(surface, 'pointermove', 160, 130, { shiftKey: true });
    await key('keydown', ' ', { shiftKey: true });
    await point(surface, 'pointermove', 500, 350, { shiftKey: true });
    expect(rect()).toEqual({ x: 340, y: 240, width: 60, height: 60 });
    await key('keyup', ' ', { shiftKey: true });
    expect(rect()).toEqual({ x: 340, y: 240, width: 60, height: 60 });
    await point(surface, 'pointermove', 490, 340, { shiftKey: true });
    expect(rect()).toEqual({ x: 340, y: 240, width: 50, height: 50 });
    await key('keyup', 'Shift');
    await point(surface, 'pointerup', 490, 340);
    expect(rect()).toEqual({ x: 340, y: 240, width: 50, height: 50 });
  });

  it('rebases Alt and Shift at the current rectangle and does not jump back when they are released', async () => {
    const surface = await start();
    await point(surface, 'pointerdown', 100, 100);
    await point(surface, 'pointermove', 160, 130);
    await key('keydown', 'Alt', { altKey: true });
    expect(rect()).toEqual({ x: 100, y: 100, width: 60, height: 30 });
    await point(surface, 'pointermove', 170, 140, { altKey: true });
    expect(rect()).toEqual({ x: 90, y: 90, width: 80, height: 50 });
    await key('keydown', 'Shift', { altKey: true, shiftKey: true });
    expect(rect()).toEqual({ x: 90, y: 75, width: 80, height: 80 });
    await key('keyup', 'Alt', { shiftKey: true });
    await key('keyup', 'Shift');
    expect(rect()).toEqual({ x: 90, y: 75, width: 80, height: 80 });
    await point(surface, 'pointermove', 180, 145);
    await point(surface, 'pointerup', 180, 145);
    expect(rect()).toEqual({ x: 90, y: 75, width: 90, height: 85 });
  });

  it.each([
    [{ shiftKey: true }, { x: 100, y: 100, width: 140, height: 70 }],
    [{ altKey: true }, { x: 60, y: 95, width: 180, height: 60 }],
    [{ altKey: true, shiftKey: true }, { x: 60, y: 80, width: 180, height: 90 }],
  ] as const)('resizes an existing crop with modifiers %j', async (modifiers, expected) => {
    await edit();
    const handle = host.querySelector('.shot__handle--se')!;
    await point(handle, 'pointerdown', 200, 150, modifiers);
    await point(handle, 'pointermove', 240, 155, modifiers);
    expect(rect()).toEqual(expected);
    await point(handle, 'pointerup', 240, 155, modifiers);
    expect(rect()).toEqual(expected);
  });

  it('remembers the original drag ratio after an unconstrained resize and continues smoothly after releasing modifiers', async () => {
    await edit();
    const handle = host.querySelector('.shot__handle--se')!;
    await point(handle, 'pointerdown', 200, 150);
    await point(handle, 'pointermove', 220, 160);
    await key('keydown', 'Alt', { altKey: true });
    expect(rect()).toEqual({ x: 100, y: 100, width: 120, height: 60 });
    await point(handle, 'pointermove', 230, 180, { altKey: true });
    expect(rect()).toEqual({ x: 90, y: 80, width: 140, height: 100 });
    await key('keydown', 'Shift', { altKey: true, shiftKey: true });
    expect(rect()).toEqual({ x: 90, y: 95, width: 140, height: 70 });
    await key('keyup', 'Alt', { shiftKey: true });
    await key('keyup', 'Shift');
    await point(handle, 'pointermove', 240, 185);
    expect(rect()).toEqual({ x: 90, y: 95, width: 150, height: 75 });
  });

  it('temporarily moves during a constrained resize and resumes from the moved rectangle', async () => {
    await edit();
    const handle = host.querySelector('.shot__handle--se')!;
    const modifiers = { altKey: true, shiftKey: true };
    await point(handle, 'pointerdown', 200, 150, modifiers);
    await point(handle, 'pointermove', 210, 155, modifiers);
    expect(rect()).toEqual({ x: 90, y: 95, width: 120, height: 60 });
    await key('keydown', ' ', modifiers);
    await point(handle, 'pointermove', 250, 175, modifiers);
    expect(rect()).toEqual({ x: 130, y: 115, width: 120, height: 60 });
    await key('keyup', ' ', modifiers);
    await point(handle, 'pointermove', 260, 180, modifiers);
    expect(rect()).toEqual({ x: 120, y: 110, width: 140, height: 70 });
    await point(handle, 'pointerup', 260, 180, modifiers);
  });

  it.each(['选择', '箭头', '画笔', '文字', '标号', '马赛克'])('uses Space over annotations to move the crop without switching the %s tool', async (label) => {
    const root = await edit();
    if (label !== '选择') host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
    await flush();
    setEditorTool.mockClear();
    hasObjectAtPointer.mockReturnValue(true);
    const canvas = host.querySelector('canvas')!;
    const canvasMouseDown = vi.fn();
    canvas.addEventListener('mousedown', canvasMouseDown);
    await key('keydown', ' ');
    await point(canvas, 'pointerdown', 150, 125);
    await point(canvas, 'mousedown', 150, 125);
    await point(root, 'pointermove', 190, 145);
    expect(rect()).toEqual({ x: 140, y: 120, width: 100, height: 50 });
    expect(canvasMouseDown).not.toHaveBeenCalled();
    expect(hasObjectAtPointer).not.toHaveBeenCalled();
    expect(setEditorTool).not.toHaveBeenCalled();
    await point(root, 'pointerup', 190, 145);
    root.dispatchEvent(new Event('lostpointercapture', { bubbles: true }));
    await flush();
    expect(root.classList.contains('is-space-moving')).toBe(true);
    await key('keyup', ' ');
    expect(root.classList.contains('is-space-moving')).toBe(false);
    expect(bridge.perform).not.toHaveBeenCalled();
  });

  it.each(['comment', 'text', 'ime'])('does not intercept selection modifiers during %s input', async (inputMode) => {
    const root = await edit();
    let target: EventTarget = window;
    if (inputMode === 'comment') {
      await flush();
      target = host.querySelector<HTMLInputElement>('#shot-comment')!;
    } else if (inputMode === 'text') isTextEditing.mockReturnValue(true);
    const before = rect();
    for (const value of [' ', 'Alt', 'Shift']) {
      const event = await key('keydown', value, { isComposing: inputMode === 'ime', altKey: value === 'Alt', shiftKey: value === 'Shift' }, target);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(root.classList.contains('is-space-moving')).toBe(false);
    expect(rect()).toEqual(before);
    expect(bridge.perform).not.toHaveBeenCalled();
  });

  it('clears held keys and unfinished gestures on blur, pointer cancellation and the next capture', async () => {
    const surface = await start();
    await key('keydown', ' ');
    await point(surface, 'pointerdown', 100, 100);
    await point(surface, 'pointermove', 120, 110);
    window.dispatchEvent(new Event('blur'));
    await flush();
    expect(host.querySelector('.shot__selection')).toBeNull();
    expect(host.querySelector('.is-space-moving')).toBeNull();
    const root = await edit();
    await key('keydown', ' ');
    await point(root, 'pointerdown', 150, 125);
    await point(root, 'pointermove', 160, 130);
    await point(root, 'pointercancel', 160, 130);
    const cancelled = rect();
    await point(root, 'pointermove', 200, 150);
    expect(rect()).toEqual(cancelled);
    expect(root.classList.contains('is-space-moving')).toBe(false);
    await key('keydown', ' ');
    await start();
    expect(root.classList.contains('is-space-moving')).toBe(false);
  });
});

describe('screenshot window hover', () => {
  const dimCount = (x: number, y: number) => [...host.querySelectorAll<HTMLElement>('.shot__dim')].filter(({ style }) => x >= parseFloat(style.left) && x < parseFloat(style.left) + parseFloat(style.width)
    && y >= parseFloat(style.top) && y < parseFloat(style.top) + parseFloat(style.height)).length;
  const masks = () => [...host.querySelectorAll('.shot__dim')].map((element) => element.outerHTML);
  const point = async (type: string, x: number, y: number) => {
    host.querySelector('.shot__selection-surface')!.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
    await flush();
  };

  it('previews a fullscreen back window as the complete captured rectangle including front windows', async () => {
    setContext({ ...structuredClone(context), pointer: { x: 350, y: 250 }, windows: [
      { id: 'front', x: 20, y: 30, width: 200, height: 180 },
      { id: 'middle', x: 100, y: 100, width: 160, height: 150 },
      { id: 'back', x: 0, y: 0, width: 400, height: 300 },
    ] });
    await flush();
    expect(dimCount(50, 50)).toBe(0);
    expect(dimCount(150, 150)).toBe(0);
    expect(dimCount(240, 240)).toBe(0);
    expect(dimCount(350, 250)).toBe(0);
    for (let y = 5; y < 300; y += 10) {
      for (let x = 5; x < 400; x += 10) {
        expect(dimCount(x, y)).toBe(0);
      }
    }
    expect(host.querySelector('.shot__selection, .shot__handle')).toBeNull();
    expect(host.querySelector<HTMLElement>('.shot__hover')!.style.width).toBe('400px');
    expect(host.querySelector('.shot__dim, .shot__hover-clip')).toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    expect(host.querySelector('.shot__hover-clip')).toBeNull();
    expect(host.querySelector<HTMLElement>('.shot__selection')!.style.width).toBe('400px');
    expect(host.querySelector('.shot__dim')).toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true }));
    await flush();
    expect(exportScreenshot.mock.calls[0]?.[2]).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it('masks only outside a back window crop even when foreground windows cross its edges', async () => {
    setContext({ ...structuredClone(context), pointer: { x: 60, y: 230 }, windows: [
      { id: 'front', x: 100, y: 80, width: 250, height: 100 },
      { id: 'middle', x: 40, y: 40, width: 100, height: 140 },
      { id: 'back', x: 20, y: 30, width: 300, height: 230 },
    ] });
    await flush();
    const mask = masks();
    const bounds = host.querySelector('.shot__hover')!.getAttribute('style');
    for (let y = 5; y < 300; y += 10) {
      for (let x = 5; x < 400; x += 10) {
        expect(dimCount(x, y)).toBe(x >= 20 && x < 320 && y >= 30 && y < 260 ? 0 : 1);
      }
    }
    expect(host.querySelector('.shot__hover-clip')).toBeNull();
    await point('pointerdown', 60, 230);
    expect(masks()).toEqual(mask);
    await point('pointerup', 60, 230);
    expect(masks()).toEqual(mask);
    expect(host.querySelector('.shot__selection')!.getAttribute('style')).toBe(bounds);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true }));
    await flush();
    expect(exportScreenshot.mock.calls[0]?.[2]).toEqual({ x: 40, y: 60, width: 600, height: 460 });
  });

  it('keeps the same mask outside windows and does not select fullscreen on click or Enter', async () => {
    setContext({ ...structuredClone(context), pointer: { x: 350, y: 250 }, windows: [context.windows[0]!] });
    await flush();
    expect(host.querySelector('.shot__hover')).toBeNull();
    expect(dimCount(50, 50)).toBe(1);
    expect(dimCount(350, 250)).toBe(1);
    expect(host.querySelector('.shot__hint, .shot__fullscreen')).toBeNull();
    await point('pointerdown', 350, 250);
    await point('pointerup', 350, 250);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    expect(host.querySelector('.shot__selection, .shot__toolbar')).toBeNull();
    expect(bridge.bandEnd).toHaveBeenCalledWith('capture-1');
    await point('pointerdown', 0, 0);
    await point('pointermove', 400, 300);
    await point('pointerup', 400, 300);
    expect(host.querySelector<HTMLElement>('.shot__selection')!.style.width).toBe('400px');
    expect(host.querySelector('.shot__dim')).toBeNull();
  });

  it('anchors a clicked window toolbar at the confirmation point without focusing the container or following the pointer', async () => {
    setContext({
      ...structuredClone(context),
      sourceSize: { width: 2400, height: 1800 }, displaySize: { width: 1200, height: 900 },
      windows: [{ id: 'window', x: 200, y: 100, width: 800, height: 600 }],
      pointer: { x: 900, y: 650 },
    });
    await flush();
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    const surface = host.querySelector('.shot__selection-surface')!;
    for (const type of ['pointerdown', 'pointerup']) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      surface.dispatchEvent(new MouseEvent(type, { clientX: 900, clientY: 650, bubbles: true }));
      await flush();
    }
    await flush();
    const toolbar = host.querySelector<HTMLElement>('.shot__toolbar')!;
    expect([toolbar.style.left, toolbar.style.top]).toEqual(['624px', '710px']);
    expect(toolbar.contains(document.activeElement)).toBe(false);
    expect(toolbar.hasAttribute('tabindex')).toBe(false);
    host.querySelector('.shot')!.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 120, bubbles: true }));
    await flush();
    expect([toolbar.style.left, toolbar.style.top]).toEqual(['624px', '710px']);
    const grip = host.querySelector('.shot__move-grip')!;
    grip.dispatchEvent(new MouseEvent('pointerdown', { clientX: 200, clientY: 80, bubbles: true }));
    host.querySelector('.shot')!.dispatchEvent(new MouseEvent('pointermove', { clientX: 220, clientY: 90, bubbles: true }));
    host.querySelector('.shot')!.dispatchEvent(new MouseEvent('pointerup', { clientX: 220, clientY: 90, bubbles: true }));
    await flush();
    expect([toolbar.style.left, toolbar.style.top]).toEqual(['638px', '720px']);
  });

  it('preselects the top window without opening the editor, and follows the pointer', async () => {
    setContext(structuredClone(context));
    await flush();
    expect(dimCount(100, 100)).toBe(0);
    expect(dimCount(350, 250)).toBe(1);
    expect(host.querySelector('.shot__selection, .shot__handle')).toBeNull();
    const hover = host.querySelector<HTMLElement>('.shot__hover')!;
    expect([hover.style.left, hover.style.top, hover.style.width]).toEqual(['20px', '30px', '200px']);
    expect(host.querySelector('.shot__toolbar')).toBeNull();
    expect(bridge.ready).toHaveBeenCalledWith('capture-1');
    host.querySelector('.shot')!.dispatchEvent(new MouseEvent('pointermove', { clientX: 350, clientY: 250, bubbles: true }));
    await flush();
    expect(dimCount(100, 100)).toBe(0);
    expect(dimCount(350, 250)).toBe(0);
    expect(hover.style.width).toBe('400px');
  });

  it('leaves other screens completely undimmed, then transfers hover between screens', async () => {
    setContext({ ...structuredClone(context), pointer: null });
    await flush();
    expect(host.querySelector('.shot__dim, .shot__fullscreen')).toBeNull();
    host.querySelector('.shot')!.dispatchEvent(new MouseEvent('pointermove', { clientX: 100, clientY: 100, bubbles: true }));
    await flush();
    expect(bridge.pointerEnter).toHaveBeenCalledWith('capture-1');
    expect(dimCount(100, 100)).toBe(0);
    expect(dimCount(350, 250)).toBe(1);
    leaveScreen('old-capture');
    await flush();
    expect(dimCount(350, 250)).toBe(1);
    leaveScreen('capture-1');
    await flush();
    expect(host.querySelector('.shot__dim, .shot__fullscreen')).toBeNull();
  });

  it('updates late candidates and confirms the preview with Enter without moving it again', async () => {
    setContext({ ...structuredClone(context), windows: [] });
    await flush();
    expect(host.querySelector('.shot__hover')).toBeNull();
    expect(dimCount(100, 100)).toBe(1);
    setCandidates('capture-1', context.windows);
    await flush();
    expect(dimCount(100, 100)).toBe(0);
    expect(dimCount(350, 250)).toBe(1);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    expect(document.activeElement).toBe(host.querySelector('button[aria-label="选择"]'));
    expect(host.querySelector('.shot__hover')).toBeNull();
    expect(host.querySelector<HTMLElement>('.shot__selection')!.style.width).toBe('200px');
    leaveScreen('capture-1');
    await flush();
    expect(host.querySelector('.shot__selection')).not.toBeNull();
    clearSelection('capture-1');
    await flush();
    expect(host.querySelector('.shot__dim, .shot__hover, .shot__selection')).toBeNull();
  });

  it.each(['zh', 'en'] as const)('shows a preview border and loupe without handles or instructions in %s', async (locale) => {
    setContext({ ...structuredClone(context), locale });
    await flush();
    expect(host.querySelector('.shot__hover')).not.toBeNull();
    expect(host.querySelector('.shot__handle, .shot__hint')).toBeNull();
    expect(host.querySelector('.shot__loupe')).not.toBeNull();
    expect(host.querySelector('.shot__fullscreen')).toBeNull();
    await point('pointerdown', 100, 100);
    await point('pointermove', 160, 130);
    expect(host.querySelector('.shot__hover, .shot__handle, .shot__hint, .shot__fullscreen')).toBeNull();
    expect(host.querySelector('.shot__loupe')).not.toBeNull();
    await point('pointerup', 160, 130);
    expect(host.querySelector('.shot__hint, .shot__loupe, .shot__fullscreen')).toBeNull();
    expect(host.querySelectorAll('.shot__handle')).toHaveLength(8);
    host.querySelector('.shot')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await flush();
    expect(host.querySelector('.shot__toolbar, .shot__fullscreen')).toBeNull();
    expect(host.querySelector('.shot__hover')).not.toBeNull();
  });

  it('holds the hovered window on press and small jitter, then changes directly to a drawn area', async () => {
    setContext(structuredClone(context));
    await flush();
    const mask = masks();
    const hover = host.querySelector('.shot__hover')!.outerHTML;
    expect(dimCount(120, 115)).toBe(0);
    expect(dimCount(60, 60)).toBe(0);
    expect(dimCount(350, 250)).toBe(1);
    await point('pointerdown', 100, 100);
    expect(host.querySelector('.shot__selection, .shot__toolbar')).toBeNull();
    expect(masks()).toEqual(mask);
    expect(host.querySelector('.shot__hover')!.outerHTML).toBe(hover);
    await point('pointermove', 103, 102);
    expect(host.querySelector('.shot__selection')).toBeNull();
    expect(masks()).toEqual(mask);
    expect(host.querySelector('.shot__hover')!.outerHTML).toBe(hover);
    await point('pointermove', 160, 130);
    expect(host.querySelector('.shot__hover')).toBeNull();
    const area = host.querySelector<HTMLElement>('.shot__selection')!;
    expect([area.style.left, area.style.top, area.style.width, area.style.height]).toEqual(['100px', '100px', '60px', '30px']);
    expect(dimCount(120, 115)).toBe(0);
    expect(dimCount(60, 60)).toBe(1);
    expect(dimCount(350, 250)).toBe(1);
    const dims = [...host.querySelectorAll('.shot__dim')].map((element) => element.outerHTML);
    await point('pointerup', 160, 130);
    expect([...host.querySelectorAll('.shot__dim')].map((element) => element.outerHTML)).toEqual(dims);
    expect(host.querySelector('.shot__toolbar')).not.toBeNull();
  });

  it('locks click confirmation to the pressed window even when jitter crosses an edge or candidates arrive late', async () => {
    setContext({ ...structuredClone(context), pointer: { x: 219, y: 100 } });
    await flush();
    await point('pointerdown', 219, 100);
    setCandidates('capture-1', [{ id: 'late', x: 210, y: 50, width: 100, height: 200 }]);
    await flush();
    expect(dimCount(100, 100)).toBe(0);
    expect(dimCount(250, 100)).toBe(1);
    await point('pointerup', 221, 100);
    expect(host.querySelector<HTMLElement>('.shot__selection')!.style.left).toBe('20px');
    expect(host.querySelector<HTMLElement>('.shot__selection')!.style.width).toBe('200px');
  });

  it('freezes the full preview rectangle until the pressed gesture is resolved', async () => {
    setContext({ ...structuredClone(context), pointer: { x: 350, y: 250 } });
    await flush();
    const mask = masks();
    const hover = host.querySelector('.shot__hover')!.outerHTML;
    await point('pointerdown', 350, 250);
    setCandidates('capture-1', [{ id: 'replacement', x: 0, y: 0, width: 400, height: 300 }]);
    await point('pointermove', 352, 252);
    expect(masks()).toEqual(mask);
    expect(host.querySelector('.shot__hover')!.outerHTML).toBe(hover);
    expect(dimCount(100, 100)).toBe(0);
    expect(dimCount(350, 250)).toBe(0);
    await point('pointerup', 352, 252);
    expect(host.querySelector<HTMLElement>('.shot__selection')!.style.width).toBe('400px');
    expect(host.querySelector('.shot__dim')).toBeNull();
  });

  it('preserves the bright preview mask when clicking an unobscured window to edit', async () => {
    setContext(structuredClone(context));
    await flush();
    const mask = masks();
    const bounds = host.querySelector('.shot__hover')!.getAttribute('style');
    await point('pointerdown', 100, 100);
    await point('pointerup', 100, 100);
    expect(masks()).toEqual(mask);
    expect(host.querySelector('.shot__selection')!.getAttribute('style')).toBe(bounds);
    expect(host.querySelector('.shot__toolbar')).not.toBeNull();
    expect(host.querySelector<HTMLElement>('.shot__selection')!.style.width).toBe('200px');
  });

  it('does not snap back to a window when a drawn area becomes too small', async () => {
    setContext(structuredClone(context));
    await flush();
    await point('pointerdown', 100, 100);
    await point('pointermove', 140, 130);
    await point('pointerup', 101, 101);
    expect(host.querySelector('.shot__selection, .shot__toolbar')).toBeNull();
    expect(bridge.bandEnd).toHaveBeenCalledWith('capture-1');
    expect(dimCount(100, 100)).toBe(0);
    expect(dimCount(350, 250)).toBe(1);
  });

  it.each(['pointercancel', 'lostpointercapture', 'blur'])('releases a pending window gesture on %s', async (type) => {
    setContext(structuredClone(context));
    await flush();
    await point('pointerdown', 100, 100);
    if (type === 'blur') window.dispatchEvent(new Event(type));
    else if (type === 'lostpointercapture') {
      host.querySelector('.shot__selection-surface')!.dispatchEvent(new MouseEvent(type, { clientX: 100, clientY: 100, buttons: 1, bubbles: true }));
      await flush();
    } else await point(type, 100, 100);
    await point('pointerup', 100, 100);
    expect(host.querySelector('.shot__toolbar, .shot__selection')).toBeNull();
    expect(bridge.bandEnd).toHaveBeenCalledWith('capture-1');
  });

  it('keeps an inactive screen undimmed until explicit input or the owning screen releases its selection', async () => {
    setContext(structuredClone(context));
    await flush();
    clearSelection('capture-1');
    await point('pointermove', 100, 100);
    expect(host.querySelector('.shot__dim, .shot__fullscreen')).toBeNull();
    expect(bridge.pointerEnter).not.toHaveBeenCalled();
    enablePreview('old-capture');
    await flush();
    expect(host.querySelector('.shot__dim, .shot__fullscreen')).toBeNull();
    enablePreview('capture-1');
    await flush();
    expect(dimCount(100, 100)).toBe(0);
    expect(dimCount(350, 250)).toBe(1);
    clearSelection('capture-1');
    await point('pointerdown', 100, 100);
    expect(bridge.bandStart).toHaveBeenCalledWith('capture-1');
    await point('pointerup', 100, 100);
    expect(host.querySelector('.shot__toolbar')).not.toBeNull();
    expect(dimCount(100, 100)).toBe(0);
    expect(dimCount(350, 250)).toBe(1);
  });

  it('drops a captured drag when another screen explicitly takes over', async () => {
    setContext(structuredClone(context));
    await flush();
    await point('pointerdown', 100, 100);
    await point('pointermove', 160, 130);
    clearSelection('capture-1');
    await point('pointermove', 200, 160);
    await point('pointerup', 200, 160);
    expect(host.querySelector('.shot__dim, .shot__hover, .shot__selection, .shot__toolbar')).toBeNull();
  });
});

describe('frame decoding for output', () => {
  let decodes: Array<{ bitmap: { width: number; height: number; close: ReturnType<typeof vi.fn> }; resolve: () => void; reject: () => void }>;
  let fetchFrame: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    decodes = [];
    setEditorFrame.mockClear();
    fetchFrame = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['frame']) }));
    vi.stubGlobal('fetch', fetchFrame);
    vi.stubGlobal('createImageBitmap', vi.fn(() => new Promise((resolve, reject) => {
      const bitmap = { width: 800, height: 600, close: vi.fn() };
      decodes.push({ bitmap, resolve: () => resolve(bitmap), reject: () => reject(new Error('decode-failed')) });
    })));
  });

  async function edit(captureId = 'capture-1'): Promise<HTMLImageElement> {
    setContext({ ...structuredClone(context), captureId });
    await flush();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    return host.querySelector<HTMLImageElement>('.shot__frame')!;
  }

  async function add(): Promise<void> {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
  }

  it('decodes the frame in the background once editing starts and exports from the decoded copy', async () => {
    setContext(structuredClone(context));
    await flush();
    expect(fetchFrame).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    expect(fetchFrame).toHaveBeenCalledExactlyOnceWith(context.frameUrl);
    expect(createImageBitmap).toHaveBeenCalledOnce();
    decodes[0]!.resolve();
    await flush();
    expect(setEditorFrame).toHaveBeenCalledExactlyOnceWith(decodes[0]!.bitmap);
    await add();
    expect(exportScreenshot.mock.calls[0]?.[0]).toBe(decodes[0]!.bitmap);
    expect(bridge.perform).toHaveBeenCalledOnce();
  });

  it('exports from the displayed frame without waiting for a pending decode', async () => {
    const frame = await edit();
    await add();
    expect(exportScreenshot.mock.calls[0]?.[0]).toBe(frame);
    expect(bridge.perform).toHaveBeenCalledOnce();
  });

  it.each(['fetch', 'decode'])('keeps using the displayed frame when the %s fails', async (failure) => {
    if (failure === 'fetch') fetchFrame.mockResolvedValueOnce({ ok: false, blob: async () => new Blob() });
    const frame = await edit();
    decodes[0]?.reject();
    await flush();
    expect(createImageBitmap).toHaveBeenCalledTimes(failure === 'fetch' ? 0 : 1);
    await add();
    expect(setEditorFrame).not.toHaveBeenCalled();
    expect(exportScreenshot.mock.calls[0]?.[0]).toBe(frame);
    expect(bridge.perform).toHaveBeenCalledOnce();
  });

  it('decodes once per capture when the selection is redrawn', async () => {
    await edit();
    decodes[0]!.resolve();
    await flush();
    host.querySelector('.shot')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await flush();
    expect(host.querySelector('.shot.is-editing')).toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flush();
    expect(host.querySelector('.shot.is-editing')).not.toBeNull();
    expect(fetchFrame).toHaveBeenCalledOnce();
    expect(decodes[0]!.bitmap.close).not.toHaveBeenCalled();
  });

  it('releases the decoded frame for the next capture and drops a decode that finishes after it', async () => {
    const frame = await edit('capture-1');
    decodes[0]!.resolve();
    await flush();
    setEditorFrame.mockClear();
    await edit('capture-2');
    expect(setEditorFrame).toHaveBeenCalledExactlyOnceWith(frame);
    expect(decodes[0]!.bitmap.close).toHaveBeenCalledOnce();
    expect(fetchFrame).toHaveBeenCalledTimes(2);
    setContext(null);
    await flush();
    decodes[1]!.resolve();
    await flush();
    expect(decodes[1]!.bitmap.close).toHaveBeenCalledOnce();
    expect(setEditorFrame).toHaveBeenCalledOnce();
  });

  it('closes the decoded frame when the overlay is torn down', async () => {
    await edit();
    decodes[0]!.resolve();
    await flush();
    app.unmount();
    expect(decodes[0]!.bitmap.close).toHaveBeenCalledOnce();
    app = createApp(ScreenshotOverlay);
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
  });
});
