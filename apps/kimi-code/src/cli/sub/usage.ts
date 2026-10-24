import { createKimiHarness, type KimiHarness } from '@moonshot-ai/kimi-code-sdk';
import type { Command } from 'commander';

import { createCliTelemetryBootstrap } from '#/cli/telemetry';
import { createKimiCodeHostIdentity } from '#/cli/version';

interface WritableLike {
  write(chunk: string): boolean;
}

type UsageResult = Awaited<ReturnType<KimiHarness['auth']['getManagedUsage']>>;

export interface UsageDeps {
  readonly getManagedUsage: () => Promise<UsageResult>;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
  readonly close: () => Promise<void>;
}

export async function handleUsage(deps: UsageDeps): Promise<void> {
  const result = await deps.getManagedUsage();
  if (result.kind === 'ok') {
    deps.stdout.write(`${JSON.stringify(result.quota, null, 2)}\n`);
    return;
  }
  deps.stderr.write(`${result.message}\n`);
  deps.exit(1);
}

export function registerUsageCommand(parent: Command, deps?: Partial<UsageDeps>): void {
  parent
    .command('usage')
    .description('Print account usage quotas as JSON.')
    .option('--json', 'Emit the quota report as JSON (default output).', false)
    .action(async () => {
      const resolved = createDefaultUsageDeps(deps);
      try {
        await handleUsage(resolved);
      } catch (error) {
        resolved.stderr.write(`${errorMessage(error)}\n`);
        resolved.exit(1);
      } finally {
        await resolved.close();
      }
    });
}

function createDefaultUsageDeps(overrides: Partial<UsageDeps> = {}): UsageDeps {
  let harness: KimiHarness | undefined;
  const getHarness = (): KimiHarness => {
    harness ??= createKimiHarness({
      homeDir: createCliTelemetryBootstrap().homeDir,
      identity: createKimiCodeHostIdentity(),
    });
    return harness;
  };
  return {
    getManagedUsage: overrides.getManagedUsage ?? (() => getHarness().auth.getManagedUsage()),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    exit: overrides.exit ?? ((code: number) => process.exit(code)),
    close:
      overrides.close ??
      (async () => {
        await harness?.close();
      }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
