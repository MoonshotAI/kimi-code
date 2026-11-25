import { ErrorCodes, Error2 } from '#/errors';
import type { Environment } from '#/environment/environment';
import { shareBinRgPath } from '#/environment/shareBinRg';

export { getShareBinRgPath } from '#/environment/shareBinRg';

export type RgResolutionSource = 'system-path' | 'share-bin-cached';

export interface RgResolution {
  readonly path: string;
  readonly source: RgResolutionSource;
}

export interface RgProbe {
  exec(args: readonly string[]): Promise<{ readonly exitCode: number }>;
}

export interface EnsureRgPathOptions {
  readonly signal?: AbortSignal;
  readonly allowCachedFallback?: boolean;
  readonly environment?: Environment;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

export async function ensureRgPath(
  probe: RgProbe,
  options: EnsureRgPathOptions = {},
): Promise<RgResolution> {
  throwIfAborted(options.signal);

  const system = await probe.exec(['rg', '--version']).catch(() => ({ exitCode: -1 }));
  if (system.exitCode === 0) {
    return { path: 'rg', source: 'system-path' };
  }

  if (options.allowCachedFallback === true) {
    throwIfAborted(options.signal);
    const cached = shareBinRgPath(options.environment);
    const cachedRun = await probe.exec([cached, '--version']).catch(() => ({ exitCode: -1 }));
    if (cachedRun.exitCode === 0) {
      return { path: cached, source: 'share-bin-cached' };
    }
  }

  throw new Error2(ErrorCodes.OS_FS_UNAVAILABLE, 'ripgrep (rg) is not available on PATH');
}
