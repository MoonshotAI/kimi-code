import { describe, expect, it } from 'vitest';

import { HookEngine } from '#/hooks/hookEngine';

describe('HookEngine', () => {
  it('passes through with continue: true by default', async () => {
    const hooks = new HookEngine(undefined as never, undefined as never);
    expect(await hooks.runUserPromptSubmit('hi')).toEqual({ continue: true });
    expect(await hooks.runPreToolCall('bash', {})).toEqual({ continue: true });
    await expect(hooks.runSessionStart()).resolves.toBeUndefined();
    hooks.dispose();
  });
});
