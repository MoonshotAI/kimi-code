

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';

import {
  type SandboxBackend,
  detectSandboxBackend,
  isLikelySandboxDenial,
} from './backend';
import { SeatbeltBackend } from './backends/seatbelt';
import { BwrapBackend } from './backends/bwrap';
import { UnsupportedBackend } from './backends/unsupported';
import type {
  ResolvedSandboxProfile,
  SandboxBackendName,
  SandboxSpawnPlan,
} from './types';

export interface ISandboxService {
  readonly _serviceBrand: undefined;

  readonly backendName: SandboxBackendName;
  readonly supported: boolean;
  readonly unsupportedReason?: string;

  wrap(
    command: string,
    args: readonly string[],
    profile: ResolvedSandboxProfile,
  ): SandboxSpawnPlan;
  isLikelyDenial(exitCode: number | null, outputTail: string): boolean;
}

export const ISandboxService: ServiceIdentifier<ISandboxService> =
  createDecorator<ISandboxService>('sandboxService');

export class SandboxService implements ISandboxService {
  declare readonly _serviceBrand: undefined;

  private readonly backend: SandboxBackend;

  constructor(@ILogService private readonly log: ILogService) {
    const detected = detectSandboxBackend();
    if (!detected.supported) {
      this.backend = new UnsupportedBackend(
        detected.unsupportedReason ?? 'no sandbox backend for this platform',
      );
      this.log.warn('OS sandbox backend unavailable; agent commands run unsandboxed', {
        reason: this.backend.unsupportedReason,
      });
    } else if (detected.name === 'seatbelt') {
      this.backend = new SeatbeltBackend();
    } else {
      this.backend = new BwrapBackend();
    }
  }

  get backendName(): SandboxBackendName {
    return this.backend.name;
  }

  get supported(): boolean {
    return this.backend.supported;
  }

  get unsupportedReason(): string | undefined {
    return this.backend.unsupportedReason;
  }

  wrap(
    command: string,
    args: readonly string[],
    profile: ResolvedSandboxProfile,
  ): SandboxSpawnPlan {
    return this.backend.wrap(command, args, profile);
  }

  isLikelyDenial(exitCode: number | null, outputTail: string): boolean {
    return isLikelySandboxDenial(exitCode, outputTail);
  }
}

registerScopedService(
  LifecycleScope.App,
  ISandboxService,
  SandboxService,
  ScopeActivation.OnDemand,
  'os/sandbox',
);
