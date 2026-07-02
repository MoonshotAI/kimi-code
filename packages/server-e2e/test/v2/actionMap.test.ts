/**
 * Drift test — asserts the SDK's resource manifests stay in lockstep with the
 * `server-v2` `actionMap`. If the server adds/removes/renames an action, this
 * test fails until `src/v2/resources/manifest.ts` (and the derived types) is
 * updated.
 */
import { actionMap } from '@moonshot-ai/server-v2/contract';
import { describe, expect, it } from 'vitest';

import { AGENT, CORE, SESSION, flattenManifest } from '../../src/v2/index.js';

function serverActions(scope: 'core' | 'session' | 'agent'): string[] {
  return Object.keys(actionMap[scope]).sort();
}

describe('v2 manifest ↔ server actionMap', () => {
  it('core scope matches', () => {
    expect(flattenManifest(CORE)).toEqual(serverActions('core'));
  });

  it('session scope matches', () => {
    expect(flattenManifest(SESSION)).toEqual(serverActions('session'));
  });

  it('agent scope matches', () => {
    expect(flattenManifest(AGENT)).toEqual(serverActions('agent'));
  });

  it('covers every server action exactly once', () => {
    const sdk = new Set([
      ...flattenManifest(CORE),
      ...flattenManifest(SESSION),
      ...flattenManifest(AGENT),
    ]);
    const server = [
      ...serverActions('core'),
      ...serverActions('session'),
      ...serverActions('agent'),
    ];
    expect(sdk.size).toBe(server.length);
  });
});
