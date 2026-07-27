import { describe, expect, it } from 'vitest';

import { runWorkflowScript, type WorkflowRunEvents } from '#/app/workflow/runtime/runtime';
import {
  DEFAULT_WORKFLOW_LIMITS,
  type WorkflowAgentOutcome,
  type WorkflowAgentRequest,
  type WorkflowDefinition,
  type WorkflowHost,
  type WorkflowLimits,
  type WorkflowMeta,
} from '#/app/workflow/runtime/types';
import { WorkflowValidationError, validateWorkflowMeta } from '#/app/workflow/runtime/validate';

const META = `export const meta = {
  name: 'test-flow',
  description: 'Test workflow.',
  phases: [{ title: 'One' }, { title: 'Two' }],
};`;

function definition(body: string): WorkflowDefinition {
  const script = `${META}\n${body}\n`;
  return {
    meta: {
      name: 'test-flow',
      description: 'Test workflow.',
      phases: [{ title: 'One' }, { title: 'Two' }],
    },
    script,
    path: '',
    source: 'project',
  };
}

function limits(overrides: Partial<WorkflowLimits> = {}): WorkflowLimits {
  return { ...DEFAULT_WORKFLOW_LIMITS, maxDurationMs: 10_000, ...overrides };
}

function echoHost(
  fn: (request: WorkflowAgentRequest, signal: AbortSignal) => Promise<WorkflowAgentOutcome> | WorkflowAgentOutcome,
): WorkflowHost {
  return { runAgent: async (request, signal) => fn(request, signal) };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function run(
  def: WorkflowDefinition,
  options: {
    host?: WorkflowHost;
    limits?: WorkflowLimits;
    signal?: AbortSignal;
    events?: WorkflowRunEvents;
    args?: string;
  } = {},
) {
  return runWorkflowScript(def, {
    args: options.args ?? '',
    host: options.host ?? echoHost(() => ({ status: 'ok', text: 'ok' })),
    limits: options.limits ?? limits(),
    signal: options.signal ?? new AbortController().signal,
    events: options.events,
  });
}

describe('runWorkflowScript basics', () => {
  it('runs phases and logs in order and completes with the returned value', async () => {
    const seen: string[] = [];
    const result = await run(
      definition(`
        phase('One');
        log('first');
        phase('Two');
        log('second');
        return { done: true, args };
      `),
      {
        args: 'topic-x',
        events: {
          onPhase: (title) => seen.push(`phase:${title}`),
          onLog: (message) => seen.push(`log:${message}`),
        },
      },
    );
    expect(result).toEqual({
      status: 'completed',
      result: { done: true, args: 'topic-x' },
      agentCalls: 0,
      phase: 'Two',
    });
    expect(seen).toEqual(['phase:One', 'log:first', 'phase:Two', 'log:second']);
  });

  it('truncates log messages to 2000 chars', async () => {
    const logs: string[] = [];
    await run(definition(`log('x'.repeat(5000)); return null;`), {
      events: { onLog: (message) => logs.push(message) },
    });
    expect(logs[0]).toHaveLength(2000);
  });

  it('fails when the script throws', async () => {
    const result = await run(definition(`throw new Error('boom');`));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('boom');
  });

  it('fails clearly when the result is not JSON-serializable', async () => {
    const result = await run(definition(`return { fn: () => 1, cyc: (() => { const o = {}; o.self = o; return o; })() };`));
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('not JSON-serializable');
  });
});

describe('agent()', () => {
  it('returns raw text without schema and null on refusal', async () => {
    const host = echoHost((request) =>
      request.prompt === 'refuse-me' ? { status: 'refused' } : { status: 'ok', text: `echo:${request.prompt}` },
    );
    const result = await run(
      definition(`
        const a = await agent('hello');
        const b = await agent('refuse-me');
        return { a, b };
      `),
      { host },
    );
    expect(result).toMatchObject({
      status: 'completed',
      result: { a: 'echo:hello', b: null },
      agentCalls: 2,
    });
  });

  it('validates schema output, parses fenced JSON, and clones the value', async () => {
    const host = echoHost(() => ({
      status: 'ok',
      text: 'Here you go:\n```json\n{ "score": 7, "tags": ["a"] }\n```\nthanks',
    }));
    const result = await run(
      definition(`
        const data = await agent('rate', { schema: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'] } });
        return data;
      `),
      { host },
    );
    expect(result).toMatchObject({ status: 'completed', result: { score: 7, tags: ['a'] } });
  });

  it('parses a bare balanced JSON object embedded in prose', async () => {
    const host = echoHost(() => ({ status: 'ok', text: 'Sure! {"ok": true} — done.' }));
    const result = await run(
      definition(`return await agent('x', { schema: { type: 'object' } });`),
      { host },
    );
    expect(result).toMatchObject({ status: 'completed', result: { ok: true } });
  });

  it('rejects when the output does not match the schema', async () => {
    const host = echoHost(() => ({ status: 'ok', text: '{"score": "high"}' }));
    const result = await run(
      definition(`return await agent('rate', { schema: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'] } });`),
      { host },
    );
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('schema');
  });

  it('rejects when the output has no parseable JSON', async () => {
    const host = echoHost(() => ({ status: 'ok', text: 'no json here' }));
    const result = await run(
      definition(`return await agent('x', { schema: { type: 'object' } });`),
      { host },
    );
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('JSON');
  });

  it('rejects an invalid JSON schema at call creation', async () => {
    const result = await run(
      definition(`return await agent('x', { schema: { type: 'not-a-type' } });`),
    );
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('schema');
  });

  it('propagates host errors as failed, and script try/catch can continue', async () => {
    let calls = 0;
    const host = echoHost(() => {
      calls += 1;
      if (calls === 1) return { status: 'error', message: 'agent exploded' };
      return { status: 'ok', text: 'recovered' };
    });

    const hard = await run(definition(`return await agent('a');`), { host: echoHost(() => ({ status: 'error', message: 'agent exploded' })) });
    expect(hard.status).toBe('failed');
    if (hard.status === 'failed') expect(hard.error).toContain('agent exploded');

    const soft = await run(
      definition(`
        let first;
        try { first = await agent('a'); } catch (e) { first = 'fallback:' + e.message; }
        const second = await agent('b');
        return { first, second };
      `),
      { host },
    );
    expect(soft).toMatchObject({
      status: 'completed',
      result: { first: 'fallback:agent exploded', second: 'recovered' },
    });
  });

  it('emits onAgentCall events with started and outcome states', async () => {
    const events: string[] = [];
    await run(
      definition(`phase('One'); await agent('p', { label: 'L' }); return null;`),
      {
        events: {
          onAgentCall: (info) => events.push(`${info.index}:${info.state}:${info.label}:${info.phase}`),
        },
      },
    );
    expect(events).toEqual(['1:started:L:One', '1:ok:L:One']);
  });

  it('passes the current phase and schemaJson to the host', async () => {
    const requests: WorkflowAgentRequest[] = [];
    const host = echoHost((request) => {
      requests.push(request);
      return { status: 'ok', text: '{}' };
    });
    await run(
      definition(`
        phase('One');
        await agent('a', { schema: { type: 'object' } });
        await agent('b', { phase: 'Custom' });
        return null;
      `),
      { host },
    );
    expect(requests[0]?.phase).toBe('One');
    expect(JSON.parse(requests[0]?.schemaJson ?? '')).toEqual({ type: 'object' });
    expect(requests[1]?.phase).toBe('Custom');
    expect(requests[1]?.schemaJson).toBeUndefined();
  });
});

describe('parallel() and pipeline()', () => {
  it('parallel fan-out never exceeds maxConcurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const host = echoHost(async (request) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { status: 'ok', text: `done:${request.prompt}` };
    });
    const result = await run(
      definition(`
        const results = await parallel([0,1,2,3,4,5,6,7].map((i) => () => agent('job' + i)));
        return results;
      `),
      { host, limits: limits({ maxConcurrency: 2 }) },
    );
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.result).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => `done:job${i}`));
    }
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('parallel rejects on non-function entries', async () => {
    const result = await run(definition(`return await parallel([1, 2]);`));
    expect(result.status).toBe('failed');
  });

  it('pipeline items flow without a barrier and results keep item order', async () => {
    const gates = new Map<string, Deferred<WorkflowAgentOutcome>>();
    const order: string[] = [];
    const host = echoHost((request) => {
      order.push(request.prompt);
      const gate = deferred<WorkflowAgentOutcome>();
      gates.set(request.prompt, gate);
      return gate.promise;
    });

    const resultPromise = run(
      definition(`
        return await pipeline(
          ['A', 'B'],
          (x) => agent('s1:' + x),
          (x) => agent('s2:' + x),
        );
      `),
      { host, limits: limits({ maxConcurrency: 8 }) },
    );

    await waitFor(() => gates.has('s1:A') && gates.has('s1:B'));
    // Finish item A's stage 1 while item B's stage 1 is still pending: item A
    // must advance to stage 2 without waiting for item B (no barrier).
    gates.get('s1:A')?.resolve({ status: 'ok', text: 'a1' });
    await waitFor(() => gates.has('s2:a1'));
    expect(gates.has('s1:B')).toBe(true);
    expect(order).toContain('s2:a1');

    gates.get('s2:a1')?.resolve({ status: 'ok', text: 'a2' });
    gates.get('s1:B')?.resolve({ status: 'ok', text: 'b1' });
    await waitFor(() => gates.has('s2:b1'));
    gates.get('s2:b1')?.resolve({ status: 'ok', text: 'b2' });

    const result = await resultPromise;
    expect(result).toMatchObject({ status: 'completed', result: ['a2', 'b2'] });
  });

  it('pipeline skips remaining stages when a stage yields null', async () => {
    const stage2Prompts: string[] = [];
    const host = echoHost((request) => {
      if (request.prompt.startsWith('s2:')) stage2Prompts.push(request.prompt);
      if (request.prompt === 's1:skip') return { status: 'refused' };
      return { status: 'ok', text: request.prompt.toUpperCase() };
    });
    const result = await run(
      definition(`
        return await pipeline(
          ['keep', 'skip'],
          (x) => agent('s1:' + x),
          (x) => agent('s2:' + x),
        );
      `),
      { host },
    );
    expect(result).toMatchObject({ status: 'completed', result: ['S2:S1:KEEP', null] });
    expect(stage2Prompts).toEqual(['s2:S1:KEEP']);
  });
});

