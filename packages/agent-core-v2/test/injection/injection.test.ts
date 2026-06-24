import { describe, expect, it } from 'vitest';

import { InjectionQueue, InjectionService } from '#/injection/injectionService';

describe('InjectionService', () => {
  it('push then flush drains in FIFO order', () => {
    const svc = new InjectionService(undefined as never);
    svc.push({ kind: 'a', content: '1' });
    svc.push({ kind: 'b', content: '2' });
    expect(svc.flush()).toEqual([
      { kind: 'a', content: '1' },
      { kind: 'b', content: '2' },
    ]);
    expect(svc.flush()).toEqual([]);
  });
});

describe('InjectionQueue', () => {
  it('is an independent per-turn queue', () => {
    const q = new InjectionQueue();
    q.push({ kind: 'x', content: 'y' });
    expect(q.flush()).toEqual([{ kind: 'x', content: 'y' }]);
  });
});
