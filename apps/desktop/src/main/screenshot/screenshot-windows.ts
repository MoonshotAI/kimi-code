import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { app, screen } from 'electron';
import type { DisplayLike, RegionRect } from './controller';
import { log } from '../diagnostics/log';

const execFileAsync = promisify(execFile);

interface NativeWindow {
  id: string | number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface NativeWindowList {
  units: 'points' | 'pixels';
  windows: NativeWindow[];
}

export interface ScreenshotWindowCandidate extends RegionRect {
  id: string;
}

function executableName(): string | null {
  if (process.platform === 'darwin') return 'screenshot-window-list';
  if (process.platform === 'win32') return 'screenshot-window-list.exe';
  return null;
}

function executablePath(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'screenshot-window-list', name)
    : join(app.getAppPath(), 'native', 'screenshot-window-list', 'dist', name);
}

function isNativeWindow(value: unknown): value is NativeWindow {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<NativeWindow>;
  return (typeof item.id === 'string' || typeof item.id === 'number')
    && [item.x, item.y, item.width, item.height].every((part) => typeof part === 'number' && Number.isFinite(part))
    && (item.width ?? 0) > 0
    && (item.height ?? 0) > 0;
}

function parseList(stdout: string): NativeWindowList | null {
  try {
    const value = JSON.parse(stdout) as { units?: unknown; windows?: unknown };
    if ((value.units !== 'points' && value.units !== 'pixels') || !Array.isArray(value.windows)) return null;
    return { units: value.units, windows: value.windows.filter(isNativeWindow).slice(0, 2_000) };
  } catch {
    return null;
  }
}

function intersect(a: RegionRect, b: RegionRect): RegionRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right - x < 8 || bottom - y < 8) return null;
  return { x, y, width: right - x, height: bottom - y };
}

export function candidatesByDisplay(
  list: NativeWindowList,
  displays: readonly DisplayLike[],
  monitors: ReadonlyMap<string, RegionRect> = new Map(),
): Map<string, ScreenshotWindowCandidate[]> {
  const result = new Map<string, ScreenshotWindowCandidate[]>(displays.map((display) => [String(display.id), []]));
  const regions = displays.map((display) => {
    const pixels = process.platform === 'win32' && list.units === 'pixels';
    const monitor = pixels ? monitors.get(String(display.id)) : undefined;
    const bounds = monitor ?? (pixels ? screen.dipToScreenRect(null, display.bounds) : display.bounds);
    return {
      display,
      bounds,
      ratioX: monitor === undefined ? display.bounds.width / bounds.width : 1 / display.scaleFactor,
      ratioY: monitor === undefined ? display.bounds.height / bounds.height : 1 / display.scaleFactor,
    };
  });
  for (const window of list.windows) {
    for (const { display, bounds, ratioX, ratioY } of regions) {
      const visible = intersect(window, bounds);
      if (visible === null) continue;
      if (visible.width * ratioX < 8 || visible.height * ratioY < 8) continue;
      result.get(String(display.id))?.push({
        id: String(window.id),
        x: (visible.x - bounds.x) * ratioX,
        y: (visible.y - bounds.y) * ratioY,
        width: visible.width * ratioX,
        height: visible.height * ratioY,
      });
    }
  }
  return result;
}

export function fakeCandidatesByDisplay(displays: readonly DisplayLike[]): Map<string, ScreenshotWindowCandidate[]> {
  return new Map(displays.map((display) => [
    String(display.id),
    [
      {
        id: `fake-${display.id}-1`,
        x: Math.round(display.bounds.width * 0.08),
        y: Math.round(display.bounds.height * 0.09),
        width: Math.round(display.bounds.width * 0.58),
        height: Math.round(display.bounds.height * 0.64),
      },
      {
        id: `fake-${display.id}-2`,
        x: Math.round(display.bounds.width * 0.42),
        y: Math.round(display.bounds.height * 0.22),
        width: Math.round(display.bounds.width * 0.48),
        height: Math.round(display.bounds.height * 0.56),
      },
    ],
  ]));
}

export async function listScreenshotWindows(
  displays: readonly DisplayLike[],
  excludedWindowIds: readonly string[] = [],
  monitors: ReadonlyMap<string, RegionRect> = new Map(),
): Promise<Map<string, ScreenshotWindowCandidate[]>> {
  const name = executableName();
  if (name === null) return new Map();
  const path = executablePath(name);
  try {
    await access(path);
    const args = [...excludedWindowIds];
    const { stdout } = await execFileAsync(path, args, { encoding: 'utf8', timeout: 1_000, maxBuffer: 1024 * 1024, windowsHide: true });
    const list = parseList(stdout.trim());
    return list === null ? new Map() : candidatesByDisplay(list, displays, monitors);
  } catch (error) {
    log.warn(`[screenshot] window detection unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return new Map();
  }
}
