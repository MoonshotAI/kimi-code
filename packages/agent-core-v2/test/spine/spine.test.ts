import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MASTER_ENV } from '#/app/flag/flagService';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';
import { ACCEPTED_OUTPUT, toControlResult } from '#/agent/spine/tools/controlResult';
import { SPINE_BRANCH_LABEL } from '#/agent/spine/tools/gate';
import { SPINE_SPAWN_SECTION } from '#/agent/spine/configSection';
import { SPINE_FLAG_ID } from '#/agent/spine/flag';
import { SpineCloseTool } from '#/agent/spine/tools/spine-close';
import { SpineNextTool } from '#/agent/spine/tools/spine-next';
import { SpineOpenTool } from '#/agent/spine/tools/spine-open';
import { SpineSpawnTool } from '#/agent/spine/tools/spine-spawn';
import { SpineTreeTool } from '#/agent/spine/tools/spine-tree';
import { SpineTrimTool } from '#/agent/spine/tools/spine-trim';
import { agentContextOf, IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { getAgentToolContributions } from '#/agent/toolRegistry/toolContribution';
import type { ServicesAccessor } from '#/_base/di/instantiation';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  IAgentSpineService,
  PlanModeEnter,
  PlanModeExit,
} from '#/index';
import type { Message } from '#/kosong/contract/message';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionSubagentService, type AgentRunHandle } from '#/session/subagent/subagent';

import {
  createCommandRunner,
  execEnvServices,
  sessionService,
  testAgent,
  type TestAgentContext,
  type TestAgentOptions,
} from '../harness';

const SPINE_ENV = 'KIMI_CODE_SPINE';

const CATALOGUED_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'kimi-code',
  baseUrl: 'http://127.0.0.1',
} as const;
const CATALOGUED_MODEL_CAPABILITIES = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;

async function configureLoop(ctx: TestAgentContext): Promise<void> {
  ctx.configure({
    provider: CATALOGUED_PROVIDER,
    modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
  });
  await ctx.rpc.setPermission({ mode: 'yolo' });
}

function recordingHostFs() {
  const writes = new Map<string, string>();
  return {
    writes,
    fs: {
      writeText: async (path: string, data: string) => {
        writes.set(path, data);
      },
      mkdir: async () => {},
    },
  };
}

function loopContext(): TestAgentContext {
  return testAgent(execEnvServices({ hostFs: recordingHostFs().fs }));
}


