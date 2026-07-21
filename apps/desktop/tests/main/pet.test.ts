import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  PET_SIZE,
  asScreenPoint,
  dragOffset,
  initialPetPosition,
  isPetPositionOnScreen,
  loadPetState,
  petUrl,
  petWindowOptions,
  savePetState,
} from '../../src/main/pet';

describe('petWindowOptions', () => {
  it('is a small transparent borderless always-on-top strip', () => {
    const opts = petWindowOptions();
    expect(opts.width).toBe(PET_SIZE.width);
    expect(opts.height).toBe(PET_SIZE.height);
    expect(opts.transparent).toBe(true);
    expect(opts.frame).toBe(false);
    expect(opts.resizable).toBe(false);
    expect(opts.fullscreenable).toBe(false);
    expect(opts.alwaysOnTop).toBe(true);
    expect(opts.skipTaskbar).toBe(true);
    expect(opts.hasShadow).toBe(false);
    // Floating but never focus-stealing (macOS still delivers mouse events).
    expect(opts.focusable).toBe(false);
  });

  it('keeps the sandboxed preload boundary of the main window', () => {
    const webPreferences = petWindowOptions().webPreferences;
    expect(webPreferences?.contextIsolation).toBe(true);
    expect(webPreferences?.nodeIntegration).toBe(false);
    expect(webPreferences?.sandbox).toBe(true);
    expect(webPreferences?.preload).toMatch(/preload\.cjs$/);
  });
});

describe('initialPetPosition', () => {
  it('anchors to the bottom-right of the work area with the default margin', () => {
    expect(initialPetPosition({ x: 0, y: 0, width: 1440, height: 875 })).toEqual({
      x: 1440 - PET_SIZE.width - 40,
      y: 875 - PET_SIZE.height - 24,
    });
  });

  it('respects a non-zero work-area origin (menu bar / multi-display)', () => {
    expect(initialPetPosition({ x: 100, y: 25, width: 1440, height: 850 })).toEqual({
      x: 100 + 1440 - PET_SIZE.width - 40,
      y: 25 + 850 - PET_SIZE.height - 24,
    });
  });
});

describe('isPetPositionOnScreen', () => {
  const primary = { x: 0, y: 0, width: 1440, height: 875 };
  const externalLeft = { x: -1920, y: 0, width: 1920, height: 1055 };

  it('accepts a position whose centre is on a connected display', () => {
    expect(isPetPositionOnScreen(initialPetPosition(primary), [primary])).toBe(true);
    expect(isPetPositionOnScreen({ x: 100, y: 100 }, [primary])).toBe(true);
    // Centre on a connected display, even if the window straddles the edge.
    expect(isPetPositionOnScreen({ x: -PET_SIZE.width / 2, y: 100 }, [primary])).toBe(true);
    expect(isPetPositionOnScreen({ x: -100, y: 100 }, [primary, externalLeft])).toBe(true);
  });

  it('rejects positions left behind on a disconnected display', () => {
    // Was on the external monitor, now unplugged.
    expect(isPetPositionOnScreen({ x: -500, y: 100 }, [primary])).toBe(false);
    // Fully past the right/bottom edges too.
    expect(isPetPositionOnScreen({ x: 5000, y: 100 }, [primary])).toBe(false);
    expect(isPetPositionOnScreen({ x: 100, y: 5000 }, [primary])).toBe(false);
    // No displays at all (defensive).
    expect(isPetPositionOnScreen({ x: 0, y: 0 }, [])).toBe(false);
  });
});

describe('dragOffset', () => {
  it('is window position minus pointer position (kept constant through a drag)', () => {
    expect(dragOffset({ x: 300, y: 200 }, { screenX: 320, screenY: 240 })).toEqual({
      x: -20,
      y: -40,
    });
  });
});

describe('asScreenPoint', () => {
  it('accepts finite screen coordinates', () => {
    expect(asScreenPoint({ screenX: 1.5, screenY: -2 })).toEqual({ screenX: 1.5, screenY: -2 });
  });

  it('rejects junk (missing keys, non-finite numbers, non-objects)', () => {
    expect(asScreenPoint({ screenX: 1 })).toBeNull();
    expect(asScreenPoint({ screenX: Number.NaN, screenY: 0 })).toBeNull();
    expect(asScreenPoint({ screenX: Infinity, screenY: 0 })).toBeNull();
    expect(asScreenPoint({ screenX: '1', screenY: 2 })).toBeNull();
    expect(asScreenPoint('point')).toBeNull();
    expect(asScreenPoint(null)).toBeNull();
  });
});

describe('petUrl', () => {
  it('loads app://renderer/pet.html when packaged (no dev server)', () => {
    expect(petUrl(undefined)).toBe('app://renderer/pet.html');
  });

  it('serves pet.html from the Vite dev server in HMR dev', () => {
    expect(petUrl('http://127.0.0.1:5174/')).toBe('http://127.0.0.1:5174/pet.html');
  });
});

describe('pet-state.json persistence', () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir !== null) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it('round-trips position + visibility', () => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-pet-'));
    const file = join(dir, 'pet-state.json');
    savePetState(file, { position: { x: 123, y: 456 }, visible: false });
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ x: 123, y: 456, visible: false });
    expect(loadPetState(file)).toEqual({ position: { x: 123, y: 456 }, visible: false });
  });

  it('round-trips a hidden state without a position', () => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-pet-'));
    const file = join(dir, 'pet-state.json');
    savePetState(file, { position: null, visible: true });
    expect(loadPetState(file)).toEqual({ position: null, visible: true });
  });

  it('defaults to visible with no file, malformed JSON, or a legacy position-only file', () => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-pet-'));
    const file = join(dir, 'pet-state.json');
    expect(loadPetState(file)).toEqual({ position: null, visible: true });
    writeFileSync(file, 'not json{');
    expect(loadPetState(file)).toEqual({ position: null, visible: true });
    // Legacy files (position only, no visible flag) keep the position and
    // stay visible — the toggle didn't exist when they were written.
    writeFileSync(file, JSON.stringify({ x: 1, y: 2 }));
    expect(loadPetState(file)).toEqual({ position: { x: 1, y: 2 }, visible: true });
    // Wrong-shaped coordinates drop the position but not the app.
    writeFileSync(file, JSON.stringify({ x: '1', y: 2, visible: false }));
    expect(loadPetState(file)).toEqual({ position: null, visible: false });
  });
});
