import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMessageAccumulator,
  type AgentHandle,
  type AgentLlmRequester,
  type LlmModelSpec,
  type LlmOutcome,
  type LlmRequestContent,
  type StreamedMessagePart,
} from '@moonshot-ai/agent-core';

import type { CLIOptions } from '#/cli/options';
import { runPrint } from '#/cli/run-print';

const mocks = vi.hoisted(() => ({
  track: vi.fn(),
  withTelemetryContext: vi.fn(() => ({ track: vi.fn() })),
  setTelemetryContext: vi.fn(),
  setCrashPhase: vi.fn(),
  shutdownTelemetry: vi.fn(async () => {}),
  initializeTelemetry: vi.fn(),
}));

vi.mock('@moonshot-ai/kimi-telemetry', () => ({
  track: mocks.track,
  withTelemetryContext: mocks.withTelemetryContext,
  setTelemetryContext: mocks.setTelemetryContext,
  setCrashPhase: mocks.setCrashPhase,
  shutdownTelemetry: mocks.shutdownTelemetry,
  initializeTelemetry: mocks.initializeTelemetry,
}));

const model: LlmModelSpec = { provider: 'test', name: 'test-model' };

interface ScriptedStep {
  readonly text?: string;
  readonly toolCalls?: ReadonlyArray<{ readonly name: string; readonly arguments: string }>;
  readonly onRequest?: (content: LlmRequestContent) => void;
}

function createScriptedRequester(steps: readonly ScriptedStep[]): AgentLlmRequester {
  const queue = [...steps];
  let callIndex = 0;
  const self: AgentLlmRequester = {
    with: () => self,
    request: () => {
      throw new Error('unused');
    },
    generate: async (rest, control) => {
      const step = queue.length > 0 ? queue.shift()! : { text: '(no more scripted output)' };
      callIndex += 1;
      step.onRequest?.({ messages: rest.content?.messages ?? [] });
      const accumulator = createMessageAccumulator();
      let toolIndex = 0;
      for (const toolCall of step.toolCalls ?? []) {
        toolIndex += 1;
        const part: StreamedMessagePart = {
          type: 'function',
          id: `call_${callIndex}_${toolIndex}`,
          name: toolCall.name,
          arguments: toolCall.arguments,
        };
        control.onEvent?.({ type: 'llm.streaming.part', part });
        accumulator.push(part);
      }
      if (step.text !== undefined) {
        const part: StreamedMessagePart = { type: 'text', text: step.text };
        control.onEvent?.({ type: 'llm.streaming.part', part });
        accumulator.push(part);
      }
      const usage = { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 };
      control.onEvent?.({ type: 'llm.streaming.usage', usage });
      const outcome: LlmOutcome = { type: 'done', message: accumulator.finish(), usage };
      control.onEvent?.({ type: 'llm.ended', outcome });
      return outcome;
    },
  };
  return self;
}

function cliOptions(overrides: Partial<CLIOptions> = {}): CLIOptions {
  return {
    session: undefined,
    continue: false,
    yolo: false,
    auto: false,
    plan: false,
    model: undefined,
    outputFormat: undefined,
    prompt: 'say hello',
    skillsDirs: [],
    agent: undefined,
    agentFiles: [],
    addDirs: [],
    ...overrides,
  };
}

function bindRequester(requester: AgentLlmRequester): (agent: AgentHandle) => void {
  return (agent) => {
    agent.setModel({ spec: model });
    agent.setRequester(requester);
  };
}

function writer() {
  let text = '';
  return {
    write: (chunk: string) => {
      text += chunk;
      return true;
    },
    text: () => text,
  };
}

function processStub() {
  return {
    once: vi.fn(),
    off: vi.fn(),
    exit: vi.fn(),
  };
}

