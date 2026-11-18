export interface BrowserSeeThroughHole {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const BROWSER_SEE_THROUGH_CLASS = 'browser-see-through';

const HOLE_PROPERTIES = ['--browser-hole-x', '--browser-hole-y', '--browser-hole-w', '--browser-hole-h'] as const;

const holes = new Map<string, BrowserSeeThroughHole>();

function render(): void {
  const root = document.documentElement;
  const hole = [...holes.values()].at(-1);
  if (hole === undefined) {
    root.classList.remove(BROWSER_SEE_THROUGH_CLASS);
    for (const property of HOLE_PROPERTIES) root.style.removeProperty(property);
    return;
  }
  const values = [hole.x, hole.y, Math.max(0, hole.width), Math.max(0, hole.height)];
  HOLE_PROPERTIES.forEach((property, index) => root.style.setProperty(property, `${values[index]}px`));
  root.classList.add(BROWSER_SEE_THROUGH_CLASS);
}

export function setBrowserSeeThrough(browserId: string, hole: BrowserSeeThroughHole | null): void {
  if (hole === null) {
    if (!holes.delete(browserId)) return;
  } else {
    holes.delete(browserId);
    holes.set(browserId, hole);
  }
  render();
}

export function hasBrowserSeeThrough(browserId: string): boolean {
  return holes.has(browserId);
}