describe('Spine control tools', () => {
  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(SPINE_ENV, '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('registers the four core spine tools when enabled', () => {
    const ctx = testAgent();
    const names = spineToolNames(ctx);
    expect(names).toEqual(
      expect.arrayContaining(['spine_open', 'spine_close', 'spine_next', 'spine_tree']),
    );
    expect(names).toHaveLength(4);
  });

  it('registers spine_spawn when the spawn flag is also on', () => {
    vi.stubEnv('KIMI_CODE_SPINE_SPAWN', '1');
    const ctx = testAgent();
    expect(spineToolNames(ctx)).toContain('spine_spawn');
  });

  it('does not register spine_spawn without the spawn flag', () => {
    const ctx = testAgent();
    expect(spineToolNames(ctx)).not.toContain('spine_spawn');
  });

  it('registers spine_trim when the trim flag is also on', () => {
    vi.stubEnv('KIMI_CODE_SPINE_TRIM', '1');
    const ctx = testAgent();
    expect(spineToolNames(ctx)).toContain('spine_trim');
  });

  it('registers spine_trim standalone with the spine flag off', () => {
    vi.stubEnv(SPINE_ENV, '0');
    vi.stubEnv('KIMI_CODE_SPINE_TRIM', '1');
    const ctx = testAgent();
    const names = spineToolNames(ctx);
    expect(names).toContain('spine_trim');
    expect(names).not.toContain('spine_open');
  });

  it('does not register spine_trim without the trim flag', () => {
    const ctx = testAgent();
    expect(spineToolNames(ctx)).not.toContain('spine_trim');
  });

  it('default agent profile whitelists the spine tools', () => {
    const ctx = testAgent();
    const profile = ctx.get(ISessionAgentProfileCatalog).getDefault();
    expect(profile.tools).toEqual(
      expect.arrayContaining(['spine_open', 'spine_close', 'spine_next', 'spine_tree', 'spine_trim', 'spine_spawn']),
    );
  });

  it('keeps spine tools active under a whitelist that lists them', () => {
    const ctx = testAgent();
    ctx.configure({
      tools: ['Read', 'spine_open', 'spine_close', 'spine_next', 'spine_tree', 'spine_trim', 'spine_spawn'],
    });
    const spine = ctx.toolsData().filter((tool) => tool.name.startsWith('spine_'));
    expect(spine).toHaveLength(4);
    expect(spine.every((tool) => tool.active)).toBe(true);
  });

  it('a whitelist omitting spine names filters them out of the request', () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['Read'] });
    const spine = ctx.toolsData().filter((tool) => tool.name.startsWith('spine_'));
    expect(spine).toHaveLength(4);
    expect(spine.some((tool) => tool.active)).toBe(false);
  });

  it('does not register spine tools when disabled', () => {
    vi.stubEnv(SPINE_ENV, '0');
    const ctx = testAgent();
    expect(spineToolNames(ctx)).toHaveLength(0);
  });

  it('commits open then close across steps via the loop', async () => {
    const ctx = loopContext();
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(toolCallPart('call_close', 'spine_close', { memory: 'did A' }));
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const state = readSpine(ctx);
    expect(state.nodes['1.1.1']?.summary).toBe('task A');
    expect(state.nodes['1.1.1']?.closedAt).toBeDefined();
    expect(state.nodes['1.1.1']?.memory).toBe('did A');
    expect(state.openStack).toEqual(['1', '1.1']);
  });

  function textOf(message: ContextMessage | undefined): string {
    return (message?.content ?? [])
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('');
  }

  it('vetoes spine_spawn mixed with a control call in one response', async () => {
    vi.stubEnv('KIMI_CODE_SPINE_SPAWN', '1');
    const ctx = loopContext();
    await configureLoop(ctx);
    ctx.mockNextResponse(
      toolCallPart('call_open', 'spine_open', { summary: 'task A' }),
      toolCallPart('call_spawn', 'spine_spawn', {
        tasks: [
          { summary: 'branch A', prompt: 'do A' },
          { summary: 'branch B', prompt: 'do B' },
        ],
      }),
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const messages = ctx.get(IAgentContextMemoryService).get();
    const openResult = messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_open');
    const spawnResult = messages.find((m) => m.role === 'tool' && m.toolCallId === 'call_spawn');
    expect(spawnResult?.isError).toBe(true);
    expect(textOf(spawnResult)).toContain(
      'spine_spawn cannot be mixed with spine_open, spine_close, or spine_next',
    );
    expect(openResult?.isError).not.toBe(true);
    expect(textOf(openResult)).toBe(ACCEPTED_OUTPUT);
    const state = readSpine(ctx);
    expect(state.openStack).toEqual(['1', '1.1']);
    expect(state.nodes['1.1.1']).toBeUndefined();
  });

  it('vetoes a second spine_spawn in one response', async () => {
    vi.stubEnv('KIMI_CODE_SPINE_SPAWN', '1');
    const ctx = loopContext();
    await configureLoop(ctx);
    ctx.mockNextResponse(
      toolCallPart('call_spawn_1', 'spine_spawn', {
        tasks: [
          { summary: 'branch A', prompt: 'do A' },
          { summary: 'branch B', prompt: 'do B' },
        ],
      }),
      toolCallPart('call_spawn_2', 'spine_spawn', {
        tasks: [
          { summary: 'branch C', prompt: 'do C' },
          { summary: 'branch D', prompt: 'do D' },
        ],
      }),
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const messages = ctx.get(IAgentContextMemoryService).get();
    const results = messages.filter(
      (m) =>
        m.role === 'tool' &&
        (m.toolCallId === 'call_spawn_1' || m.toolCallId === 'call_spawn_2'),
    );
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(
        'spine_spawn may be called at most once in one model response',
      );
    }
    expect(readSpine(ctx).nodes['1.1.1']).toBeUndefined();
  });

  it('commits a spine transition after an undo shrank the history', async () => {
    const ctx = loopContext();
    await configureLoop(ctx);
    for (let i = 0; i < 3; i++) ctx.appendExchange(i + 1, `seed u${i}`, `seed a${i}`, 100);
    ctx.mockNextResponse(toolCallPart('call_open_1', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();
    expect(readSpine(ctx).nodes['1.1.1']?.summary).toBe('task A');

    ctx.mockNextResponse({ type: 'text', text: 'work' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'work a bit' }] });
    await ctx.untilTurnEnd();
    await ctx.rpc.undoHistory({ count: 1 });

    ctx.mockNextResponse(toolCallPart('call_open_2', 'spine_open', { summary: 'task B' }));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });
    await ctx.untilTurnEnd();

    const state = readSpine(ctx);
    expect(state.nodes['1.1.1.1']?.summary).toBe('task B');
    expect(state.openStack).toEqual(['1', '1.1', '1.1.1', '1.1.1.1']);
  });

  it('reopens a closed span when an undo truncates its close evidence', async () => {
    let lastRequestText = '';
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      lastRequestText = historyText(history);
      return textResult('answer');
    };
    const ctx = testAgent(execEnvServices({ hostFs: recordingHostFs().fs }), { generate });
    await configureLoop(ctx);
    ctx.appendExchange(1, 'u0', 'a0', 100);
    ctx.context.append(assistantSpineCall('call_open', 'spine_open', { summary: 'old work' }));
    ctx.context.append(spineReceipt('call_open'));
    for (let i = 1; i < 4; i++) ctx.appendExchange(i + 1, `u${String(i)}`, `a${String(i)}`, 100);
    ctx.context.append(assistantSpineCall('call_close', 'spine_close', { memory: 'old memory' }));
    ctx.context.append(spineReceipt('call_close'));
    for (let i = 4; i < 10; i++) ctx.appendExchange(i + 1, `u${String(i)}`, `a${String(i)}`, 100);

    await ctx.rpc.undoHistory({ count: 7 });
    expect(readSpine(ctx).nodes['1.1.1']?.closedAt).toBeUndefined();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'FRESH-PROMPT-MARKER' }] });
    await ctx.untilTurnEnd();

    expect(lastRequestText).toContain('FRESH-PROMPT-MARKER');
    expect(lastRequestText).toContain('u1');
    expect(lastRequestText).not.toContain('old memory');
  });

  it('keeps the rebuilt history visible after /clear', async () => {
    let lastRequestText = '';
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      lastRequestText = historyText(history);
      return textResult('answer');
    };
    const ctx = testAgent(execEnvServices({ hostFs: recordingHostFs().fs }), { generate });
    await configureLoop(ctx);
    for (let i = 0; i < 11; i++) ctx.appendExchange(i + 1, `u${String(i)}`, `a${String(i)}`, 100);

    await ctx.rpc.clearContext({});

    const state = readSpine(ctx);
    expect(state.rootEpoch).toBe(1);
    expect(state.epochStartAt).toBe(0);
    expect(state.epochMemoryAt).toBeUndefined();
    expect(state.nodes['2']).toBeUndefined();

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'AFTER-CLEAR-MARKER' }] });
    await ctx.untilTurnEnd();

    expect(lastRequestText).toContain('AFTER-CLEAR-MARKER');
  });

  it('folds a closed startup node memory into the next projection', async () => {
    const ctx = loopContext();
    await configureLoop(ctx);
    ctx.mockNextResponse(
      toolCallPart('call_close', 'spine_close', { memory: 'STARTUP-MEMORY-MARKER' }),
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'STARTUP-PHASE-PROMPT' }] });
    await ctx.untilTurnEnd();

    ctx.mockNextResponse({ type: 'text', text: 'answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'AFTER-STARTUP-CLOSE' }] });
    await ctx.untilTurnEnd();

    const projected = historyText(ctx.project());
    expect(projected).toContain('<spine_memory node_id="1.1">');
    expect(projected).toContain('STARTUP-MEMORY-MARKER');
    expect(projected).toContain('[U1] STARTUP-PHASE-PROMPT');
    expect(projected).not.toContain('## User Message');
    expect(projected).toContain('AFTER-STARTUP-CLOSE');
  });

  it('stores the closing memory verbatim and keeps span requests in place', async () => {
    const ctx = loopContext();
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse({ type: 'text', text: 'working' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start the work' }] });
    await ctx.untilTurnEnd();

    ctx.mockNextResponse(
      toolCallPart('call_close', 'spine_close', { memory: 'did A per [U2]' }),
    );
    ctx.mockNextResponse({ type: 'text', text: 'finished' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'MID-SPAN-REQUEST' }] });
    await ctx.untilTurnEnd();

    const memory = readSpine(ctx).nodes['1.1.1']?.memory ?? '';
    expect(memory).toBe('did A per [U2]');

    const projected = historyText(ctx.project());
    expect(projected).toContain('[U2] MID-SPAN-REQUEST');
    expect(projected).toContain('<spine_memory node_id="1.1.1">\ndid A per [U2]\n</spine_memory>');
    expect(projected).not.toContain('## User Message');
  });

  it('keeps [U#] anchors stable when a span folds', async () => {
    let lastRequestText = '';
    const generate: GenerateFn = async (_provider, _system, _tools, history) => {
      lastRequestText = historyText(history);
      return textResult('answer');
    };
    const ctx = testAgent(execEnvServices({ hostFs: recordingHostFs().fs }), { generate });
    await configureLoop(ctx);
    ctx.appendExchange(1, 'seed-u0', 'seed-a0', 100);
    ctx.context.append(assistantSpineCall('call_open', 'spine_open', { summary: 'old work' }));
    ctx.context.append(spineReceipt('call_open'));
    ctx.appendExchange(2, 'seed-u1', 'seed-a1', 100);
    ctx.context.append(assistantSpineCall('call_close', 'spine_close', { memory: 'old memory' }));
    ctx.context.append(spineReceipt('call_close'));
    ctx.appendExchange(3, 'seed-u2', 'seed-a2', 100);
    ctx.appendExchange(4, 'seed-u3', 'seed-a3', 100);
    ctx.appendExchange(5, 'seed-u4', 'seed-a4', 100);

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'NUMBER-CHECK-PROMPT' }] });
    await ctx.untilTurnEnd();

    expect(lastRequestText).toContain('[U1] seed-u0');
    expect(lastRequestText).toContain('[U4] seed-u3');
    expect(lastRequestText).toContain('[U6] NUMBER-CHECK-PROMPT');
    expect(lastRequestText).toContain('old memory');
    expect(lastRequestText).toContain('[U2] seed-u1');
    expect(lastRequestText).toContain('<spine_memory node_id="1.1.1">');
  });

  it('commits next atomically across a single step', async () => {
    const ctx = loopContext();
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(
      toolCallPart('call_next', 'spine_next', { summary: 'task B', memory: 'did A' }),
    );
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const state = readSpine(ctx);
    expect(state.nodes['1.1.1']?.memory).toBe('did A');
    expect(state.nodes['1.1.2']?.summary).toBe('task B');
    expect(state.openStack.at(-1)).toBe('1.1.2');
  });

  it('keeps batched tool results visible and paired after a close', async () => {
    const rec = recordingHostFs();
    const ctx = testAgent(
      execEnvServices({
        hostFs: rec.fs,
        processRunner: createCommandRunner('ORDINARY-RESULT-MARKER'),
      }),
    );
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(
      toolCallPart('call_bash', 'Bash', { command: 'true', description: 'noop' }),
      toolCallPart('call_close', 'spine_close', { memory: 'did A' }),
    );
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const history = ctx.context.get();
    const carrierIndex = history.findIndex(
      (m) => m.role === 'assistant' && m.toolCalls.some((call) => call.id === 'call_close'),
    );
    expect(carrierIndex).toBeGreaterThan(0);
    expect(readSpine(ctx).nodes['1.1.1']?.closedAt).toBe(carrierIndex - 1);

    const folded = ctx.get(IAgentSpineService).fold(history) as readonly ContextMessage[];
    expect(folded.some((m) => m.role === 'tool' && m.toolCallId === 'call_bash')).toBe(true);
    expect(folded.some((m) => m.role === 'tool' && m.toolCallId === 'call_close')).toBe(true);
    expect(toolPairingGaps(folded)).toEqual([]);

    expect(historyText(ctx.project())).toContain('ORDINARY-RESULT-MARKER');

    const archive = [...rec.writes.values()].join('\n');
    expect(archive).toContain('did A');
    expect(archive).not.toContain('call_bash');
    expect(archive).not.toContain('call_close');
  });

  it('hands the transition carrier to the new sibling span on next', async () => {
    const ctx = testAgent(
      execEnvServices({
        hostFs: recordingHostFs().fs,
        processRunner: createCommandRunner('ORDINARY-RESULT-MARKER'),
      }),
    );
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(
      toolCallPart('call_bash', 'Bash', { command: 'true', description: 'noop' }),
      toolCallPart('call_next', 'spine_next', { summary: 'task B', memory: 'did A' }),
    );
    ctx.mockNextResponse(toolCallPart('call_close_b', 'spine_close', { memory: 'did B' }));
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const history = ctx.context.get();
    const carrierIndex = history.findIndex(
      (m) => m.role === 'assistant' && m.toolCalls.some((call) => call.id === 'call_next'),
    );
    const state = readSpine(ctx);
    expect(state.nodes['1.1.1']?.closedAt).toBe(carrierIndex - 1);
    expect(state.nodes['1.1.2']?.openedAt).toBe(carrierIndex);

    const folded = ctx.get(IAgentSpineService).fold(history) as readonly ContextMessage[];
    expect(folded.some((m) => m.role === 'tool' && m.toolCallId === 'call_bash')).toBe(false);
    expect(toolPairingGaps(folded)).toEqual([]);
    const memories = folded.filter((m) => textOf(m).startsWith('<spine_memory node_id="'));
    expect(memories).toHaveLength(2);
    expect(historyText(ctx.project())).not.toContain('ORDINARY-RESULT-MARKER');
  });

  it('applies neither control when one response carries two (silent void)', async () => {
    const ctx = loopContext();
    await configureLoop(ctx);
    ctx.mockNextResponse(
      toolCallPart('call_open_1', 'spine_open', { summary: 'task A' }),
      toolCallPart('call_open_2', 'spine_open', { summary: 'task B' }),
    );
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const state = readSpine(ctx);
    expect(state.openStack).toEqual(['1', '1.1']);
    expect(state.nodes['1.1.1']).toBeUndefined();

    const receipts = ctx.context
      .get()
      .filter(
        (m) =>
          m.role === 'tool' &&
          (m.toolCallId === 'call_open_1' || m.toolCallId === 'call_open_2'),
      );
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      expect(receipt.isError).not.toBe(true);
    }
  });

  it('accepts close memory that references an unknown [U#] anchor', async () => {
    const ctx = loopContext();
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(
      toolCallPart('call_close', 'spine_close', { memory: 'wrapped up per [U9]' }),
    );
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const state = readSpine(ctx);
    expect(state.nodes['1.1.1']?.closedAt).toBeDefined();
    const receipt = ctx.context.get().find((m) => m.role === 'tool' && m.toolCallId === 'call_close');
    expect(receipt?.isError).not.toBe(true);
  });

  it('accepts close memory that references an existing [U#] anchor', async () => {
    const ctx = loopContext();
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(
      toolCallPart('call_close', 'spine_close', { memory: 'wrapped up per [U1]' }),
    );
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const state = readSpine(ctx);
    expect(state.nodes['1.1.1']?.closedAt).toBeDefined();
    expect(state.nodes['1.1.1']?.memory).toContain('wrapped up per [U1]');
  });

  it('accepts next memory that references an unknown [U#] anchor', async () => {
    const ctx = loopContext();
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(
      toolCallPart('call_next', 'spine_next', { summary: 'task B', memory: 'did A per [U7]' }),
    );
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const state = readSpine(ctx);
    expect(state.nodes['1.1.1']?.closedAt).toBeDefined();
    expect(state.nodes['1.1.2']?.summary).toBe('task B');
    const receipt = ctx.context.get().find((m) => m.role === 'tool' && m.toolCallId === 'call_next');
    expect(receipt?.isError).not.toBe(true);
  });

  it('renders the current tree through spine.tree', async () => {
    const ctx = loopContext();
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(toolCallPart('call_tree', 'spine_tree', {}));
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const treeMessage = ctx.context
      .get()
      .find((m) => m.role === 'tool' && m.toolCallId === 'call_tree');
    const output = textOf(treeMessage);
    expect(output).toContain('1.1.1');
    expect(output).toContain('task A');
    expect(output).toContain('cursor');
  });

  it('maps an accepted transition to the delayed-commit receipt', () => {
    const result = toControlResult({ accepted: true });
    expect(result.isError).toBe(false);
    expect(result.output).toBe(ACCEPTED_OUTPUT);
    expect(result.output).toMatch(/^accepted/);
    expect(result.output).toContain('commit');
  });

  it('returns the delayed-commit receipt as the tool output of an accepted open', async () => {
    const ctx = loopContext();
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const receipt = ctx.context.get().find((m) => m.role === 'tool' && m.toolCallId === 'call_open');
    expect(receipt?.isError).not.toBe(true);
    expect(textOf(receipt)).toBe(ACCEPTED_OUTPUT);
  });
});

