import type { Event } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import {
  SessionEngineController,
  type SessionClientFactoryOptions,
  type SessionClientHandle,
} from '#/cli/session-engine-controller';

/** A fake engine client that captures the wired sinks so a test can drive
 *  the engine side (fire events, trigger approval) without a live process. */
class FakeClient implements SessionClientHandle {
  readonly sessionId: string;
  onEvent: ((event: unknown) => void) | undefined;
  authorizeTool: ((req: unknown) => Promise<{ block: boolean; resolved: boolean }>) | undefined;
  cancelled = false;
  saved = false;
  prompts: string[] = [];

  constructor(options: SessionClientFactoryOptions) {
    this.sessionId = options.sessionId ?? 'fake';
    this.onEvent = options.onEvent;
    this.authorizeTool = options.lifecycle?.authorizeTool;
  }

  prompt(
    text: string,
  ): Promise<{ stop_reason: string; steps: number; usage: { total_tokens: number } } | null> {
    this.prompts.push(text);
    return Promise.resolve({ stop_reason: 'EndTurn', steps: 2, usage: { total_tokens: 9 } });
  }
  cancel(): Promise<boolean> {
    this.cancelled = true;
    return Promise.resolve(true);
  }
  save(): Promise<boolean> {
    this.saved = true;
    return Promise.resolve(true);
  }
  load(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

describe('SessionEngineController', () => {
  it('translates engine events into SDK events and drives prompt/cancel', async () => {
    const emitted: Event[] = [];
    let fake: FakeClient | undefined;
    const controller = new SessionEngineController({
      createClient: (options) => {
        fake = new FakeClient(options);
        return Promise.resolve(fake);
      },
      emitEvent: (event) => emitted.push(event),
    });

    const started = await controller.start({ sessionId: 's1', model: 'mock' });
    expect(started).toBe(true);
    expect(controller.sessionId).toBe('s1');

    // Engine fires wire events → controller translates + emits SDK events.
    fake!.onEvent!({ type: 'session.turn.started', turn_id: 1 });
    fake!.onEvent!({ type: 'llm.delta', part: { type: 'text', text: 'Hi' } });
    fake!.onEvent!({ type: 'llm.step.begin', model: 'm' }); // internal → dropped
    fake!.onEvent!({ type: 'session.turn.ended', turn_id: 1, stop_reason: 'EndTurn' });
    expect(emitted.map((e) => e.type)).toEqual(['turn.started', 'assistant.delta', 'turn.ended']);

    const outcome = await controller.prompt('do it');
    expect(fake!.prompts).toEqual(['do it']);
    expect(outcome).toEqual({ stopReason: 'EndTurn', steps: 2, totalTokens: 9 });

    expect(await controller.cancel()).toBe(true);
    expect(fake!.cancelled).toBe(true);
    expect(await controller.save()).toBe(true);
  });

  it('taps every raw engine event, including ones the translator drops', async () => {
    const raw: string[] = [];
    let fake: FakeClient | undefined;
    const controller = new SessionEngineController({
      createClient: (options) => {
        fake = new FakeClient(options);
        return Promise.resolve(fake);
      },
      emitEvent: () => {},
      onRawEvent: (event) => {
        raw.push((event as { type?: string }).type ?? '');
      },
    });
    await controller.start({ sessionId: 's1' });

    // session.goal.updated is dropped by the translator (no SDK snapshot
    // shape) but must still reach a raw tap so the host can render it.
    fake!.onEvent!({ type: 'session.goal.updated', status: 'active' });
    fake!.onEvent!({ type: 'llm.step.begin', model: 'm' });
    expect(raw).toEqual(['session.goal.updated', 'llm.step.begin']);
  });

  it('bridges the engine approval gate onto the host yes/no prompt', async () => {
    const approvals: string[] = [];
    let allow = true;
    let fake: FakeClient | undefined;
    const controller = new SessionEngineController({
      createClient: (options) => {
        fake = new FakeClient(options);
        return Promise.resolve(fake);
      },
      emitEvent: () => {},
      requestApproval: (req) => {
        approvals.push(req.toolName);
        return Promise.resolve(allow);
      },
    });
    await controller.start({ sessionId: 's1' });

    const allowed = await fake!.authorizeTool!({ tool_name: 'Write', tool_call_id: 'c1' });
    expect(allowed).toEqual({ block: false, resolved: true });

    allow = false;
    const denied = await fake!.authorizeTool!({ tool_name: 'Bash', tool_call_id: 'c2' });
    expect(denied).toMatchObject({ block: true, resolved: true });
    expect(approvals).toEqual(['Write', 'Bash']);
  });

  it('auto-allows when no approver is supplied (permission auto)', async () => {
    let fake: FakeClient | undefined;
    const controller = new SessionEngineController({
      createClient: (options) => {
        fake = new FakeClient(options);
        return Promise.resolve(fake);
      },
      emitEvent: () => {},
    });
    await controller.start({ sessionId: 's1' });
    const decision = await fake!.authorizeTool!({ tool_name: 'Write', tool_call_id: 'c1' });
    expect(decision).toEqual({ block: false, resolved: true });
  });

  it('reports engine-unavailable when the factory returns null', async () => {
    const controller = new SessionEngineController({
      createClient: () => Promise.resolve(null),
      emitEvent: () => {},
    });
    expect(await controller.start({ sessionId: 's1' })).toBe(false);
    expect(controller.isStarted).toBe(false);
    expect(await controller.prompt('x')).toBeNull();
    expect(await controller.cancel()).toBe(false);
  });
});
