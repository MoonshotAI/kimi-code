import { describe, expect, it, vi } from 'vitest';

import { SwarmCoordinator } from '../../src/agent/swarm/coordinator';
import type { SpawnSubagentFn } from '../../src/agent/swarm/types';

const PLAN_JSON = JSON.stringify({
  subtasks: [
    { role: 'Researcher', systemPrompt: 'sp-research', prompt: 'p-research' },
    { role: 'Analyst', systemPrompt: 'sp-analyst', prompt: 'p-analyst', toolAllowlist: ['Read'] },
  ],
});

function makeSpawner(byProfile: Record<string, string>): SpawnSubagentFn {
  return vi.fn(async (args) => {
    if (args.profileName === 'swarm-planner') return { result: '```json\n' + PLAN_JSON + '\n```' };
    if (args.profileName === 'swarm-synthesizer') return { result: 'FINAL ANSWER' };
    const key = args.profileName;
    return { result: byProfile[key] ?? `done:${args.description}` };
  });
}

describe('SwarmCoordinator.run', () => {
  it('plans, runs workers concurrently, and synthesizes', async () => {
    const spawn = makeSpawner({});
    const coordinator = new SwarmCoordinator({
      spawnSubagent: spawn,
      signal: new AbortController().signal,
      maxConcurrency: 4,
    });

    const result = await coordinator.run('do a thing');

    expect(result).toBe('FINAL ANSWER');
    const calls = (spawn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(4);
    expect(calls[0].profileName).toBe('swarm-planner');
    expect(calls.some((c) => c.profileName === 'swarm:Researcher' && c.systemPrompt === 'sp-research')).toBe(true);
    expect(calls.some((c) => c.profileName === 'swarm:Analyst' && c.tools.includes('Read'))).toBe(true);
    expect(calls[calls.length - 1].profileName).toBe('swarm-synthesizer');
  });

  it('retries planning once on invalid JSON, then succeeds', async () => {
    let first = true;
    const spawn: SpawnSubagentFn = vi.fn(async (args) => {
      if (args.profileName === 'swarm-planner') {
        if (first) {
          first = false;
          return { result: 'not json at all' };
        }
        return { result: PLAN_JSON };
      }
      if (args.profileName === 'swarm-synthesizer') return { result: 'OK' };
      return { result: 'worker-done' };
    });
    const coordinator = new SwarmCoordinator({ spawnSubagent: spawn, signal: new AbortController().signal });
    const result = await coordinator.run('x');
    expect(result).toBe('OK');
  });

  it('throws when planning fails twice', async () => {
    const spawn: SpawnSubagentFn = vi.fn(async () => ({ result: 'never json' }));
    const coordinator = new SwarmCoordinator({ spawnSubagent: spawn, signal: new AbortController().signal });
    await expect(coordinator.run('x')).rejects.toThrow(/valid plan/i);
  });

  it('records a failed worker and still synthesizes', async () => {
    const spawn: SpawnSubagentFn = vi.fn(async (args) => {
      if (args.profileName === 'swarm-planner') return { result: PLAN_JSON };
      if (args.profileName === 'swarm-synthesizer') return { result: 'SYNTH' };
      if (args.profileName === 'swarm:Researcher') throw new Error('boom');
      return { result: 'analyst-done' };
    });
    const onProgress = vi.fn();
    const coordinator = new SwarmCoordinator({
      spawnSubagent: spawn,
      signal: new AbortController().signal,
      onProgress,
    });
    const result = await coordinator.run('x');
    expect(result).toBe('SYNTH');
    expect(onProgress.mock.calls.some((c) => /failed/i.test(String(c[0])))).toBe(true);
  });

  it('strips disallowed tools (Agent/Bash) from a planner-supplied allowlist', async () => {
    const planWithBadTools = JSON.stringify({
      subtasks: [{ role: 'X', systemPrompt: 's', prompt: 'p', toolAllowlist: ['Agent', 'Read', 'Bash'] }],
    });
    const spawn = vi.fn(async (args) => {
      if (args.profileName === 'swarm-planner') return { result: planWithBadTools };
      if (args.profileName === 'swarm-synthesizer') return { result: 'S' };
      return { result: 'w' };
    });
    const coordinator = new SwarmCoordinator({ spawnSubagent: spawn, signal: new AbortController().signal });
    await coordinator.run('x');
    const worker = (spawn as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .find((c) => c.profileName === 'swarm:X');
    expect(worker?.tools).toEqual(['Read']);
  });

  it('emits structured progress: planned(total) → synthesizing → done', async () => {
    const spawn = makeSpawner({});
    const onProgressCustom = vi.fn();
    const coordinator = new SwarmCoordinator({
      spawnSubagent: spawn,
      signal: new AbortController().signal,
      onProgressCustom,
    });
    await coordinator.run('do a thing');
    const payloads = (onProgressCustom as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(payloads).toContainEqual({ phase: 'planned', total: 2 });
    expect(payloads).toContainEqual({ phase: 'synthesizing' });
    expect(
      payloads.some(
        (p) => p.phase === 'done' && p.succeeded === 2 && p.failed === 0 && p.dropped === 0,
      ),
    ).toBe(true);
  });

  it('propagates abort instead of swallowing it (no synthesis after cancel)', async () => {
    const controller = new AbortController();
    const PLAN = JSON.stringify({ subtasks: [{ role: 'A', systemPrompt: 's', prompt: 'p' }] });
    const spawn = vi.fn(async (args) => {
      if (args.profileName === 'swarm-planner') return { result: PLAN };
      controller.abort();
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    const coordinator = new SwarmCoordinator({ spawnSubagent: spawn, signal: controller.signal });
    await expect(coordinator.run('x')).rejects.toThrow();
    const profiles = (spawn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].profileName);
    expect(profiles).not.toContain('swarm-synthesizer');
  });
});

// One-subtask plan keeps wave behavior deterministic for recovery tests.
const ONE_PLAN = JSON.stringify({
  subtasks: [{ id: 'task-1', role: 'Worker', systemPrompt: 'sp', prompt: 'p-original' }],
});

describe('SwarmCoordinator failure recovery', () => {
  it('retry: a worker fails once, reviser says retry, re-run succeeds', async () => {
    let workerCalls = 0;
    const spawn = vi.fn(async (args) => {
      if (args.profileName === 'swarm-planner') return { result: ONE_PLAN };
      if (args.profileName === 'swarm-synthesizer') return { result: 'SYNTH' };
      if (args.profileName === 'swarm-reviser') return { result: '{"kind":"retry"}' };
      // swarm:Worker
      workerCalls += 1;
      if (workerCalls === 1) throw new Error('boom');
      return { result: 'worker-ok' };
    });
    const onProgressCustom = vi.fn();
    const coordinator = new SwarmCoordinator({
      spawnSubagent: spawn,
      signal: new AbortController().signal,
      onProgressCustom,
    });
    const result = await coordinator.run('x');
    expect(result).toBe('SYNTH');
    expect(workerCalls).toBe(2);
    const payloads = (onProgressCustom as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(payloads).toContainEqual({
      phase: 'revising',
      subtaskId: 'task-1',
      role: 'Worker',
      decision: 'retry',
      attempt: 1,
    });
    expect(
      payloads.some(
        (p) => p.phase === 'done' && p.succeeded === 1 && p.failed === 0 && p.dropped === 0,
      ),
    ).toBe(true);
  });

  it('regenerate: re-run uses the new prompt from the reviser', async () => {
    const workerPrompts: string[] = [];
    let workerCalls = 0;
    const spawn = vi.fn(async (args) => {
      if (args.profileName === 'swarm-planner') return { result: ONE_PLAN };
      if (args.profileName === 'swarm-synthesizer') return { result: 'SYNTH' };
      if (args.profileName === 'swarm-reviser')
        return { result: '{"kind":"regenerate","prompt":"NEW PROMPT"}' };
      workerCalls += 1;
      workerPrompts.push(args.prompt);
      if (workerCalls === 1) throw new Error('boom');
      return { result: 'worker-ok' };
    });
    const coordinator = new SwarmCoordinator({
      spawnSubagent: spawn,
      signal: new AbortController().signal,
    });
    const result = await coordinator.run('x');
    expect(result).toBe('SYNTH');
    expect(workerPrompts[0]).toBe('p-original');
    expect(workerPrompts[1]).toBe('NEW PROMPT');
  });

  it('reassign: re-run uses the new role, systemPrompt, and tools', async () => {
    const seen: Array<{ profileName: string; systemPrompt: string; tools: string[] }> = [];
    let workerCalls = 0;
    const spawn = vi.fn(async (args) => {
      if (args.profileName === 'swarm-planner') return { result: ONE_PLAN };
      if (args.profileName === 'swarm-synthesizer') return { result: 'SYNTH' };
      if (args.profileName === 'swarm-reviser')
        return {
          result: '{"kind":"reassign","role":"R2","systemPrompt":"SP2","toolAllowlist":["Read"]}',
        };
      seen.push({
        profileName: args.profileName,
        systemPrompt: args.systemPrompt,
        tools: args.tools,
      });
      workerCalls += 1;
      if (workerCalls === 1) throw new Error('boom');
      return { result: 'worker-ok' };
    });
    const onProgressCustom = vi.fn();
    const coordinator = new SwarmCoordinator({
      spawnSubagent: spawn,
      signal: new AbortController().signal,
      onProgressCustom,
    });
    const result = await coordinator.run('x');
    expect(result).toBe('SYNTH');
    expect(seen[0]?.profileName).toBe('swarm:Worker');
    expect(seen[1]?.profileName).toBe('swarm:R2');
    expect(seen[1]?.systemPrompt).toBe('SP2');
    expect(seen[1]?.tools).toEqual(['Read']);
    // The 'revising' event carries the role as it was BEFORE the reassign so
    // the dashboard can correlate it to the existing worker row, plus the NEW
    // role so the dashboard can re-key that row instead of stranding it.
    const payloads = (onProgressCustom as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(payloads).toContainEqual({
      phase: 'revising',
      subtaskId: 'task-1',
      role: 'Worker',
      decision: 'reassign',
      newRole: 'R2',
      attempt: 1,
    });
  });

  it('drop (LLM-chosen): a dropped subtask is not re-run and is surfaced as a gap', async () => {
    let workerCalls = 0;
    let synthesizerPrompt: string | undefined;
    const spawn = vi.fn(async (args) => {
      if (args.profileName === 'swarm-planner') return { result: ONE_PLAN };
      if (args.profileName === 'swarm-synthesizer') {
        synthesizerPrompt = args.prompt;
        return { result: 'SYNTH' };
      }
      if (args.profileName === 'swarm-reviser')
        return { result: '{"kind":"drop","reason":"impossible"}' };
      workerCalls += 1;
      throw new Error('boom');
    });
    const onProgressCustom = vi.fn();
    const coordinator = new SwarmCoordinator({
      spawnSubagent: spawn,
      signal: new AbortController().signal,
      onProgressCustom,
    });
    const result = await coordinator.run('x');
    expect(result).toBe('SYNTH');
    expect(workerCalls).toBe(1); // ran once, then dropped — never re-run
    const payloads = (onProgressCustom as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(payloads).toContainEqual({
      phase: 'dropped',
      subtaskId: 'task-1',
      role: 'Worker',
      reason: 'impossible',
    });
    expect(
      payloads.some(
        (p) => p.phase === 'done' && p.succeeded === 0 && p.failed === 0 && p.dropped === 1,
      ),
    ).toBe(true);
    expect(synthesizerPrompt).toMatch(/DROPPED/);
    expect(synthesizerPrompt).toContain('impossible');
  });

  it('maxAttempts: a perpetually failing subtask runs exactly maxAttempts times then force-drops', async () => {
    let workerCalls = 0;
    const spawn = vi.fn(async (args) => {
      if (args.profileName === 'swarm-planner') return { result: ONE_PLAN };
      if (args.profileName === 'swarm-synthesizer') return { result: 'SYNTH' };
      if (args.profileName === 'swarm-reviser') return { result: '{"kind":"retry"}' };
      workerCalls += 1;
      throw new Error('always-boom');
    });
    const onProgressCustom = vi.fn();
    const coordinator = new SwarmCoordinator({
      spawnSubagent: spawn,
      signal: new AbortController().signal,
      maxAttempts: 2,
      onProgressCustom,
    });
    const result = await coordinator.run('x');
    expect(result).toBe('SYNTH');
    expect(workerCalls).toBe(2); // exactly maxAttempts runs
    const payloads = (onProgressCustom as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(payloads.some((p) => p.phase === 'dropped' && p.subtaskId === 'task-1')).toBe(true);
    expect(
      payloads.some((p) => p.phase === 'done' && p.succeeded === 0 && p.dropped === 1),
    ).toBe(true);
    // Reviser is consulted only after attempt 1 (attempt 2 hits the cap and force-drops).
    const reviserCalls = (spawn as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .filter((c) => c.profileName === 'swarm-reviser');
    expect(reviserCalls).toHaveLength(1);
  });

  it('reviser parse failure falls back to a conservative drop (does not burn attempts)', async () => {
    let workerCalls = 0;
    const spawn = vi.fn(async (args) => {
      if (args.profileName === 'swarm-planner') return { result: ONE_PLAN };
      if (args.profileName === 'swarm-synthesizer') return { result: 'SYNTH' };
      if (args.profileName === 'swarm-reviser') return { result: 'I am confused, no json here' };
      workerCalls += 1;
      throw new Error('boom');
    });
    const onProgressCustom = vi.fn();
    const coordinator = new SwarmCoordinator({
      spawnSubagent: spawn,
      signal: new AbortController().signal,
      onProgressCustom,
    });
    const result = await coordinator.run('x');
    expect(result).toBe('SYNTH');
    expect(workerCalls).toBe(1);
    const payloads = (onProgressCustom as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(payloads).toContainEqual({
      phase: 'revising',
      subtaskId: 'task-1',
      role: 'Worker',
      decision: 'drop',
      attempt: 1,
    });
    expect(payloads.some((p) => p.phase === 'dropped' && p.subtaskId === 'task-1')).toBe(true);
  });

  it('multi-wave: a revised subtask re-runs in a later wave and the loop terminates', async () => {
    // Two subtasks; both fail on wave 1, retry, both succeed on wave 2.
    const TWO_PLAN = JSON.stringify({
      subtasks: [
        { id: 'task-1', role: 'A', systemPrompt: 'spa', prompt: 'pa' },
        { id: 'task-2', role: 'B', systemPrompt: 'spb', prompt: 'pb' },
      ],
    });
    const calls: Record<string, number> = {};
    const spawn = vi.fn(async (args) => {
      if (args.profileName === 'swarm-planner') return { result: TWO_PLAN };
      if (args.profileName === 'swarm-synthesizer') return { result: 'SYNTH' };
      if (args.profileName === 'swarm-reviser') return { result: '{"kind":"retry"}' };
      calls[args.profileName] = (calls[args.profileName] ?? 0) + 1;
      if (calls[args.profileName] === 1) throw new Error('boom');
      return { result: 'ok' };
    });
    const coordinator = new SwarmCoordinator({
      spawnSubagent: spawn,
      signal: new AbortController().signal,
    });
    const result = await coordinator.run('x');
    expect(result).toBe('SYNTH');
    expect(calls['swarm:A']).toBe(2);
    expect(calls['swarm:B']).toBe(2);
  });

  it('all subtasks dropped: still synthesizes with a gap-only prompt (no crash)', async () => {
    const TWO_PLAN = JSON.stringify({
      subtasks: [
        { id: 'task-1', role: 'A', systemPrompt: 'spa', prompt: 'pa' },
        { id: 'task-2', role: 'B', systemPrompt: 'spb', prompt: 'pb' },
      ],
    });
    let synthesizerPrompt: string | undefined;
    const spawn = vi.fn(async (args) => {
      if (args.profileName === 'swarm-planner') return { result: TWO_PLAN };
      if (args.profileName === 'swarm-synthesizer') {
        synthesizerPrompt = args.prompt;
        return { result: 'SYNTH' };
      }
      if (args.profileName === 'swarm-reviser')
        return { result: '{"kind":"drop","reason":"impossible"}' };
      // Every worker fails on its first (only) run, then is dropped.
      throw new Error('boom');
    });
    const onProgressCustom = vi.fn();
    const coordinator = new SwarmCoordinator({
      spawnSubagent: spawn,
      signal: new AbortController().signal,
      onProgressCustom,
    });
    const result = await coordinator.run('x');
    expect(result).toBe('SYNTH');
    // Synthesizer was consulted and its prompt surfaces both subtasks as gaps,
    // never inventing a success.
    expect(synthesizerPrompt).toBeDefined();
    expect(synthesizerPrompt).toMatch(/DROPPED/);
    expect(synthesizerPrompt).not.toMatch(/done\)/);
    const payloads = (onProgressCustom as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(
      payloads.some(
        (p) => p.phase === 'done' && p.succeeded === 0 && p.dropped === 2 && p.failed === 0,
      ),
    ).toBe(true);
  });

  it('does not revise on a genuine swarm-wide cancel (re-throws the abort)', async () => {
    const controller = new AbortController();
    const spawn = vi.fn(async (args) => {
      if (args.profileName === 'swarm-planner') return { result: ONE_PLAN };
      // Worker: a real swarm-wide cancel — abort the coordinator signal and throw.
      controller.abort();
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    });
    const coordinator = new SwarmCoordinator({ spawnSubagent: spawn, signal: controller.signal });
    await expect(coordinator.run('x')).rejects.toThrow();
    const profiles = (spawn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].profileName);
    expect(profiles).not.toContain('swarm-reviser');
    expect(profiles).not.toContain('swarm-synthesizer');
  });
});
