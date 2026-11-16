import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';

import type { ArtexTargetPin } from '#/features/artex/store/artexWorkStore';

export interface IArtexTargetPinCache {
  readonly _serviceBrand: undefined;
  remember(taskId: number, host: string, port: number, pinnedIps: readonly string[]): void;
  activePins(taskId: number, host: string, port: number): readonly ArtexTargetPin[];
}

export const IArtexTargetPinCache: ServiceIdentifier<IArtexTargetPinCache> =
  createDecorator<IArtexTargetPinCache>('artexTargetPinCache');

export class ArtexTargetPinCache extends Disposable implements IArtexTargetPinCache {
  declare readonly _serviceBrand: undefined;

  private readonly pins = new Map<string, ArtexTargetPin>();

  remember(taskId: number, host: string, port: number, pinnedIps: readonly string[]): void {
    const key = `${String(taskId)}|${host.toLowerCase()}|${String(port)}`;
    const existing = this.pins.get(key);
    if (existing !== undefined) {
      const merged = new Set([...existing.pinnedIps, ...pinnedIps]);
      this.pins.set(key, { ...existing, pinnedIps: [...merged] });
      return;
    }
    const now = new Date().toISOString();
    this.pins.set(key, {
      id: -1,
      taskId,
      host,
      port,
      version: 1,
      status: 'active',
      pinnedIps: [...pinnedIps],
      resolver: 'approval-cache',
      resolvedAt: now,
      nameOnlyEffective: false,
      createdAt: now,
    });
  }

  activePins(taskId: number, host: string, port: number): readonly ArtexTargetPin[] {
    const normalized = host.toLowerCase();
    const matches: ArtexTargetPin[] = [];
    for (const pin of this.pins.values()) {
      if (pin.taskId !== taskId || pin.status !== 'active') continue;
      if (pin.host.toLowerCase() !== normalized) continue;
      if (pin.port !== port && pin.port !== 0) continue;
      matches.push(pin);
    }
    return matches;
  }
}

registerScopedService(
  LifecycleScope.Session,
  IArtexTargetPinCache,
  ArtexTargetPinCache,
  ScopeActivation.OnScopeCreated,
  'artexTargetPinCache',
);