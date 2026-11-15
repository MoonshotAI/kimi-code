import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { IConfigService } from '#/app/config/config';

import { resolveArtexNoiseProfile } from '#/features/artex/config/configSection';

/**
 * Paces ARTEX-mode egress (WebFetch, web_search) per host according to the
 * configured noise profile. A session-scoped backstop to the scanner-flag
 * guidance in the noise-profile prompt; Bash commands are not paced here.
 */
export interface IArtexEgressPacer {
  readonly _serviceBrand: undefined;
  pace(host: string, signal?: AbortSignal): Promise<void>;
}

export const IArtexEgressPacer: ServiceIdentifier<IArtexEgressPacer> =
  createDecorator<IArtexEgressPacer>('artexEgressPacer');

export class ArtexEgressPacer extends Disposable implements IArtexEgressPacer {
  declare readonly _serviceBrand: undefined;

  private readonly nextAllowed = new Map<string, number>();

  constructor(@IConfigService private readonly config: IConfigService) {
    super();
  }

  async pace(host: string, signal?: AbortSignal): Promise<void> {
    const profile = resolveArtexNoiseProfile(this.config);
    if (profile.name === 'off' || profile.rps <= 0) return;
    const minIntervalMs = Math.max(1, Math.trunc(1000 / profile.rps));
    const key = host.trim().toLowerCase();
    const now = Date.now();
    const earliest = this.nextAllowed.get(key) ?? 0;
    const start = Math.max(now, earliest);
    this.nextAllowed.set(key, start + minIntervalMs);
    const delayMs = start - now;
    if (delayMs <= 0) return;
    await delay(delayMs, signal);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
