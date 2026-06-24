import { describe, expect, it } from 'vitest';

import { BackgroundService } from '#/background/backgroundService';

describe('BackgroundService', () => {
  it('start / list / stop / getOutput', async () => {
    const svc = new BackgroundService(
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const id = await svc.start({ id: 'x', kind: 'process' });
    expect(svc.list()).toEqual([{ id: 'x', kind: 'process' }]);
    expect(await svc.getOutput(id)).toBe('');
    await svc.stop(id);
    svc.dispose();
  });
});
