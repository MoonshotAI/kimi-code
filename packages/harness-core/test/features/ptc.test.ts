import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createFeature,
  createUserMessage,
  extractText,
  MAIN_AGENT_ID,
  MemoryBackend,
  createHarness,
  openBlobs,
  openSessionStores,
  Trees,
  useAgent,
  useAgentTools,
  useBeforeTool,
  useToolExecutor,
  type AgentHandle,
  type FeatureSpec,
  type AgentLlmRequester,
  type Message,
  type SessionStores,
  type ToolDescription,
  type ToolMeta,
} from '@moonshot-ai/agent-core';

import { CODE_TOOL_NAME, createPtc } from '#/features/ptc/index';

import { fakeRequester, textOutcome, testModel } from '../fake-llm';

interface LlmCall {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDescription[];
}

type LlmScript = (call: LlmCall) => { text: string } | { toolCall: { name: string; arguments: string } };

function createMockRequester(script: LlmScript): { requester: AgentLlmRequester; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    calls,
    requester: fakeRequester((rest, onEvent) => {
        const call: LlmCall = {
          systemPrompt: rest.profile?.systemPrompt,
          messages: rest.content?.messages ?? [],
          tools: rest.profile?.tools ?? [],
        };
        calls.push(call);
        const out = script(call);
        onEvent?.({
          type: 'llm.streaming.usage',
          usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
        });
        if ('toolCall' in out) {
          return textOutcome('', [
            { type: 'function', id: `call-${calls.length}`, name: out.toolCall.name, arguments: out.toolCall.arguments },
          ]);
        }
        return textOutcome(out.text);
      }),
  };
}

function bindTestLlm(requester: AgentLlmRequester): FeatureSpec {
  return createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setModel(testModel);
      agent.setRequester(requester);
    },
  });
}

function bindTestTools(executed: string[]): FeatureSpec {
  return createFeature('test-tools', {
    agent() {
      useAgentTools(
        {
          name: 'Read',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
          execute: async () => {
            executed.push('Read');
            return { content: [{ type: 'text' as const, text: 'file contents' }] };
          },
        },
        {
          name: 'Hidden',
          description: 'A deferred tool',
          parameters: { type: 'object', properties: {} },
          deferred: true,
          execute: async () => {
            executed.push('Hidden');
            return { content: [{ type: 'text' as const, text: 'hidden result' }] };
          },
        },
      );
      useToolExecutor('Secret', {
        execute: async () => {
          executed.push('Secret');
          return { content: [{ type: 'text' as const, text: 'secret result' }] };
        },
      });
    },
  });
}

function bindBashVeto(executed: string[]): FeatureSpec {
  return createFeature('test-veto', {
    agent() {
      useAgentTools({
        name: 'Bash',
        description: 'Run a shell command',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          executed.push('Bash');
          return { content: [{ type: 'text' as const, text: 'bash output' }] };
        },
      });
      useBeforeTool(({ toolCall }) => {
        if (toolCall.name === 'Bash') {
          return {
            type: 'denied',
            result: { content: [{ type: 'text', text: 'Bash is disabled' }] },
          };
        }
        return undefined;
      });
    },
  });
}

async function testStores(): Promise<{ stores: SessionStores }> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  return { stores: await openSessionStores(tree, openBlobs(backend.blobs)) };
}