describe('limits and cancellation', () => {
  it('fails the run when maxAgentCalls is exceeded even with try/catch', async () => {
    const result = await run(
      definition(`
        for (let i = 0; i < 10; i++) {
          try { await agent('call' + i); } catch (e) { /* swallowed */ }
        }
        return 'survived';
      `),
      { limits: limits({ maxAgentCalls: 3 }) },
    );
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('agent call limit exceeded');
  });

  it('fails with a duration error when maxDurationMs elapses', async () => {
    const host = echoHost(async (_request, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve(); }, { once: true });
      });
      return { status: 'error', message: 'aborted' };
    });
    const result = await run(definition(`return await agent('never');`), {
      host,
      limits: limits({ maxDurationMs: 1000 }),
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toBe('workflow exceeded max duration');
  });

  it('returns cancelled when the external signal aborts mid-agent-call, and the host sees the abort', async () => {
    const controller = new AbortController();
    let hostSawAbort = false;
    const started = deferred<void>();
    const host = echoHost(async (_request, signal) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            hostSawAbort = true;
            resolve();
          },
          { once: true },
        );
      });
      return { status: 'error', message: 'aborted' };
    });
    const resultPromise = run(
      definition(`
        try {
          return await agent('long');
        } catch (e) {
          return 'swallowed';
        }
      `),
      { host, signal: controller.signal },
    );
    await started.promise;
    controller.abort();
    const result = await resultPromise;
    expect(result.status).toBe('cancelled');
    expect(hostSawAbort).toBe(true);
  });
});

