import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IContextMemory, type ContextMessage } from '#/contextMemory';
import { IDynamicInjector } from '#/dynamicInjector';
import { DynamicInjectorService } from '#/dynamicInjector/dynamicInjectorService';
import { ITurnService, type TurnStepContext } from '#/turn';
import { stubContextMemory, type StubContextMemory } from '../contextMemory/stubs';
import { stubTurnWithHooks } from '../turn/stubs';

function textOf(message: ContextMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

// NOTE: the legacy `IInjectionService.push/flush` queue and `IInjectionQueue`
// have no equivalent in the new `dynamicInjector` domain. Injection is now
// provider-based: callers `register(variant, provider)` and the injector
// splices the provider's content into context on each turn step. These cases
// exercise that provider flow instead of the deleted FIFO queue.

describe('DynamicInjectorService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let ctx: StubContextMemory;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IContextMemory, stubContextMemory());
    ix.stub(ITurnService, stubTurnWithHooks());
    ix.set(IDynamicInjector, new SyncDescriptor(DynamicInjectorService));
    ctx = ix.get(IContextMemory) as StubContextMemory;
  });
  afterEach(() => disposables.dispose());

  async function runBeforeStep(): Promise<void> {
    const turn = ix.get(ITurnService);
    const stepCtx: TurnStepContext = {
      turn: turn.launch({ kind: 'user' }),
      continueTurn: true,
    };
    await turn.hooks.beforeStep.run(stepCtx);
  }

  it('splices a registered provider content into context on a step', async () => {
    const injector = ix.get(IDynamicInjector);
    injector.register('reminder', () => 'hello injection');

    await runBeforeStep();

    expect(ctx.messages).toHaveLength(1);
    expect(textOf(ctx.messages[0]!)).toContain('hello injection');
    expect(ctx.messages[0]?.origin).toEqual({ kind: 'injection', variant: 'reminder' });
  });

  it('stops injecting after the registration is disposed', async () => {
    const injector = ix.get(IDynamicInjector);
    const registration = injector.register('reminder', () => 'hello injection');
    registration.dispose();

    await runBeforeStep();

    expect(ctx.messages).toHaveLength(0);
  });
});
