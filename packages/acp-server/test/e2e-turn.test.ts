import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getLiveSessionById, IAgentLifecycleService, IEventBus } from '@moonshot-ai/agent-core-v2';
import { ToolProgress } from '@moonshot-ai/agent-core-v2/agent/toolExecutor/toolExecutorEvents';
import { afterEach, describe, expect, it } from 'vitest';

import { mapPromptLaunchError } from '../src/session';
import { createTestClient, type TestClient } from './_helpers/acpClient';
import { writeFakeModelConfig } from './_helpers/fakeModelConfig';
import { solidPngBase64 } from './_helpers/png';
import { createScriptedProvider, type ScriptedProvider } from './_helpers/scriptedProvider';

const STDIO_MCP_FIXTURE = fileURLToPath(
  new URL('../../agent-core-v2/test/mcpCore/fixtures/mock-stdio-server.mjs', import.meta.url),
);

describe('acp-server real prompt turn (scripted LLM)', () => {
  let homeDir: string | undefined;
  let client: TestClient | undefined;
  let scripted: ScriptedProvider | undefined;

  afterEach(async () => {
    if (client !== undefined) {
      await client.close();
      client = undefined;
    }
    if (homeDir !== undefined) {
      await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      homeDir = undefined;
    }
  });

  function installTerminalClient(c: TestClient): void {
    c.onRequest('terminal/create', () => ({ terminalId: 'term-1' }));
    c.onRequest('terminal/output', () => ({
      output: 'hello_from_bash\ndelta_stream\n',
      truncated: false,
      exitStatus: { exitCode: 0, signal: null },
    }));
    c.onRequest('terminal/wait_for_exit', () => ({ exitCode: 0, signal: null }));
    c.onRequest('terminal/kill', () => ({}));
    c.onRequest('terminal/release', () => ({}));
  }

  async function boot(clientCapabilities: Record<string, unknown> = {}): Promise<TestClient> {
    homeDir = await mkdtemp(join(tmpdir(), 'acp-e2e-turn-'));
    await writeFakeModelConfig(homeDir);
    scripted = createScriptedProvider();
    client = await createTestClient({ homeDir, extraSeeds: [scripted.seed] });
    await client.send('initialize', { protocolVersion: 1, clientCapabilities });
    if (clientCapabilities['terminal'] === true) installTerminalClient(client);
    return client;
  }

  it('drives initialize → new → prompt and streams the assistant text as agent_message_chunk', async () => {
    const c = await boot();
    scripted!.mockNextText('hello from the scripted model');

    const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
      sessionId: string;
    };
    expect(created.sessionId).toMatch(/^session_/);
    await c.waitForSessionUpdate('available_commands_update', 10_000);

    const promptPromise = c.send('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'say hi' }],
    });

    const chunk = await c.waitForSessionUpdate('agent_message_chunk', 10_000);
    const update = (chunk.params as { update?: { content?: { text?: string } } }).update;
    expect(update?.content?.text).toContain('hello from the scripted model');

    const result = (await promptPromise) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');
    expect(scripted!.callCount()).toBe(1);

    const usage = await c.waitForSessionUpdate('usage_update', 10_000);
    const usageUpdate = (
      usage.params as { update?: { used?: number; size?: number; cost?: unknown } }
    ).update;
    expect(usageUpdate?.size).toBe(8192);
    expect(usageUpdate?.used).toBeGreaterThan(0);
    expect(usageUpdate?.cost).toBeUndefined();
  }, 30_000);

  it('runs a tool call and bridges the approval request to the client', async () => {
    const c = await boot({ terminal: true });
    scripted!.mockNextResponse({
      type: 'function',
      id: 'call_1',
      name: 'Bash',
      arguments: '{"command":"echo hello_from_bash"}',
    });
    scripted!.mockNextText('ran it');

    const permissionRequests: unknown[] = [];
    c.onRequest('session/request_permission', (params) => {
      permissionRequests.push(params);
      return { outcome: { outcome: 'selected', optionId: 'approve_once' } };
    });

    const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
      sessionId: string;
    };
    await c.waitForSessionUpdate('available_commands_update', 10_000);

    const promptPromise = c.send('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'run echo' }],
    });

    await c.waitForSessionUpdate('tool_call', 10_000);
    await c.waitForSessionUpdate('tool_call_update', 10_000);

    const result = (await promptPromise) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');
    expect(scripted!.callCount()).toBe(2);

    expect(permissionRequests).toHaveLength(1);
    const req = permissionRequests[0] as { toolCall?: { toolCallId?: string } };
    expect(req.toolCall?.toolCallId).toContain('call_1');

    type ToolCallUpdate = {
      sessionUpdate?: string;
      status?: string;
      content?: Array<{ content?: { text?: string } }>;
    };
    const terminal = c
      .sessionUpdates()
      .map((m) => (m.params as { update?: ToolCallUpdate }).update)
      .find((u) => u?.sessionUpdate === 'tool_call_update' && u?.status === 'completed');
    expect(terminal).toBeDefined();
    expect(JSON.stringify(scripted!.callHistory()[1])).toContain('hello_from_bash');
  }, 30_000);

  it('bridges AskUserQuestion through elicitation/create for form-capable clients', async () => {
    const c = await boot({ elicitation: { form: {} } });
    scripted!.mockNextResponse({
      type: 'function',
      id: 'call_q',
      name: 'AskUserQuestion',
      arguments: JSON.stringify({
        questions: [
          {
            question: 'Pick one',
            header: 'One',
            options: [{ label: 'A' }, { label: 'B' }],
            multi_select: false,
          },
          {
            question: 'Pick many',
            header: 'Many',
            options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }],
            multi_select: true,
          },
        ],
      }),
    });
    scripted!.mockNextText('noted');

    const elicitationRequests: unknown[] = [];
    c.onRequest('elicitation/create', (params) => {
      elicitationRequests.push(params);
      return { action: 'accept', content: { q0: 'B', q1: ['Z', 'X'] } };
    });
    const permissionRequests: unknown[] = [];
    c.onRequest('session/request_permission', (params) => {
      permissionRequests.push(params);
      return { outcome: { outcome: 'selected', optionId: 'approve_once' } };
    });

    const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
      sessionId: string;
    };
    await c.waitForSessionUpdate('available_commands_update', 10_000);

    const result = (await c.send('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'ask me things' }],
    })) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');
    expect(scripted!.callCount()).toBe(2);

    expect(elicitationRequests).toHaveLength(1);
    expect(permissionRequests.filter((p) => JSON.stringify(p).includes('AskUserQuestion')))
      .toHaveLength(0);
    const elicitation = elicitationRequests[0] as {
      mode?: string;
      toolCallId?: string;
      requestedSchema?: { required?: string[]; properties?: Record<string, { type?: string }> };
    };
    expect(elicitation.mode).toBe('form');
    expect(elicitation.toolCallId).toContain('call_q');
    expect(elicitation.requestedSchema?.required).toEqual(['q0', 'q1']);
    expect(elicitation.requestedSchema?.properties?.['q0']?.type).toBe('string');
    expect(elicitation.requestedSchema?.properties?.['q1']?.type).toBe('array');

    const history = JSON.stringify(scripted!.callHistory()[1]);
    expect(history).toContain('\\"Pick one\\":\\"B\\"');
    expect(history).toContain('\\"Pick many\\":\\"X, Z\\"');
  }, 30_000);

  it('rejects a second prompt while a turn is in flight', async () => {
    const c = await boot();
    scripted!.mockNextResponse({
      type: 'function',
      id: 'call_busy',
      name: 'Bash',
      arguments: '{"command":"echo busy_probe"}',
    });
    scripted!.mockNextText('done');

    let answerPermission: ((response: unknown) => void) | undefined;
    const permissionSeen = new Promise<void>((seen) => {
      c.onRequest('session/request_permission', () => {
        seen();
        return new Promise((resolve) => {
          answerPermission = resolve;
        });
      });
    });

    const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
      sessionId: string;
    };
    await c.waitForSessionUpdate('available_commands_update', 10_000);

    const firstPrompt = c.send('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'run echo' }],
    });
    await permissionSeen;

    await expect(
      c.send('session/prompt', {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'again' }],
      }),
    ).rejects.toThrow(/another turn is already in progress/);

    answerPermission!({ outcome: { outcome: 'selected', optionId: 'approve_once' } });
    const result = (await firstPrompt) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');
    expect(scripted!.callCount()).toBe(2);
  }, 30_000);

  it('settles as cancelled when cancel arrives while the launch is in flight', async () => {
    const c = await boot();
    scripted!.mockNextResponse({
      type: 'function',
      id: 'call_cancel',
      name: 'Bash',
      arguments: '{"command":"echo cancel_probe"}',
    });
    c.onRequest('session/request_permission', () => ({
      outcome: { outcome: 'selected', optionId: 'approve_once' },
    }));

    const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
      sessionId: string;
    };
    await c.waitForSessionUpdate('available_commands_update', 10_000);

    const promptPromise = c.send('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'run echo' }],
    });
    c.notify('session/cancel', { sessionId: created.sessionId });

    const result = (await promptPromise) as { stopReason: string };
    expect(result.stopReason).toBe('cancelled');
  }, 30_000);

  it('attaches locations to a file tool call and its terminal update', async () => {
    const c = await boot();
    const filePath = join(homeDir!, 'note.txt');
    await writeFile(filePath, 'location probe');
    scripted!.mockNextResponse({
      type: 'function',
      id: 'call_read',
      name: 'Read',
      arguments: JSON.stringify({ path: filePath }),
    });
    scripted!.mockNextText('read it');

    c.onRequest('session/request_permission', () => ({
      outcome: { outcome: 'selected', optionId: 'approve_once' },
    }));

    const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
      sessionId: string;
    };
    await c.waitForSessionUpdate('available_commands_update', 10_000);

    const promptPromise = c.send('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'read the note' }],
    });

    type ToolCallWire = {
      sessionUpdate?: string;
      status?: string;
      locations?: Array<{ path: string; line?: number | null }>;
    };
    const updateOf = (m: unknown) => (m as { params?: { update?: ToolCallWire } }).params?.update;

    const createdNotification = await c.waitForSessionUpdate('tool_call', 10_000);
    expect(updateOf(createdNotification)?.status).toBe('pending');
    expect(updateOf(createdNotification)?.locations).toBeUndefined();

    const result = (await promptPromise) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');

    const updates = c.sessionUpdates().map(updateOf);
    const upgrade = updates.find(
      (u) => u?.sessionUpdate === 'tool_call_update' && u?.locations !== undefined,
    );
    expect(upgrade?.locations?.[0]?.path).toBe(filePath);

    const terminal = updates.find(
      (u) => u?.sessionUpdate === 'tool_call_update' && u?.status === 'completed',
    );
    expect(terminal?.locations?.[0]?.path).toBe(filePath);
  }, 30_000);

  it('settles as cancelled without launching a turn when cancel arrives during image compression', async () => {
    const c = await boot();
    const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
      sessionId: string;
    };
    await c.waitForSessionUpdate('available_commands_update', 10_000);

    const promptPromise = c.send('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'image', data: solidPngBase64(3600, 1800), mimeType: 'image/png' }],
    });
    c.notify('session/cancel', { sessionId: created.sessionId });
    const result = (await promptPromise) as { stopReason: string };

    expect(result.stopReason).toBe('cancelled');
    expect(scripted!.callCount()).toBe(0);
  }, 30_000);

  it('streams tool-call args deltas: lazy pending CREATE → cumulative update → started upgrade → completed', async () => {
    const c = await boot({ terminal: true });
    scripted!.mockNextResponse(
      { type: 'function', id: 'call_1', name: 'Bash', arguments: '{"command":"ec' },
      { type: 'tool_call_part', argumentsPart: 'ho delta_stream"}' },
    );
    scripted!.mockNextText('done');
    c.onRequest('session/request_permission', () => ({
      outcome: { outcome: 'selected', optionId: 'approve_once' },
    }));

    const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
      sessionId: string;
    };
    await c.waitForSessionUpdate('available_commands_update', 10_000);

    const promptPromise = c.send('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'run echo' }],
    });
    const result = (await promptPromise) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');

    type ToolCallWire = {
      sessionUpdate?: string;
      toolCallId?: string;
      status?: string;
      title?: string;
      kind?: string;
      rawInput?: unknown;
      content?: Array<{ content?: { text?: string } }>;
    };
    const updates = c
      .sessionUpdates()
      .map((m) => (m.params as { update?: ToolCallWire }).update)
      .filter((u) => u?.toolCallId?.endsWith(':call_1'));
    const textOf = (u: ToolCallWire | undefined) =>
      u?.content?.map((entry) => entry.content?.text ?? '').join('') ?? '';

    expect(updates[0]?.sessionUpdate).toBe('tool_call');
    expect(updates[0]?.status).toBe('pending');
    expect(updates[0]?.title).toBe('Bash');
    expect(updates[0]?.kind).toBe('execute');
    expect(updates[0]?.rawInput).toBeUndefined();
    expect(textOf(updates[0])).toBe('{"command":"ec');

    expect(updates[1]?.sessionUpdate).toBe('tool_call_update');
    expect(updates[1]?.status).toBe('in_progress');
    expect(textOf(updates[1])).toBe('{"command":"echo delta_stream"}');

    expect(updates[2]?.sessionUpdate).toBe('tool_call_update');
    expect(updates[2]?.status).toBe('in_progress');
    expect(updates[2]?.kind).toBe('execute');
    expect(updates[2]?.rawInput).toEqual({ command: 'echo delta_stream' });

    const terminal = updates.at(-1);
    expect(terminal?.sessionUpdate).toBe('tool_call_update');
    expect(terminal?.status).toBe('completed');
    expect(JSON.stringify(scripted!.callHistory()[1])).toContain('delta_stream');
  }, 30_000);

  it('refreshes the tool card title on a status progress update and drops other progress kinds', async () => {
    const c = await boot();
    scripted!.mockNextResponse({
      type: 'function',
      id: 'call_1',
      name: 'Bash',
      arguments: JSON.stringify({ command: 'sleep 1 && echo progress_done' }),
    });
    scripted!.mockNextText('done');
    c.onRequest('session/request_permission', () => ({
      outcome: { outcome: 'selected', optionId: 'approve_once' },
    }));

    const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
      sessionId: string;
    };
    await c.waitForSessionUpdate('available_commands_update', 10_000);

    const promptPromise = c.send('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'run it' }],
    });

    const create = await c.waitForSessionUpdate('tool_call', 10_000);
    const wireId = (create.params as { update?: { toolCallId?: string } }).update?.toolCallId;
    const turnId = Number(wireId?.split(':')[0]);
    const session = getLiveSessionById(c.server.core.accessor, created.sessionId);
    const agentHandle = session?.accessor.get(IAgentLifecycleService).handleOf('main');
    const bus = agentHandle?.accessor.get(IEventBus);
    expect(bus).toBeDefined();
    bus!.publish(
      new ToolProgress({
        agentId: 'main',
        turnId,
        toolCallId: 'call_1',
        update: { kind: 'stdout', text: 'raw-stdout-bytes' },
      }),
    );
    bus!.publish(
      new ToolProgress({
        agentId: 'main',
        turnId,
        toolCallId: 'call_1',
        update: { kind: 'status', text: 'Still working…' },
      }),
    );

    const result = (await promptPromise) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');

    type ToolCallWire = { sessionUpdate?: string; toolCallId?: string; title?: string };
    const updates = c
      .sessionUpdates()
      .map((m) => (m.params as { update?: ToolCallWire }).update)
      .filter((u) => u?.toolCallId === wireId);
    expect(
      updates.some((u) => u?.sessionUpdate === 'tool_call_update' && u?.title === 'Still working…'),
    ).toBe(true);
    expect(updates.some((u) => u?.title === 'raw-stdout-bytes')).toBe(false);
  }, 30_000);
});

