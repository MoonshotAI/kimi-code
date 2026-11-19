import { Point, type FabricObject, type TPointerEventInfo } from 'fabric';
import { createComposerEditor, runComposerMenuEdit } from '@moonshot-ai/app-composer/runtime';
import { parseAttachmentLinks } from '@moonshot-ai/app-composer/model';
import { ScreenshotEditor } from '../../src/renderer/screenshot/editor';
import { exportScreenshot } from '../../src/renderer/screenshot/export';
import type { ScreenshotTool, ScreenshotToolStyle } from '../../src/renderer/screenshot/types';

export async function checkScreenshotEditor(): Promise<string[]> {
  const style: ScreenshotToolStyle = { color: '#ff3b30', width: 4, fill: false, fontSize: 24, pixelSize: 16 };
  const selection = { x: 0, y: 0, width: 640, height: 480 };
  const passed: string[] = [];
  const check = (condition: boolean, message: string): void => {
    if (!condition) throw new Error(message);
    passed.push(message);
  };
  for (const comment of ['', '请关注这里\n第二行说明']) {
    const host = document.createElement('div');
    document.body.append(host);
    const composer = createComposerEditor(host, { initialText: 'before ', onChange: () => {}, handleKeyDown: () => false });
    try {
      composer.insertAttachmentWithText(
        { attId: 'screenshot1', name: 'screenshot.png', kind: 'image' },
        comment,
        7,
        { attId: 'screenshot1', name: 'screenshot.png', kind: 'image', key: 'blob:screenshot1', refCount: 0, uploading: true, previewUrl: 'blob:screenshot-preview' },
      );
      const inserted = composer.getText();
      check(composer.getAttachmentInventory().activeIds.has('screenshot1'), 'screenshot is active in the media rail');
      const reference = parseAttachmentLinks(inserted)[0]?.attrs;
      check(reference?.attId === 'screenshot1' && (reference.comment ?? '') === comment, 'screenshot reference and optional comment are bundled together');
      check(composer.getAttachmentEntries()[0]?.previewUrl === 'blob:screenshot-preview', 'screenshot resource is available for media preview and upload');
      runComposerMenuEdit(composer.dom, 'undo');
      check(composer.getText() === 'before ' && !composer.getAttachmentInventory().activeIds.has('screenshot1'), 'one undo removes screenshot activation and its comment');
      runComposerMenuEdit(composer.dom, 'redo');
      check(composer.getText() === inserted && composer.getAttachmentInventory().activeIds.has('screenshot1'), 'one redo restores screenshot activation and its comment');
      check(composer.getAttachmentEntries()[0]?.previewUrl === 'blob:screenshot-preview', 'redo keeps the original screenshot resource');
    } finally {
      composer.destroy();
      host.remove();
    }
  }
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.001;
  const frame = document.createElement('canvas');
  frame.width = 640;
  frame.height = 480;
  const ctx = frame.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 640, 480);
  for (let x = 0; x < 640; x += 4) {
    ctx.fillStyle = x < 320 ? '#ff0000' : '#0000ff';
    ctx.fillRect(x, 0, 2, 480);
  }
  ctx.fillStyle = '#000000';
  ctx.fillRect(400, 0, 16, 480);
  const element = document.createElement('canvas');
  let selected: { tool: ScreenshotTool; style: ScreenshotToolStyle } | null = null;
  const editor = new ScreenshotEditor(element, {
    frame, sourceWidth: 640, sourceHeight: 480, displayWidth: 320, displayHeight: 240,
    onHistoryChange: () => {}, onSelectionChange: (value) => { selected = value; },
  });
  const draw = (tool: ScreenshotTool, x = 100, y = 100, endX = 240, endY = 180): FabricObject => {
    editor.setTool(tool);
    for (const [type, px, py] of [['mouse:down', x, y], ['mouse:move', endX, endY], ['mouse:up', endX, endY]] as const) {
      editor.canvas.fire(type, { e: new MouseEvent(type), scenePoint: new Point(px, py), viewportPoint: new Point(px, py) } as TPointerEventInfo);
    }
    return editor.canvas.getObjects().at(-1)!;
  };
  const select = (object: FabricObject): void => { editor.setTool('select'); editor.canvas.setActiveObject(object); };
  const pixels = (): string => editor.annotationCanvas(selection).toDataURL();
  const reset = (): void => {
    editor.reset();
    editor.resize(640, 480, 320, 240);
    editor.setSelection(selection);
    editor.setStyle(style);
  };
  try {
    document.body.append(editor.canvas.wrapperEl);
    for (const tool of ['rect', 'ellipse', 'line', 'arrow', 'number', 'mosaic', 'pen'] as const) {
      reset();
      editor.setTool(tool);
      const drawWithMouse = (offset: number): void => {
        editor.canvas.calcOffset();
        const bounds = editor.canvas.upperCanvasEl.getBoundingClientRect();
        for (const [type, x, y, buttons] of [['mousedown', 40 + offset, 40, 1], ['mousemove', 110 + offset, 80, 1], ['mouseup', 110 + offset, 80, 0]] as const) {
          editor.canvas.upperCanvasEl.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: bounds.x + x, clientY: bounds.y + y, button: 0, buttons, view: window }));
        }
      };
      drawWithMouse(0);
      const object = editor.canvas.getObjects()[0]!;
      check(object !== undefined && editor.canvas.getActiveObject() === undefined && selected === null, `${tool} finishes drawing without automatic selection`);
      const before = pixels();
      const changedStyle = { ...style, width: 5, fontSize: 25, pixelSize: 17 };
      editor.setStyle(changedStyle);
      editor.commitStyle();
      check(pixels() === before, `${tool} unselected drawing is unchanged by tool size adjustment`);
      drawWithMouse(80);
      const next = editor.canvas.getObjects()[1]!;
      check(next !== undefined && editor.canvas.getActiveObject() === undefined, `${tool} continues drawing without selecting the next object`);
      select(next);
      check((selected as { style: ScreenshotToolStyle } | null)?.style[tool === 'number' ? 'fontSize' : tool === 'mosaic' ? 'pixelSize' : 'width'] === changedStyle[tool === 'number' ? 'fontSize' : tool === 'mosaic' ? 'pixelSize' : 'width'], `${tool} next drawing inherits the adjusted size`);
      check(editor.deleteSelection() && editor.canvas.getObjects().length === 1 && editor.canvas.getObjects()[0] === object, `${tool} delete removes only the manually selected object`);
      editor.undo();
      check(editor.canvas.getObjects().length === 2, `${tool} undo restores the deleted drawing`);
    }
    for (const tool of ['rect', 'ellipse', 'line', 'arrow', 'mosaic'] as const) {
      reset();
      draw(tool, 100, 100, 101, 101);
      check(!editor.hasAnnotations() && editor.canvas.getActiveObject() === undefined, `${tool} ignores tiny drawings without selecting a discarded object`);
    }
    reset();
    draw('arrow');
    draw('rect', 180, 180, 260, 240);
    draw('number', 300, 250);
    draw('mosaic', 64, 64, 120, 120);
    const annotated = pixels();
    editor.clear();
    check(!editor.hasAnnotations() && selected === null, 'clear removes all annotation types without a selected object');
    editor.undo();
    check(pixels() === annotated, 'one undo restores all cleared annotations and their original pixels');
    editor.redo();
    check(!editor.hasAnnotations(), 'redo clears all annotations again');
    draw('number', 300, 250);
    check(editor.hasAnnotations(), 'clear keeps the crop available for new annotations');
    reset();
    draw('number');
    const first = pixels();
    const second = draw('number', 200, 100);
    check(second.getCenterPoint().eq(new Point(200, 100)), 'number is centered at click');
    const both = pixels();
    editor.undo();
    check(pixels() === first, 'undo removes last number');
    editor.redo();
    check(pixels() === both, 'redo restores number pixels');
    select(editor.canvas.getObjects()[1]!);
    check(JSON.stringify(selected) === JSON.stringify({ tool: 'number', style }), 'number selection preserves drawing width and fill');
    editor.deleteSelection();
    check(pixels() === first, 'delete affects only selected number');
    draw('number', 200, 100);
    check(pixels() === both, 'numbering continues after deletion');
    reset();
    const marker = draw('number');
    check(pixels() === first, 'new capture resets numbering');
    select(marker);
    editor.setStyle({ ...style, fontSize: 40, color: '#ffffff' });
    editor.commitStyle();
    check(marker.width === 68 && marker.getCenterPoint().eq(new Point(100, 100)), 'number size changes around its center');
    const larger = pixels();
    editor.undo();
    check(pixels() === first, 'undo restores number size and color');
    editor.redo();
    check(pixels() === larger, 'redo restores resized number pixels');

    for (const [color, background] of [
      ['#ff3b30', [220, 48, 40]],
      ['#ff9500', [179, 95, 0]],
      ['#ffcc00', [144, 115, 0]],
      ['#34c759', [35, 132, 58]],
      ['#00c7be', [0, 131, 125]],
      ['#1783ff', [22, 114, 224]],
      ['#af52de', [155, 66, 206]],
      ['#ffffff', [115, 115, 115]],
    ] as const) {
      reset();
      editor.setStyle({ ...style, color });
      const marker = draw('number');
      const rendered = editor.annotationCanvas(selection).getContext('2d')!;
      const data = rendered.getImageData(92, 88, 16, 24).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255 && data[i + 3] === 255) count++;
      }
      check(count > 15, `${color} number uses white digits`);
      const renderedBackground = Array.from(rendered.getImageData(100, 82, 1, 1).data);
      check(JSON.stringify(renderedBackground) === JSON.stringify([...background, 255]), `${color} number uses its readable background`);
      const rgb = renderedBackground.slice(0, 3).map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      const luminance = rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
      check(1.05 / (luminance + 0.05) >= 4.5, `${color} number white digits meet 4.5:1 contrast`);
      const image = new Image();
      image.src = frame.toDataURL();
      await image.decode();
      const exported = await exportScreenshot(image, editor, selection);
      const bitmap = await createImageBitmap(new Blob([exported.bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      check(JSON.stringify(Array.from(context.getImageData(92, 88, 16, 24).data)) === JSON.stringify(Array.from(data)), `${color} exported PNG preserves number contrast`);
      select(marker);
      check((selected as { style: ScreenshotToolStyle } | null)?.style.color === color, `${color} number retains the selected drawing color`);
      const before = pixels();
      select(marker);
      editor.setStyle({ ...style, color: color === '#ffcc00' ? '#ff3b30' : '#ffcc00' });
      editor.commitStyle();
      editor.undo();
      check(pixels() === before, `${color} number contrast survives undo`);
    }

    for (const tool of ['rect', 'ellipse', 'line', 'arrow'] as const) {
      reset();
      const object = draw(tool);
      object.set({ scaleX: 1.5, scaleY: 1.25 });
      object.setCoords();
      editor.canvas.fire('object:modified', { target: object });
      const before = pixels();
      select(object);
      const center = object.getCenterPoint();
      const bounds = object.getBoundingRect();
      editor.setStyle({ ...style, width: 12 });
      editor.commitStyle();
      const changed = object.getBoundingRect();
      check(near(object.getCenterPoint().x, center.x) && near(object.getCenterPoint().y, center.y), `${tool} center stays fixed`);
      check(near(changed.left, bounds.left - 4) && near(changed.top, bounds.top - 4) && near(changed.width, bounds.width + 8) && near(changed.height, bounds.height + 8), `${tool} stroke expands symmetrically after resize`);
      const after = pixels();
      check(before !== after, `${tool} stroke changes rendered pixels`);
      editor.undo();
      check(pixels() === before, `${tool} undo preserves geometry and pixels`);
      editor.redo();
      check(pixels() === after, `${tool} redo preserves geometry and pixels`);
    }

    reset();
    const mosaic = draw('mosaic', 64, 64, 256, 192);
    let output = editor.annotationCanvas(selection).getContext('2d')!;
    const sample = (x: number, y: number): number[] => Array.from(output.getImageData(x, y, 1, 1).data);
    const block = sample(70, 80);
    check(sample(60, 80)[3] === 0 && block[3] === 255, 'pixelation covers only its rectangle');
    check(block[0] === 255 && block[1]! > 0 && block[1]! < 255 && JSON.stringify(sample(71, 80)) === JSON.stringify(block), 'pixelation averages source pixels into blocks');
    const original = pixels();
    select(mosaic);
    check(JSON.stringify(selected) === JSON.stringify({ tool: 'mosaic', style }), 'pixelation selection preserves drawing style');
    editor.nudgeSelection(300, 0);
    output = editor.annotationCanvas(selection).getContext('2d')!;
    check(sample(70, 80)[3] === 0 && sample(370, 80)[2] === 255 && sample(370, 80)[0]! < 255, 'moving pixelation samples its new background');
    const moved = pixels();
    editor.undo();
    check(pixels() === original, 'undo restores pixelation region');
    editor.redo();
    check(pixels() === moved, 'redo restores pixelation pixels');
    select(editor.canvas.getObjects()[0]!);
    editor.setStyle({ ...style, pixelSize: 32 });
    editor.commitStyle();
    const coarser = pixels();
    check(coarser !== moved, 'block size changes pixelation pixels');
    editor.undo();
    check(pixels() === moved, 'undo restores block size');
    editor.redo();
    check(pixels() === coarser, 'redo restores block size');
    const background = new Image();
    background.src = frame.toDataURL();
    await background.decode();
    const exported = await exportScreenshot(background, editor, selection);
    const png = new Image();
    const url = URL.createObjectURL(new Blob([exported.bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
    try {
      png.src = url;
      await png.decode();
      const flattened = document.createElement('canvas');
      flattened.width = 640;
      flattened.height = 480;
      const flattenedContext = flattened.getContext('2d')!;
      flattenedContext.drawImage(png, 0, 0);
      const pixel = flattenedContext.getImageData(405, 80, 1, 1).data;
      check(png.naturalWidth === 640 && png.naturalHeight === 480 && pixel[2]! > 0 && pixel[3] === 255, 'export flattens source and pixelation into full-resolution PNG');
    } finally {
      URL.revokeObjectURL(url);
    }
    select(editor.canvas.getObjects()[0]!);
    editor.deleteSelection();
    check(!editor.hasAnnotations(), 'pixelation can be deleted');
    editor.undo();
    check(editor.hasAnnotations(), 'deleted pixelation can be restored');

    reset();
    editor.setSelection({ x: 100, y: 100, width: 200, height: 100 });
    draw('number', 50, 50);
    draw('mosaic', 50, 50);
    check(!editor.hasAnnotations(), 'new tools ignore clicks outside crop');
    draw('mosaic', 250, 150, 50, 50);
    output = editor.annotationCanvas(selection).getContext('2d')!;
    check(sample(99, 120)[3] === 0 && sample(101, 120)[3] === 255 && sample(251, 120)[3] === 0, 'backwards pixelation drag clips to crop');

    for (const background of ['#fafafa', '#202020', '#4a90e2']) {
      reset();
      editor.canvas.backgroundColor = background;
      draw('arrow', 100, 100, 220, 100);
      for (const restored of [false, true]) {
        if (restored) { editor.undo(); editor.redo(); }
        select(editor.canvas.getObjects()[0]!);
        editor.canvas.renderAll();
        const data = editor.canvas.getContext().getImageData(80, 60, 160, 80).data;
        let blue = 0;
        let white = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] === 255 && data[i] === 74 && data[i + 1] === 144 && data[i + 2] === 226) blue++;
          if (data[i + 3] === 255 && data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) white++;
        }
        check(blue > 300 && white > 300, `${restored ? 'restored' : 'new'} arrow has visible blue and white selection edges on ${background} at 2x`);
        const annotation = editor.annotationCanvas(selection).getContext('2d')!.getImageData(0, 0, 640, 480).data;
        let exportedBlue = 0;
        for (let i = 0; i < annotation.length; i += 4) {
          if (annotation[i] === 74 && annotation[i + 1] === 144 && annotation[i + 2] === 226 && annotation[i + 3] === 255) exportedBlue++;
        }
        if (background !== '#4a90e2') check(exportedBlue === 0, 'annotation export excludes the blue selection controls');
      }
    }
    return passed;
  } finally {
    await editor.canvas.dispose();
    element.remove();
  }
}
