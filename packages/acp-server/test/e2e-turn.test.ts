/**
 * "Real" end-to-end ACP turn test.
 *
 * Unlike the mapper / wiring unit tests, this boots the FULL agent-core-v2
 * engine and the real ACP wire (ND-JSON over an in-memory stream), drives an
 * actual `session/prompt` turn, and only fakes the network LLM call via the
 * scripted-provider seam. Every layer is exercised for real: the agent turn
 * loop, `ModelImpl.request`, the `generate()` stream merge, `IEventBus`
 * `assistant.delta` → ACP `session/update` translation, and turn settlement.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getLiveSessionById, IAgentLifecycleService, IEventBus } from '@moonshot-ai/agent-core-v2';
import { afterEach, describe, expect, it } from 'vitest';

import { mapPromptLaunchError } from '../src/session';
import { createTestClient, type TestClient } from './_helpers/acpClient';
import { writeFakeModelConfig } from './_helpers/fakeModelConfig';
import { solidPngBase64 } from './_helpers/png';
import { createScriptedProvider, type ScriptedProvider } from './_helpers/scriptedProvider';

/** Real stdio MCP fixture server from the agent-core-v2 test suite. */
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
      await rm(homeDir, { recursive: true, force: true });
      homeDir = undefined;
    }
  });

  async function boot(clientCapabilities: Record<string, unknown> = {}): Promise<TestClient> {
    homeDir = await mkdtemp(join(tmpdir(), 'acp-e2e-turn-'));
    await writeFakeModelConfig(homeDir);
    scripted = createScriptedProvider();
    client = await createTestClient({ homeDir, extraSeeds: [scripted.seed] });
    await client.send('initialize', { protocolVersion: 1, clientCapabilities });
    return client;
  }

  it('drives initialize → new → prompt and streams the assistant text as agent_message_chunk', async () => {
    const c = await boot();
    scripted!.mockNextText('hello from the scripted model');

    const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
      sessionId: string;
    };
    expect(created.sessionId).toMatch(/^session_/);
    // Drain the post-new available_commands_update so prompt assertions only
    // see turn traffic.
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

    // Turn settlement pushes a one-shot usage_update: `used` is the
    // LLM-measured context token count (the scripted provider reports
    // output usage only, so > 0), `size` the fake model's max context
    // size (8192, see fakeModelConfig); `cost` stays omitted.
    const usage = await c.waitForSessionUpdate('usage_update', 10_000);
    const usageUpdate = (
      usage.params as { update?: { used?: number; size?: number; cost?: unknown } }
    ).update;
    expect(usageUpdate?.size).toBe(8192);
    expect(usageUpdate?.used).toBeGreaterThan(0);
    expect(usageUpdate?.cost).toBeUndefined();
  }, 30_000);

  it('runs a tool call and bridges the approval request to the client', async () => {
    const c = await boot();
    // First model response: a Bash tool call. Second: a short text wrap-up
    // after the tool result is fed back to the model.
    scripted!.mockNextResponse({
      type: 'function',
      id: 'call_1',
      name: 'Bash',
      arguments: '{"command":"echo hello_from_bash"}',
    });
    scripted!.mockNextText('ran it');

    // Auto-approve any permission request and record it so we can assert the
    // bridge forwarded the engine's approval to the ACP client.
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

    // The tool call must be created and then completed (Bash actually ran).
    await c.waitForSessionUpdate('tool_call', 10_000);
    await c.waitForSessionUpdate('tool_call_update', 10_000);

    const result = (await promptPromise) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');
    // Two model calls: the tool-call response and the post-tool text response.
    expect(scripted!.callCount()).toBe(2);

    // The default (manual) permission mode asks before running Bash, so the
    // bridge must have forwarded exactly one approval request to the client.
    expect(permissionRequests).toHaveLength(1);
    const req = permissionRequests[0] as { toolCall?: { toolCallId?: string } };
    expect(req.toolCall?.toolCallId).toContain('call_1');

    // The terminal tool_call_update must report success and include the
    // command's output.
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
    const text = terminal?.content?.map((c) => c.content?.text ?? '').join('\n') ?? '';
    expect(text).toContain('hello_from_bash');
  }, 30_000);

  it('bridges AskUserQuestion through elicitation/create for form-capable clients', async () => {
    const c = await boot({ elicitation: { form: {} } });
    // First model response: an AskUserQuestion tool call with a single-select
    // and a multi-select question. Second: wrap-up after the answers come back.
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
    // Auto-approve in case the tool itself requires an approval first.
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

    // The question went over `elicitation/create` — never the permission
    // bridge — as one form carrying both questions.
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

    // The answers fed back to the model key by question text; the multi-select
    // joins in declared option order. (The history is JSON-stringified, so
    // the tool output's quotes appear escaped.)
    const history = JSON.stringify(scripted!.callHistory()[1]);
    expect(history).toContain('\\"Pick one\\":\\"B\\"');
    expect(history).toContain('\\"Pick many\\":\\"X, Z\\"');
  }, 30_000);

  it('rejects a second prompt while a turn is in flight', async () => {
    const c = await boot();
    // First model response parks the turn at a Bash approval; the follow-up
    // text closes the turn once the approval lands.
    scripted!.mockNextResponse({
      type: 'function',
      id: 'call_busy',
      name: 'Bash',
      arguments: '{"command":"echo busy_probe"}',
    });
    scripted!.mockNextText('done');

    // Park the approval until the test releases it.
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
    // The turn is in flight once its approval reached the client.
    await permissionSeen;

    // A second prompt while the turn runs must fail fast with -32600, not
    // silently queue behind the engine and overwrite the in-flight driver.
    await expect(
      c.send('session/prompt', {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'again' }],
      }),
    ).rejects.toThrow(/another turn is already in progress/);

    // Release the parked approval: the first turn completes normally and its
    // prompt settles with end_turn (the driver was never displaced).
    answerPermission!({ outcome: { outcome: 'selected', optionId: 'approve_once' } });
    const result = (await firstPrompt) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');
    expect(scripted!.callCount()).toBe(2);
  }, 30_000);

  it('settles as cancelled when cancel arrives while the launch is in flight', async () => {
    const c = await boot();
    // The scripted Bash call would park the turn at approval — but the cancel
    // must win regardless of whether it lands before or after the launch
    // round-trip delivers the turn id.
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
    // Fire the cancel immediately: the driver's turn id is very likely still
    // unknown at this point, which used to drop the cancel on the floor and
    // let the turn run to completion.
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

    // Auto-approve in case the manual permission mode gates the Read.
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

    // The engine streams the args delta BEFORE `tool.call.started`, so the
    // CREATE is the lazy pending one, which cannot carry locations yet (they
    // derive from the full args/display at started).
    const createdNotification = await c.waitForSessionUpdate('tool_call', 10_000);
    expect(updateOf(createdNotification)?.status).toBe('pending');
    expect(updateOf(createdNotification)?.locations).toBeUndefined();

    const result = (await promptPromise) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');

    // The started-upgrade update attaches the absolute path as a location…
    const updates = c.sessionUpdates().map(updateOf);
    const upgrade = updates.find(
      (u) => u?.sessionUpdate === 'tool_call_update' && u?.locations !== undefined,
    );
    expect(upgrade?.locations?.[0]?.path).toBe(filePath);

    // …and the terminal tool_call_update re-attaches the same locations
    // (`tool.result` itself carries no args/display).
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

    // A solid 3600×1800 PNG is small on the wire but slow enough to compress
    // (decode + rescale) that the cancel below reliably lands mid-compression,
    // before any turn exists — while staying well inside the test timeout.
    const promptPromise = c.send('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'image', data: solidPngBase64(3600, 1800), mimeType: 'image/png' }],
    });
    c.notify('session/cancel', { sessionId: created.sessionId });
    const result = (await promptPromise) as { stopReason: string };

    expect(result.stopReason).toBe('cancelled');
    // The turn was never launched — the model was never called.
    expect(scripted!.callCount()).toBe(0);
  }, 30_000);

  it('streams tool-call args deltas: lazy pending CREATE → cumulative update → started upgrade → completed', async () => {
    const c = await boot();
    // Args stream in two fragments; the merge yields the full command.
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

    // 1. First delta → lazy CREATE: pending, titled by the tool name, content
    //    is the first args fragment, no rawInput yet.
    expect(updates[0]?.sessionUpdate).toBe('tool_call');
    expect(updates[0]?.status).toBe('pending');
    expect(updates[0]?.title).toBe('Bash');
    expect(updates[0]?.kind).toBe('execute');
    expect(updates[0]?.rawInput).toBeUndefined();
    expect(textOf(updates[0])).toBe('{"command":"ec');

    // 2. Second delta → cumulative REPLACE update with the full args text.
    expect(updates[1]?.sessionUpdate).toBe('tool_call_update');
    expect(updates[1]?.status).toBe('in_progress');
    expect(textOf(updates[1])).toBe('{"command":"echo delta_stream"}');

    // 3. `tool.call.started` → upgrade update: canonical metadata lands on the
    //    existing card (kind + rawInput), status stays in_progress.
    expect(updates[2]?.sessionUpdate).toBe('tool_call_update');
    expect(updates[2]?.status).toBe('in_progress');
    expect(updates[2]?.kind).toBe('execute');
    expect(updates[2]?.rawInput).toEqual({ command: 'echo delta_stream' });

    // 4. Result → terminal completed update carrying the command output.
    const terminal = updates.at(-1);
    expect(terminal?.sessionUpdate).toBe('tool_call_update');
    expect(terminal?.status).toBe('completed');
    expect(textOf(terminal)).toContain('delta_stream');
  }, 30_000);

  it('refreshes the tool card title on a status progress update and drops other progress kinds', async () => {
    const c = await boot();
    // A slow command keeps the turn alive so the progress events below land
    // while the call is still in flight.
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

    // Wait for the in-flight call, then publish progress events onto the main
    // agent's event bus (the same channel a progress-reporting tool uses) —
    // a stdout chunk (dropped by the mapping) and a status text (forwarded).
    const create = await c.waitForSessionUpdate('tool_call', 10_000);
    const wireId = (create.params as { update?: { toolCallId?: string } }).update?.toolCallId;
    const turnId = Number(wireId?.split(':')[0]);
    const session = getLiveSessionById(c.server.core.accessor, created.sessionId);
    const agentHandle = session?.accessor.get(IAgentLifecycleService).get('main');
    const bus = agentHandle?.accessor.get(IEventBus);
    expect(bus).toBeDefined();
    bus!.publish({
      type: 'tool.progress',
      turnId,
      toolCallId: 'call_1',
      update: { kind: 'stdout', text: 'raw-stdout-bytes' },
    });
    bus!.publish({
      type: 'tool.progress',
      turnId,
      toolCallId: 'call_1',
      update: { kind: 'status', text: 'Still working…' },
    });

    const result = (await promptPromise) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');

    type ToolCallWire = { sessionUpdate?: string; toolCallId?: string; title?: string };
    const updates = c
      .sessionUpdates()
      .map((m) => (m.params as { update?: ToolCallWire }).update)
      .filter((u) => u?.toolCallId === wireId);
    // The status progress refreshed the card title…
    expect(
      updates.some((u) => u?.sessionUpdate === 'tool_call_update' && u?.title === 'Still working…'),
    ).toBe(true);
    // …while the stdout progress never crossed the wire.
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
    // The SDK prefixes the wire message with "Internal error: ".
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
      await rm(homeDir, { recursive: true, force: true });
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

    // Delete the session engine-side (bypassing ACP) so the ACP session stays
    // registered locally but its klient calls fail with the engine's raw
    // "session not found: <id>" — a message that must not cross the wire.
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
      await rm(homeDir, { recursive: true, force: true });
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

  /** Create a session and drain the post-new available_commands_update. */
  async function newSession(c: TestClient): Promise<string> {
    const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
      sessionId: string;
    };
    await c.waitForSessionUpdate('available_commands_update', 10_000);
    return created.sessionId;
  }

  /**
   * Send a slash-command prompt and return the text of the
   * `agent_message_chunk` it produced plus the prompt's stop reason.
   */
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
          name: 'mock',
          command: process.execPath,
          args: [STDIO_MCP_FIXTURE],
          env: [{ name: 'KIMI_TEST_MCP_START_DELAY_MS', value: '0' }],
        },
      ],
    })) as { sessionId: string };
    await c.waitForSessionUpdate('available_commands_update', 10_000);

    const { chunk, stopReason } = await runSlash(c, created.sessionId, '/mcp');
    expect(stopReason).toBe('end_turn');
    expect(chunk).toContain('MCP servers (1):');
    expect(chunk).toContain('- mock (stdio):');
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

    // One real turn so the history is non-empty (`begin` refuses an empty
    // context); the compaction summarization itself consumes the second
    // scripted reply asynchronously.
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

    // One real turn so the history is non-empty; the compaction summarization
    // consumes the second scripted reply asynchronously.
    scripted!.mockNextText('turn reply');
    const result = (await c.send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'say something' }],
    })) as { stopReason: string };
    expect(result.stopReason).toBe('end_turn');
    scripted!.mockNextText('compaction summary');

    // The args travel as the summarization instruction.
    const { chunk, stopReason } = await runSlash(c, sessionId, '/compact keep it short');
    expect(stopReason).toBe('end_turn');
    expect(chunk).toContain('Context compaction started');

    // The compaction lifecycle events subscribed at session scope push the
    // terminal report as a follow-up chunk once the background task settles.
    const completion = await waitForChunk(c, 'Compaction completed.');
    expect(completion).toContain('Messages compacted:');
    expect(completion).toContain('Tokens before:');
    expect(completion).toContain('Tokens after:');
  }, 30_000);

  /**
   * Poll the received `agent_message_chunk`s until one carries `needle`
   * (the compaction report arrives asynchronously, after the prompt settled).
   */
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
      await rm(homeDir, { recursive: true, force: true });
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

  /** Register fake `terminal/*` handlers; returns the created terminals. */
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

    // terminal/create fired once, for this session, wrapping the model's
    // command in the Bash tool's shell invocation with its noninteractive
    // env and the session cwd.
    expect(terminals).toHaveLength(1);
    const t = terminals[0]!;
    expect(t.createParams.sessionId).toBe(sessionId);
    expect(t.createParams.args?.[0]).toBe('-c');
    expect(t.createParams.args?.[1]).toContain('echo hello_from_terminal');
    expect(t.createParams.cwd).toBe(homeDir);
    expect(t.createParams.env).toContainEqual({ name: 'TERM', value: 'dumb' });

    // Normal-exit lifecycle: wait_for_exit resolved, the terminal was
    // released exactly once (via IProcess.dispose), never killed.
    expect(t.released).toBe(true);
    expect(t.killed).toBe(false);

    // The tool card carries the terminal embed — not a textual copy of the
    // output (the client already renders the bytes in the terminal pane).
    const updates = toolCallUpdates(c);
    const attached = updates.find((u) => u.content?.[0]?.type === 'terminal');
    expect(attached?.content?.[0]?.terminalId).toBe(t.id);
    const completed = updates.find((u) => u.status === 'completed');
    expect(completed?.content).toEqual([{ type: 'terminal', terminalId: t.id }]);

    // …while the model still received the captured output in the tool
    // result fed back on the second generate() call.
    const secondCall = scripted!.callHistory()[1];
    expect(JSON.stringify(secondCall)).toContain('hello_from_terminal');
  }, 30_000);

  it('falls back to local execution when the client does not advertise the capability', async () => {
    const c = await boot({});
    const terminals = fakeTerminalClient(c, 'should_not_be_used\n');
    scriptBashTurn('echo hello_from_bash');

    const { stopReason } = await runPrompt(c);
    expect(stopReason).toBe('end_turn');

    // No terminal reverse-RPC at all — behavior identical to today.
    expect(terminals).toHaveLength(0);
    const terminalRpcs = c.received.filter(
      (m) => typeof m.method === 'string' && m.method.startsWith('terminal/'),
    );
    expect(terminalRpcs).toHaveLength(0);

    // The tool card carries the textual output, exactly as before.
    const completed = toolCallUpdates(c).find((u) => u.status === 'completed');
    const text = completed?.content?.map((entry) => entry.content?.text ?? '').join('\n') ?? '';
    expect(text).toContain('hello_from_bash');
  }, 30_000);
});
