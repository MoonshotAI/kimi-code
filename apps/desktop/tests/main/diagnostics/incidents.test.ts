import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  probePage: vi.fn(async () => ({ readyState: 'complete', appChildren: 0 })),
  capturePageStats: vi.fn(async () => ({ width: 10, height: 10, dominantColor: '#ffffff', dominantRatio: 1, distinctColors: 1 })),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.3.0',
    isPackaged: true,
    getGPUFeatureStatus: () => ({ gpu_compositing: 'enabled' }),
    getAppMetrics: () => [],
  },
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('../../../src/main/diagnostics/collector', () => ({
  probePage: mocks.probePage,
  capturePageStats: mocks.capturePageStats,
  describeProcesses: () => [{ type: 'Tab', pid: 7 }],
}));

import { incidentFileName, serializeIncident, writeIncident } from '../../../src/main/diagnostics/incidents';
import { log, logStartup } from '../../../src/main/diagnostics/log';

let home = '';

beforeEach(async () => {
  vi.clearAllMocks();
  home = await mkdtemp(join(tmpdir(), 'kimi-incident-home-'));
  vi.stubEnv('KIMI_CODE_HOME', home);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('writeIncident', () => {
  it('writes the startup timeline, environment, page evidence and recent log lines', async () => {
    logStartup('ui-mounted');
    log.info('recent line for the incident');
    const contents = { isDestroyed: () => false };

    const path = await writeIncident({
      kind: 'boot-stalled',
      summary: 'boot-stalled stage=boot-sessions after=60000ms',
      contents: contents as never,
      details: { extra: true },
    });

    expect(path).not.toBeNull();
    const [file] = await readdir(join(home, 'logs', 'desktop-incidents'));
    expect(file).toMatch(/^\d{4}-\d{2}-\d{2}T.*-boot-stalled-\d+\.json$/);
    const incident = JSON.parse(await readFile(join(home, 'logs', 'desktop-incidents', file!), 'utf-8'));
    expect(incident).toMatchObject({
      kind: 'boot-stalled',
      version: '1.3.0',
      channel: 'stable',
      pid: process.pid,
      gpuFeatures: { gpu_compositing: 'enabled' },
      processes: [{ type: 'Tab', pid: 7 }],
      page: { appChildren: 0 },
      screenshot: { dominantColor: '#ffffff' },
      extra: true,
    });
    expect(incident.timeline.map((entry: { step: string }) => entry.step)).toContain('ui-mounted');
    expect(incident.recentLog.join('')).toContain('recent line for the incident');
  });

  it('skips page evidence without a live renderer', async () => {
    await writeIncident({ kind: 'renderer-gone', summary: 'renderer-gone', contents: null });
    expect(mocks.probePage).not.toHaveBeenCalled();
    const [file] = await readdir(join(home, 'logs', 'desktop-incidents'));
    const incident = JSON.parse(await readFile(join(home, 'logs', 'desktop-incidents', file!), 'utf-8'));
    expect(incident.page).toBeUndefined();
  });
});

describe('incident helpers', () => {
  it('names files by time, kind and process', () => {
    expect(incidentFileName('not-mounted', new Date('2026-10-29T08:00:01.234Z'), 42)).toBe(
      '2026-10-29T08-00-01-234Z-not-mounted-42.json',
    );
  });

  it('drops the oldest log lines until the snapshot fits', () => {
    const recentLog = Array.from({ length: 400 }, (_, i) => `${i}:${'x'.repeat(2_000)}`);
    const json = serializeIncident({ kind: 'k', recentLog });
    expect(json.length).toBeLessThanOrEqual(512 * 1024);
    const parsed = JSON.parse(json) as { recentLog: string[] };
    expect(parsed.recentLog.at(-1)).toBe(recentLog.at(-1));
    expect(parsed.recentLog.length).toBeLessThan(400);
  });
});
