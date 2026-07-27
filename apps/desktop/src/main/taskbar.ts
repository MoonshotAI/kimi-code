// Windows taskbar attention: an overlay badge on the taskbar button plus
// flash-frame while new attention arrives — the Windows counterpart of the
// macOS menu-bar count + Dock badge (Tray.setTitle and app.dock don't exist
// on Windows). Fed from tray.ts's setTrayAttention (the renderer's
// kimi:tray-attention pushes); no-op on other platforms.
//
// The badge pixels are generated at runtime (nativeImage.createFromBitmap),
// so there is no asset to ship and nothing for extraResources to miss.

import { nativeImage } from 'electron';
import type { BrowserWindow, NativeImage } from 'electron';

import { getMainWindow } from './window';

// --- overlay badge ------------------------------------------------------------

// Attention red; written BGRA premultiplied by coverage below.
const BADGE_RGB = { r: 0xe5, g: 0x48, b: 0x4d };

const BADGE_GLYPHS: Record<string, readonly string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000'],
};

export function badgeText(total: number): string {
  if (total <= 0) return '';
  return total > 99 ? '99+' : String(Math.floor(total));
}

function roundedRectCoverage(
  pixelX: number,
  pixelY: number,
  box: { x: number; y: number; width: number; height: number; radius: number },
  scale: number,
): number {
  const centerX = Math.min(Math.max(pixelX, box.x + box.radius), box.x + box.width - box.radius);
  const centerY = Math.min(Math.max(pixelY, box.y + box.radius), box.y + box.height - box.radius);
  const distance = Math.hypot(pixelX - centerX, pixelY - centerY);
  return Math.max(0, Math.min(1, (box.radius - distance) * scale + 0.5));
}

/** Numeric badge pixels: a compact red circle/pill on a transparent 16px
    logical canvas, with a dependency-free 3x5 white bitmap font. Counts cap
    visually at 99+ while the tooltip retains the exact breakdown. */
export function badgePixels(size: number, total: number): Buffer {
  const pixels = Buffer.alloc(size * size * 4, 0);
  const text = badgeText(total);
  if (text === '') return pixels;
  const scale = size / 16;
  const textWidth = text.length * 3 + text.length - 1;
  const boxWidth = Math.max(10, textWidth + 4);
  const box = {
    x: (16 - boxWidth) / 2,
    y: 3,
    width: boxWidth,
    height: 10,
    radius: 5,
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const coverage = roundedRectCoverage((x + 0.5) / scale, (y + 0.5) / scale, box, scale);
      if (coverage === 0) continue;
      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(BADGE_RGB.b * coverage);
      pixels[offset + 1] = Math.round(BADGE_RGB.g * coverage);
      pixels[offset + 2] = Math.round(BADGE_RGB.r * coverage);
      pixels[offset + 3] = Math.round(255 * coverage);
    }
  }
  const textX = Math.floor((16 - textWidth) / 2);
  const textY = 5;
  for (let charIndex = 0; charIndex < text.length; charIndex++) {
    const glyph = BADGE_GLYPHS[text[charIndex]!];
    if (glyph === undefined) continue;
    for (let glyphY = 0; glyphY < glyph.length; glyphY++) {
      for (let glyphX = 0; glyphX < 3; glyphX++) {
        if (glyph[glyphY]![glyphX] !== '1') continue;
        const startX = (textX + charIndex * 4 + glyphX) * scale;
        const startY = (textY + glyphY) * scale;
        for (let py = startY; py < startY + scale; py++) {
          for (let px = startX; px < startX + scale; px++) {
            const offset = (py * size + px) * 4;
            pixels[offset] = 255;
            pixels[offset + 1] = 255;
            pixels[offset + 2] = 255;
            pixels[offset + 3] = 255;
          }
        }
      }
    }
  }
  return pixels;
}

// The overlay slot is 16px logical; the 2x representation keeps it sharp on
// high-DPI displays.
function createBadgeImage(total: number): NativeImage | null {
  try {
    const image = nativeImage.createFromBitmap(badgePixels(16, total), { width: 16, height: 16 });
    image.addRepresentation({ scaleFactor: 2, width: 32, height: 32, buffer: badgePixels(32, total) });
    return image.isEmpty() ? null : image;
  } catch {
    return null;
  }
}

// --- state machine --------------------------------------------------------------

export interface TaskbarWindowLike {
  isDestroyed(): boolean;
  isFocused(): boolean;
  setOverlayIcon(overlay: NativeImage | null, description: string): void;
  flashFrame(flag: boolean): void;
  on(event: 'focus', listener: () => void): void;
}

export interface TaskbarAttentionController {
  update(total: number, description: string): void;
}

/** Per-window attention state: badge while anything pends; flash only when
    the total GROWS while unfocused (re-pushing an unchanged count, e.g. the
    boot-time restore of last-known state, must not flash), stop flashing on
    focus or when caught up. A failed badge render degrades to flash-only. */
export function createTaskbarAttention(
  win: TaskbarWindowLike,
  badgeForTotal: (total: number) => NativeImage | null,
): TaskbarAttentionController {
  let lastTotal: number | null = null;
  win.on('focus', () => win.flashFrame(false));
  return {
    update(total: number, description: string): void {
      if (win.isDestroyed()) return;
      if (total > 0) {
        const badge = badgeForTotal(total);
        if (badge !== null) {
          win.setOverlayIcon(badge, description);
        } else {
          win.setOverlayIcon(null, '');
        }
      } else {
        win.setOverlayIcon(null, '');
      }
      if (lastTotal !== null && total > lastTotal && !win.isFocused()) win.flashFrame(true);
      if (total === 0) win.flashFrame(false);
      lastTotal = total;
    },
  };
}

// --- production wiring ----------------------------------------------------------

const cachedBadges = new Map<string, NativeImage | null>();
let badgeWarningShown = false;
let controller: TaskbarAttentionController | null = null;
let controllerWindow: BrowserWindow | null = null;

function badgeForTotal(total: number): NativeImage | null {
  const key = badgeText(total);
  if (!cachedBadges.has(key)) {
    cachedBadges.set(key, createBadgeImage(total));
  }
  const badge = cachedBadges.get(key) ?? null;
  if (badge === null && !badgeWarningShown) {
    badgeWarningShown = true;
    console.warn('[taskbar] badge image creation failed, overlay icon disabled');
  }
  return badge;
}

/** Entry point for tray.ts: Windows-only, resolves the (possibly recreated)
    main window lazily and rebuilds the per-window controller when it changes. */
export function setTaskbarAttention(total: number, description: string): void {
  if (process.platform !== 'win32') return;
  const win = getMainWindow();
  if (win === null || win.isDestroyed()) return;
  if (controllerWindow !== win || controller === null) {
    controller = createTaskbarAttention(win, badgeForTotal);
    controllerWindow = win;
  }
  controller.update(total, description);
}
