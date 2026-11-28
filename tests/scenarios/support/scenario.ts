import { createServerLogger, startServer, type RunningServer } from '@moonshot-ai/kap-server';
import type { KimiConfig, McpServerEntry } from '@moonshot-ai/testkit/fixtures';
import type { FakeModelOptions, FakeProviderType } from '@moonshot-ai/testkit/model';
import { kapFixtures, type KapFixtureDefinitions, type KapFixtures } from '@moonshot-ai/testkit/vitest';

export type ScenarioFixtures = KapFixtures<RunningServer>;

export interface ScenarioOptions {
  readonly serverVersion?: string;
  readonly provider?: FakeProviderType;
  readonly config?: KimiConfig;
  readonly modelOptions?: FakeModelOptions;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly mcpServers?: Readonly<Record<string, McpServerEntry>>;
}

export function scenarioFixtures(options: ScenarioOptions = {}): KapFixtureDefinitions<RunningServer> {
  return kapFixtures({
    startServer,
    createServerLogger,
    modelOptions: options.modelOptions,
    serverOptions: { serverVersion: options.serverVersion },
    provider: { type: options.provider },
    config: { defaultPermissionMode: 'yolo', ...options.config },
    env: options.env,
    mcpServers: options.mcpServers,
    verifyInvariants: true,
  });
}
