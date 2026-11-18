import type { Rectangle } from 'electron';

export type CornerRadii = [topLeft: number, topRight: number, bottomRight: number, bottomLeft: number];

export interface WindowCornerState {
  fullScreen: boolean;
  maximized: boolean;
}

export interface WindowEdgeGeometry {
  insets: [top: number, right: number, bottom: number, left: number];
  corners: CornerRadii;
}

const DARWIN_RADII: readonly { minDarwin: number; radius: number }[] = [
  { minDarwin: 26, radius: 20 },
  { minDarwin: 25, radius: 16 },
  { minDarwin: 0, radius: 10 },
];
const WIN32_RADII: readonly { minBuild: number; radius: number }[] = [
  { minBuild: 22000, radius: 8 },
  { minBuild: 0, radius: 0 },
];

export function windowCornerRadius(platform: NodeJS.Platform, release: string, state: WindowCornerState): number {
  if (state.fullScreen) return 0;
  if (platform === 'darwin') {
    const darwin = Number.parseInt(release, 10) || 0;
    return DARWIN_RADII.find(row => darwin >= row.minDarwin)!.radius;
  }
  if (platform === 'win32') {
    if (state.maximized) return 0;
    const build = Number.parseInt(release.split('.')[2] ?? '', 10) || 0;
    return WIN32_RADII.find(row => build >= row.minBuild)!.radius;
  }
  return 0;
}

export function windowBorderWidth(platform: NodeJS.Platform, state: WindowCornerState): number {
  return platform === 'darwin' && !state.fullScreen ? 1 : 0;
}

export function windowEdgeGeometry(bounds: Rectangle, content: { width: number; height: number }, radius: number, border: number): WindowEdgeGeometry {
  const left = bounds.x <= 1, top = bounds.y <= 1;
  const right = bounds.x + bounds.width >= content.width - 1, bottom = bounds.y + bounds.height >= content.height - 1;
  const corner = Math.max(0, radius - border);
  return {
    insets: [top ? border : 0, right ? border : 0, bottom ? border : 0, left ? border : 0],
    corners: [top && left ? corner : 0, top && right ? corner : 0, bottom && right ? corner : 0, bottom && left ? corner : 0],
  };
}