describe('mapPromptLaunchError', () => {
  it('maps an auth-coded rejection to auth_required (-32000)', () => {
    const error = Object.assign(new Error('Provider returned 401'), {
      code: 'provider.auth_error',
    });
    const mapped = mapPromptLaunchError(error, 'sess-x');
    expect(mapped.code).toBe(-32000);
  });

  it('maps turn.agent_busy to invalidRequest (-32600)', () => {
    const error = Object.assign(new Error('Cannot activate skill while another turn is active'), {
      code: 'turn.agent_busy',
    });
    const mapped = mapPromptLaunchError(error, 'sess-x');
    expect(mapped.code).toBe(-32600);
  });

  it('maps a generic rejection to a fixed internalError without leaking the raw message', () => {
    const mapped = mapPromptLaunchError(new Error('boom internal secret'), 'sess-x');
    expect(mapped.code).toBe(-32603);
    expect(mapped.message).toBe('Internal error: session prompt failed');
    expect(JSON.stringify(mapped)).not.toContain('boom internal secret');
  });
});

describe('acp-server prompt error hygiene', () => {
  let homeDir: string | undefined;
  let client: TestClient | undefined;

  afterEach(async () => {
    if (client !== undefined) {
      await client.close();
      client = undefined;
    }
    if (homeDir !== undefined) {
      await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      homeDir = undefined;
    }
  });

  it('a launch failure settles as a fixed internalError and never leaks the engine message', async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'acp-prompt-error-'));
    client = await createTestClient({ homeDir });
    const c = client;
    await c.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
      sessionId: string;
    };

    await c.server.klient.session(created.sessionId).delete();

    let captured: unknown;
    try {
      await c.send('session/prompt', {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      });
    } catch (error) {
      captured = error;
    }
    const serialized = JSON.stringify((captured as Error)?.message ?? String(captured));
    expect(serialized).toContain('-32603');
    expect(serialized).toContain('session prompt failed');
    expect(serialized).not.toContain('session not found');
    expect(serialized).not.toContain(created.sessionId);
  }, 30_000);
});

