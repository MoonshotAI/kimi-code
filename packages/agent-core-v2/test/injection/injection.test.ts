import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IContextService } from '#/context/context';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { InjectionQueue, InjectionService } from '#/injection/injectionService';

describe('InjectionService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IContextService, { _serviceBrand: undefined });
  });
  afterEach(() => disposables.dispose());

  it('push then flush drains in FIFO order', () => {
    const svc = ix.createInstance(InjectionService);
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
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
  });
  afterEach(() => disposables.dispose());

  it('is an independent per-turn queue', () => {
    const q = ix.createInstance(InjectionQueue);
    q.push({ kind: 'x', content: 'y' });
    expect(q.flush()).toEqual([{ kind: 'x', content: 'y' }]);
  });
});