async function startApp(opts: {
  script: LlmScript;
  features?: FeatureSpec[];
  ptcFactory?: (dir: string) => FeatureSpec;
}): Promise<{
  stores: SessionStores;
  main: AgentHandle;
  calls: LlmCall[];
  cleanup(): Promise<void>;
}> {
  const { stores } = await testStores();
  const { requester, calls } = createMockRequester(opts.script);
  const dir = await mkdtemp(join(tmpdir(), 'ptc-test-'));
  const ptc = (opts.ptcFactory ?? ((d: string) => createPtc({ dir: d, enabled: () => true })))(dir);
  const app = createHarness({ features: [...(opts.features ?? []), bindTestLlm(requester), ptc] });
  const session = await app.create({ sessionId: 'sess', stores });
  const main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  return {
    stores,
    main,
    calls,
    cleanup: async () => {
      await app.disposeAsync();
      await stores.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function nextTurnDone(agent: AgentHandle): Promise<void> {
  return new Promise((resolve) => {
    agent.on('turn.done', () => {
      resolve();
    });
  });
}

function toolTexts(stores: SessionStores, agentId: string): string[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => extractText(entry.message));
}

function toolIsErrors(stores: SessionStores, agentId: string): boolean[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => (entry.meta as ToolMeta | undefined)?.isError === true);
}

function userTexts(stores: SessionStores, agentId: string): string[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'user')
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
    const env = await startApp({ script, features: [bindTestTools(executed)] });
    const done = nextTurnDone(env.main);
    env.main.submit(createUserMessage('orchestrate'));
    await done;
    await env.stores.flush();

    expect(executed).toEqual(['Read', 'Hidden', 'Secret']);
    const results = toolTexts(env.stores, MAIN_AGENT_ID);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('intermediate length 39');
    expect(results[0]).toContain('"summary":"file"');
    expect(results[0]).not.toContain('hidden result');
    const codeTool = env.calls[0]?.tools.find((tool) => tool.name === CODE_TOOL_NAME);
    expect(codeTool).toBeDefined();
    expect(codeTool?.description).toContain('### Read');
    expect(codeTool?.description).toContain('### Hidden');
    expect(codeTool?.description).not.toContain('### Code');
    expect(env.calls[0]?.tools.some((tool) => tool.name === 'Hidden')).toBe(false);

    await env.cleanup();
  });

  it('honors beforeTool vetoes inside the sandbox without executing the real tool', async () => {
    const executed: string[] = [];
    const script: LlmScript = (call) => {
      if (call.messages.some((message) => message.role === 'tool')) return endAfterTool(call);
      return codeArguments(`
const denied = await tools.Bash({});
console.log('got:', denied);
`);
    };
    const env = await startApp({ script, features: [bindBashVeto(executed)] });
    const done = nextTurnDone(env.main);
    env.main.submit(createUserMessage('run bash'));
    await done;
    await env.stores.flush();

    expect(executed).toEqual([]);
    const results = toolTexts(env.stores, MAIN_AGENT_ID);
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
    const env = await startApp({
      script,
      features: [bindTestTools(executed)],
      ptcFactory: (dir) =>
        createPtc({ dir, exclude: ['Hidden'], limits: { maxToolCalls: 3 }, enabled: () => true }),
    });
    const done = nextTurnDone(env.main);
    env.main.submit(createUserMessage('budget'));
    await done;
    await env.stores.flush();

    expect(executed).toEqual(['Read']);
    const results = toolTexts(env.stores, MAIN_AGENT_ID);
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
    const env = await startApp({ script });
    const done = nextTurnDone(env.main);
    env.main.submit(createUserMessage('explode'));
    await done;
    await env.stores.flush();

    const results = toolTexts(env.stores, MAIN_AGENT_ID);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('error: boom');
    expect(results[0]).toContain('partial progress');
    expect(toolIsErrors(env.stores, MAIN_AGENT_ID)).toEqual([true]);

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
    const slow: FeatureSpec = createFeature('test-slow', {
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
            return { content: [{ type: 'text' as const, text: 'slow done' }] };
          },
        });
      },
    });
    const env = await startApp({
      script,
      features: [slow],
      ptcFactory: (dir) =>
        createPtc({ dir, limits: { maxOutputBytes: 100, timeoutMs: 500 }, enabled: () => true }),
    });
    const done = nextTurnDone(env.main);
    env.main.submit(createUserMessage('limits'));
    await done;
    await env.stores.flush();

    const results = toolTexts(env.stores, MAIN_AGENT_ID);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('error: Code execution timed out after 500ms');
    expect(results[0]).toContain('x'.repeat(99));
    expect(results[0]).not.toContain('x'.repeat(100));
    expect(results[0]).not.toContain('unreachable');
    expect(executed).toEqual(['Slow']);
    expect(toolIsErrors(env.stores, MAIN_AGENT_ID)).toEqual([true]);

    await env.cleanup();
  });

  it('detaches into the background and reports completion through the async-tool channel', async () => {
    const executed: string[] = [];
    const script: LlmScript = (call) => {
      const last = call.messages.at(-1);
      if (last?.role === 'user' && extractText(last).includes('[async tool completed]')) {
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
    const env = await startApp({ script, features: [bindTestTools(executed)] });
    const first = nextTurnDone(env.main);
    env.main.submit(createUserMessage('background'));
    await first;
    await env.stores.flush();

    const ack = toolTexts(env.stores, MAIN_AGENT_ID);
    expect(ack).toHaveLength(1);
    expect(ack[0]).not.toContain('finished chunk');
    expect(executed).toEqual(['Read']);

    const second = nextTurnDone(env.main);
    env.main.submit(createUserMessage('continue'));
    await second;
    await env.stores.flush();

    const notifications = userTexts(env.stores, MAIN_AGENT_ID).filter((text) =>
      text.includes('[async tool completed]'),
    );
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
console.log('agent:', agent.agentId);
console.log('history:', store.getState().history.length);
console.log('blob missing:', await blobs.has('nope'));
console.log('session:', session.sessionId, session.list().join(','));
console.log('dispatch:', typeof store.dispatch);
console.log('submit:', typeof agent.submit);
agent.on('turn.done', () => { globalThis.__ptc_leak_readonly = (globalThis.__ptc_leak_readonly ?? 0) + 1; });
`);
    };
    const env = await startApp({
      script,
      ptcFactory: (dir) => createPtc({ dir, context: 'readonly', enabled: () => true }),
    });
    const first = nextTurnDone(env.main);
    env.main.submit(createUserMessage('peek'));
    await first;
    await env.stores.flush();

    const results = toolTexts(env.stores, MAIN_AGENT_ID);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('agent: main');
    expect(results[0]).toMatch(/history: [1-9]/);
    expect(results[0]).toContain('blob missing: false');
    expect(results[0]).toContain('session: sess main');
    expect(results[0]).toContain('dispatch: undefined');
    expect(results[0]).toContain('submit: undefined');

    const second = nextTurnDone(env.main);
    env.main.submit(createUserMessage('again'));
    await second;
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
const ref = await blobs.put(new TextEncoder().encode('payload'));
const back = new TextDecoder().decode(await blobs.get(ref.ref));
console.log('blob:', back);
const entry = await store.dispatch({ type: 'ptc.probe', marker: 41 });
console.log('dispatched:', typeof entry);
agent.remind({ role: 'user', content: [{ type: 'text', text: 'remember-this-note' }] }, { key: 'ptc-note' });
console.log('remind sent');
`);
    };
    const env = await startApp({
      script,
      ptcFactory: (dir) => createPtc({ dir, context: 'full', enabled: () => true }),
    });
    const done = nextTurnDone(env.main);
    env.main.submit(createUserMessage('write'));
    await done;
    await env.stores.flush();

    const results = toolTexts(env.stores, MAIN_AGENT_ID);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('blob: payload');
    expect(results[0]).toContain('dispatched: object');
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
    const env = await startApp({
      script,
      ptcFactory: (dir) => createPtc({ dir, enabled: () => false }),
    });
    const done = nextTurnDone(env.main);
    env.main.submit(createUserMessage('hello'));
    await done;

    expect(env.calls[0]?.tools.some((tool) => tool.name === CODE_TOOL_NAME)).toBe(false);

    await env.cleanup();
  });
});
