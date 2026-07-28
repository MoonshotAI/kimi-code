// E2E: the host-facing SessionClient against the real stdio engine.
//
// The engine owns the loop/context/goal; the host hands over a step function
// and a tool table. Asserts the full chain: host tools are registered at
// session/create, presented to the model (previously the assembled tool table
// was dropped and the model saw NO tools), executed back at the host, and the
// lifecycle events arrive.
//
// KIMI_AGENT_FORCE_STDIO=1 must be set before the module initializes the
// engine — the session surface is stdio-only and the napi addon would
// otherwise win engine selection.
import { beforeAll, describe, expect, it } from 'vitest';

process.env['KIMI_AGENT_FORCE_STDIO'] = '1';

type RustLoop = typeof import('./rust-loop');
let rustLoop: RustLoop;

beforeAll(async () => {
  rustLoop = await import('./rust-loop');
});

describe('createSessionClient (stdio e2e)', () => {
  it('runs a prompt with host tools and lifecycle events', async () => {
    const events: { type?: string }[] = [];
    const toolInvocations: unknown[] = [];
    const seenToolTables: string[][] = [];
    let llmCalls = 0;

    const client = await rustLoop.createSessionClient({
      sessionId: 'ts-e2e-s1',
      systemPrompt: 'test',
      model: 'mock',
      goalEnabled: true,
      llmStep: (req) => {
        llmCalls += 1;
        seenToolTables.push((req.tools ?? []).map((t) => t.name));
        if (llmCalls === 1) {
          return Promise.resolve({
            tool_calls: [{ id: 'c1', name: 'HostEcho', arguments: { text: 'ping' } }],
            finish_reason: 'tool_calls',
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          });
        }
        return Promise.resolve({
          tool_calls: [],
          finish_reason: 'stop',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      },
      tools: [
        {
          name: 'HostEcho',
          description: 'Echo text back',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
          execute: (args) => {
            toolInvocations.push(args);
            return Promise.resolve({ output: `echo: ${(args as { text: string }).text}` });
          },
        },
      ],
      onEvent: (event) => events.push(event as { type?: string }),
    });
    expect(client, 'stdio engine must be available (build kimi-agent-cli first)').not.toBeNull();

    const result = await client!.prompt('call the echo tool');
    expect(result).not.toBeNull();
    expect(result!.stop_reason).toBe('EndTurn');

    // The model actually saw the tool table (host tool + engine tools).
    expect(seenToolTables[0]).toContain('HostEcho');
    expect(seenToolTables[0]).toContain('CreateGoal');
    // The host tool executed at the host with the model's arguments.
    expect(toolInvocations).toEqual([{ text: 'ping' }]);
    // Lifecycle events arrived over host/event.
    const types = events.map((e) => e.type);
    expect(types).toContain('session.turn.started');
    expect(types).toContain('session.turn.ended');
    // Tool activity is reported for thin-client rendering: the host tool
    // call shows up as started/settled even though it settled at the host.
    const toolEvents = events as { type?: string; tool_name?: string; content?: string }[];
    const toolStarted = toolEvents.find((e) => e.type === 'session.tool.started');
    const toolSettled = toolEvents.find((e) => e.type === 'session.tool.settled');
    expect(toolStarted?.tool_name).toBe('HostEcho');
    expect(toolSettled?.content).toBe('echo: ping');

    // Persistence round trip through the client handle.
    expect(await client!.save()).toBe(true);
    expect(await client!.load()).toBe(true);
  }, 30000);
});
