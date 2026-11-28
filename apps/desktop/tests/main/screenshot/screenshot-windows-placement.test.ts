import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

interface PlacementReport {
  scaleFactor: number;
  displayBounds: Electron.Rectangle;
  after: Electron.Rectangle;
  monitor: Electron.Rectangle;
  placed: Electron.Rectangle;
  visible: Electron.Rectangle;
  thumbnail: { width: number; height: number } | null;
}

describe.runIf(process.platform === 'win32')('Windows screenshot overlay placement', () => {
  it.each(['1', '1.4625', '2.925'])('covers the monitor pixel for pixel at a forced %sx device scale', async (scale) => {
    const electron = createRequire(import.meta.url)('electron') as string;
    const fixture = fileURLToPath(new URL('../fixtures/screenshot-windows-placement.mjs', import.meta.url));
    const { stdout } = await promisify(execFile)(electron, [`--force-device-scale-factor=${scale}`, fixture], {
      timeout: 45_000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    });
    const report = JSON.parse(stdout.trim().split('\n').at(-1)!) as PlacementReport;
    expect(report.scaleFactor).toBeCloseTo(Number(scale), 4);
    expect(report.placed).toEqual(report.monitor);
    expect(report.visible).toEqual(report.monitor);
    expect(report.after).toEqual(report.displayBounds);
    expect(report.thumbnail).toEqual({ width: report.monitor.width, height: report.monitor.height });
  }, 60_000);
});
