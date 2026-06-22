import { describe, expect, it } from 'vitest';

import { _util } from '#/_base/di/test';
import {
  IAgentContext,
  ISessionContext,
  IToolCallContext,
  ITurnContext,
} from '#/scope/context/index';

describe('scope identity contexts (I*Context)', () => {
  it('each context decorator is a distinct ServiceIdentifier with the canonical name', () => {
    const decorators = [
      { id: ISessionContext, name: 'sessionContext' },
      { id: IAgentContext, name: 'agentContext' },
      { id: ITurnContext, name: 'turnContext' },
      { id: IToolCallContext, name: 'toolCallContext' },
    ];

    // Each is a callable ServiceIdentifier whose toString() is the decorator name.
    for (const { id, name } of decorators) {
      expect(typeof id).toBe('function');
      expect(id.toString()).toBe(name);
    }

    // All four are distinct objects (createDecorator produced separate ids).
    const unique = new Set(decorators.map((d) => d.id));
    expect(unique.size).toBe(decorators.length);
  });

  it('ISessionContext has id / abortSignal / executionScope and parentId undefined', () => {
    const ctx: ISessionContext = {
      id: 'session-1',
      parentId: undefined,
      abortSignal: new AbortController().signal,
      executionScope: undefined,
    };

    expect(ctx.id).toBe('session-1');
    expect(ctx.parentId).toBeUndefined();
    expect(ctx.abortSignal).toBeInstanceOf(AbortSignal);
    expect('executionScope' in ctx).toBe(true);
  });

  it('IAgentContext has id / abortSignal / executionScope and string parentId (sessionId)', () => {
    const ctx: IAgentContext = {
      id: 'agent-1',
      parentId: 'session-1',
      abortSignal: new AbortController().signal,
      executionScope: undefined,
    };

    expect(ctx.id).toBe('agent-1');
    expect(typeof ctx.parentId).toBe('string');
    expect(ctx.parentId).toBe('session-1');
    expect(ctx.abortSignal).toBeInstanceOf(AbortSignal);
    expect('executionScope' in ctx).toBe(true);
  });

  it('ITurnContext has id / abortSignal / executionScope and string parentId (agentId)', () => {
    const ctx: ITurnContext = {
      id: 'turn-1',
      parentId: 'agent-1',
      abortSignal: new AbortController().signal,
      executionScope: undefined,
    };

    expect(ctx.id).toBe('turn-1');
    expect(typeof ctx.parentId).toBe('string');
    expect(ctx.parentId).toBe('agent-1');
    expect(ctx.abortSignal).toBeInstanceOf(AbortSignal);
    expect('executionScope' in ctx).toBe(true);
  });

  it('IToolCallContext has id / abortSignal / executionScope and string parentId (turnId)', () => {
    const ctx: IToolCallContext = {
      id: 'toolCall-1',
      parentId: 'turn-1',
      abortSignal: new AbortController().signal,
      executionScope: undefined,
    };

    expect(ctx.id).toBe('toolCall-1');
    expect(typeof ctx.parentId).toBe('string');
    expect(ctx.parentId).toBe('turn-1');
    expect(ctx.abortSignal).toBeInstanceOf(AbortSignal);
    expect('executionScope' in ctx).toBe(true);
  });

  it('decorators register a constructor parameter dependency in the DI metadata', () => {
    // Simulate what `class C { constructor(@IAgentContext ctx) {} }` emits:
    // the decorator is invoked as (ctor, undefined, paramIndex).
    class Consumer {
      public constructor(_ctx: IAgentContext) {
        // identity-only; no behavior needed for this assertion
      }
    }

    IAgentContext(Consumer, undefined, 0);

    const deps = _util.getServiceDependencies(
      Consumer as unknown as _util.DI_TARGET_OBJ,
    );
    expect(deps).toEqual([{ id: IAgentContext, index: 0 }]);
  });
});
