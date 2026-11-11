import {
  createCloudAppender,
  IBootstrapService,
  IConfigService,
  IOAuthToolkit,
  ITelemetryService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { IWorkspaceSessions } from '@moonshot-ai/agent-core-v2/app/workspaceSessions/workspaceSessions';
import { IWorkspaceService } from '@moonshot-ai/agent-core-v2/app/workspace/workspace';
import type { TelemetryProperties } from '@moonshot-ai/kimi-telemetry';
import type { HostDisposable } from './hostExtension';

const DISABLE_ENV_VALUES = new Set(['1', 'true', 't', 'yes', 'y']);
const SHUTDOWN_TIMEOUT_MS = 3_000;


export interface HostTelemetryRecord {
  readonly event: string;
  readonly context: Record<string, unknown>;
  readonly properties: TelemetryProperties;
}

export interface HostTelemetryAppender {
  track(record: HostTelemetryRecord): void;
  startPeriodicFlush(): void;
  stopPeriodicFlush(): void;
  retryDiskEvents(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface HostCloudAppenderOptions {
  readonly deviceId: string;
  readonly appName: string;
  readonly uiMode?: string;
  readonly model?: string;
  readonly getAccessToken: () => string | null | Promise<string | null>;
}

export interface HostTelemetry {
  readConsent(): Promise<unknown>;
  defaultModel(): string | undefined;
  resolveMaxImageEdgePx(): number;
  getCachedAccessToken(): Promise<string | null>;
  createCloudAppender(options: HostCloudAppenderOptions): HostTelemetryAppender;
  addAppender(appender: HostTelemetryAppender): HostDisposable;
  track(event: string, properties?: TelemetryProperties): void;
  countSessions(): Promise<number>;
  shutdown(): Promise<void>;
}

export function createHostTelemetry(core: Scope): HostTelemetry {
  const config = core.accessor.get(IConfigService);
  const auth = core.accessor.get(IOAuthToolkit);
  const telemetry = core.accessor.get(ITelemetryService);
  return {
    readConsent: async () => {
      await config.ready;
      const disabled = core.accessor.get(IBootstrapService).getEnv('KIMI_DISABLE_TELEMETRY');
      if (disabled !== undefined && DISABLE_ENV_VALUES.has(disabled.trim().toLowerCase())) return false;
      try {
        return config.get('telemetry');
      } catch {
        return undefined;
      }
    },
    defaultModel: () => {
      try {
        return config.get<string>('defaultModel') ?? undefined;
      } catch {
        return undefined;
      }
    },
    resolveMaxImageEdgePx: () => {
      try {
        return config.get<{ readonly maxEdgePx?: number }>('image')?.maxEdgePx ?? 2_000;
      } catch {
        return 2_000;
      }
    },
    getCachedAccessToken: async () => (await auth.getCachedAccessToken()) ?? null,
    createCloudAppender: (options) => createCloudAppender(core.accessor, options),
    addAppender: (appender) => telemetry.addAppender(appender),
    track: (event, properties) => telemetry.track(event, properties),
    countSessions: async () => {
      const workspaces = await core.accessor.get(IWorkspaceService).list();
      const sessions = core.accessor.get(IWorkspaceSessions);
      const counts = await Promise.all(workspaces.map((workspace) => sessions.count(workspace.id)));
      return counts.reduce((total, count) => total + count, 0);
    },
    shutdown: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          telemetry.shutdown(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
      } catch {
        return;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