describe('Spine durability', () => {
  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(SPINE_ENV, '1');
  });
  afterEach(() => {
    resetUnexpectedErrorHandler();
    vi.unstubAllEnvs();
  });

  it('closes the node, marks its memory, and reports when the archive write fails', async () => {
    const reported: unknown[] = [];
    setUnexpectedErrorHandler((err) => {
      reported.push(err);
    });
    const failingHostFs = {
      writeText: async () => {
        throw new Error('disk full');
      },
      mkdir: async () => {},
    };
    const ctx = testAgent(execEnvServices({ hostFs: failingHostFs }));
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('call_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(toolCallPart('call_close', 'spine_close', { memory: 'did A' }));
    ctx.mockNextResponse({ type: 'text', text: 'finished' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    const node = readSpine(ctx).nodes['1.1.1'];
    expect(node?.closedAt).toBeDefined();
    expect(node?.archivePath).toBeUndefined();
    expect(node?.memory).toContain('could not be written');
    expect(reported.some((err) => String(err).includes('disk full'))).toBe(true);
  });

});

describe('spine control tool host gating', () => {
  const controlTools = [
    ['spine_open', SpineOpenTool],
    ['spine_close', SpineCloseTool],
    ['spine_next', SpineNextTool],
  ] as const;
  const mainOnlyTools = [
    ['spine_tree', SpineTreeTool],
    ['spine_trim', SpineTrimTool],
    ['spine_spawn', SpineSpawnTool],
  ] as const;

  function accessorFor(
    agentId: string,
    flags: { spine: boolean; trim: boolean; spawn: boolean },
    maxThreads?: number,
    labels: Record<string, string> = {},
  ): ServicesAccessor {
    const scopeContext: IAgentScopeContext = makeAgentScopeContext({
      agentId,
      agentScope: '',
      labels,
    });
    const flagService = {
      enabled: (id: string) => {
        if (id === SPINE_FLAG_ID) return flags.spine;
        if (id === 'spine_trim') return flags.trim;
        if (id === 'spine_spawn') return flags.spawn;
        return false;
      },
    } as unknown as IFlagService;
    const configService = {
      get: (domain: string) =>
        domain === SPINE_SPAWN_SECTION && maxThreads !== undefined
          ? { maxConcurrentThreadsPerSession: maxThreads }
          : undefined,
    } as unknown as IConfigService;
    return {
      get: (id: unknown) => {
        if (id === IAgentScopeContext) return scopeContext;
        if (id === IFlagService) return flagService;
        if (id === IConfigService) return configService;
        throw new Error(`unexpected service identifier: ${String(id)}`);
      },
    } as unknown as ServicesAccessor;
  }

  const branchLabels = { [SPINE_BRANCH_LABEL]: 'true' };

  it.each(controlTools)('%s registers on the main agent and on spawned branches', (name, ctor) => {
    const contribution = getAgentToolContributions().find((c) => c.ctor === ctor);
    expect(contribution, `${name} contribution`).toBeDefined();
    const when = contribution?.options.when;
    expect(when, `${name} must gate on the spine flag + control-host identity`).toBeDefined();
    expect(when?.(accessorFor('main', { spine: true, trim: false, spawn: false }))).toBe(true);
    expect(when?.(accessorFor('sub-1', { spine: true, trim: false, spawn: false }))).toBe(false);
    expect(
      when?.(accessorFor('sub-1', { spine: true, trim: false, spawn: false }, undefined, branchLabels)),
    ).toBe(true);
    expect(
      when?.(accessorFor('sub-1', { spine: false, trim: false, spawn: false }, undefined, branchLabels)),
    ).toBe(false);
  });

  it.each(mainOnlyTools)('%s registers only on the main agent with the required flags', (name, ctor) => {
    const contribution = getAgentToolContributions().find((c) => c.ctor === ctor);
    expect(contribution, `${name} contribution`).toBeDefined();
    const when = contribution?.options.when;
    expect(when, `${name} must gate on flags + main-agent identity`).toBeDefined();
    const needsSpawn = name === 'spine_spawn';
    const needsTrim = name === 'spine_trim';
    expect(when?.(accessorFor('main', { spine: true, trim: needsTrim, spawn: needsSpawn }))).toBe(true);
    expect(when?.(accessorFor('sub-1', { spine: true, trim: needsTrim, spawn: needsSpawn }))).toBe(false);
    expect(
      when?.(accessorFor('sub-1', { spine: true, trim: needsTrim, spawn: needsSpawn }, undefined, branchLabels)),
    ).toBe(false);
    expect(when?.(accessorFor('main', { spine: false, trim: needsTrim, spawn: needsSpawn }))).toBe(
      needsTrim,
    );
  });

  it('spine_spawn requires capacity for at least two branches', () => {
    const contribution = getAgentToolContributions().find((c) => c.ctor === SpineSpawnTool);
    const when = contribution?.options.when;
    expect(when?.(accessorFor('main', { spine: true, trim: false, spawn: true }, 2))).toBe(false);
  });
});

function readSpine(ctx: TestAgentContext) {
  return ctx.get(IAgentSpineService).currentState();
}

describe('Spine derivation basics', () => {
  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(SPINE_ENV, '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('starts with an open root epoch and startup node', () => {
    const ctx = testAgent();
    const state = ctx.get(IAgentSpineService).currentState();
    expect(state.rootEpoch).toBe(1);
    expect(state.openStack).toEqual(['1', '1.1']);
    expect(state.nodes['1']?.children).toEqual(['1.1']);
    expect(state.nodes['1.1']?.closedAt).toBeUndefined();
  });

  it('rejects closing the root epoch', () => {
    const ctx = testAgent();
    const spine = ctx.get(IAgentSpineService);
    expect(spine.acceptClose('startup done').accepted).toBe(true);
    ctx.context.append({
      role: 'assistant',
      content: [{ type: 'text', text: 'calling spine_close' }],
      toolCalls: [
        {
          type: 'function',
          id: 'close_1.1',
          name: 'spine_close',
          arguments: JSON.stringify({ memory: 'startup done' }),
        },
      ],
    });
    ctx.context.append({
      role: 'tool',
      content: [{ type: 'text', text: ACCEPTED_OUTPUT }],
      toolCalls: [],
      toolCallId: 'close_1.1',
    });
    const rejected = spine.acceptClose('nope');
    expect(rejected.accepted).toBe(false);
  });
});

