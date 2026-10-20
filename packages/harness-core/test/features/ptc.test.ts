import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFeature, useToolHandler, type Feature } from '@moonshot-ai/agent-core/app/index';
import { createUserEntry, type ToolMeta } from '@moonshot-ai/agent-core/history/index';
import {
  createAssistantMessage,
  createUserMessage,
  extractText,
  type Message,
  type ToolCall,
  type ToolDescription,
} from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import { MAIN_AGENT_ID, type Agent } from '@moonshot-ai/agent-core/session/index';

import { CODE_TOOL_NAME, createPtc, usePtcToolGuard } from '#/features/ptc/index';
import {
  createHarness,
  harnessInternals,
  memoryHarnessSpace,
  useAgentTools,
  type Harness,
} from '#/runtime/index';

type GenerateRest = Parameters<LoopLlmRequester['generate']>[0];

interface LlmCall {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDescription[];
}

type LlmScript = (call: LlmCall) => { text: string } | { toolCall: { name: string; arguments: string } };

function textOutcome(text: string, toolCalls: ToolCall[] = []): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls) };
}

function createMockRequester(script: LlmScript): { requester: LoopLlmRequester; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  const requester: LoopLlmRequester = {
    with: () => requester,
    request: (part) => part as unknown as LlmRequest,
    generate: async (rest: GenerateRest) => {
      const call: LlmCall = {
        systemPrompt: rest.profile?.systemPrompt,
        messages: rest.content?.messages ?? [],
        tools: rest.profile?.tools ?? [],
      };
      calls.push(call);
      const out = script(call);
      if ('toolCall' in out) {
        return textOutcome('', [
          { type: 'function', id: `call-${calls.length}`, name: out.toolCall.name, arguments: out.toolCall.arguments },
        ]);
      }
      return textOutcome(out.text);
    },
  };
  return { requester, calls };
}

function bindTestTools(executed: string[]): Feature<void> {
  return createFeature('test-tools', {
    agent() {
      useAgentTools(
        {
          name: 'Read',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
          execute: async () => {
            executed.push('Read');
            return { content: [{ type: 'text', text: 'file contents' }] };
          },
        },
        {
          name: 'Hidden',
          description: 'A deferred tool',
          parameters: { type: 'object', properties: {} },
          deferred: true,
          execute: async () => {
            executed.push('Hidden');
            return { content: [{ type: 'text', text: 'hidden result' }] };
          },
        },
      );
      useToolHandler('Secret', {
        execute: async () => {
          executed.push('Secret');
          return { content: [{ type: 'text', text: 'secret result' }] };
        },
      });
    },
  });
}

function bindBashVeto(executed: string[]): Feature<void> {
  return createFeature('test-veto', {
    agent() {
      useAgentTools({
        name: 'Bash',
        description: 'Run a shell command',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          executed.push('Bash');
          return { content: [{ type: 'text', text: 'bash output' }] };
        },
      });
      usePtcToolGuard(({ toolCall }) => {
        if (toolCall.name !== 'Bash') return undefined;
        return {
          blocked: { reason: 'denied', message: 'Bash is disabled' },
          result: { content: [{ type: 'text', text: 'Bash is disabled' }] },
        };
      });
    },
  });
}

