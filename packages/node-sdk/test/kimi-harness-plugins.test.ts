import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { createKimiHarness } from '#/index';
import { TEST_IDENTITY } from './test-identity';
import { recordingTelemetry, type TelemetryRecord } from './telemetry';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-plugins-'));
  tempDirs.push(dir);
  return dir;
}

describe('KimiHarness plugin management', () => {
  it('lists, installs, enables, disables, and removes plugins', async () => {
    const homeDir = await makeTempDir();
    const records: TelemetryRecord[] = [];
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
      telemetry: recordingTelemetry(records),
    });

    expect(await harness.listPlugins()).toEqual([]);

    const pluginDir = await makeTempDir();
    await writeFile(
      join(pluginDir, 'kimi.plugin.json'),
      JSON.stringify({
        name: 'demo-plugin',
        version: '1.0.0',
        interface: { displayName: 'Demo Plugin' },
      }),
      'utf8',
    );

    const summary = await harness.installPlugin(pluginDir);
    expect(summary.id).toBe('demo-plugin');
    expect(summary.enabled).toBe(true);

    const listed = await harness.listPlugins();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe('demo-plugin');

    await harness.setPluginEnabled('demo-plugin', false);
    expect((await harness.listPlugins())[0]?.enabled).toBe(false);

    const info = await harness.getPluginInfo('demo-plugin');
    expect(info.id).toBe('demo-plugin');
    expect(info.enabled).toBe(false);

    await harness.removePlugin('demo-plugin');
    expect(await harness.listPlugins()).toEqual([]);

    await harness.close();
  });
});