describe('Spine plan-mode gating', () => {
  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(SPINE_ENV, '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects open / close / next in plan mode', async () => {
    const ctx = testAgent();
    const spine = ctx.get(IAgentSpineService);
    await ctx.dispatcher.dispatch(new PlanModeEnter({ agentId: 'main', id: 'plan-1' }));
    for (const result of [
      spine.acceptOpen('task A'),
      spine.acceptClose('memory'),
      spine.acceptNext('sibling', 'memory'),
    ]) {
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.reason).toContain('Spine transitions are not allowed in Plan mode');
      }
    }
  });

  it('rejects spawn in plan mode', async () => {
    vi.stubEnv('KIMI_CODE_SPINE_SPAWN', '1');
    const ctx = testAgent();
    const spine = ctx.get(IAgentSpineService);
    await ctx.dispatcher.dispatch(new PlanModeEnter({ agentId: 'main', id: 'plan-1' }));
    const result = await spine.executeSpawn(
      [
        { summary: 'branch A', prompt: 'do A' },
        { summary: 'branch B', prompt: 'do B' },
      ],
      new AbortController().signal,
    );
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toContain('Spine transitions are not allowed in Plan mode');
    }
  });

  it('rejects trim in plan mode', async () => {
    vi.stubEnv('KIMI_CODE_SPINE_TRIM', '1');
    const ctx = testAgent();
    const spine = ctx.get(IAgentSpineService);
    await ctx.dispatcher.dispatch(new PlanModeEnter({ agentId: 'main', id: 'plan-1' }));
    const result = spine.acceptTrim('trim_1', { kind: 'snip' });
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toContain('Spine transitions are not allowed in Plan mode');
    }
  });

  it('accepts transitions again after plan mode exits', async () => {
    const ctx = testAgent();
    const spine = ctx.get(IAgentSpineService);
    await ctx.dispatcher.dispatch(new PlanModeEnter({ agentId: 'main', id: 'plan-1' }));
    await ctx.dispatcher.dispatch(new PlanModeExit({ agentId: 'main', id: 'plan-1' }));
    expect(spine.acceptOpen('task A').accepted).toBe(true);
  });
});

