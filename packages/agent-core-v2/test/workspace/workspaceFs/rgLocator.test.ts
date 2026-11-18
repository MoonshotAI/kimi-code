import { describe, expect, it, vi } from 'vitest';

import {
  ensureRgPath,
  getShareBinRgPath,
  type RgProbe,
} from '#/workspace/workspaceFs/internal/rgLocator';
import { stubRgProbe } from '../../os/stubs';

function probeWith(
  resolveExitCode: (args: readonly string[]) => number,
): RgProbe & { exec: ReturnType<typeof vi.fn> } {
  return stubRgProbe(resolveExitCode);
}

describe('ensureRgPath cached fallback', () => {
  it('probes the local share bin', async () => {
    const probe = probeWith((args) => (args[0] === 'rg' ? -1 : 0));

    const resolution = await ensureRgPath(probe, { allowCachedFallback: true });

    expect(resolution).toEqual({ path: getShareBinRgPath(), source: 'share-bin-cached' });
  });
});
