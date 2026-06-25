import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { IInjectionQueue, IInjectionService } from '#/injection/injection';
import { InjectionQueue, InjectionService } from '#/injection/injectionService';
import { registerContextServices } from '../context/stubs';

describe('InjectionService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerContextServices],
      additionalServices: (reg) => {
        reg.define(IInjectionService, InjectionService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('push then flush drains in FIFO order', () => {
    const svc = ix.get(IInjectionService);
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
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IInjectionQueue, InjectionQueue);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('is an independent per-turn queue', () => {
    const q = ix.get(IInjectionQueue);
    q.push({ kind: 'x', content: 'y' });
    expect(q.flush()).toEqual([{ kind: 'x', content: 'y' }]);
  });
});