describe('Spine carrier-group classification', () => {
  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(SPINE_ENV, '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function assistantCarrier(
    calls: ReadonlyArray<readonly [string, string, Record<string, unknown>]>,
  ): ContextMessage {
    return {
      role: 'assistant',
      content: [{ type: 'text', text: 'calling spine tools' }],
      toolCalls: calls.map(([id, name, args]) => ({
        type: 'function' as const,
        id,
        name,
        arguments: JSON.stringify(args),
      })),
    };
  }

  function errorReceipt(toolCallId: string, output: string): ContextMessage {
    return {
      role: 'tool',
      content: [{ type: 'text', text: output }],
      toolCalls: [],
      toolCallId,
      isError: true,
    } as ContextMessage;
  }

  it('applies nothing when one response carries two accepted control calls', () => {
    const ctx = testAgent();
    ctx.get(IAgentContextMemoryService).append(
      assistantCarrier([
        ['call_open', 'spine_open', { summary: 'task A' }],
        ['call_close', 'spine_close', { memory: 'did A' }],
      ]),
      spineReceipt('call_open'),
      spineReceipt('call_close'),
    );
    const state = readSpine(ctx);
    expect(state.openStack).toEqual(['1', '1.1']);
    expect(state.nodes['1.1.1']).toBeUndefined();
  });

  it('applies the lone accepted control when its sibling control failed', () => {
    const ctx = testAgent();
    ctx.get(IAgentContextMemoryService).append(
      assistantCarrier([
        ['call_open', 'spine_open', { summary: 'task A' }],
        ['call_close', 'spine_close', { memory: 'did A' }],
      ]),
      spineReceipt('call_open'),
      errorReceipt('call_close', 'close rejected'),
    );
    const state = readSpine(ctx);
    expect(state.nodes['1.1.1']?.summary).toBe('task A');
    expect(state.openStack).toEqual(['1', '1.1', '1.1.1']);
  });

  it('voids spawn nodes and the control when one response mixes them', () => {
    const ctx = testAgent();
    const receipt = JSON.stringify({
      schema: 'spine.spawn.result.v1',
      results: [
        { ordinal: 0, outcome: 'completed', memory_body: 'memory A' },
        { ordinal: 1, outcome: 'completed', memory_body: 'memory B' },
      ],
    });
    ctx.get(IAgentContextMemoryService).append(
      assistantCarrier([
        [
          'call_spawn',
          'spine_spawn',
          {
            tasks: [
              { summary: 'branch A', prompt: 'do A' },
              { summary: 'branch B', prompt: 'do B' },
            ],
          },
        ],
        ['call_open', 'spine_open', { summary: 'task A' }],
      ]),
      {
        role: 'tool',
        content: [{ type: 'text', text: receipt }],
        toolCalls: [],
        toolCallId: 'call_spawn',
        isError: false,
      } as ContextMessage,
      spineReceipt('call_open'),
    );
    const state = readSpine(ctx);
    expect(state.openStack).toEqual(['1', '1.1']);
    expect(state.nodes['1.1.1']).toBeUndefined();
    expect(state.nodes['1.1.2']).toBeUndefined();
  });
});

