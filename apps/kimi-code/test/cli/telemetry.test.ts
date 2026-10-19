/**
 * Tests for the CLI telemetry bootstrap helpers, focusing on the
 * `kimi web` / `kimi server run` host wiring added in `cli/telemetry.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initializeTelemetry: vi.fn(),
  createKimiDeviceId: vi.fn(() => 'device-123'),
  resolveKimiHome: vi.fn(() => '/home/.kimi-code'),
  resolveConfigPath: vi.fn(() => '/home/.kimi-code/config.toml'),
  loadRuntimeConfigSafe: vi.fn(
    (): {
      config: { defaultModel?: string; telemetry?: boolean };
      fileError: Error | undefined;
    } => ({
      config: { defaultModel: 'kimi-k2', telemetry: true },
      fileError: undefined,
    }),
  ),
  getCachedAccessToken: vi.fn(async () => 'tok'),
}));

vi.mock('@moonshot-ai/kimi-telemetry', () => ({
  initializeTelemetry: mocks.initializeTelemetry,
  setTelemetryContext: vi.fn(),
  track: vi.fn(),
  withTelemetryContext: vi.fn(),
}));

vi.mock('@moonshot-ai/kimi-code-oauth', async (importOriginal) => {
  // Spread the real module: the SDK's v2 client pulls agent-core-v2 into the
  // import graph, which subclasses KimiOAuthToolkit from this package.
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-oauth')>();
  return {
    ...actual,
    createKimiDeviceId: mocks.createKimiDeviceId,
    KIMI_CODE_PROVIDER_NAME: 'managed:kimi-code',
  };
});

vi.mock('@moonshot-ai/kimi-code-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-sdk')>();
  return {
    ...actual,
    resolveKimiHome: mocks.resolveKimiHome,
    resolveConfigPath: mocks.resolveConfigPath,
    loadRuntimeConfigSafe: mocks.loadRuntimeConfigSafe,
    KimiAuthFacade: vi.fn(function () {
      return { getCachedAccessToken: mocks.getCachedAccessToken };
    }),
  };
});

describe('initializeServerTelemetry', () => {
  beforeEach(() => {
    mocks.initializeTelemetry.mockClear();
    mocks.loadRuntimeConfigSafe.mockClear();
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      config: { defaultModel: 'kimi-k2', telemetry: true },
      fileError: undefined,
    });
  });

  it('configures the sink with ui_mode="web" and the CLI product identity', async () => {
    const { initializeServerTelemetry } = await import('#/cli/telemetry');
    const client = initializeServerTelemetry({ version: '1.2.3' });
    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({
        appName: 'kimi-code-cli',
        version: '1.2.3',
        uiMode: 'web',
        model: 'kimi-k2',
        enabled: true,
        deviceId: 'device-123',
        homeDir: '/home/.kimi-code',
      }),
    );
    // The returned client wraps the module functions so core + the host share
    // the same underlying client.
    expect(client).toEqual(
      expect.objectContaining({
        track: expect.any(Function),
        withContext: expect.any(Function),
        setContext: expect.any(Function),
      }),
    );
    // The first dynamic import pulls in the whole SDK/oauth chain (~3s idle,
    // more under full-suite transform contention) — give it headroom past the
    // 5s default timeout.
  }, 20000);

  it('disables telemetry when config.toml sets telemetry = false', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      config: { defaultModel: 'kimi-k2', telemetry: false },
      fileError: undefined,
    });
    const { initializeServerTelemetry } = await import('#/cli/telemetry');
    initializeServerTelemetry({ version: '1.2.3' });

    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it('degrades to enabled with no model when config is unreadable', async () => {
    mocks.loadRuntimeConfigSafe.mockReturnValue({
      config: {},
      fileError: new Error('bad toml'),
    });
    const { initializeServerTelemetry } = await import('#/cli/telemetry');
    initializeServerTelemetry({ version: '1.2.3' });

    expect(mocks.initializeTelemetry).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, model: undefined }),
    );
  });
});

describe('telemetry shutdown deadline', () => {
  it('gives each pipeline only the budget remaining from one deadline', async () => {
    const { createTelemetryShutdownDeadline } = await import(
      '#/cli/telemetry-shutdown'
    );
    let nowMs = 1_000;
    const observedBudgets: number[] = [];
    const deadline = createTelemetryShutdownDeadline(
      3_000,
      vi.fn(),
      () => nowMs,
    );

    await deadline.run(async (remainingMs) => {
      observedBudgets.push(remainingMs);
      nowMs = 2_250;
    });
    await deadline.run(async (remainingMs) => {
      observedBudgets.push(remainingMs);
    });

    expect(observedBudgets).toEqual([3_000, 1_750]);
  });

  it('still invokes a later pipeline with no budget after the deadline expires', async () => {
    const { createTelemetryShutdownDeadline } = await import(
      '#/cli/telemetry-shutdown'
    );
    let nowMs = 1_000;
    const pipeline = vi.fn(async (_remainingMs: number) => {});
    const deadline = createTelemetryShutdownDeadline(
      3_000,
      vi.fn(),
      () => nowMs,
    );
    nowMs = 4_001;

    await deadline.run(pipeline);

    expect(pipeline).toHaveBeenCalledWith(0);
  });

  it('continues to a later pipeline after an earlier one rejects', async () => {
    const { createTelemetryShutdownDeadline } = await import(
      '#/cli/telemetry-shutdown'
    );
    const laterPipeline = vi.fn(async (_remainingMs: number) => {});
    const reportError = vi.fn();
    const deadline = createTelemetryShutdownDeadline(
      3_000,
      reportError,
      () => 1_000,
    );

    await expect(
      deadline.run(async () => {
        throw new Error('telemetry unavailable');
      }),
    ).resolves.toBeUndefined();
    await deadline.run(laterPipeline);

    expect(laterPipeline).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'telemetry unavailable' }),
    );
  });

  it('continues to a later pipeline when the error reporter also throws', async () => {
    const { createTelemetryShutdownDeadline } = await import(
      '#/cli/telemetry-shutdown'
    );
    const laterPipeline = vi.fn(async (_remainingMs: number) => {});
    const deadline = createTelemetryShutdownDeadline(3_000, () => {
      throw new Error('stderr unavailable');
    });

    await expect(
      deadline.run(async () => {
        throw new Error('telemetry unavailable');
      }),
    ).resolves.toBeUndefined();
    await deadline.run(laterPipeline);

    expect(laterPipeline).toHaveBeenCalledOnce();
  });
});