describe('acp-server builtin slash commands (local execution, no LLM turn)', () => {
  let homeDir: string | undefined;
  let client: TestClient | undefined;
  let scripted: ScriptedProvider | undefined;

  afterEach(async () => {
    if (client !== undefined) {
      await client.close();
      client = undefined;
    }
    if (homeDir !== undefined) {
      await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      homeDir = undefined;
    }
  });

  async function boot(): Promise<TestClient> {
    homeDir = await mkdtemp(join(tmpdir(), 'acp-builtin-'));
    await writeFakeModelConfig(homeDir);
    scripted = createScriptedProvider();
    client = await createTestClient({ homeDir, extraSeeds: [scripted.seed] });
    await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    return client;
  }

  async function newSession(c: TestClient): Promise<string> {
    const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
      sessionId: string;
    };
    await c.waitForSessionUpdate('available_commands_update', 10_000);
    return created.sessionId;
  }

  async function runSlash(
    c: TestClient,
    sessionId: string,
    text: string,
  ): Promise<{ chunk: string; stopReason: string }> {
    const before = c.sessionUpdates().length;
    const result = (await c.send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    })) as { stopReason: string };
    type Update = { sessionUpdate?: string; content?: { text?: string } };
    const chunk = c
      .sessionUpdates()
      .slice(before)
      .map((m) => (m.params as { update?: Update }).update)
      .find((u) => u?.sessionUpdate === 'agent_message_chunk');
    expect(chunk).toBeDefined();
    return { chunk: chunk?.content?.text ?? '', stopReason: result.stopReason };
  }

  it('/usage answers with the context token usage and never calls the model', async () => {
    const c = await boot();
    const sessionId = await newSession(c);

    const { chunk, stopReason } = await runSlash(c, sessionId, '/usage');
    expect(stopReason).toBe('end_turn');
    expect(chunk).toContain('Context: 0 / 8192 tokens');
    expect(chunk).toContain('no LLM calls yet');
    expect(scripted!.callCount()).toBe(0);
  }, 30_000);

  it('/status answers with the session summary and never calls the model', async () => {
    const c = await boot();
    const sessionId = await newSession(c);

    const { chunk, stopReason } = await runSlash(c, sessionId, '/status');
    expect(stopReason).toBe('end_turn');
    expect(chunk).toContain(`Session: ${sessionId}`);
    expect(chunk).toContain('Model: fake');
    expect(chunk).toContain('Mode: default');
    expect(chunk).toContain(`Working directory: ${homeDir}`);
    expect(scripted!.callCount()).toBe(0);
  }, 30_000);

  it('/help lists every advertised builtin command and never calls the model', async () => {
    const c = await boot();
    const sessionId = await newSession(c);

    const { chunk, stopReason } = await runSlash(c, sessionId, '/help');
    expect(stopReason).toBe('end_turn');
    for (const name of ['compact', 'status', 'usage', 'mcp', 'tasks', 'help']) {
      expect(chunk).toContain(`/${name}`);
    }
    expect(scripted!.callCount()).toBe(0);
  }, 30_000);

  it('/tasks answers with the empty background-task list and never calls the model', async () => {
    const c = await boot();
    const sessionId = await newSession(c);

    const { chunk, stopReason } = await runSlash(c, sessionId, '/tasks');
    expect(stopReason).toBe('end_turn');
    expect(chunk).toContain('No background tasks.');
    expect(scripted!.callCount()).toBe(0);
  }, 30_000);

  it('/mcp lists the session MCP servers and never calls the model', async () => {
    const c = await boot();
    const created = (await c.send('session/new', {
      cwd: homeDir,
      mcpServers: [
        {
          type: 'http',
          name: 'mock',
          url: 'http://127.0.0.1:1/mcp',
          headers: [{ name: 'X-Test-Fixture', value: STDIO_MCP_FIXTURE }],
        },
      ],
    })) as { sessionId: string };
    await c.waitForSessionUpdate('available_commands_update', 10_000);

    const { chunk, stopReason } = await runSlash(c, created.sessionId, '/mcp');
    expect(stopReason).toBe('end_turn');
    expect(chunk).toContain('MCP servers (1):');
    expect(chunk).toContain('- mock (http):');
    expect(scripted!.callCount()).toBe(0);
  }, 30_000);

  it('/mcp on a session without servers says so and never calls the model', async () => {
    const c = await boot();
    const sessionId = await newSession(c);

    const { chunk, stopReason } = await runSlash(c, sessionId, '/mcp');
    expect(stopReason).toBe('end_turn');
    expect(chunk).toContain('No MCP servers configured for this session.');
    expect(scripted!.callCount()).toBe(0);
  }, 30_000);

  it('/compact triggers engine compaction (fire-and-forget) after a turn', async () => {
    const c = await boot();
    const sessionId = await newSession(c);

    scripted!.mockNextText('turn reply');
    const result = (await c.send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'say something' }],
    })) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');
    scripted!.mockNextText('compaction summary');

    const { chunk, stopReason } = await runSlash(c, sessionId, '/compact');
    expect(stopReason).toBe('end_turn');
    expect(chunk).toContain('Context compaction started');
  }, 30_000);

  it('/compact reports the completion summary as a follow-up agent_message_chunk', async () => {
    const c = await boot();
    const sessionId = await newSession(c);

    scripted!.mockNextText('turn reply');
    const result = (await c.send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'say something' }],
    })) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');
    scripted!.mockNextText('compaction summary');

    const { chunk, stopReason } = await runSlash(c, sessionId, '/compact keep it short');
    expect(stopReason).toBe('end_turn');
    expect(chunk).toContain('Context compaction started');

    const completion = await waitForChunk(c, 'Compaction completed.');
    expect(completion).toContain('Messages compacted:');
    expect(completion).toContain('Tokens before:');
    expect(completion).toContain('Tokens after:');
  }, 30_000);

  async function waitForChunk(c: TestClient, needle: string, timeoutMs = 10_000): Promise<string> {
    type Update = { sessionUpdate?: string; content?: { text?: string } };
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = c
        .sessionUpdates()
        .map((m) => (m.params as { update?: Update }).update)
        .find(
          (u) => u?.sessionUpdate === 'agent_message_chunk' && u.content?.text?.includes(needle),
        );
      if (hit !== undefined) return hit.content?.text ?? '';
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for an agent_message_chunk containing '${needle}'`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it('/compact on an empty history surfaces the engine refusal and never calls the model', async () => {
    const c = await boot();
    const sessionId = await newSession(c);

    const { chunk, stopReason } = await runSlash(c, sessionId, '/compact');
    expect(stopReason).toBe('end_turn');
    expect(chunk).toContain('/compact failed:');
    expect(chunk).toContain('No messages to compact');
    expect(scripted!.callCount()).toBe(0);
  }, 30_000);
});

describe('acp-server terminal reverse-RPC (clientCapabilities.terminal)', () => {
  let homeDir: string | undefined;
  let client: TestClient | undefined;
  let scripted: ScriptedProvider | undefined;

  afterEach(async () => {
    if (client !== undefined) {
      await client.close();
      client = undefined;
    }
    if (homeDir !== undefined) {
      await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      homeDir = undefined;
    }
  });

  interface FakeTerminal {
    readonly id: string;
    readonly createParams: {
      sessionId?: string;
      command?: string;
      args?: string[];
      env?: Array<{ name: string; value: string }>;
      cwd?: string;
      outputByteLimit?: number;
    };
    output: string;
    exitCode: number;
    killed: boolean;
    released: boolean;
  }

  function fakeTerminalClient(c: TestClient, output: string, exitCode = 0): FakeTerminal[] {
    const terminals: FakeTerminal[] = [];
    let next = 0;
    c.onRequest('terminal/create', (params) => {
      next += 1;
      const terminal: FakeTerminal = {
        id: `term-${String(next)}`,
        createParams: params as FakeTerminal['createParams'],
        output,
        exitCode,
        killed: false,
        released: false,
      };
      terminals.push(terminal);
      return { terminalId: terminal.id };
    });
    c.onRequest('terminal/output', (params) => {
      const t = terminals.find((x) => x.id === (params as { terminalId?: string }).terminalId);
      return {
        output: t?.output ?? '',
        truncated: false,
        exitStatus: { exitCode: t?.exitCode ?? null, signal: null },
      };
    });
    c.onRequest('terminal/wait_for_exit', (params) => {
      const t = terminals.find((x) => x.id === (params as { terminalId?: string }).terminalId);
      return { exitCode: t?.exitCode ?? null, signal: null };
    });
    c.onRequest('terminal/kill', (params) => {
      const t = terminals.find((x) => x.id === (params as { terminalId?: string }).terminalId);
      if (t !== undefined) t.killed = true;
      return {};
    });
    c.onRequest('terminal/release', (params) => {
      const t = terminals.find((x) => x.id === (params as { terminalId?: string }).terminalId);
      if (t !== undefined) t.released = true;
      return {};
    });
    return terminals;
  }

  async function boot(clientCapabilities: Record<string, unknown>): Promise<TestClient> {
    homeDir = await mkdtemp(join(tmpdir(), 'acp-terminal-'));
    await writeFakeModelConfig(homeDir);
    scripted = createScriptedProvider();
    client = await createTestClient({ homeDir, extraSeeds: [scripted.seed] });
    await client.send('initialize', { protocolVersion: 1, clientCapabilities });
    return client;
  }

  function scriptBashTurn(command: string): void {
    scripted!.mockNextResponse({
      type: 'function',
      id: 'call_1',
      name: 'Bash',
      arguments: JSON.stringify({ command }),
    });
    scripted!.mockNextText('done');
  }

  async function runPrompt(c: TestClient): Promise<{ sessionId: string; stopReason: string }> {
    c.onRequest('session/request_permission', () => ({
      outcome: { outcome: 'selected', optionId: 'approve_once' },
    }));
    const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
      sessionId: string;
    };
    await c.waitForSessionUpdate('available_commands_update', 10_000);
    const result = (await c.send('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'run it' }],
    })) as { stopReason: string };
    return { sessionId: created.sessionId, stopReason: result.stopReason };
  }

  type ToolCallUpdate = {
    sessionUpdate?: string;
    status?: string;
    content?: Array<{ type?: string; terminalId?: string; content?: { text?: string } }>;
  };

  const toolCallUpdates = (c: TestClient): ToolCallUpdate[] =>
    c
      .sessionUpdates()
      .map((m) => (m.params as { update?: ToolCallUpdate }).update)
      .filter((u): u is ToolCallUpdate => u?.sessionUpdate === 'tool_call_update');

  it('routes the Bash tool through terminal/* when the client advertises the capability', async () => {
    const c = await boot({ terminal: true });
    const terminals = fakeTerminalClient(c, 'hello_from_terminal\n');
    scriptBashTurn('echo hello_from_terminal');

    const { sessionId, stopReason } = await runPrompt(c);
    expect(stopReason).toBe('end_turn');
    expect(scripted!.callCount()).toBe(2);

    expect(terminals).toHaveLength(1);
    const t = terminals[0]!;
    expect(t.createParams.sessionId).toBe(sessionId);
    expect(t.createParams.args?.[0]).toBe('-c');
    expect(t.createParams.args?.[1]).toContain('echo hello_from_terminal');
    expect(t.createParams.cwd).toBe(homeDir);
    expect(t.createParams.env).toContainEqual({ name: 'TERM', value: 'dumb' });

    expect(t.released).toBe(true);
    expect(t.killed).toBe(false);

    const updates = toolCallUpdates(c);
    const attached = updates.find((u) => u.content?.[0]?.type === 'terminal');
    expect(attached?.content?.[0]?.terminalId).toBe(t.id);
    const completed = updates.find((u) => u.status === 'completed');
    expect(completed?.content).toEqual([{ type: 'terminal', terminalId: t.id }]);

    const secondCall = scripted!.callHistory()[1];
    expect(JSON.stringify(secondCall)).toContain('hello_from_terminal');
  }, 30_000);

  it('falls back to local execution when the client does not advertise the capability', async () => {
    const c = await boot({});
    const terminals = fakeTerminalClient(c, 'should_not_be_used\n');
    scriptBashTurn('echo hello_from_bash');

    const { stopReason } = await runPrompt(c);
    expect(stopReason).toBe('end_turn');

    expect(terminals).toHaveLength(0);
    const terminalRpcs = c.received.filter(
      (m) => typeof m.method === 'string' && m.method.startsWith('terminal/'),
    );
    expect(terminalRpcs).toHaveLength(0);

    const completed = toolCallUpdates(c).find((u) => u.status === 'completed');
    const text = completed?.content?.map((entry) => entry.content?.text ?? '').join('\n') ?? '';
    expect(text).toContain('hello_from_bash');
  }, 30_000);
});
