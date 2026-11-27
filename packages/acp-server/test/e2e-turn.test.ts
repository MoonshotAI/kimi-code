import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RequestError, type NewSessionResponse, type RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { getLiveSessionById, IAgentLifecycleService, IEventBus, type Interaction } from '@moonshot-ai/agent-core-v2';
import { ToolUpdated } from '@moonshot-ai/agent-core-v2/agent/toolExecutor/toolExecutorEvents';
import { askUserQuestion, call, createFakeModel, exitPlanMode, say, write, type FakeModel } from '@moonshot-ai/testkit/model';
import { slashPathOf } from '@moonshot-ai/testkit/fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AcpInteractionBridge } from '../src/interaction-bridge';
import { AcpSession, mapPromptLaunchError } from '../src/session';
import { createTestClient, type TestClient } from './_helpers/acpClient';
import { writeFakeModelConfig, type FakeModelConfigOptions } from './_helpers/fakeModelConfig';
import { solidPngBase64 } from './_helpers/png';

describe('acp-server real prompt turn (scripted LLM)', () => {
  let homeDir: string | undefined;
  let client: TestClient | undefined;
  let model: FakeModel | undefined;

  afterEach(async () => {
    if (client !== undefined) {
      await client.close();
      client = undefined;
    }
    if (model !== undefined) {
      const current = model;
      model = undefined;
      try {
        current.verify();
      } finally {
        await current.close();
      }
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

  async function boot(
    clientCapabilities: Record<string, unknown> = {},
    imageInput = false,
    defaults?: Pick<FakeModelConfigOptions, 'defaultPlanMode' | 'defaultPermissionMode'>,
  ): Promise<TestClient> {
    homeDir = await mkdtemp(join(tmpdir(), 'acp-e2e-turn-'));
    model = createFakeModel();
    await model.listen();
    await writeFakeModelConfig(homeDir, { image: imageInput, baseUrl: model.origin, ...defaults });
    client = await createTestClient({ homeDir });
    await client.send('initialize', { protocolVersion: 1, clientCapabilities });
    if (clientCapabilities['terminal'] === true) installTerminalClient(client);
    return client;
  }

  it('drives initialize → new → prompt and streams the assistant text as agent_message_chunk', async () => {
    const c = await boot();
    model!.script(say('hello from the scripted model'));

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
    expect(model!.requests().length).toBe(1);

    const usage = await c.waitForSessionUpdate('usage_update', 10_000);
    const usageUpdate = (
      usage.params as { update?: { used?: number; size?: number; cost?: unknown } }
    ).update;
    expect(usageUpdate?.size).toBe(262144);
    expect(usageUpdate?.used).toBeGreaterThan(0);
    expect(usageUpdate?.cost).toBeUndefined();
  }, 30_000);

  it('replays a file tool card at the session directory, even when the editor loads the session from another one', async () => {
    const c = await boot();
    const project = join(homeDir!, 'project');
    const elsewhere = join(homeDir!, 'elsewhere');
    await mkdir(project);
    await mkdir(elsewhere);
    await writeFile(join(project, 'notes.txt'), 'hello\n');
    model!.script(call('Read', { path: 'notes.txt' }, { id: 'call_read' }), say('read it'));

    const created = (await c.send('session/new', { cwd: project, mcpServers: [] })) as { sessionId: string };
    await c.waitForSessionUpdate('available_commands_update', 10_000);
    await c.send('session/prompt', { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'read the notes' }] });

    const beforeLoad = c.sessionUpdates().length;
    await c.send('session/load', { sessionId: created.sessionId, cwd: elsewhere, mcpServers: [] });
    type ToolCallWire = { sessionUpdate?: string; toolCallId?: string; locations?: Array<{ path: string }> };
    const replayed = c
      .sessionUpdates()
      .slice(beforeLoad)
      .map((m) => (m.params as { update?: ToolCallWire }).update)
      .find((u) => u?.sessionUpdate === 'tool_call' && u.toolCallId?.endsWith(':call_read'));
    const located = replayed?.locations?.[0]?.path;

    expect(located).toBeDefined();
    expect(await realpath(located!)).toBe(await realpath(join(project, 'notes.txt')));
  }, 30_000);

  it.each([
    { optionId: 'plan_approve', expectedMode: 'default' },
    { optionId: 'plan_reject_and_exit', expectedMode: 'default' },
    { optionId: 'plan_approve', expectedMode: 'yolo', defaults: { defaultPlanMode: true, defaultPermissionMode: 'yolo' as const } },
  ])('uses editor files for plan review and reports $expectedMode after $optionId', async ({ optionId, expectedMode, defaults }) => {
    const c = await boot({ fs: { readTextFile: true, writeTextFile: true } }, false, defaults);
    const plan = '# Proposed plan\n\nUpdate the example documentation.\n';
    const permissions: RequestPermissionRequest[] = [];
    let planPath: string | undefined;
    c.onRequest('fs/read_text_file', async (params) => {
      const { path } = params as { path: string };
      try {
        return { content: await readFile(path, 'utf8') };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw RequestError.resourceNotFound(path);
        throw error;
      }
    });
    c.onRequest('fs/write_text_file', async (params) => {
      const { path, content } = params as { path: string; content: string };
      await writeFile(path, content);
      return {};
    });
    c.onRequest('session/request_permission', (params) => {
      permissions.push(params as RequestPermissionRequest);
      return { outcome: { outcome: 'selected', optionId } };
    });

    model!.script(
      (request) => {
        planPath = /^Plan file: (.+)$/m.exec(request.remindersSinceReply.join('\n'))?.[1];
        if (planPath === undefined) throw new Error('The model did not receive the plan file in its plan mode reminder.');
        return write({ path: planPath, content: plan });
      },
      exitPlanMode(),
      ...(optionId === 'plan_approve' ? [say('The plan was approved.')] : []),
    );
    const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as NewSessionResponse;
    const { sessionId } = created;
    if (defaults === undefined) {
      await c.send('session/set_mode', { sessionId, modeId: 'plan' });
    }
    const start = c.sessionUpdates().length;
    const result = await c.send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Prepare a plan.' }] });
    expect(result).toMatchObject({ stopReason: 'end_turn' });
    expect(permissions).toHaveLength(1);
    expect(permissions[0]?.toolCall.content).toContainEqual({
      type: 'content',
      content: { type: 'text', text: expect.stringContaining(plan.trim()) },
    });
    expect(await readFile(planPath!, 'utf8')).toBe(plan);
    const updates = () => c.sessionUpdates().slice(start).map(({ params }) => (params as { update: unknown }).update);
    await expect.poll(updates).toContainEqual({ sessionUpdate: 'current_mode_update', currentModeId: expectedMode });
    await expect.poll(updates, { timeout: 5_000 }).toContainEqual({
      sessionUpdate: 'config_option_update',
      configOptions: expect.arrayContaining([expect.objectContaining({ id: 'mode', currentValue: expectedMode })]),
    });
  }, 30_000);

  it('runs a tool call and bridges the approval request to the client', async () => {
    const c = await boot({ terminal: true });
    model!.script(call('Bash', { command: 'printf hello_from_bash > approval-probe.txt' }, { id: 'call_1' }));
    model!.script(say('ran it'));

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
    expect(model!.requests().length).toBe(2);

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
    expect(model!.requests()[1]?.rawBody).toContain('hello_from_bash');
  }, 30_000);

  it('keeps a command card on the editor terminal, without repeating its output as text, when the editor offers terminals', async () => {
    const c = await boot({ terminal: true });
    model!.script(call('Bash', { command: 'printf terminal_probe' }, { id: 'call_term' }), say('ran it'));
    c.onRequest('session/request_permission', () => ({
      outcome: { outcome: 'selected', optionId: 'approve_once' },
    }));
    const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as { sessionId: string };
    await c.waitForSessionUpdate('available_commands_update', 10_000);

    const result = (await c.send('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'run it' }],
    })) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');
    expect(model!.requests()[1]?.rawBody).toContain('delta_stream');

    type ToolCallWire = { sessionUpdate?: string; toolCallId?: string; content?: Array<{ type: string }> };
    const cardUpdates = c
      .sessionUpdates()
      .map((m) => (m.params as { update?: ToolCallWire }).update)
      .filter((u) => u?.sessionUpdate === 'tool_call_update' && u.toolCallId?.endsWith(':call_term'));
    expect(cardUpdates.at(-1)?.content).toEqual([{ type: 'terminal', terminalId: 'term-1' }]);
    expect(JSON.stringify(cardUpdates)).not.toContain('delta_stream');
  }, 30_000);

  it('bridges AskUserQuestion through elicitation/create for form-capable clients', async () => {
    const c = await boot({ elicitation: { form: {} } });
    model!.script(call('AskUserQuestion', {
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
    }, { id: 'call_q' }));
    model!.script(say('noted'));

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
    expect(model!.requests().length).toBe(2);

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

    const history = model!.requests()[1]?.rawBody;
    expect(history).toContain('\\"Pick one\\":\\"B\\"');
    expect(history).toContain('\\"Pick many\\":\\"X, Z\\"');
  }, 30_000);

  it('rejects a second prompt while a turn is in flight', async () => {
    const c = await boot();
    model!.script(call('Bash', { command: 'printf busy_probe > approval-probe.txt' }, { id: 'call_busy' }));
    model!.script(say('done'));

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
    expect(model!.requests().length).toBe(2);
  }, 30_000);

  it('settles as cancelled when cancel arrives while the launch is in flight', async () => {
    const c = await boot();
    model!.lane('main').unscripted('hang');
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
    model!.script(call('Read', { path: filePath }, { id: 'call_read' }));
    model!.script(say('read it'));

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
    expect(model!.requests().length).toBe(0);
  }, 30_000);

  it('streams tool-call args deltas: lazy pending CREATE → cumulative update → started upgrade → completed', async () => {
    const c = await boot({ terminal: true }, true);
    model!.script(call('Bash', { command: 'echo delta_stream' }, { id: 'call_1', argumentChunks: 2 }));
    model!.script(say('done'));
    c.onRequest('session/request_permission', () => ({
      outcome: { outcome: 'selected', optionId: 'approve_once' },
    }));

    const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
      sessionId: string;
    };
    await c.waitForSessionUpdate('available_commands_update', 10_000);

    const bashResult = (await c.send('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'run the command' }],
    })) as { stopReason: string };
    expect(bashResult.stopReason).toBe('end_turn');

    type ToolCallWire = {
      sessionUpdate?: string;
      toolCallId?: string;
      status?: string;
      title?: string;
      kind?: string;
      rawInput?: unknown;
      rawOutput?: unknown;
      content?: Array<{ type?: string; content?: { type?: string; text?: string } }>;
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
    expect(textOf(updates[0])).toBe('');

    const fullArgs = '{"command":"echo delta_stream"}';
    const partial = textOf(updates[1]);
    expect(updates[1]?.sessionUpdate).toBe('tool_call_update');
    expect(updates[1]?.status).toBe('in_progress');
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(fullArgs.length);
    expect(fullArgs.startsWith(partial)).toBe(true);

    expect(updates[2]?.sessionUpdate).toBe('tool_call_update');
    expect(updates[2]?.status).toBe('in_progress');
    expect(textOf(updates[2])).toBe(fullArgs);

    expect(updates[3]?.sessionUpdate).toBe('tool_call_update');
    expect(updates[3]?.status).toBe('in_progress');
    expect(updates[3]?.kind).toBe('execute');
    expect(updates[3]?.rawInput).toEqual({ command: 'echo delta_stream' });

    expect(updates.at(-1)?.sessionUpdate).toBe('tool_call_update');
    expect(updates.at(-1)?.status).toBe('completed');
    expect(model!.requests()[1]?.rawBody).toContain('delta_stream');

    const mediaCallOffset = model!.requests().length;
    const mediaPath = join(homeDir!, 'picture.png');
    await writeFile(mediaPath, Buffer.from(solidPngBase64(1, 1), 'base64'));
    const args = JSON.stringify({ path: mediaPath });
    model!.script(call('ReadMediaFile', { path: mediaPath }, { id: 'call_media', argumentChunks: 2 }));
    model!.script(say('done'));

    const mediaResult = (await c.send('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'read the picture' }],
    })) as { stopReason: string };
    expect(mediaResult.stopReason).toBe('end_turn');

    const mediaUpdates = c
      .sessionUpdates()
      .map((m) => (m.params as { update?: ToolCallWire }).update)
      .filter((u) => u?.toolCallId?.endsWith(':call_media'));
    expect(mediaUpdates[0]?.sessionUpdate).toBe('tool_call');
    expect(mediaUpdates[0]?.status).toBe('pending');
    expect(mediaUpdates[0]?.title).toBe('ReadMediaFile');
    expect(mediaUpdates[0]?.kind).toBe('other');
    expect(mediaUpdates[0]?.rawInput).toBeUndefined();
    expect(textOf(mediaUpdates[0])).toBe('');
    const mediaPartial = textOf(mediaUpdates[1]);
    expect(mediaUpdates[1]?.sessionUpdate).toBe('tool_call_update');
    expect(mediaUpdates[1]?.status).toBe('in_progress');
    expect(mediaPartial.length).toBeGreaterThan(0);
    expect(mediaPartial.length).toBeLessThan(args.length);
    expect(args.startsWith(mediaPartial)).toBe(true);
    expect(mediaUpdates[2]?.sessionUpdate).toBe('tool_call_update');
    expect(mediaUpdates[2]?.status).toBe('in_progress');
    expect(textOf(mediaUpdates[2])).toBe(args);
    expect(mediaUpdates[3]?.sessionUpdate).toBe('tool_call_update');
    expect(mediaUpdates[3]?.status).toBe('in_progress');
    expect(mediaUpdates[3]?.kind).toBe('other');
    expect(mediaUpdates[3]?.rawInput).toEqual({ path: mediaPath });

    const terminal = mediaUpdates.at(-1);
    expect(terminal?.sessionUpdate).toBe('tool_call_update');
    expect(terminal?.status).toBe('completed');
    expect(terminal?.rawOutput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'image_url',
          imageUrl: expect.objectContaining({ url: expect.any(String) }),
        }),
      ]),
    );
    expect(JSON.stringify(terminal?.rawOutput)).not.toContain('"source"');
    expect(model!.requests()[mediaCallOffset + 1]?.rawBody).toContain('picture.png');

    const beforeLoad = c.sessionUpdates().length;
    await c.send('session/load', { sessionId: created.sessionId, cwd: homeDir, mcpServers: [] });
    const replayedUpdates = c
      .sessionUpdates()
      .slice(beforeLoad)
      .map((m) => (m.params as { update?: ToolCallWire }).update)
      .filter((u) => u?.toolCallId?.endsWith(':call_media') && u.status === 'completed');
    expect(replayedUpdates).toHaveLength(1);
    expect(replayedUpdates[0]?.content).toEqual(
      expect.arrayContaining([
        { type: 'content', content: { type: 'text', text: '[image_url]' } },
      ]),
    );
    expect(JSON.stringify(replayedUpdates)).not.toContain('"source"');
  }, 30_000);

  it('refreshes the tool card title on a status progress update and drops other progress kinds', async () => {
    const c = await boot();
    model!.script(call('Bash', { command: 'sleep 1 && echo progress_done' }, { id: 'call_1' }));
    model!.script(say('done'));
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
      new ToolUpdated({
        agentId: 'main',
        origin: 'loop',
        turnId,
        toolCallId: 'call_1',
        taskId: 'task-1',
        status: 'running',
        detached: false,
        fields: {},
        output: { offset: 0, text: 'raw-stdout-bytes' },
      }),
    );
    bus!.publish(
      new ToolUpdated({
        agentId: 'main',
        origin: 'loop',
        turnId,
        toolCallId: 'call_1',
        taskId: 'task-1',
        status: 'running',
        detached: false,
        fields: { status: 'Still working…' },
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

  it('shows what a running command has printed when the editor offers no terminal', async () => {
    const c = await boot();
    model!.script(call('Bash', { command: "printf 'rea%s\\n' dy; sleep 30" }, { id: 'call_slow' }));
    c.onRequest('session/request_permission', () => ({
      outcome: { outcome: 'selected', optionId: 'approve_once' },
    }));
    const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as { sessionId: string };
    await c.waitForSessionUpdate('available_commands_update', 10_000);
    const promptPromise = c.send('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'run the slow command' }],
    });

    type ToolCallWire = {
      sessionUpdate?: string;
      toolCallId?: string;
      status?: string;
      content?: Array<{ type: string; content?: { type: string; text?: string } }>;
    };
    const cardUpdates = () =>
      c
        .sessionUpdates()
        .map((m) => (m.params as { update?: ToolCallWire }).update)
        .filter((u) => u?.sessionUpdate === 'tool_call_update' && u.toolCallId?.endsWith(':call_slow'))
        .map((u) => ({ status: u?.status, text: (u?.content ?? []).map((part) => part.content?.text ?? '').join('') }));
    await vi.waitFor(() => {
      expect(cardUpdates().map((u) => u.text)).toContain('ready\n');
    }, 10_000);
    expect(cardUpdates().map((u) => u.status)).not.toEqual(expect.arrayContaining(['completed']));
    expect(cardUpdates().map((u) => u.status)).not.toEqual(expect.arrayContaining(['failed']));

    c.notify('session/cancel', { sessionId: created.sessionId });
    const result = (await promptPromise) as { stopReason: string };
    expect(result.stopReason).toBe('cancelled');
    expect(cardUpdates().at(-1)?.status).toBe('failed');
    expect(cardUpdates().at(-1)?.text).toContain('ready');
  }, 30_000);

  describe('when the editor learns the turn id only after the model has called a tool', () => {
    type ReactToPending = (pending: readonly Interaction[], release: () => void) => void;

    const releaseOnceAnInteractionIsPending: ReactToPending = (pending, release) => {
      if (pending.length > 0) release();
    };

    function holdLaunch(react: ReactToPending, land: (launched: unknown) => unknown = (launched) => launched): () => void {
      let releaseLaunch!: () => void;
      const launchHeld = new Promise<void>((resolve) => {
        releaseLaunch = resolve;
      });
      const sessions = AcpSession.prototype as unknown as {
        driveLaunch(this: AcpSession, launch: Promise<unknown>): Promise<unknown>;
      };
      const driveLaunch = sessions.driveLaunch;
      const heldLaunch = vi.spyOn(sessions, 'driveLaunch').mockImplementation(function (this: AcpSession, launch) {
        return driveLaunch.call(
          this,
          launch.then(async (launched) => {
            await launchHeld;
            return land(launched);
          }),
        );
      });
      const bridges = AcpInteractionBridge.prototype as unknown as {
        onPendingChanged(this: AcpInteractionBridge, pending: readonly Interaction[]): void;
      };
      const onPendingChanged = bridges.onPendingChanged;
      const watchedBridge = vi.spyOn(bridges, 'onPendingChanged').mockImplementation(function (this: AcpInteractionBridge, pending) {
        onPendingChanged.call(this, pending);
        react(pending, releaseLaunch);
      });
      return () => {
        heldLaunch.mockRestore();
        watchedBridge.mockRestore();
      };
    }

    type WireToolCall = { sessionUpdate?: string; toolCallId?: string; rawInput?: { questions?: unknown[] } };
    type WirePermission = { toolCall?: { toolCallId?: string } };

    function permissionRequestIndex(c: TestClient): number {
      return c.received.findIndex((m) => m.method === 'session/request_permission');
    }

    function announcedIndex(c: TestClient, toolCallId: string | undefined, matches: (update: WireToolCall) => boolean): number {
      return c.received.findIndex((m) => {
        if (m.method !== 'session/update') return false;
        const update = (m.params as { update?: WireToolCall }).update;
        return update !== undefined && update.toolCallId === toolCallId && matches(update);
      });
    }

    async function prompt(c: TestClient, text: string): Promise<string> {
      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as { sessionId: string };
      await c.waitForSessionUpdate('available_commands_update', 10_000);
      const result = (await c.send('session/prompt', {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text }],
      })) as { stopReason: string };
      return result.stopReason;
    }

    it('announces every question of the tool call before asking the editor the first one', async () => {
      const restore = holdLaunch(releaseOnceAnInteractionIsPending);
      try {
        const c = await boot();
        model!.script(askUserQuestion({
          questions: [
            { question: 'Which database should we use?', header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multi_select: false },
            { question: 'Which cache should we use?', header: 'Cache', options: [{ label: 'Redis' }, { label: 'None' }], multi_select: false },
          ],
        }, { id: 'call_q' }));
        model!.script(say('noted'));
        c.onRequest('session/request_permission', () => ({ outcome: { outcome: 'selected', optionId: 'q0_opt_1' } }));

        expect(await prompt(c, 'Help me set up storage.')).toBe('end_turn');

        const asked = permissionRequestIndex(c);
        expect(asked).toBeGreaterThanOrEqual(0);
        const toolCallId = (c.received[asked]!.params as WirePermission).toolCall?.toolCallId;
        expect(toolCallId).toMatch(/:call_q$/);
        const announced = announcedIndex(c, toolCallId, (update) => update.rawInput?.questions?.length === 2);
        expect(announced).toBeGreaterThanOrEqual(0);
        expect(announced).toBeLessThan(asked);
      } finally {
        restore();
      }
    }, 30_000);

    it('shows the tool call to the editor before asking it to approve the call', async () => {
      const restore = holdLaunch(releaseOnceAnInteractionIsPending);
      try {
        const c = await boot();
        model!.script(write({ path: 'late-turn.txt', content: 'written after approval\n' }, { id: 'call_w' }));
        model!.script(say('done'));
        c.onRequest('session/request_permission', () => ({ outcome: { outcome: 'selected', optionId: 'approve_once' } }));

        expect(await prompt(c, 'Write the file.')).toBe('end_turn');

        const asked = permissionRequestIndex(c);
        expect(asked).toBeGreaterThanOrEqual(0);
        const toolCallId = (c.received[asked]!.params as WirePermission).toolCall?.toolCallId;
        expect(toolCallId).toMatch(/:call_w$/);
        const announced = announcedIndex(c, toolCallId, (update) => update.sessionUpdate === 'tool_call');
        expect(announced).toBeGreaterThanOrEqual(0);
        expect(announced).toBeLessThan(asked);
        expect(await readFile(join(homeDir!, 'late-turn.txt'), 'utf8')).toBe('written after approval\n');
      } finally {
        restore();
      }
    }, 30_000);

    it('still asks the editor to approve the call when the prompt fails before the editor learns the turn id', async () => {
      const restore = holdLaunch(releaseOnceAnInteractionIsPending, () => {
        throw new Error('the prompt launch was lost');
      });
      try {
        const c = await boot();
        model!.script(write({ path: 'lost-launch.txt', content: 'written after approval\n' }, { id: 'call_w' }));
        model!.script(say('done'));
        c.onRequest('session/request_permission', () => ({ outcome: { outcome: 'selected', optionId: 'approve_once' } }));

        await expect(prompt(c, 'Write the file.')).rejects.toThrow('session prompt failed');

        await vi.waitFor(() => {
          expect(model!.requests()).toHaveLength(2);
        }, 10_000);
        const asked = permissionRequestIndex(c);
        expect(asked).toBeGreaterThanOrEqual(0);
        expect((c.received[asked]!.params as WirePermission).toolCall?.toolCallId).toMatch(/:call_w$/);
        expect(await readFile(join(homeDir!, 'lost-launch.txt'), 'utf8')).toBe('written after approval\n');
      } finally {
        restore();
      }
    }, 30_000);

    it('does not ask the editor about a call the user stopped before the editor learned the turn id', async () => {
      let stopTurn = (): void => undefined;
      let stopped = false;
      const restore = holdLaunch((pending, release) => {
        if (pending.length > 0) {
          stopped = true;
          stopTurn();
          return;
        }
        if (stopped) release();
      });
      try {
        const c = await boot();
        model!.script(write({ path: 'stopped.txt', content: 'never written\n' }, { id: 'call_w' }));
        c.onRequest('session/request_permission', () => ({ outcome: { outcome: 'cancelled' } }));
        const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as { sessionId: string };
        await c.waitForSessionUpdate('available_commands_update', 10_000);
        stopTurn = () => {
          c.notify('session/cancel', { sessionId: created.sessionId });
        };

        const result = (await c.send('session/prompt', {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'Write the file.' }],
        })) as { stopReason: string };

        expect(stopped).toBe(true);
        expect(result.stopReason).toBe('cancelled');
        expect(c.received.filter((m) => m.method === 'session/request_permission')).toEqual([]);
        await expect(readFile(join(homeDir!, 'stopped.txt'), 'utf8')).rejects.toThrow();
      } finally {
        restore();
      }
    }, 30_000);
  });
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
  let model: FakeModel | undefined;

  afterEach(async () => {
    if (client !== undefined) {
      await client.close();
      client = undefined;
    }
    if (model !== undefined) {
      const current = model;
      model = undefined;
      try {
        current.verify();
      } finally {
        await current.close();
      }
    }
    if (homeDir !== undefined) {
      await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      homeDir = undefined;
    }
  });

  async function boot(): Promise<TestClient> {
    homeDir = await mkdtemp(join(tmpdir(), 'acp-builtin-'));
    model = createFakeModel();
    await model.listen();
    await writeFakeModelConfig(homeDir, { baseUrl: model.origin });
    client = await createTestClient({ homeDir });
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
    expect(chunk).toContain('Context: 0 / 262144 tokens');
    expect(chunk).toContain('no LLM calls yet');
    expect(model!.requests().length).toBe(0);
  }, 30_000);

  it('/status answers with the session summary and never calls the model', async () => {
    const c = await boot();
    const sessionId = await newSession(c);

    const { chunk, stopReason } = await runSlash(c, sessionId, '/status');
    expect(stopReason).toBe('end_turn');
    expect(chunk).toContain(`Session: ${sessionId}`);
    expect(chunk).toContain('Model: fake');
    expect(chunk).toContain('Mode: default');
    expect(chunk).toContain(`Working directory: ${slashPathOf(homeDir)}`);
    expect(model!.requests().length).toBe(0);
  }, 30_000);

  it('/help lists every advertised builtin command and never calls the model', async () => {
    const c = await boot();
    const sessionId = await newSession(c);

    const { chunk, stopReason } = await runSlash(c, sessionId, '/help');
    expect(stopReason).toBe('end_turn');
    for (const name of ['compact', 'status', 'usage', 'mcp', 'tasks', 'help']) {
      expect(chunk).toContain(`/${name}`);
    }
    expect(model!.requests().length).toBe(0);
  }, 30_000);

  it('/tasks answers with the empty background-task list and never calls the model', async () => {
    const c = await boot();
    const sessionId = await newSession(c);

    const { chunk, stopReason } = await runSlash(c, sessionId, '/tasks');
    expect(stopReason).toBe('end_turn');
    expect(chunk).toContain('No background tasks.');
    expect(model!.requests().length).toBe(0);
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
          headers: [{ name: 'X-Test-Fixture', value: 'example' }],
        },
      ],
    })) as { sessionId: string };
    await c.waitForSessionUpdate('available_commands_update', 10_000);

    const { chunk, stopReason } = await runSlash(c, created.sessionId, '/mcp');
    expect(stopReason).toBe('end_turn');
    expect(chunk).toContain('MCP servers (1):');
    expect(chunk).toContain('- mock (http):');
    expect(model!.requests().length).toBe(0);
  }, 30_000);

  it('/mcp on a session without servers says so and never calls the model', async () => {
    const c = await boot();
    const sessionId = await newSession(c);

    const { chunk, stopReason } = await runSlash(c, sessionId, '/mcp');
    expect(stopReason).toBe('end_turn');
    expect(chunk).toContain('No MCP servers configured for this session.');
    expect(model!.requests().length).toBe(0);
  }, 30_000);

  it('/compact triggers engine compaction (fire-and-forget) after a turn', async () => {
    const c = await boot();
    const sessionId = await newSession(c);

    model!.script(say('turn reply'));
    const result = (await c.send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'say something' }],
    })) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');
    model!.script(say('compaction summary'));

    const { chunk, stopReason } = await runSlash(c, sessionId, '/compact');
    expect(stopReason).toBe('end_turn');
    expect(chunk).toContain('Context compaction started');
  }, 30_000);

  it('/compact reports the completion summary as a follow-up agent_message_chunk', async () => {
    const c = await boot();
    const sessionId = await newSession(c);

    model!.script(say('turn reply'));
    const result = (await c.send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'say something' }],
    })) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');
    model!.script(say('compaction summary'));

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
    expect(model!.requests().length).toBe(0);
  }, 30_000);
});

