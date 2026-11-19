import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

interface OverlayImeReport {
  rwhvRespondsBefore: boolean;
  rwhvRespondsAfter: boolean;
  before: {
    implicitRespondsBefore: boolean;
    explicitLevelBefore: number;
  };
  after: {
    overlayHasRwhv: boolean;
    normalHasRwhv: boolean;
    overlayWindowLevel: number;
    normalWindowLevel: number;
    overlayRwhvLevel: number;
    normalRwhvLevel: number;
    implicitAttachedLevel: number;
    implicitDetachedLevel: number;
    explicitAttachedLevel: number;
  };
}

async function compileAddon(source: string, output: string, nodeInclude: string, target: string): Promise<void> {
  await execFileAsync('xcrun', [
    'clang++', '-std=c++17', '-O2', '-fobjc-arc', '-bundle', '-undefined', 'dynamic_lookup',
    '-target', target, '-DNAPI_VERSION=8', '-I', nodeInclude, '-framework', 'AppKit',
    source, '-o', output,
  ], { timeout: 30_000 });
}

describe('macOS screenshot overlay IME window level', () => {
  it.runIf(process.platform === 'darwin')('exposes the containing NSWindow level on NSTextInputClient views without overriding existing implementations', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'kimi-shot-ime-'));
    try {
      const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx12.0`;
      const nodeInclude = join(dirname(await realpath(process.execPath)), '..', 'include', 'node');
      const overlaySource = fileURLToPath(new URL('../../../native/screenshot-window-list/macos/overlay.mm', import.meta.url));
      const probeSource = fileURLToPath(new URL('../fixtures/screenshot-macos-overlay-probe.mm', import.meta.url));
      const overlayBinary = join(tempDir, 'screenshot-overlay.node');
      const probeBinary = join(tempDir, 'probe.node');
      await Promise.all([
        compileAddon(overlaySource, overlayBinary, nodeInclude, target),
        compileAddon(probeSource, probeBinary, nodeInclude, target),
      ]);

      const electronBinary = createRequire(import.meta.url)('electron') as string;
      const harness = fileURLToPath(new URL('../fixtures/screenshot-macos-overlay.cjs', import.meta.url));
      const { stdout } = await execFileAsync(electronBinary, [harness, overlayBinary, probeBinary], {
        timeout: 30_000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      });
      const report = JSON.parse(stdout.trim().split('\n').at(-1)!) as OverlayImeReport;

      expect(report.rwhvRespondsBefore).toBe(false);
      expect(report.rwhvRespondsAfter).toBe(true);
      expect(report.before).toEqual({
        implicitRespondsBefore: false,
        explicitLevelBefore: 77,
      });
      expect(report.after.overlayHasRwhv).toBe(true);
      expect(report.after.normalHasRwhv).toBe(true);
      expect(report.after.overlayWindowLevel).toBeGreaterThan(0);
      expect(report.after.normalWindowLevel).toBe(0);
      expect(report.after.overlayRwhvLevel).toBe(report.after.overlayWindowLevel);
      expect(report.after.normalRwhvLevel).toBe(0);
      expect(report.after.implicitAttachedLevel).toBe(report.after.overlayWindowLevel);
      expect(report.after.implicitDetachedLevel).toBe(0);
      expect(report.after.explicitAttachedLevel).toBe(77);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 60_000);
});
