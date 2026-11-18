import { describe, expect, it } from 'vitest';
import { windowBorderWidth, windowCornerRadius, windowEdgeGeometry } from '../../../src/main/window/window-corners';

const windowed = { fullScreen: false, maximized: false };

describe('window corner radius', () => {
  it('picks the macOS radius from the Darwin version and falls back to the newest row', () => {
    expect(windowCornerRadius('darwin', '21.6.0', windowed)).toBe(10);
    expect(windowCornerRadius('darwin', '24.1.0', windowed)).toBe(10);
    expect(windowCornerRadius('darwin', '25.6.0', windowed)).toBe(16);
    expect(windowCornerRadius('darwin', '26.0.0', windowed)).toBe(20);
    expect(windowCornerRadius('darwin', '30.0.0', windowed)).toBe(20);
    expect(windowCornerRadius('darwin', '26.0.0', { fullScreen: true, maximized: false })).toBe(0);
    expect(windowCornerRadius('darwin', '26.0.0', { fullScreen: false, maximized: true })).toBe(20);
  });

  it('rounds Windows 11 only while the window floats, and never rounds Windows 10 or Linux', () => {
    expect(windowCornerRadius('win32', '10.0.26100', windowed)).toBe(8);
    expect(windowCornerRadius('win32', '10.0.26100', { fullScreen: false, maximized: true })).toBe(0);
    expect(windowCornerRadius('win32', '10.0.19045', windowed)).toBe(0);
    expect(windowCornerRadius('linux', '6.8.0', windowed)).toBe(0);
  });

  it('insets past the window border only on macOS, and not in full screen', () => {
    expect(windowBorderWidth('darwin', windowed)).toBe(1);
    expect(windowBorderWidth('darwin', { fullScreen: true, maximized: false })).toBe(0);
    expect(windowBorderWidth('win32', windowed)).toBe(0);
    expect(windowBorderWidth('linux', windowed)).toBe(0);
  });

  it('insets and rounds only where the bounds meet the window edge', () => {
    const content = { width: 1200, height: 800 };
    expect(windowEdgeGeometry({ x: 600, y: 80, width: 600, height: 720 }, content, 16, 1)).toEqual({ insets: [0, 1, 1, 0], corners: [0, 0, 15, 0] });
    expect(windowEdgeGeometry({ x: 0, y: 80, width: 1200, height: 720 }, content, 16, 1)).toEqual({ insets: [0, 1, 1, 1], corners: [0, 0, 15, 15] });
    expect(windowEdgeGeometry({ x: 0, y: 0, width: 1200, height: 800 }, content, 16, 1)).toEqual({ insets: [1, 1, 1, 1], corners: [15, 15, 15, 15] });
    expect(windowEdgeGeometry({ x: 624, y: 104, width: 552, height: 672 }, content, 16, 1)).toEqual({ insets: [0, 0, 0, 0], corners: [0, 0, 0, 0] });
    expect(windowEdgeGeometry({ x: 600, y: 80, width: 600, height: 720 }, content, 8, 0)).toEqual({ insets: [0, 0, 0, 0], corners: [0, 0, 8, 0] });
    expect(windowEdgeGeometry({ x: 600, y: 80, width: 600, height: 720 }, content, 0, 0)).toEqual({ insets: [0, 0, 0, 0], corners: [0, 0, 0, 0] });
  });
});