function setRequester(harness: Harness, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime = session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

async function startEnv(opts: {
  script: LlmScript;
  features?: Feature<void>[];
  ptcFactory?: (dir: string) => Feature<void>;
}): Promise<{
  agent: Agent;
  calls: LlmCall[];
  cleanup(): Promise<void>;
}> {
  const harness = createHarness({ space: memoryHarnessSpace() });
  const { requester, calls } = createMockRequester(opts.script);
  const dir = await mkdtemp(join(tmpdir(), 'ptc-test-'));
  const ptc = (opts.ptcFactory ?? ((d: string) => createPtc({ dir: d, enabled: () => true })))(dir);
  for (const feature of [...(opts.features ?? []), ptc]) {
    await harness.app.features.add(feature);
  }
  const session = await harness.app.create({ sessionId: 'sess' });
  const agent = await harness.ensureAgent(session, MAIN_AGENT_ID, { systemPrompt: 'main-host' });
  setRequester(harness, 'sess', MAIN_AGENT_ID, requester);
  return {
    agent,
    calls,
    cleanup: async () => {
      await harness.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function user(text: string) {
  return createUserEntry(createUserMessage(text), { source: 'input' });
}

function toolTexts(agent: Agent): string[] {
  return agent.view
    .getState()
    .messages.filter((entry) => entry.message.role === 'tool')
    .map((entry) => extractText(entry.message));
}

function toolIsErrors(agent: Agent): boolean[] {
  return agent.view
    .getState()
    .messages.filter((entry) => entry.message.role === 'tool')
    .map((entry) => (entry.meta as ToolMeta | undefined)?.isError === true);
}

function userTexts(agent: Agent): string[] {
  return agent.view
    .getState()
    .messages.filter((entry) => entry.message.role === 'user')
    .map((entry) => extractText(entry.message));
}

function codeArguments(code: string): { toolCall: { name: string; arguments: string } } {
  return { toolCall: { name: CODE_TOOL_NAME, arguments: JSON.stringify({ code }) } };
}

function endAfterTool(call: LlmCall): { text: string } {
  const last = call.messages.at(-1);
  return { text: last?.role === 'tool' ? `done:${extractText(last)}` : 'done' };
}

describe('ptc feature', () => {
  it('orchestrates registered, deferred, and executor-only tools from code and returns only the summary', async () => {
    const executed: string[] = [];
    const script: LlmScript = (call) => {
      if (call.messages.some((message) => message.role === 'tool')) return endAfterTool(call);
      return codeArguments(`
const a = await tools.Read({ path: 'a.ts' });
const b = await tools.Hidden({});
const c = await tools.Secret({});
console.log('intermediate length', a.length + b.length + c.length);
return { summary: a.split(' ')[0], count: 3 };
`);
    };
    const env = await startEnv({ script, features: [bindTestTools(executed)] });
    await env.agent.loop.runTurn(user('orchestrate'));
    await env.agent.flush();

    expect(executed).toEqual(['Read', 'Hidden', 'Secret']);
    const results = toolTexts(env.agent);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('intermediate length 39');
    expect(results[0]).toContain('"summary":"file"');
    expect(results[0]).not.toContain('hidden result');
    const codeTool = env.calls[0]?.tools.find((tool) => tool.name === CODE_TOOL_NAME);
    expect(codeTool).toBeDefined();
    expect(codeTool?.description).toContain('### Read');
    expect(codeTool?.description).toContain('### Hidden');
    expect(codeTool?.description).not.toContain('### Code');
    const hidden = env.calls[0]?.tools.find((tool) => tool.name === 'Hidden');
    expect(hidden?.deferred).toBe(true);

    await env.cleanup();
  });

  it('honors tool guards inside the sandbox without executing the real tool', async () => {
    const executed: string[] = [];
    const script: LlmScript = (call) => {
      if (call.messages.some((message) => message.role === 'tool')) return endAfterTool(call);
      return codeArguments(`
const denied = await tools.Bash({});
console.log('got:', denied);
`);
    };
    const env = await startEnv({ script, features: [bindBashVeto(executed)] });
    await env.agent.loop.runTurn(user('run bash'));
    await env.agent.flush();

    expect(executed).toEqual([]);
    const results = toolTexts(env.agent);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('got: Bash is disabled');

    await env.cleanup();
  });

  it('enforces the tool call budget and reports unknown or excluded tools as errors', async () => {
    const executed: string[] = [];
    const script: LlmScript = (call) => {
      if (call.messages.some((message) => message.role === 'tool')) return endAfterTool(call);
      return codeArguments(`
await tools.Read({ path: 'a.ts' });
try { await tools.Ghost({}); } catch (error) { console.log('ghost:', error.message); }
try { await tools.Hidden({}); } catch (error) { console.log('hidden:', error.message); }
try { await tools.Read({ path: 'b.ts' }); } catch (error) { console.log('budget:', error.message); }
console.log('after budget');
`);
    };
    const env = await startEnv({
      script,
      features: [bindTestTools(executed)],
      ptcFactory: (dir) =>
        createPtc({ dir, exclude: ['Hidden'], limits: { maxToolCalls: 3 }, enabled: () => true }),
    });
    await env.agent.loop.runTurn(user('budget'));
    await env.agent.flush();

    expect(executed).toEqual(['Read']);
    const results = toolTexts(env.agent);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('ghost: unknown tool: Ghost');
    expect(results[0]).toContain(`hidden: tool 'Hidden' is not callable from ${CODE_TOOL_NAME}`);
    expect(results[0]).toContain('budget: Code execution exceeded the tool call budget of 3');
    expect(results[0]).toContain('after budget');
    const codeTool = env.calls[0]?.tools.find((tool) => tool.name === CODE_TOOL_NAME);
    expect(codeTool?.description).not.toContain('### Hidden');

    await env.cleanup();
  });

  it('surfaces uncaught code errors together with captured stdout', async () => {
    const script: LlmScript = (call) => {
      if (call.messages.some((message) => message.role === 'tool')) return endAfterTool(call);
      return codeArguments(`
console.log('partial progress');
throw new Error('boom');
`);
    };
    const env = await startEnv({ script });
    await env.agent.loop.runTurn(user('explode'));
    await env.agent.flush();

    const results = toolTexts(env.agent);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('error: boom');
    expect(results[0]).toContain('partial progress');
    expect(toolIsErrors(env.agent)).toEqual([true]);

    await env.cleanup();
  });

  it('truncates oversized output and aborts on timeout with a clear error', async () => {
    const executed: string[] = [];
    const script: LlmScript = (call) => {
      if (call.messages.some((message) => message.role === 'tool')) return endAfterTool(call);
      return codeArguments(`
console.log('x'.repeat(500));
await tools.Slow({});
console.log('unreachable');
`);
    };
    const slow: Feature<void> = createFeature('test-slow', {
      agent() {
        useAgentTools({
          name: 'Slow',
          description: 'Never resolves in time',
          parameters: { type: 'object', properties: {} },
          execute: async ({ signal }) => {
            executed.push('Slow');
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, 10_000);
              signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
              }, { once: true });
            });
            return { content: [{ type: 'text', text: 'slow done' }] };
          },
        });
      },
    });
    const env = await startEnv({
      script,
      features: [slow],
      ptcFactory: (dir) =>
        createPtc({ dir, limits: { maxOutputBytes: 100, timeoutMs: 500 }, enabled: () => true }),
    });
    await env.agent.loop.runTurn(user('limits'));
    await env.agent.flush();

    const results = toolTexts(env.agent);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('error: Code execution timed out after 500ms');
    expect(results[0]).toContain('x'.repeat(99));
    expect(results[0]).not.toContain('x'.repeat(100));
    expect(results[0]).not.toContain('unreachable');
    expect(executed).toEqual(['Slow']);
    expect(toolIsErrors(env.agent)).toEqual([true]);

    await env.cleanup();
  });

  it('detaches into the background and reports completion through the async-tool channel', async () => {
    const executed: string[] = [];
    let notifyCompletion: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => {
      notifyCompletion = resolve;
    });
    const script: LlmScript = (call) => {
      const last = call.messages.at(-1);
      if (last?.role === 'user' && extractText(last).includes('[async tool completed]')) {
        notifyCompletion();
        return { text: 'bg-done' };
      }
      if (call.messages.some((message) => message.role === 'tool')) return endAfterTool(call);
      return codeArguments(`
detach('long orchestration');
await tools.Read({ path: 'a.ts' });
console.log('finished chunk');
return 'all done';
`);
    };
    const env = await startEnv({ script, features: [bindTestTools(executed)] });
    await env.agent.loop.runTurn(user('background'));
    await env.agent.flush();

    const ack = toolTexts(env.agent);
    expect(ack).toHaveLength(1);
    expect(ack[0]).toContain('long orchestration');
    expect(ack[0]).not.toContain('finished chunk');

    await completion;
    await env.agent.loop.waitForIdle();
    await env.agent.flush();

    expect(executed).toEqual(['Read']);
    const notifications = userTexts(env.agent).filter((text) => text.includes('[async tool completed]'));
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain(CODE_TOOL_NAME);

    await env.cleanup();
  });

  it('exposes readonly agent/session facades and drains subscriptions after the run', async () => {
    const script: LlmScript = (call) => {
      const last = call.messages.at(-1);
      if (last?.role === 'tool') return { text: `done:${extractText(last)}` };
      return codeArguments(`
const agent = useAgent();
const store = useAgentStore();
const blobs = useBlobs();
const session = useSession();
console.log('agent:', agent.id);
console.log('messages:', (await store.getState()).messages.length);
console.log('blob missing:', await blobs.has('nope'));
console.log('session:', session.id, [...session.agents.keys()].join(','));
console.log('dispatch:', typeof store.dispatch);
console.log('loop:', typeof agent.loop);
agent.subscribe((event) => {
  if (event.type === 'turn.ended') {
    globalThis.__ptc_leak_readonly = (globalThis.__ptc_leak_readonly ?? 0) + 1;
  }
});
`);
    };
    const env = await startEnv({
      script,
      ptcFactory: (dir) => createPtc({ dir, context: 'readonly', enabled: () => true }),
    });
    await env.agent.loop.runTurn(user('peek'));
    await env.agent.flush();

    const results = toolTexts(env.agent);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('agent: main');
    expect(results[0]).toMatch(/messages: [1-9]/);
    expect(results[0]).toContain('blob missing: false');
    expect(results[0]).toContain('session: sess main');
    expect(results[0]).toContain('dispatch: undefined');
    expect(results[0]).toContain('loop: undefined');

    await env.agent.loop.runTurn(user('again'));
    expect((globalThis as Record<string, unknown>).__ptc_leak_readonly).toBeUndefined();

    await env.cleanup();
  });

  it('grants full context access including dispatch, blobs write, and remind', async () => {
    const script: LlmScript = (call) => {
      if (call.messages.some((message) => message.role === 'tool')) return { text: 'after-code' };
      return codeArguments(`
const agent = useAgent();
const store = useAgentStore();
const blobs = useBlobs();
const ref = await blobs.put({ bytes: new TextEncoder().encode('payload') });
const back = new TextDecoder().decode((await blobs.get(ref.ref)).bytes);
console.log('blob:', back);
await store.dispatch([{ type: 'ptc.probe', marker: 41 }]);
console.log('dispatch: ok');
agent.loop.remind({ message: { role: 'user', content: [{ type: 'text', text: 'remember-this-note' }] }, meta: { key: 'ptc-note' } });
console.log('remind sent');
`);
    };
    const env = await startEnv({
      script,
      ptcFactory: (dir) => createPtc({ dir, context: 'full', enabled: () => true }),
    });
    await env.agent.loop.runTurn(user('write'));
    await env.agent.flush();

    const results = toolTexts(env.agent);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('blob: payload');
    expect(results[0]).toContain('dispatch: ok');
    expect(results[0]).toContain('remind sent');
    const secondCall = env.calls[1];
    expect(
      secondCall?.messages.some(
        (message) => message.role === 'user' && extractText(message).includes('remember-this-note'),
      ),
    ).toBe(true);

    await env.cleanup();
  });

  it('does not register the Code tool when the flag is off', async () => {
    const script: LlmScript = () => ({ text: 'plain' });
    const env = await startEnv({
      script,
      ptcFactory: (dir) => createPtc({ dir, enabled: () => false }),
    });
    await env.agent.loop.runTurn(user('hello'));

    expect(env.calls[0]?.tools.some((tool) => tool.name === CODE_TOOL_NAME)).toBe(false);

    await env.cleanup();
  });
});