function spineToolNames(ctx: TestAgentContext): string[] {
  return ctx
    .toolsData()
    .map((tool) => tool.name)
    .filter((name) => name.startsWith('spine_'));
}

function toolCallPart(
  id: string,
  name: string,
  args: Record<string, unknown>,
): {
  readonly type: 'function';
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
} {
  return { type: 'function', id, name, arguments: JSON.stringify(args) };
}

type GenerateFn = NonNullable<TestAgentOptions['generate']>;

function textResult(text: string): Awaited<ReturnType<GenerateFn>> {
  return {
    id: 'mock-spine-text',
    message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
    usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
    finishReason: 'completed',
    rawFinishReason: 'stop',
  };
}

function historyText(history: readonly Message[]): string {
  return history
    .flatMap((message) => message.content)
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function textOf(message: { content?: readonly { type: string; text?: string }[] } | undefined): string {
  return (
    message?.content?.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('') ?? ''
  );
}

function toolPairingGaps(messages: readonly ContextMessage[]): string[] {
  const gaps: string[] = [];
  const openCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) openCallIds.add(call.id);
    } else if (
      message.role === 'tool' &&
      message.toolCallId !== undefined &&
      !openCallIds.has(message.toolCallId)
    ) {
      gaps.push(message.toolCallId);
    }
  }
  return gaps;
}

function assistantSpineCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: `calling ${name}` }],
    toolCalls: [{ type: 'function', id, name, arguments: JSON.stringify(args) }],
  };
}

function spineReceipt(toolCallId: string): ContextMessage {
  return {
    role: 'tool',
    content: [{ type: 'text', text: ACCEPTED_OUTPUT }],
    toolCalls: [],
    toolCallId,
  };
}

function mockLifecycleService(): IAgentLifecycleService {
  let minted = 0;
  const contexts = new Map<string, AgentContext>([
    ['main', { agentId: 'main' } as unknown as AgentContext],
  ]);
  return {
    _serviceBrand: undefined,
    onDidCreate: () => ({ dispose: () => undefined }),
    onDidDispose: () => ({ dispose: () => undefined }),
    create: () => Promise.reject(new Error('create is not used in spawn tests')),
    fork: (source: AgentContext, _opts?: unknown) => {
      if (source.agentId !== 'main') {
        return Promise.reject(new Error(`unknown source ${source.agentId}`));
      }
      const id = `agent-${String(minted++)}`;
      const context = { agentId: id } as unknown as AgentContext;
      contexts.set(id, context);
      return Promise.resolve(context);
    },
    get: (agentId: string) => contexts.get(agentId),
    list: () => [...contexts.values()],
    resolve: () =>
      new Proxy({} as Record<string | symbol, unknown>, {
        get: (target, prop) => target[prop] ?? (() => undefined),
        set: (target, prop, value) => {
          target[prop] = value;
          return true;
        },
      }),
    broadcastPermissionMode: () => undefined,
    remove: (agent: AgentContext) => {
      contexts.delete(agent.agentId);
      return Promise.resolve();
    },
    handleOf: () => undefined,
    adopt: (handle: IAgentScopeHandle) => {
      const context = agentContextOf(handle);
      contexts.set(context.agentId, context);
      return context;
    },
    attachRuntimes: () => undefined,
  } as unknown as IAgentLifecycleService;
}

function mockSubagentService(
  summaries: Record<string, string>,
): ISessionSubagentService {
  return {
    _serviceBrand: undefined,
    hooks: { onWillStartAgentTask: { register: () => ({ dispose: () => undefined }) } },
    onDidStopAgentTask: () => ({ dispose: () => undefined }),
    run: async (agent: AgentContext) => {
      const summary = summaries[agent.agentId] ?? '';
      const controller = new AbortController();
      const handle: AgentRunHandle = {
        agentId: agent.agentId,
        turn: {
          id: 1,
          signal: controller.signal,
          cancel: () => {
            controller.abort();
            return true;
          },
          ready: Promise.resolve(),
          result: Promise.resolve({ type: 'completed', steps: 0 } as never),
        },
        completion: Promise.resolve({ summary }),
      };
      return handle;
    },
    notifyAgentTaskStopped: () => undefined,
  } as unknown as ISessionSubagentService;
}

