/**
 * Real-Session e2e for the bundled `coder` subagent profile (aligned with
 * agent-core-v2's CODER_TOOLS). Proves the tools newly added to the profile
 * don't just pass the profile allowlist but actually execute inside a real
 * subagent: Skill / TodoList / background Bash + the Task* trio / plan mode
 * enter+write+exit / a nested Agent (explore) call / a nested AgentSwarm batch.
 * Also pins the declared-but-not-delivered contract for cron tools on sub
 * agents (same as v2).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'pathe';

import {
  isContentPart,
  isToolCall,
  type FinishReason,
  type Message,
  type ProviderConfig,
  type StreamedMessagePart,
} from '@moonshot-ai/kosong';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Agent, AgentOptions } from '../../src/agent';
import { isBackgroundTaskTerminal } from '../../src/agent/background';
import type { ResolvedAgentProfile } from '../../src/profile';
import type { SDKSessionRPC } from '../../src/rpc';
import { Session } from '../../src/session';
import { ProviderManager } from '../../src/session/provider-manager';
import { createScriptedGenerate } from '../agent/harness/scripted-generate';
import { testKaos } from '../fixtures/test-kaos';

const MOCK_PROVIDER = { type: 'kimi', apiKey: 'test-key', model: 'mock-model' } as const satisfies ProviderConfig;

const tempDirs: string[] = [];
const openSessions: Session[] = [];

afterEach(async () => {
  await Promise.allSettled(openSessions.splice(0).map((s) => s.close()));
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

type GenerateFn = NonNullable<AgentOptions['generate']>;

interface StepRecord {
  readonly label: string;
  readonly wireTools: readonly string[];
  readonly prevToolOutput: string | null;
  readonly prevToolIsError: boolean;
}

function toolText(message: Message | undefined): string | null {
  if (message === undefined) return null;
  const parts = message.content;
  return parts
    .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : JSON.stringify(part)))
    .join('');
}

function lastToolMessage(history: readonly Message[]): Message | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    if (message.role === 'tool') return message;
  }
  return undefined;
}

function callTool(name: string, args: unknown): StreamedMessagePart[] {
  return [{ type: 'function', id: `call_${name}`, name, arguments: JSON.stringify(args) }];
}

const FINAL_TEXT =
  'E2E-CODER-DONE: exercised Skill, TodoList, background Bash with the TaskList/TaskOutput/TaskStop ' +
  'trio, plan mode enter/write-plan/exit, and a nested explore Agent call. Every newly aligned tool ' +
  'executed successfully on a real Session with a real home directory, skill registry, background ' +
  'manager, and subagent host wiring. No tool call returned an error.';

function createVerifyGenerate(steps: StepRecord[]): GenerateFn {
  let taskId = '';
  let planPath = '';

  const generate: GenerateFn = async (_chat, systemPrompt, tools, history, callbacks, options) => {
    options?.signal?.throwIfAborted();
    options?.onRequestStart?.();

    const wireTools = tools.filter((tool) => tool.deferred !== true).map((tool) => tool.name);
    const firstUserText = toolText(history.find((message) => message.role === 'user')) ?? '';
    const isExploreChild = firstUserText.includes('Probe nested subagent support');
    const isSwarmChild = firstUserText.includes('SWARM-PROBE');

    let parts: StreamedMessagePart[];
    if (isExploreChild) {
      parts = [
        {
          type: 'text',
          text: 'NESTED-EXPLORE-OK: the nested explore subagent ran and reported back to the coder.',
        },
      ];
    } else if (isSwarmChild) {
      // Long enough (>200 chars) to skip the subagent summary-continuation retry,
      // keeping the scripted call count deterministic across the swarm batch.
      parts = [
        {
          type: 'text',
          text:
            'SWARM-CHILD-OK: this swarm child subagent ran to completion inside the coder subagent, ' +
            'executed its assigned slice of the batch, and is reporting the outcome back to its ' +
            'parent so the swarm results can be aggregated.',
        },
      ];
    } else {
      const last = lastToolMessage(history);
      const prevToolOutput = toolText(last);
      const prevToolIsError = (last as { isError?: boolean } | undefined)?.isError === true;
      const step = history.filter((message) => message.role === 'assistant').length + 1;
      steps.push({ label: `step-${String(step)}`, wireTools, prevToolOutput, prevToolIsError });

      switch (step) {
        case 1:
          parts = callTool('Skill', { skill: 'demo-skill', args: 'e2e' });
          break;
        case 2:
          parts = callTool('TodoList', { todos: [{ title: 'verify-tools-e2e', status: 'in_progress' }] });
          break;
        case 3:
          parts = callTool('Bash', { command: 'sleep 15', description: 'e2e bg sleep', run_in_background: true });
          break;
        case 4: {
          const match = /task_id: (\S+)/.exec(prevToolOutput ?? '');
          taskId = match?.[1] ?? '';
          parts = callTool('TaskList', {});
          break;
        }
        case 5:
          parts = callTool('TaskOutput', { task_id: taskId, block: false });
          break;
        case 6:
          parts = callTool('TaskStop', { task_id: taskId });
          break;
        case 7:
          parts = callTool('EnterPlanMode', {});
          break;
        case 8: {
          const match = /Plan file: (\S+)/.exec(prevToolOutput ?? '');
          planPath = match?.[1] ?? '';
          parts = callTool('Write', { path: planPath, content: '# e2e plan\n\nDo the thing.\n' });
          break;
        }
        case 9:
          parts = callTool('ExitPlanMode', {});
          break;
        case 10:
          parts = callTool('Agent', {
            description: 'nested explore check',
            prompt: 'Probe nested subagent support: confirm you can run and report back.',
            subagent_type: 'explore',
          });
          break;
        case 11:
          parts = callTool('AgentSwarm', {
            description: 'swarm probe',
            prompt_template: 'SWARM-PROBE {{item}}',
            items: ['alpha', 'beta'],
            subagent_type: 'explore',
          });
          break;
        default:
          parts = [{ type: 'text', text: FINAL_TEXT }];
          break;
      }
    }

    for (const part of parts) {
      await callbacks?.onMessagePart?.(structuredClone(part));
      options?.signal?.throwIfAborted();
    }
    options?.onStreamEnd?.();

    const content = parts.filter((part) => isContentPart(part));
    const toolCalls = parts.filter((part) => isToolCall(part));
    const message: Message = {
      role: 'assistant',
      content: structuredClone(content),
      toolCalls: structuredClone(toolCalls),
    };
    const finishReason: FinishReason = toolCalls.length > 0 ? 'tool_calls' : 'completed';
    options?.onTraceId?.(null);
    return {
      id: 'mock-generate',
      message,
      usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
      finishReason,
      rawFinishReason: finishReason === 'completed' ? 'stop' : finishReason,
      traceId: null,
    };
  };
  return generate;
}

const DRAIN_FINAL_TEXT =
  'DRAIN-CHECK-DONE: started a background sleep with Bash and finished my main work. ' +
  'The subagent run must not complete until that background task settles — this final ' +
  'message should reach the parent only after the background task has terminated, and ' +
  'no orphan notification turn may run on me afterwards.';

async function createCoderSession(
  generate: AgentOptions['generate'],
): Promise<{ session: Session; mainAgent: Agent }> {
  const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-coder-tools-e2e-'));
  tempDirs.push(sessionDir);
  const rpc: SDKSessionRPC = {
    emitEvent: vi.fn(async () => {}),
    requestApproval: vi.fn(async () => ({ decision: 'approved', selectedLabel: 'approve' })),
    requestQuestion: vi.fn(async () => null),
    toolCall: vi.fn(async () => ({ output: '', isError: true })),
  } as unknown as SDKSessionRPC;

  const session = new Session({
    id: 'coder-tools-drain-e2e',
    kaos: testKaos.withCwd(sessionDir),
    homedir: sessionDir,
    rpc,
    skills: { explicitDirs: [join(sessionDir, 'no-such-skills-dir')] },
    providerManager: new ProviderManager({
      config: {
        providers: { test: { type: MOCK_PROVIDER.type, apiKey: MOCK_PROVIDER.apiKey } },
        models: {
          [MOCK_PROVIDER.model]: { provider: 'test', model: MOCK_PROVIDER.model, maxContextSize: 1_000_000 },
        },
      },
    }),
  });
  openSessions.push(session);

  const mainProfile: ResolvedAgentProfile = {
    name: 'agent',
    systemPrompt: () => '<system-prompt>',
    tools: [],
  };
  const { agent: mainAgent } = await session.createAgent(
    { type: 'main', generate },
    { profile: mainProfile },
  );
  mainAgent.config.update({ modelAlias: MOCK_PROVIDER.model, thinkingEffort: 'off' });
  mainAgent.permission.setMode('auto');
  return { session, mainAgent };
}

describe('coder subagent aligned tools (real Session e2e)', () => {
  it('runs every newly aligned tool to success inside a real coder subagent', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'kimi-coder-tools-e2e-'));
    tempDirs.push(sessionDir);

    const rpc: SDKSessionRPC = {
      emitEvent: vi.fn(async () => {}),
      requestApproval: vi.fn(async () => ({ decision: 'approved', selectedLabel: 'approve' })),
      requestQuestion: vi.fn(async () => null),
      toolCall: vi.fn(async () => ({ output: '', isError: true })),
    } as unknown as SDKSessionRPC;

    const session = new Session({
      id: 'coder-tools-e2e',
      kaos: testKaos.withCwd(sessionDir),
      homedir: sessionDir,
      rpc,
      skills: { explicitDirs: [join(sessionDir, 'no-such-skills-dir')] },
      providerManager: new ProviderManager({
        config: {
          providers: { test: { type: MOCK_PROVIDER.type, apiKey: MOCK_PROVIDER.apiKey } },
          models: {
            [MOCK_PROVIDER.model]: { provider: 'test', model: MOCK_PROVIDER.model, maxContextSize: 1_000_000 },
          },
        },
      }),
    });
    openSessions.push(session);

    // Register an invocable skill BEFORE the child agent initializes its
    // builtin tools (the Skill tool only registers when the shared session
    // skill registry has model-invocable skills).
    session.skills.registerBuiltinSkill({
      name: 'demo-skill',
      description: 'Demo skill for e2e',
      path: '/skills/demo-skill/SKILL.md',
      dir: '/skills/demo-skill',
      content: 'Demo skill body for the e2e check.',
      metadata: {},
      source: 'builtin',
    });

    const steps: StepRecord[] = [];
    const mainProfile: ResolvedAgentProfile = {
      name: 'agent',
      systemPrompt: () => '<system-prompt>',
      tools: [],
    };
    const { agent: mainAgent } = await session.createAgent(
      { type: 'main', generate: createVerifyGenerate(steps) },
      { profile: mainProfile },
    );
    mainAgent.config.update({ modelAlias: MOCK_PROVIDER.model, thinkingEffort: 'off' });
    mainAgent.permission.setMode('auto');

    const handle = await mainAgent.subagentHost!.spawn({
      profileName: 'coder',
      parentToolCallId: 'e2e-agent-call',
      prompt: 'Verify the newly aligned coder tools work end to end.',
      description: 'verify coder tools',
      runInBackground: false,
      signal: new AbortController().signal,
    });

    const completion = await handle.completion;
    expect(completion.result).toContain('E2E-CODER-DONE');

    // The child's first request must carry the new tools on the wire.
    const firstCallTools = steps[0]?.wireTools ?? [];
    for (const expected of [
      'Agent',
      'AgentSwarm',
      'Bash',
      'Edit',
      'EnterPlanMode',
      'ExitPlanMode',
      'Glob',
      'Grep',
      'Read',
      'Skill',
      'TaskList',
      'TaskOutput',
      'TaskStop',
      'TodoList',
      'Write',
    ]) {
      expect(firstCallTools, `wire tools should include ${expected}`).toContain(expected);
    }
    // Cron tools stay declared-but-not-delivered for sub agents (v2 parity).
    expect(firstCallTools).not.toContain('CronCreate');
    expect(firstCallTools).not.toContain('CreateGoal');

    const byStep = (n: number) => steps.find((record) => record.label === `step-${String(n)}`);
    const taskId = /task_id: (\S+)/.exec(byStep(4)?.prevToolOutput ?? '')?.[1] ?? '';

    expect(byStep(2)?.prevToolOutput).toContain('Skill "demo-skill" loaded inline');
    expect(byStep(3)?.prevToolOutput).toContain('verify-tools-e2e');
    expect(byStep(4)?.prevToolOutput).toContain('task_id:');
    expect(taskId).not.toBe('');
    expect(byStep(5)?.prevToolOutput).toContain(taskId);
    expect(byStep(6)?.prevToolIsError).toBe(false);
    expect(byStep(7)?.prevToolIsError).toBe(false);
    expect(byStep(8)?.prevToolOutput).toContain('Plan file:');
    expect(byStep(9)?.prevToolIsError).toBe(false);
    expect(byStep(10)?.prevToolOutput).toContain('Exited plan mode');
    expect(byStep(11)?.prevToolOutput).toContain('NESTED-EXPLORE-OK');
    expect(byStep(12)?.prevToolOutput).toContain('SWARM-CHILD-OK');

    for (const record of steps) {
      expect(record.prevToolIsError, `${record.label} saw an error tool result`).toBe(false);
    }
  }, 30_000);

  it('blocks completion until the child background bash task settles', async () => {
    const scripted = createScriptedGenerate();
    scripted.mockNextResponse({
      type: 'function',
      id: 'c1',
      name: 'Bash',
      arguments: JSON.stringify({ command: 'sleep 2', description: 'drain probe', run_in_background: true }),
    });
    scripted.mockNextResponse({ type: 'text', text: DRAIN_FINAL_TEXT });
    const { session, mainAgent } = await createCoderSession(scripted.generate);

    const handle = await mainAgent.subagentHost!.spawn({
      profileName: 'coder',
      parentToolCallId: 'e2e-drain-call',
      prompt: 'Start a short background sleep, then finish without waiting for it.',
      description: 'drain check',
      runInBackground: false,
      signal: new AbortController().signal,
    });

    // The model turn ends almost immediately; completion must still be held
    // by the background-task drain until the sleep exits (~2s).
    const early = await Promise.race([
      handle.completion.then(() => 'resolved' as const),
      delay(1_200).then(() => 'pending' as const),
    ]);
    expect(early).toBe('pending');

    const completion = await handle.completion;
    expect(completion.result).toContain('DRAIN-CHECK-DONE');

    const child = await session.ensureAgentResumed(handle.agentId);
    // The task settled before completion, and the drain suppressed its
    // terminal notification — no orphan turn, no <notification> in context.
    expect(child.background.list(true)).toHaveLength(0);
    const settled = child.background.list(false);
    expect(settled.length).toBeGreaterThan(0);
    for (const task of settled) {
      expect(isBackgroundTaskTerminal(task.status)).toBe(true);
    }
    expect(child.turn.hasActiveTurn).toBe(false);
    expect(JSON.stringify(child.context.history)).not.toContain('<notification ');
  }, 30_000);

  it('aborting the run during the background drain rejects the completion', async () => {
    const scripted = createScriptedGenerate();
    scripted.mockNextResponse({
      type: 'function',
      id: 'c1',
      name: 'Bash',
      arguments: JSON.stringify({ command: 'sleep 30', description: 'drain cancel probe', run_in_background: true }),
    });
    scripted.mockNextResponse({ type: 'text', text: DRAIN_FINAL_TEXT });
    const { mainAgent } = await createCoderSession(scripted.generate);

    const controller = new AbortController();
    const handle = await mainAgent.subagentHost!.spawn({
      profileName: 'coder',
      parentToolCallId: 'e2e-drain-cancel-call',
      prompt: 'Start a long background sleep, then finish without waiting for it.',
      description: 'drain cancel check',
      runInBackground: false,
      signal: controller.signal,
    });

    // Both scripted LLM calls consumed ⇒ the turn has finished and the run
    // is now held open only by the background-task drain.
    const deadline = Date.now() + 5_000;
    while (scripted.calls.length < 2 && Date.now() < deadline) {
      await delay(25);
    }
    expect(scripted.calls.length).toBe(2);
    await delay(300);
    controller.abort();

    await expect(handle.completion).rejects.toThrow(/abort/i);
  }, 30_000);

  it('completes cleanly when the background task settles before the final turn ends', async () => {
    const scripted = createScriptedGenerate();
    // The background task settles while the turn is still running: its
    // terminal notification is delivered into the active turn (the
    // legitimate path), so the drain afterwards has nothing to wait for
    // and must not launch or leak a follow-up turn either.
    scripted.mockNextResponse({
      type: 'function',
      id: 'c1',
      name: 'Bash',
      arguments: JSON.stringify({ command: 'sleep 0.2', description: 'early settle probe', run_in_background: true }),
    });
    scripted.mockNextResponse({
      type: 'function',
      id: 'c2',
      name: 'Bash',
      arguments: JSON.stringify({ command: 'sleep 1' }),
    });
    scripted.mockNextResponse({ type: 'text', text: DRAIN_FINAL_TEXT });
    const { session, mainAgent } = await createCoderSession(scripted.generate);

    const handle = await mainAgent.subagentHost!.spawn({
      profileName: 'coder',
      parentToolCallId: 'e2e-early-settle-call',
      prompt: 'Start a quick background sleep, keep working briefly, then finish.',
      description: 'early settle check',
      runInBackground: false,
      signal: new AbortController().signal,
    });

    const completion = await handle.completion;
    expect(completion.result).toContain('DRAIN-CHECK-DONE');

    const child = await session.ensureAgentResumed(handle.agentId);
    expect(child.background.list(true)).toHaveLength(0);
    expect(child.turn.hasActiveTurn).toBe(false);
    // The task settled mid-turn, so its notification was delivered into the
    // turn (visible in context) rather than orphaned after completion.
    expect(JSON.stringify(child.context.history)).toContain('<notification ');
  }, 30_000);
});
