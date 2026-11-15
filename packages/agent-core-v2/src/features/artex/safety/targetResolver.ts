import { lookup } from 'node:dns/promises';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';

export interface ArtexResolveResult {
  readonly ips: readonly string[];
  readonly resolvedAt: string;
}

/**
 * Resolves a hostname to its addresses for the target gate. Injectable so tests
 * can supply a deterministic resolver instead of real DNS.
 */
export interface IArtexTargetResolver {
  readonly _serviceBrand: undefined;
  readonly resolverName: string;
  lookup(host: string, signal?: AbortSignal): Promise<ArtexResolveResult>;
}

export const IArtexTargetResolver: ServiceIdentifier<IArtexTargetResolver> =
  createDecorator<IArtexTargetResolver>('artexTargetResolver');

export class SystemArtexTargetResolver extends Disposable implements IArtexTargetResolver {
  declare readonly _serviceBrand: undefined;
  readonly resolverName = 'system';

  async lookup(host: string): Promise<ArtexResolveResult> {
    const records = await lookup(host, { all: true });
    const ips = records.map((record) => record.address).filter((address) => address !== '');
    if (ips.length === 0) {
      throw new Error(`no addresses for ${host}`);
    }
    return { ips, resolvedAt: new Date().toISOString() };
  }
}
