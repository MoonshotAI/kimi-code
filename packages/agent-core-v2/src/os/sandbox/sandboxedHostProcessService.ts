

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { ScopeActivation, overrideScopedService, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { LifecycleScope } from '#/app/scopes';
import { IFlagService } from '#/app/flag/flag';

import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import {
  type HostProcessOptions,
  type IHostProcess,
  IHostProcessService,
} from '#/os/interface/hostProcess';

import { SANDBOX_FLAG_ID } from './flag';
import { INetworkProxyService } from './networkProxy';
import { ISandboxProfileResolver } from './sandboxProfileResolver';
import { ISandboxService } from './sandboxService';
import type { SandboxProcessInfo } from './types';

export const IHostProcessBackend: ServiceIdentifier<IHostProcessService> =
  createDecorator<IHostProcessService>('hostProcessBackend');

const SANDBOX_ENV_KEYS = {
  sandboxed: 'KIMI_SANDBOXED',
  mode: 'KIMI_SANDBOX_MODE',
  backend: 'KIMI_SANDBOX_BACKEND',
} as const;

class SandboxedHostProcess implements IHostProcess {
  declare readonly _serviceBrand: undefined;

  private settled = false;

  constructor(
    private readonly inner: IHostProcess,
    readonly sandboxed: SandboxProcessInfo,
    private readonly onSettled?: () => void,
  ) {}

  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.onSettled?.();
  }

  get pid(): number {
    return this.inner.pid;
  }

  get exitCode(): number | null {
    return this.inner.exitCode;
  }

  get stdin() {
    return this.inner.stdin;
  }

  get stdout() {
    return this.inner.stdout;
  }

  get stderr() {
    return this.inner.stderr;
  }

  async wait(): Promise<number> {
    try {
      return await this.inner.wait();
    } finally {
      this.settle();
    }
  }

  kill(signal?: NodeJS.Signals): Promise<void> {
    return this.inner.kill(signal);
  }

  dispose(): void | Promise<void> {
    this.settle();
    return this.inner.dispose();
  }
}

export class SandboxedHostProcessService implements IHostProcessService {
  declare readonly _serviceBrand: undefined;

  private unsupportedWarned = false;

  constructor(
    @IHostProcessBackend private readonly inner: IHostProcessService,
    @ISandboxService private readonly sandbox: ISandboxService,
    @ISandboxProfileResolver private readonly resolver: ISandboxProfileResolver,
    @IFlagService private readonly flags: IFlagService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ILogService private readonly log: ILogService,
    @INetworkProxyService private readonly proxy: INetworkProxyService,
  ) {}

  async spawn(
    command: string,
    args: readonly string[] = [],
    options: HostProcessOptions = {},
  ): Promise<IHostProcess> {
    const request = options.sandbox;
    if (request === undefined || !this.flags.enabled(SANDBOX_FLAG_ID)) {
      return this.inner.spawn(command, args, options);
    }

    const profile = this.resolver.resolve(request);
    if (profile === undefined) {
      return this.inner.spawn(command, args, options);
    }

    if (profile.mode === 'danger-full-access') {
      this.telemetry.track2('sandbox_spawn', {
        backend: 'none' as string,
        mode: profile.mode as string,
        network_mode: 'all' as string,
      });
      const env = {
        ...options.env,
        [SANDBOX_ENV_KEYS.sandboxed]: '0',
        [SANDBOX_ENV_KEYS.mode]: profile.mode,
      };
      return this.inner.spawn(command, args, { ...options, env });
    }

    if (!this.sandbox.supported) {
      if (!this.unsupportedWarned) {
        this.unsupportedWarned = true;
        this.telemetry.track2('sandbox_unsupported_passthrough', {
          platform: process.platform as string,
          reason: this.sandbox.unsupportedReason ?? 'unknown',
        });
      }
      return this.inner.spawn(command, args, options);
    }

    if (
      profile.network.mode === 'allowlist' &&
      profile.network.proxyPorts !== undefined &&
      this.sandbox.backendName === 'bwrap'
    ) {
      this.telemetry.track2('network_egress_unenforced', {
        backend: this.sandbox.backendName as string,
        network_mode: profile.network.mode as string,
      });
    }

    const plan = this.sandbox.wrap(command, args, profile);
    const env = {
      ...options.env,
      ...request.proxy?.env,
      ...plan.env,
      [SANDBOX_ENV_KEYS.sandboxed]: '1',
      [SANDBOX_ENV_KEYS.mode]: profile.mode,
      [SANDBOX_ENV_KEYS.backend]: this.sandbox.backendName,
    };
    this.telemetry.track2('sandbox_spawn', {
      backend: this.sandbox.backendName as string,
      mode: profile.mode as string,
      network_mode: profile.network.mode as string,
    });
    const proxyToken = request.proxy?.token;
    const proc = await this.inner.spawn(plan.command, plan.args, { ...options, env });
    return new SandboxedHostProcess(
      proc,
      {
        backend: this.sandbox.backendName,
        mode: profile.mode,
      },
      proxyToken === undefined
        ? undefined
        : () => {
            this.proxy.release(proxyToken);
          },
    );
  }
}

registerScopedService(
  LifecycleScope.App,
  IHostProcessBackend,
  HostProcessService,
  ScopeActivation.OnDemand,
  'os/sandbox',
);

overrideScopedService(
  LifecycleScope.App,
  IHostProcessService,
  SandboxedHostProcessService,
  ScopeActivation.OnDemand,
  'os/sandbox',
);
