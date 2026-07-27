/**
 * Kap server telemetry composition tests — boot the real App scope and storage,
 * then verify config gating, host-appender preservation, cloud delivery wiring,
 * and owned shutdown. The outbound cloud fetch remains behind the appender and
 * is never contacted by these scenarios.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bootstrap,
  type ITelemetryAppender,
  ITelemetryService,
  logSeed,
  resolveConfigPath,
  resolveLoggingConfig,
  type Scope,
  type ScopeSeed,
  TelemetryService,
} from '@moonshot-ai/agent-core-v2';
import { readKimiDeviceId } from '@moonshot-ai/kimi-code-oauth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  async function bootCore(
    toml?: string,
    env?: NodeJS.ProcessEnv,
    seeds: ScopeSeed = [],
  ): Promise<Scope> {
    const resolvedEnv = env ?? {
      ...process.env,
      KIMI_DISABLE_TELEMETRY: undefined,
    };
    if (toml !== undefined) {
      await writeFile(join(home as string, 'config.toml'), toml, 'utf-8');
    }
    const { app } = bootstrap(
      {
        homeDir: home as string,
        configPath: resolveConfigPath({ homeDir: home as string }),
        env: resolvedEnv,
      },
      [
        ...logSeed(resolveLoggingConfig({ homeDir: home as string, env: resolvedEnv })),
        ...seeds,
      ],
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

  it('adds cloud delivery without replacing a host appender and removes only its owned appender on shutdown', async () => {
    const hostEvents: string[] = [];
    const hostAppender: ITelemetryAppender = {
      track: (event) => hostEvents.push(event),
    };
    const hostTelemetry = new TelemetryService();
    hostTelemetry.addAppender(hostAppender);
    const app = await bootCore(undefined, undefined, [[ITelemetryService, hostTelemetry]]);
    const telemetry = await initializeServerTelemetry(app, home as string);
    const appender = telemetry.appender;
    if (appender === undefined) throw new Error('cloud appender was not attached');
    const cloudTrack = vi.spyOn(appender, 'track');

    app.accessor.get(ITelemetryService).track('server_probe');

    expect(hostEvents).toEqual(['server_probe']);
    expect(cloudTrack).toHaveBeenCalledWith('server_probe', {});

    await shutdownServerTelemetry(telemetry, Date.now() - 1);
    app.accessor.get(ITelemetryService).track('host_after_server_shutdown');

    expect(hostEvents).toEqual(['server_probe', 'host_after_server_shutdown']);
    expect(cloudTrack).toHaveBeenCalledTimes(1);
  });

  it('keeps the null appender when config sets telemetry = false', async () => {
    const app = await bootCore('telemetry = false\n');
    const telemetry = await initializeServerTelemetry(app, home as string);
    expect(telemetry.appender).toBeUndefined();
    await shutdownServerTelemetry(telemetry);
  });

  it.each(['1', 'true', 't', 'yes', 'y', ' TRUE '])(
    'keeps the null appender when KIMI_DISABLE_TELEMETRY=%s',
    async (value) => {
      const app = await bootCore(undefined, {
        ...process.env,
        KIMI_DISABLE_TELEMETRY: value,
      });
      const telemetry = await initializeServerTelemetry(app, home as string);
      expect(telemetry.appender).toBeUndefined();
      expect(readKimiDeviceId(home as string)).toBeNull();
      await shutdownServerTelemetry(telemetry);
    },
  );
});
