import type { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import type {
  Environment,
  EnvironmentCapability,
  EnvironmentStatus,
} from '#/environment/environment';
import type { EnvironmentRegistry } from '#/environment/environmentRegistry';

export function stubAgentEnvironment(
  environment: Environment | (() => Environment),
  options: {
    readonly workDir?: string;
    readonly additionalDirs?: readonly string[];
    readonly isAvailable?: (required?: readonly EnvironmentCapability[]) => boolean;
    readonly onDidChange?: IAgentEnvironmentService['onDidChange'];
  } = {},
): IAgentEnvironmentService {
  const resolve = typeof environment === 'function' ? environment : () => environment;
  const lease = () => ({
    environment: resolve(),
    track: <T,>(resource: T): T => resource,
    dispose: () => {},
  });
  return {
    _serviceBrand: undefined,
    onDidChange: options.onDidChange ?? (() => ({ dispose: () => {} })),
    isAvailable: options.isAvailable ?? (() => true),
    inspect: resolve,
    acquire: lease,
    acquireWhenReady: async () => lease(),
    reconnect: async () => {},
    workspaceRoots: () => ({
      workDir: options.workDir ?? '/workspace',
      additionalDirs: options.additionalDirs ?? [],
    }),
  };
}

export function fakeEnvironment(
  environmentId: string,
  generation: string,
  options: {
    readonly workspaceId?: string;
    readonly status?: EnvironmentStatus;
    readonly capabilities?: readonly EnvironmentCapability[];
    readonly host?: Partial<Environment['host']>;
    readonly pathClass?: 'posix' | 'win32';
  } = {},
): FakeEnvironment {
  const capabilities = options.capabilities ?? ['fs', 'process'];
  const value = new FakeEnvironment(
    { environmentId, generation },
    {
      status: options.status ?? 'ready',
      capabilities,
      host: options.host,
      pathClass: options.pathClass,
    },
  );
  return Object.assign(value, {
    fs: capabilities.includes('fs') ? {} : undefined,
    process: capabilities.includes('process') ? {} : undefined,
    terminal: capabilities.includes('terminal') ? {} : undefined,
  });
}

export function connectableEnvironment(
  registry: EnvironmentRegistry,
  options: {
    readonly environmentId?: string;
    readonly workspaceId?: string;
    readonly status?: 'pending' | 'ready' | 'disconnected';
    readonly connect?: () => Promise<void>;
    readonly stat?: (path: string) => Promise<{ isDirectory: boolean }>;
  } = {},
): {
  readonly fake: FakeEnvironment;
  readonly calls: string[];
  readonly connectCalls: string[];
} {
  const environmentId = options.environmentId ?? 'connectable';
  const fake = new FakeEnvironment(
    { environmentId, generation: `${environmentId}-pending` },
    { status: options.status ?? 'pending', capabilities: ['fs', 'process'] },
  );
  const calls: string[] = [];
  const connectCalls: string[] = [];
  const connectable = Object.assign(fake, {
    connect: async () => {
      calls.push('connect');
      connectCalls.push('connect');
      if (options.connect !== undefined) return options.connect();
      fake.setStatus('ready');
    },
    fs: {
      stat: options.stat ?? (async () => ({ isDirectory: true })),
    },
    process: {},
  });
  registry.register(connectable);
  return { fake: connectable, calls, connectCalls };
}
