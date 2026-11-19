import { createServerLogger, startServer, type RunningServer } from '@moonshot-ai/kap-server';
import type { KimiConfig } from '@moonshot-ai/testkit/fixtures';
import type { FakeProviderType } from '@moonshot-ai/testkit/model';
import { kapFixtures, type KapFixtureDefinitions, type KapFixtures } from '@moonshot-ai/testkit/vitest';

export type ScenarioFixtures = KapFixtures<RunningServer>;

export interface ScenarioOptions {
  readonly serverVersion?: string;
  readonly provider?: FakeProviderType;
  readonly config?: KimiConfig;
}

export function scenarioFixtures(options: ScenarioOptions = {}): KapFixtureDefinitions<RunningServer> {
  return kapFixtures({
    startServer,
    createServerLogger,
    serverOptions: { serverVersion: options.serverVersion },
    provider: { type: options.provider },
    config: { defaultPermissionMode: 'yolo', ...options.config },
  });
}
