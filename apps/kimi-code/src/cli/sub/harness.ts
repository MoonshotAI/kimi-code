import {
  createKimiHarness,
  type KimiHarness,
  type TelemetryClient,
} from '@moonshot-ai/kimi-code-sdk';
import {
  setTelemetryContext,
  shutdownTelemetry,
  track,
  withTelemetryContext,
} from '@moonshot-ai/kimi-telemetry';

import { createCliTelemetryBootstrap, initializeCliTelemetry } from '#/cli/telemetry';
import { createKimiCodeUserAgent, getVersion } from '#/cli/version';
import { CLI_SHUTDOWN_TIMEOUT_MS, CLI_UI_MODE, CLI_USER_AGENT_PRODUCT } from '#/constant/app';

export async function withSubHarness<T>(run: (harness: KimiHarness) => Promise<T>): Promise<T> {
  const version = getVersion();
  const bootstrap = createCliTelemetryBootstrap();
  const telemetryClient: TelemetryClient = {
    track,
    withContext: withTelemetryContext,
    setContext: setTelemetryContext,
  };
  const harness = await createKimiHarness({
    homeDir: bootstrap.homeDir,
    identity: CLI_USER_AGENT_PRODUCT,
    uiMode: 'print',
    workDir: process.cwd(),
    version,
    userAgent: createKimiCodeUserAgent(version),
    telemetry: telemetryClient,
  });
  try {
    await harness.ensureConfigFile();
    initializeCliTelemetry({
      harness,
      bootstrap,
      config: {
        defaultModel: harness.config.get<string | undefined>('defaultModel'),
        telemetry: harness.config.get<boolean | undefined>('telemetry'),
      },
      version,
      uiMode: CLI_UI_MODE,
    });
    return await run(harness).catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
  } finally {
    await shutdownTelemetry({ timeoutMs: CLI_SHUTDOWN_TIMEOUT_MS }).catch(() => {});
    await harness.close().catch(() => {});
  }
}
