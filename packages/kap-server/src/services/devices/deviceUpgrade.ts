import { z } from 'zod';

import { okEnvelope } from '../../envelope';
import { defineRoute } from '../../middleware/defineRoute';
import type { ServerLogger } from '../pinoLoggerService';
import { deviceGet, deviceRequest, DeviceSourceError } from './deviceFanout';
import type { DeviceSession } from './deviceSession';

const VERSION_LINE = /^v?\d+\.\d+\.\d+\S*$/;
const OUTPUT_TAIL_LINES = 3;
const OUTPUT_TAIL_CHARS = 500;
const SYSTEM_UPGRADE_PATH = '/api/v1/system:upgrade';

export const SERVER_UPGRADED_CLOSE_CODE = 4001;

export function readVersionLine(output: string): string | undefined {
  return output
    .split('\n')
    .map((line) => line.trim())
    .findLast((line) => VERSION_LINE.test(line));
}

export function upgradeOutputTail(output: string): string | undefined {
  const tail = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !VERSION_LINE.test(line))
    .slice(-OUTPUT_TAIL_LINES)
    .join('\n')
    .slice(-OUTPUT_TAIL_CHARS);
  return tail.length > 0 ? tail : undefined;
}

export interface HostCommandResult {
  readonly code: number | null;
  readonly output: string;
}

export type HostCommandRunner = (args: readonly string[]) => Promise<HostCommandResult>;

export const systemUpgradeStatusSchema = z.object({
  state: z.enum(['idle', 'installing', 'restarting', 'failed']),
  version: z.string().optional(),
  message: z.string().optional(),
});

export type SystemUpgradeStatus = z.infer<typeof systemUpgradeStatusSchema>;

export class SystemUpgrade {
  private status: SystemUpgradeStatus = { state: 'idle' };

  constructor(
    private readonly runHostCommand: HostCommandRunner,
    private readonly serverVersion: string,
    private readonly onInstalled: (version: string) => void,
    private readonly logger?: Pick<ServerLogger, 'info' | 'warn'>,
  ) {}

  get current(): SystemUpgradeStatus {
    return this.status;
  }

  start(): void {
    if (this.status.state === 'installing' || this.status.state === 'restarting') return;
    this.status = { state: 'installing' };
    this.logger?.info('upgrading Kimi Code on request of a connected device');
    void this.install().then(
      (status) => {
        this.finish(status);
      },
      (error: unknown) => {
        this.finish({ state: 'failed', message: error instanceof Error ? error.message : String(error) });
      },
    );
  }

  private async install(): Promise<SystemUpgradeStatus> {
    const upgrade = await this.runHostCommand(['upgrade', '--yes']);
    if (upgrade.code !== 0) {
      return {
        state: 'failed',
        message: upgradeOutputTail(upgrade.output) ?? `kimi upgrade exited with code ${String(upgrade.code)}`,
      };
    }
    const check = await this.runHostCommand(['--version']);
    const version = readVersionLine(check.output);
    if (version === undefined) {
      return {
        state: 'failed',
        message: `could not read the upgraded kimi version: ${upgradeOutputTail(check.output) ?? `kimi --version exited with code ${String(check.code)}`}`,
      };
    }
    if (version === this.serverVersion) {
      return { state: 'failed', message: upgradeOutputTail(upgrade.output) ?? `Kimi Code ${version} is already the newest version` };
    }
    return { state: 'restarting', version };
  }

  private finish(status: SystemUpgradeStatus): void {
    this.status = status;
    if (status.state !== 'restarting' || status.version === undefined) {
      this.logger?.warn({ reason: status.message }, 'Kimi Code upgrade did not install a newer version');
      return;
    }
    this.logger?.info({ version: status.version }, 'Kimi Code upgraded; exiting once no work is running');
    this.onInstalled(status.version);
  }
}

interface SystemUpgradeRouteHost {
  get(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: never): unknown;
  post(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: never): unknown;
}

export function registerSystemUpgradeRoutes(app: SystemUpgradeRouteHost, upgrade: SystemUpgrade): void {
  const startRoute = defineRoute(
    {
      method: 'POST',
      path: '/system::upgrade',
      success: { data: z.object({ started: z.literal(true) }) },
      description:
        'Upgrade Kimi Code on this computer with `kimi upgrade --yes`; after a newer version is installed this background server exits as soon as no work is running, so the next connection starts the new version',
      tags: ['devices'],
    },
    async (req, reply) => {
      upgrade.start();
      reply.send(okEnvelope({ started: true as const }, req.id));
    },
  );
  app.post(startRoute.path, startRoute.options, startRoute.handler as never);

  const statusRoute = defineRoute(
    {
      method: 'GET',
      path: '/system::upgrade',
      success: { data: systemUpgradeStatusSchema },
      description: 'Report the progress of the upgrade started by POST /api/v1/system:upgrade',
      tags: ['devices'],
    },
    async (req, reply) => {
      reply.send(okEnvelope(upgrade.current, req.id));
    },
  );
  app.get(statusRoute.path, statusRoute.options, statusRoute.handler as never);
}

export async function startSystemUpgrade(session: DeviceSession): Promise<void> {
  await deviceRequest<unknown>(session, 'POST', SYSTEM_UPGRADE_PATH);
}

export async function readSystemUpgrade(session: DeviceSession): Promise<SystemUpgradeStatus> {
  const parsed = systemUpgradeStatusSchema.safeParse(await deviceGet<unknown>(session, SYSTEM_UPGRADE_PATH));
  if (!parsed.success) throw new DeviceSourceError(undefined, 'device returned an unexpected upgrade status');
  return parsed.data;
}