describe('runPrint (v3 harness)', () => {
  let root: string | undefined;
  let previousCwd: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kimi-run-print-'));
    previousCwd = process.cwd();
    previousHome = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = join(root, 'home');
    const workDir = join(root, 'work');
    await mkdir(workDir, { recursive: true });
    await mkdir(join(root, 'home'), { recursive: true });
    await writeFile(join(root, 'home', 'config.toml'), 'default_model = "test/test-model"\n');
    process.chdir(workDir);
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env['KIMI_CODE_HOME'];
    else process.env['KIMI_CODE_HOME'] = previousHome;
    process.exitCode = undefined;
    const current = root;
    root = undefined;
    if (current !== undefined) {
      await rm(current, { recursive: true, force: true });
    }
  });

  it('text mode emits assistant text, resume hint, and completes', async () => {
    const stdout = writer();
    const stderr = writer();

    await runPrint(cliOptions(), '0.0.0-test', { stdout, stderr, process: processStub() }, {
      bindAgent: bindRequester(createScriptedRequester([{ text: 'hello world' }])),
    });

    expect(stdout.text()).toBe('• hello world\n\n');
    expect(stderr.text()).toContain('kimi version 0.0.0-test\n');
    expect(stderr.text()).toMatch(/To resume this session: kimi -r \S+\n/);
  }, 30_000);

  it('stream-json emits NDJSON assistant and meta lines with the session id', async () => {
    const stdout = writer();
    const stderr = writer();

    await runPrint(
      cliOptions({ outputFormat: 'stream-json' }),
      '0.0.0-test',
      { stdout, stderr, process: processStub() },
      { bindAgent: bindRequester(createScriptedRequester([{ text: 'hi there' }])) },
    );

    const lines = stdout
      .text()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toEqual({ role: 'meta', type: 'system.version', version: '0.0.0-test' });
    const assistant = lines.find((line) => line['role'] === 'assistant');
    expect(assistant).toEqual({ role: 'assistant', content: 'hi there' });
    const resume = lines.at(-1);
    expect(resume?.['role']).toBe('meta');
    expect(resume?.['type']).toBe('session.resume_hint');
    expect(typeof resume?.['session_id']).toBe('string');
    expect((resume?.['session_id'] as string).length).toBeGreaterThan(0);
    expect(stderr.text()).toBe('');
  }, 30_000);

  it('renders the tool call path: tool_calls on the assistant line, tool result line', async () => {
    const stdout = writer();
    const stderr = writer();

    await runPrint(
      cliOptions({ outputFormat: 'stream-json' }),
      '0.0.0-test',
      { stdout, stderr, process: processStub() },
      {
        bindAgent: bindRequester(
          createScriptedRequester([
            { toolCalls: [{ name: 'Bash', arguments: JSON.stringify({ command: 'echo tool-ran' }) }] },
            { text: 'done' },
          ]),
        ),
      },
    );

    const lines = stdout
      .text()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const assistant = lines.find((line) => line['role'] === 'assistant');
    const toolCalls = assistant?.['tool_calls'] as
      | Array<{ id: string; function: { name: string; arguments: string } }>
      | undefined;
    expect(toolCalls?.[0]?.function.name).toBe('Bash');
    const tool = lines.find((line) => line['role'] === 'tool');
    expect(tool?.['tool_call_id']).toBe(toolCalls?.[0]?.id);
    expect(String(tool?.['content'])).toContain('tool-ran');
  }, 30_000);

  it('never blocks on permission: an approval-requiring tool completes under mode auto', async () => {
    const stdout = writer();
    const stderr = writer();
    const requests: LlmRequestContent[] = [];

    await runPrint(
      cliOptions(),
      '0.0.0-test',
      { stdout, stderr, process: processStub() },
      {
        bindAgent: bindRequester(
          createScriptedRequester([
            {
              toolCalls: [{ name: 'Bash', arguments: JSON.stringify({ command: 'echo approved' }) }],
              onRequest: (content) => requests.push(content),
            },
            { text: 'finished', onRequest: (content) => requests.push(content) },
          ]),
        ),
      },
    );

    expect(stdout.text()).toContain('finished');
    const toolMessages = requests
      .at(-1)
      ?.messages.filter((message) => message.role === 'tool');
    expect(toolMessages?.length).toBeGreaterThan(0);
    const toolText = JSON.stringify(toolMessages);
    expect(toolText).toContain('approved');
    expect(toolText).not.toContain('was not run');
  }, 30_000);

  it('waits for an active goal to settle before exiting', async () => {
    const stdout = writer();
    const stderr = writer();
    let calls = 0;

    await runPrint(
      cliOptions({ prompt: '/goal ship the feature' }),
      '0.0.0-test',
      { stdout, stderr, process: processStub() },
      {
        bindAgent: bindRequester(
          createScriptedRequester([
            { text: 'starting work', onRequest: () => { calls += 1; } },
            {
              toolCalls: [{ name: 'UpdateGoal', arguments: JSON.stringify({ status: 'complete' }) }],
              onRequest: () => { calls += 1; },
            },
            { text: 'all done', onRequest: () => { calls += 1; } },
          ]),
        ),
      },
    );

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(stderr.text()).toContain('Goal [complete]');
    expect(process.exitCode ?? 0).toBe(0);
    expect(stderr.text()).toMatch(/To resume this session: kimi -r \S+\n/);
  }, 30_000);
});
