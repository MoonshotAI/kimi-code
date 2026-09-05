/**
 * Scenario: the `update-all-session-models` experiment flag must be registered
 * on BOTH engines with a matching id, env var, and default, so the TUI gate
 * (`experimentalFlag: 'update-all-session-models'`) resolves identically on
 * v1 and v2 and `/experimental` can toggle it on either engine. The v1↔v2
 * parity suite only compares the id intersection; this pins the registration
 * itself so the two registries cannot drift apart silently.
 * Run: pnpm -C packages/node-sdk exec vitest run test/update-all-session-models-flag.test.ts
 */
import { describe, expect, it } from 'vitest';

import { FLAG_DEFINITIONS } from '@moonshot-ai/agent-core';
import { updateAllSessionModelsFlag } from '@moonshot-ai/agent-core-v2';

const FLAG_ID = 'update-all-session-models';

describe('update-all-session-models experiment flag registration', () => {
  it('is registered on the v1 engine, default off', () => {
    const v1 = FLAG_DEFINITIONS.find((flag) => flag.id === FLAG_ID);
    expect(v1).toBeDefined();
    expect(v1!.env).toBe('KIMI_CODE_EXPERIMENTAL_UPDATE_ALL_SESSION_MODELS');
    expect(v1!.default).toBe(false);
  });

  it('is registered on the v2 engine with the same id, env, and default', () => {
    expect(updateAllSessionModelsFlag.id).toBe(FLAG_ID);
    expect(updateAllSessionModelsFlag.env).toBe('KIMI_CODE_EXPERIMENTAL_UPDATE_ALL_SESSION_MODELS');
    expect(updateAllSessionModelsFlag.default).toBe(false);
  });
});
