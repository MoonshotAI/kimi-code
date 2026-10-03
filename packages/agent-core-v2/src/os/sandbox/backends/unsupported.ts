import type { SandboxBackend } from '../backend';
import type { SandboxSpawnPlan } from '../types';

export class UnsupportedBackend implements SandboxBackend {
  readonly name = 'unsupported' as const;
  readonly supported = false;

  constructor(readonly unsupportedReason: string) {}

  wrap(): SandboxSpawnPlan {
    throw new Error(`sandbox unsupported: ${this.unsupportedReason}`);
  }
}
