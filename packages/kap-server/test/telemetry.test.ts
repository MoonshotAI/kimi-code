import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bootstrap,
  logSeed,
  resolveConfigPath,
  resolveLoggingConfig,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { readKimiDeviceId } from '@moonshot-ai/kimi-code-oauth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initializeServerTelemetry, shutdownServerTelemetry } from '../src/services/telemetry';

describe('server telemetry', () => {
  let home: string | undefined;
  let core: Scope | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-telemetry-'));
  });

  afterEach(async () => {
    core?.dispose();
    core = undefined;
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function bootCore(toml?: string): Promise<Scope> {
    if (toml !== undefined) {
      await writeFile(join(home as string, 'config.toml'), toml, 'utf-8');
    }
    const { app } = bootstrap(
      {
        homeDir: home as string,
        configPath: resolveConfigPath({ homeDir: home as string }),
      },
      logSeed(resolveLoggingConfig({ homeDir: home as string, env: process.env })),
    );
    core = app;
    return app;
  }

  it('attaches the cloud appender by default and persists the device id', async () => {
    const app = await bootCore();
    const telemetry = await initializeServerTelemetry(app, home as string);
    expect(telemetry.appender).toBeDefined();
    expect(readKimiDeviceId(home as string)).not.toBeNull();
    await shutdownServerTelemetry(telemetry);
  });

  it('keeps the null appender when config sets telemetry = false', async () => {
    const app = await bootCore('telemetry = false\n');
    const telemetry = await initializeServerTelemetry(app, home as string);
    expect(telemetry.appender).toBeUndefined();
    await shutdownServerTelemetry(telemetry);
  });
});