describe('sandbox restrictions', () => {
  it('has no process/require access', async () => {
    const result = await run(definition(`process.exit(1); return 1;`));
    expect(result.status).toBe('failed');
    const result2 = await run(definition(`return require('node:fs');`));
    expect(result2.status).toBe('failed');
  });

  it('blocks dynamic code generation via constructor.constructor', async () => {
    const result = await run(
      definition(`return ({}).constructor.constructor('return 1')();`),
    );
    expect(result.status).toBe('failed');
  });

  it('has no timers or fetch', async () => {
    const result = await run(definition(`setTimeout(() => {}, 1); return 1;`));
    expect(result.status).toBe('failed');
    const result2 = await run(definition(`return await fetch('https://example.com');`));
    expect(result2.status).toBe('failed');
  });
});

describe('validateWorkflowMeta argumentHint', () => {
  const VALID: WorkflowMeta = {
    name: 'test-flow',
    description: 'Test workflow.',
    phases: [{ title: 'One' }],
  };

  it('accepts an optional argumentHint', () => {
    const meta = validateWorkflowMeta({ ...VALID, argumentHint: '<research question>' });
    expect(meta.argumentHint).toBe('<research question>');
  });

  it('rejects an argumentHint longer than 200 chars', () => {
    expect(() => validateWorkflowMeta({ ...VALID, argumentHint: 'x'.repeat(201) })).toThrow(
      WorkflowValidationError,
    );
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