function buildCompletionController() {
  let resolve!: (value: { summary: string }) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<{ summary: string }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('spine_spawn service', () => {
  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(SPINE_ENV, '1');
    vi.stubEnv('KIMI_CODE_SPINE_SPAWN', '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts spawn after a control accept (mixing is vetoed at the executor, not the service)', async () => {
    const ctx = testAgent(
      sessionService(IAgentLifecycleService, mockLifecycleService()),
      sessionService(ISessionSubagentService, mockSubagentService({})),
    );
    const spine = ctx.get(IAgentSpineService);
    expect(spine.acceptOpen('task A').accepted).toBe(true);
    const result = await spine.executeSpawn(
      [
        { summary: 'branch A', prompt: 'do A' },
        { summary: 'branch B', prompt: 'do B' },
      ],
      new AbortController().signal,
    );
    expect(result.accepted).toBe(true);
  });

  it('accepts a sequential spawn once capacity frees up (duplicates are vetoed at the executor)', async () => {
    const ctx = testAgent(
      sessionService(IAgentLifecycleService, mockLifecycleService()),
      sessionService(ISessionSubagentService, mockSubagentService({})),
    );
    const spine = ctx.get(IAgentSpineService);
    const first = await spine.executeSpawn(
      [
        { summary: 'branch A', prompt: 'do A' },
        { summary: 'branch B', prompt: 'do B' },
      ],
      new AbortController().signal,
    );
    expect(first.accepted).toBe(true);
    const second = await spine.executeSpawn(
      [
        { summary: 'branch C', prompt: 'do C' },
        { summary: 'branch D', prompt: 'do D' },
      ],
      new AbortController().signal,
    );
    expect(second.accepted).toBe(true);
  });

  it('rejects duplicate branch summaries in one spawn call', async () => {
    const ctx = testAgent();
    const spine = ctx.get(IAgentSpineService);
    const result = await spine.executeSpawn(
      [
        { summary: 'branch A', prompt: 'do A' },
        { summary: ' branch A ', prompt: 'do A again' },
      ],
      new AbortController().signal,
    );
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toContain('duplicate summary `branch A`');
    }
  });

  it('reports capacity-unavailable admission as an all-errored receipt', async () => {
    const completions: ReturnType<typeof buildCompletionController>[] = [];
    const hangingSubagent: ISessionSubagentService = {
      _serviceBrand: undefined,
      hooks: { onWillStartAgentTask: { register: () => ({ dispose: () => undefined }) } },
      onDidStopAgentTask: () => ({ dispose: () => undefined }),
      run: async (agent: AgentContext) => {
        const controller = new AbortController();
        const completion = buildCompletionController();
        completions.push(completion);
        return {
          agentId: agent.agentId,
          turn: {
            id: 1,
            signal: controller.signal,
            cancel: () => {
              controller.abort();
              return true;
            },
            ready: Promise.resolve(),
            result: Promise.resolve({ type: 'completed', steps: 0 } as never),
          },
          completion: completion.promise,
        } as AgentRunHandle;
      },
      notifyAgentTaskStopped: () => undefined,
    } as unknown as ISessionSubagentService;

    const ctx = testAgent(
      { initialConfig: { spineSpawn: { maxConcurrentThreadsPerSession: 3 } } },
      sessionService(IAgentLifecycleService, mockLifecycleService()),
      sessionService(ISessionSubagentService, hangingSubagent),
    );
    const spine = ctx.get(IAgentSpineService);

    const firstPromise = spine.executeSpawn(
      [
        { summary: 'branch A', prompt: 'do A' },
        { summary: 'branch B', prompt: 'do B' },
      ],
      new AbortController().signal,
    );
    await Promise.resolve();

    const second = await spine.executeSpawn(
      [
        { summary: 'branch C', prompt: 'do C' },
        { summary: 'branch D', prompt: 'do D' },
      ],
      new AbortController().signal,
    );
    expect(second.accepted).toBe(true);
    const receipt = JSON.parse(second.receipt!);
    expect(receipt.schema).toBe('spine.spawn.result.v1');
    expect(receipt.results).toHaveLength(2);
    for (const ordinal of [0, 1]) {
      const result = receipt.results[ordinal];
      expect(result.outcome).toBe('errored');
      expect(result.diagnostic).toContain(`spine_spawn task ${String(ordinal + 1)}/2`);
      expect(result.diagnostic).toContain('was not started');
      expect(result.diagnostic).toContain('aggregate admission requested 2 child agents');
      expect(result.diagnostic).toContain(
        'Admission is all-or-nothing, so no child agents from this batch were created',
      );
      expect(result.diagnostic).toContain('spine_spawn.max_concurrent_threads_per_session');
      expect(result.memory_body).toBe(result.diagnostic);
      expect(result.execution_ref).toBeUndefined();
    }

    ctx.get(IAgentContextMemoryService).append(
      assistantSpineCall('call_spawn_cap', 'spine_spawn', {
        tasks: [
          { summary: 'branch C', prompt: 'do C' },
          { summary: 'branch D', prompt: 'do D' },
        ],
      }),
      {
        role: 'tool',
        content: [{ type: 'text', text: second.receipt! }],
        toolCallId: 'call_spawn_cap',
        isError: false,
      } as ContextMessage,
    );
    const state = readSpine(ctx);
    expect(state.nodes['1.1.1']?.summary).toBe('branch C');
    expect(state.nodes['1.1.1']?.spawn?.outcome).toBe('errored');
    expect(state.nodes['1.1.1']?.closedAt).toBeDefined();
    expect(state.nodes['1.1.2']?.summary).toBe('branch D');
    expect(state.nodes['1.1.2']?.spawn?.outcome).toBe('errored');
    expect(state.nodes['1.1.2']?.closedAt).toBeDefined();

    completions.forEach((c) => c.resolve({ summary: 'done' }));
    await firstPromise;
  });

  it('produces a receipt that derive accepts and synthesizes closed nodes', async () => {
    const ctx = testAgent(
      sessionService(IAgentLifecycleService, mockLifecycleService()),
      sessionService(
        ISessionSubagentService,
        mockSubagentService({
          'agent-0': 'memory A',
          'agent-1': 'memory B',
        }),
      ),
    );
    const spine = ctx.get(IAgentSpineService);
    const result = await spine.executeSpawn(
      [
        { summary: 'branch A', prompt: 'do A' },
        { summary: 'branch B', prompt: 'do B' },
      ],
      new AbortController().signal,
    );
    expect(result.accepted).toBe(true);
    expect(result.receipt).toBeDefined();
    const receipt = JSON.parse(result.receipt!);
    expect(receipt.schema).toBe('spine.spawn.result.v1');
    expect(receipt.results).toHaveLength(2);
    expect(receipt.results[0]).toMatchObject({ ordinal: 0, outcome: 'completed', memory_body: 'memory A', execution_ref: 'agent-0' });
    expect(receipt.results[1]).toMatchObject({ ordinal: 1, outcome: 'completed', memory_body: 'memory B', execution_ref: 'agent-1' });

    ctx.get(IAgentContextMemoryService).append(
      assistantSpineCall('call_spawn', 'spine_spawn', {
        tasks: [
          { summary: 'branch A', prompt: 'do A' },
          { summary: 'branch B', prompt: 'do B' },
        ],
      }),
      {
        role: 'tool',
        content: [{ type: 'text', text: result.receipt! }],
        toolCallId: 'call_spawn',
        isError: false,
      } as ContextMessage,
    );

    const state = readSpine(ctx);
    expect(state.nodes['1.1.1']?.summary).toBe('branch A');
    expect(state.nodes['1.1.1']?.memory).toBe('memory A');
    expect(state.nodes['1.1.1']?.closedAt).toBeDefined();
    expect(state.nodes['1.1.2']?.summary).toBe('branch B');
    expect(state.nodes['1.1.2']?.memory).toBe('memory B');
    expect(state.nodes['1.1.2']?.closedAt).toBeDefined();
  });
});
