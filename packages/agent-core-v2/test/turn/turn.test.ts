import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import { IContextService } from '#/context/context';
import { IInjectionService } from '#/injection/injection';
import { ILLMService } from '#/kosong/kosong';
import { ILogService } from '#/log/log';
import { IPermissionService } from '#/permission/permission';
import { ITelemetryService } from '#/telemetry/telemetry';
import { IToolService } from '#/tool/tool';
import { ILoopRunner } from '#/turn/turn';
import { IUsageService } from '#/usage/usage';

import { LoopRunner } from '#/turn/loopRunner';
import { TurnService } from '#/turn/turnService';

describe('TurnService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IContextService, {});
    ix.stub(IToolService, {});
    ix.stub(IPermissionService, {});
    ix.stub(ILLMService, {});
    ix.stub(IInjectionService, {});
    ix.stub(IUsageService, {});
    ix.stub(ITelemetryService, {});
    ix.stub(ILogService, {});
    ix.stub(IAgentLifecycleService, {});
    ix.set(ILoopRunner, new LoopRunner());
  });
  afterEach(() => disposables.dispose());

  function make(): TurnService {
    return disposables.add(ix.createInstance(TurnService));
  }

  it('launch emits start → step → end and tracks active state', async () => {
    const svc = make();
    const events: string[] = [];
    svc.onWillStartTurn((e) => events.push(`start:${e.turnId}`));
    svc.onDidEndStep((e) => events.push(`step:${e.step}`));
    svc.onDidEndTurn((e) => events.push(`end:${e.reason}`));

    expect(svc.hasActiveTurn).toBe(false);
    await svc.prompt('hello');
    expect(svc.hasActiveTurn).toBe(false);
    expect(events).toEqual(['start:turn-0', 'step:0', 'end:completed']);
  });

  it('steer buffers input', () => {
    const svc = make();
    svc.steer('a');
    svc.steer('b', 'user');
    expect(svc.hasActiveTurn).toBe(false);
  });

  it('cancel fires onDidEndTurn with cancelled reason', async () => {
    const svc = make();
    const ends: string[] = [];
    svc.onDidEndTurn((e) => ends.push(e.reason));
    const slow = new (class extends LoopRunner {
      override run(): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
    ix.set(ILoopRunner, slow);
    const svc2 = disposables.add(ix.createInstance(TurnService));
    svc2.onDidEndTurn((e) => ends.push(e.reason));
    const p = svc2.prompt('hello');
    expect(svc2.hasActiveTurn).toBe(true);
    svc2.cancel('user');
    await p;
    expect(ends).toContain('user');
  });
});