describe('acp-server terminal reverse-RPC (clientCapabilities.terminal)', () => {
  let homeDir: string | undefined;
  let client: TestClient | undefined;
  let model: FakeModel | undefined;

  afterEach(async () => {
    if (client !== undefined) {
      await client.close();
      client = undefined;
    }
    if (model !== undefined) {
      const current = model;
      model = undefined;
      try {
        current.verify();
      } finally {
        await current.close();
      }
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

  async function boot(
    clientCapabilities: Record<string, unknown>,
    defaults?: Pick<FakeModelConfigOptions, 'defaultPermissionMode'>,
  ): Promise<TestClient> {
    homeDir = await mkdtemp(join(tmpdir(), 'acp-terminal-'));
    model = createFakeModel();
    await model.listen();
    await writeFakeModelConfig(homeDir, { baseUrl: model.origin, ...defaults });
    client = await createTestClient({ homeDir });
    await client.send('initialize', { protocolVersion: 1, clientCapabilities });
    return client;
  }

  function scriptBashTurn(command: string): void {
    model!.script(call('Bash', { command }, { id: 'call_1' }));
    model!.script(say('done'));
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
    expect(model!.requests().length).toBe(2);

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

    expect(model!.requests()[1]?.rawBody).toContain('hello_from_terminal');
  }, 30_000);

  it('attaches the terminal to a command that runs before the editor learns which turn it belongs to', async () => {
    let releaseLaunch!: () => void;
    const launchHeld = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const sessions = AcpSession.prototype as unknown as {
      driveLaunch(this: AcpSession, launch: Promise<unknown>): Promise<unknown>;
    };
    const driveLaunch = sessions.driveLaunch;
    const heldLaunch = vi.spyOn(sessions, 'driveLaunch').mockImplementation(function (this: AcpSession, launch) {
      return driveLaunch.call(
        this,
        launch.then(async (launched) => {
          await launchHeld;
          return launched;
        }),
      );
    });
    try {
      const c = await boot({ terminal: true }, { defaultPermissionMode: 'yolo' });
      const terminals = fakeTerminalClient(c, 'hello_from_terminal\n');
      c.onRequest('terminal/wait_for_exit', async () => {
        releaseLaunch();
        await c.waitForSessionUpdate('tool_call', 10_000);
        return { exitCode: 0, signal: null };
      });
      scriptBashTurn('echo hello_from_terminal');

      const { stopReason } = await runPrompt(c);
      expect(stopReason).toBe('end_turn');

      const created = c.received.findIndex((m) => m.method === 'terminal/create');
      const announced = c.received.findIndex(
        (m) =>
          m.method === 'session/update' &&
          (m.params as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === 'tool_call',
      );
      expect(created).toBeGreaterThanOrEqual(0);
      expect(announced).toBeGreaterThan(created);

      const t = terminals[0]!;
      const updates = toolCallUpdates(c);
      const attached = updates.find((u) => u.content?.[0]?.type === 'terminal');
      expect(attached?.content?.[0]?.terminalId).toBe(t.id);
      const completed = updates.find((u) => u.status === 'completed');
      expect(completed?.content).toEqual([{ type: 'terminal', terminalId: t.id }]);
    } finally {
      heldLaunch.mockRestore();
    }
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
