import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'tsdown';

type Verdict = string;
type FileReads = Record<'sibling' | 'outside', { fetch: Verdict; xhr: Verdict }>;
type WorkerVerdict = Verdict | FileReads;
interface ProbeReport {
  allowed: Record<'script' | 'parentScript' | 'style' | 'image' | 'parentImage' | 'frame', boolean>;
  channels: Record<string, Record<'sibling' | 'outside', Verdict> | WorkerVerdict>;
}

const canShowWindows = process.platform !== 'linux' || Boolean(process.env['DISPLAY']);
const READS_FILES: FileReads = { sibling: { fetch: 'read', xhr: 'read' }, outside: { fetch: 'read', xhr: 'read' } };

async function runProbe(): Promise<{ browser: ProbeReport; unprivileged: ProbeReport; other: { fetch: Record<'sibling' | 'outside', Verdict> } }> {
  const output = await mkdtemp(join(tmpdir(), 'kimi-file-guard-'));
  try {
    await build({
      config: false,
      logLevel: 'silent',
      entry: { guard: fileURLToPath(new URL('../../../src/main/browser/browser-file-read-guard.ts', import.meta.url)) },
      format: ['cjs'], platform: 'node', outDir: output, dts: false,
      deps: { neverBundle: ['electron'], onlyBundle: false },
    });
    const executable = createRequire(import.meta.url)('electron') as string;
    const harness = fileURLToPath(new URL('../fixtures/local-file-probe.cjs', import.meta.url));
    const probe = fileURLToPath(new URL('../fixtures/local-file-probe', import.meta.url));
    const { stdout } = await promisify(execFile)(executable, [harness, probe, join(output, 'guard.cjs')], {
      timeout: 120_000, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    });
    return JSON.parse(stdout.trim().split('\n').at(-1)!) as Awaited<ReturnType<typeof runProbe>>;
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}

describe('local file pages in the browser partition on stock Electron', () => {
  it.runIf(canShowWindows)('keeps their own resources, blocks fetch, XHR and workers under extra file privileges, and leaves the rest to the packaged fuse', async () => {
    const { browser, unprivileged, other } = await runProbe();
    for (const report of [browser, unprivileged]) {
      expect(report.allowed).toEqual({ script: true, parentScript: true, style: true, image: true, parentImage: true, frame: true });
      for (const channel of ['fetch', 'xhr']) {
        expect(report.channels[channel], channel).toEqual({ sibling: expect.stringMatching(/^blocked/), outside: expect.stringMatching(/^blocked/) });
      }
      expect(report.channels['serviceWorker']).toEqual(expect.stringMatching(/^blocked/));
    }

    for (const channel of ['blobWorker', 'worker', 'sharedWorker']) {
      expect(browser.channels[channel], channel).toEqual(expect.stringMatching(/^blocked/));
    }

    const closedByFuseInPackagedBuilds = ['iframe', 'object', 'canvas', 'cssRules', 'importJson', 'navigateBack'];
    for (const channel of closedByFuseInPackagedBuilds) {
      expect(browser.channels[channel], channel).toEqual({ sibling: expect.stringMatching(/^read/), outside: expect.stringMatching(/^read/) });
    }
    for (const channel of ['blobWorker', 'worker', 'sharedWorker']) {
      expect(unprivileged.channels[channel], channel).toEqual(READS_FILES);
    }

    expect(other.fetch).toEqual({ sibling: 'read', outside: 'read' });
  }, 180_000);
});
