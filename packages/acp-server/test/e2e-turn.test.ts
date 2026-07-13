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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTestClient, type TestClient } from './_helpers/acpClient';
import { writeFakeModelConfig } from './_helpers/fakeModelConfig';
import { createScriptedProvider, type ScriptedProvider } from './_helpers/scriptedProvider';

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

  async function boot(): Promise<TestClient> {
    homeDir = await mkdtemp(join(tmpdir(), 'acp-e2e-turn-'));
    await writeFakeModelConfig(homeDir);
    scripted = createScriptedProvider();
    client = await createTestClient({ homeDir, extraSeeds: [scripted.seed] });
    await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    return client;
  }

  it(
    'drives initialize → new → prompt and streams the assistant text as agent_message_chunk',
    async () => {
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
    },
    30_000,
  );

  it(
    'runs a tool call and bridges the approval request to the client',
    async () => {
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
    },
    30_000,
  );
});
