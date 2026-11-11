import {
  createCloudAppender,
  IConfigService,
  IOAuthToolkit,
  ITelemetryService,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { ISessionIndex } from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
import { IWorkspaceService } from '@moonshot-ai/agent-core-v2/app/workspace/workspace';
import type { TelemetryProperties } from '@moonshot-ai/kimi-telemetry';


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
}

export interface HostCloudAppenderOptions {
  readonly deviceId: string;
  readonly appName: string;
  readonly uiMode?: string;
  readonly getAccessToken: () => string | null | Promise<string | null>;
}

export interface HostTelemetry {
  readConsent(): Promise<unknown>;
  getCachedAccessToken(): Promise<string | null>;
  createCloudAppender(options: HostCloudAppenderOptions): HostTelemetryAppender;
  addAppender(appender: HostTelemetryAppender): void;
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
      try {
        return config.get('telemetry');
      } catch {
        return undefined;
      }
    },
    getCachedAccessToken: async () => (await auth.getCachedAccessToken()) ?? null,
    createCloudAppender: (options) => createCloudAppender(core.accessor, options),
    addAppender: (appender) => telemetry.addAppender(appender),
    track: (event, properties) => telemetry.track(event, properties),
    countSessions: async () => {
      const workspaces = await core.accessor.get(IWorkspaceService).list();
      return core.accessor.get(ISessionIndex).count({ workspaceIds: workspaces.map((workspace) => workspace.id) });
    },
    shutdown: () => telemetry.shutdown(),
  };
}
