import { describe, expect, it } from 'vitest';

import { NativeSessionAdapter, nativeEngineOpsFromRustLoop } from '#/cli/native-session-adapter';
import type { RustLoopSessionApi } from '#/cli/native-session-adapter';
import type {
  SessionClientFactoryOptions,
  SessionClientHandle,
} from '@moonshot-ai/kimi-code-sdk/rust';

/** A fake engine client capturing the wired sinks so a test can drive events
 *  and approvals without a live engine process. */
class FakeClient implements SessionClientHandle {
  readonly sessionId: string;
  onEvent: ((event: unknown) => void) | undefined;
  authorizeTool: ((req: unknown) => Promise<{ block: boolean; resolved: boolean }>) | undefined;
  prompts: string[] = [];
  cancelled = false;
  saved = false;

  constructor(options: SessionClientFactoryOptions) {
    this.sessionId = options.sessionId ?? 'fake';
    this.onEvent = options.onEvent;
    this.authorizeTool = options.lifecycle?.authorizeTool;
  }
  prompt(text: string) {
    this.prompts.push(text);
    return Promise.resolve({ stop_reason: 'EndTurn', steps: 1, usage: { total_tokens: 3 } });
  }
  cancel() {
    this.cancelled = true;
    return Promise.resolve(true);
  }
  save() {
    this.saved = true;
    return Promise.resolve(true);
  }
  load() {
    return Promise.resolve(true);
  }
}

/** Raw engine wire event; the SDK passes it through verbatim as `llm.delta`. */
function rawTextDelta(text: string): unknown {
  return { type: 'llm.delta', part: { type: 'text', text } };
}

describe('NativeSessionAdapter', () => {
  it('fans out events to dynamic subscribers and supports unsubscribe', async () => {
    let fake: FakeClient | undefined;
    const adapter = new NativeSessionAdapter({
      createClient: (o) => {
        fake = new FakeClient(o);
        return Promise.resolve(fake);
      },
    });
    await adapter.start({ sessionId: 's1' });

    const a: string[] = [];
    const b: string[] = [];
    const offA = adapter.onEvent(
      (e) => e.type === 'llm.delta' && e.part.type === 'text' && a.push(e.part.text ?? ''),
    );
    adapter.onEvent(
      (e) => e.type === 'llm.delta' && e.part.type === 'text' && b.push(e.part.text ?? ''),
    );

    fake!.onEvent!(rawTextDelta('one'));
    offA(); // A unsubscribes
    fake!.onEvent!(rawTextDelta('two'));

    expect(a).toEqual(['one']); // stopped after unsubscribe
    expect(b).toEqual(['one', 'two']); // still receiving
  });

  it('delegates prompt/cancel/save to the engine client', async () => {
    let fake: FakeClient | undefined;
    const adapter = new NativeSessionAdapter({
      createClient: (o) => {
        fake = new FakeClient(o);
        return Promise.resolve(fake);
      },
    });
    await adapter.start({ sessionId: 's1' });

    const outcome = await adapter.prompt('do it');
    expect(fake!.prompts).toEqual(['do it']);
    expect(outcome).toEqual({ stopReason: 'EndTurn', steps: 1, totalTokens: 3 });
    expect(await adapter.cancel()).toBe(true);
    expect(fake!.cancelled).toBe(true);
    expect(await adapter.save()).toBe(true);
    expect(fake!.saved).toBe(true);
  });

  it('routes approvals to the current handler, and allows when none is set', async () => {
    let fake: FakeClient | undefined;
    const adapter = new NativeSessionAdapter({
      createClient: (o) => {
        fake = new FakeClient(o);
        return Promise.resolve(fake);
      },
    });
    await adapter.start({ sessionId: 's1' });

    // No handler yet → allow (auto-like default for the pre-handler window).
    expect(await fake!.authorizeTool!({ tool_name: 'Write', tool_call_id: 'c0' })).toEqual({
      block: false,
      resolved: true,
    });

    // Set a denying handler → engine gate blocks.
    const seen: string[] = [];
    adapter.setApprovalHandler((req) => {
      seen.push(req.toolName);
      return Promise.resolve(false);
    });
    expect(await fake!.authorizeTool!({ tool_name: 'Bash', tool_call_id: 'c1' })).toMatchObject({
      block: true,
      resolved: true,
    });
    expect(seen).toEqual(['Bash']);

    // Clear the handler → back to allow.
    adapter.setApprovalHandler(undefined);
    expect(await fake!.authorizeTool!({ tool_name: 'Write', tool_call_id: 'c2' })).toEqual({
      block: false,
      resolved: true,
    });
  });

  it('setPermission forwards to the injected mode setter', async () => {
    const modes: string[] = [];
    const adapter = new NativeSessionAdapter({
      createClient: (o) => Promise.resolve(new FakeClient(o)),
      setPermissionMode: (mode) => {
        modes.push(mode);
        return Promise.resolve();
      },
    });
    await adapter.start({ sessionId: 's1' });
    await adapter.setPermission('manual');
    expect(modes).toEqual(['manual']);
  });

  it('setModel forwards to the injected model setter', async () => {
    const models: string[] = [];
    const adapter = new NativeSessionAdapter({
      createClient: (o) => Promise.resolve(new FakeClient(o)),
      setModel: (model) => {
        models.push(model);
        return Promise.resolve();
      },
    });
    await adapter.start({ sessionId: 's1' });
    await adapter.setModel('kimi-k2');
    expect(models).toEqual(['kimi-k2']);
    // No setter → no-op (does not throw).
    const bare = new NativeSessionAdapter({ createClient: (o) => Promise.resolve(new FakeClient(o)) });
    await bare.start({ sessionId: 's2' });
    await expect(bare.setModel('x')).resolves.toBeUndefined();
  });

  it('setThinking forwards to the injected effort setter', async () => {
    const efforts: Array<string | null> = [];
    const adapter = new NativeSessionAdapter({
      createClient: (o) => Promise.resolve(new FakeClient(o)),
      setThinking: (effort) => {
        efforts.push(effort);
        return Promise.resolve();
      },
    });
    await adapter.start({ sessionId: 's1' });
    await adapter.setThinking('high');
    await adapter.setThinking(null);
    expect(efforts).toEqual(['high', null]);
  });

  it('runShellCommand delegates to the injected runner, and reports unavailable without one', async () => {
    const calls: Array<[string, number | undefined]> = [];
    const adapter = new NativeSessionAdapter({
      createClient: (o) => Promise.resolve(new FakeClient(o)),
      runShell: (command, timeoutS) => {
        calls.push([command, timeoutS]);
        return Promise.resolve({ output: 'hello\n', isError: false });
      },
    });
    await adapter.start({ sessionId: 's1' });
    const out = await adapter.runShellCommand('echo hello', 30);
    expect(out).toEqual({ output: 'hello\n', isError: false, unavailable: false });
    expect(calls).toEqual([['echo hello', 30]]);

    // No runner → unavailable (host should run it).
    const bare = new NativeSessionAdapter({ createClient: (o) => Promise.resolve(new FakeClient(o)) });
    await bare.start({ sessionId: 's2' });
    expect(await bare.runShellCommand('ls')).toEqual({
      output: null,
      isError: false,
      unavailable: true,
    });
  });

  it('binds engine ops to the adapter session id (production wiring shape)', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const adapter = new NativeSessionAdapter({
      createClient: (o) => Promise.resolve(new FakeClient({ ...o, sessionId: 'S-42' })),
      engine: {
        setModel: (sid, model) => {
          calls.push(['setModel', sid, model]);
          return Promise.resolve({ ok: true });
        },
        setThinking: (sid, effort) => {
          calls.push(['setThinking', sid, effort]);
          return Promise.resolve({ ok: true });
        },
        setPermissionMode: (sid, mode) => {
          calls.push(['setPermission', sid, mode]);
          return Promise.resolve({ ok: true });
        },
        runShell: (sid, command) => {
          calls.push(['runShell', sid, command]);
          return Promise.resolve({ output: 'x', is_error: false });
        },
      },
    });
    await adapter.start({ sessionId: 'S-42' });
    await adapter.setModel('m1');
    await adapter.setThinking('high');
    await adapter.setPermission('manual');
    const shell = await adapter.runShellCommand('echo hi');

    // Every op received the adapter's own session id (bound at call time).
    expect(calls).toEqual([
      ['setModel', 'S-42', 'm1'],
      ['setThinking', 'S-42', 'high'],
      ['setPermission', 'S-42', 'manual'],
      ['runShell', 'S-42', 'echo hi'],
    ]);
    // runShell maps the engine's snake_case is_error onto the SDK shape.
    expect(shell).toEqual({ output: 'x', isError: false, unavailable: false });
  });

  it('reloadSession and steer delegate to the engine (load RPC + steer op)', async () => {
    const steered: Array<[string, unknown]> = [];
    const adapter = new NativeSessionAdapter({
      createClient: (o) => Promise.resolve(new FakeClient(o)),
      engine: {
        steer: (sid, input) => {
          steered.push([sid, input]);
          return Promise.resolve({ queued: true });
        },
      },
    });
    await adapter.start({ sessionId: 'R1' });
    expect(await adapter.reloadSession()).toBe(true); // FakeClient.load() → true
    await adapter.steer('redirect now');
    expect(steered).toEqual([['R1', [{ type: 'text', text: 'redirect now' }]]]);
  });

  it('reports engine-unavailable when the factory returns null', async () => {
    const adapter = new NativeSessionAdapter({ createClient: () => Promise.resolve(null) });
    expect(await adapter.start({ sessionId: 's1' })).toBe(false);
    expect(adapter.isStarted).toBe(false);
  });

  it('listSessions forwards to the engine op and returns [] without one', async () => {
    const records = [
      { id: 's1', created_at: '1', updated_at: '2', title: '', work_dir: '/w' },
    ];
    const adapter = new NativeSessionAdapter({
      createClient: (o) => Promise.resolve(new FakeClient(o)),
      engine: {
        listSessions: () => Promise.resolve({ sessions: records }),
      },
    });
    await adapter.start({ sessionId: 's1' });
    expect(await adapter.listSessions()).toEqual(records);

    const bare = new NativeSessionAdapter({
      createClient: (o) => Promise.resolve(new FakeClient(o)),
    });
    await bare.start({ sessionId: 's2' });
    expect(await bare.listSessions()).toEqual([]);
  });
});

describe('nativeEngineOpsFromRustLoop', () => {
  it('binds every op to the matching rust-loop function (session id forwarded; permission process-wide)', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const record =
      (name: string, ret: unknown = null) =>
      (...args: unknown[]) => {
        calls.push([name, args]);
        return Promise.resolve(ret);
      };
    const fakeRustLoop = {
      sessionSetModel: record('sessionSetModel'),
      sessionSetThinking: record('sessionSetThinking'),
      sessionRunShell: record('sessionRunShell', { output: 'o', is_error: false }),
      sessionSteer: record('sessionSteer'),
      sessionAddAdditionalDir: record('sessionAddAdditionalDir', { success: true, additional_dirs: ['/d'] }),
      sessionRemoveAdditionalDir: record('sessionRemoveAdditionalDir', { success: true, additional_dirs: [] }),
      sessionUpdateMetadata: record('sessionUpdateMetadata', { ok: true, metadata: { a: 1 } }),
      sessionGoalCreate: record('sessionGoalCreate', { goal_id: 'g1', objective: 'x', status: 'active' }),
      sessionGoalGet: record('sessionGoalGet', { goal: null }),
      sessionGoalPause: record('sessionGoalPause', { goal_id: 'g1', objective: 'x', status: 'paused' }),
      sessionGoalResume: record('sessionGoalResume', { goal_id: 'g1', objective: 'x', status: 'active' }),
      sessionGoalCancel: record('sessionGoalCancel', { goal_id: 'g1', objective: 'x', status: 'cancelled' }),
      sessionSetSwarmMode: record('sessionSetSwarmMode', { active: true }),
      sessionSetPlanMode: record('sessionSetPlanMode', { plan_mode: true }),
      sessionGetStatus: record('sessionGetStatus', {
        thinking_effort: '', permission: 'manual', plan_mode: false, swarm_mode: false,
        goal_enabled: true, context_tokens: 10, max_context_tokens: 100, context_usage: 0.1,
      }),
      sessionListMcpServers: record('sessionListMcpServers', { servers: [] }),
      sessionListSkills: record('sessionListSkills', { skills: [] }),
      sessionGetWarnings: record('sessionGetWarnings', { warnings: [] }),
      sessionGetUsage: record('sessionGetUsage', { total: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } }),
      sessionCompact: record('sessionCompact', { compacted: true, summary: 's' }),
      sessionCancelCompaction: record('sessionCancelCompaction', { cancelled: true }),
      sessionGetContext: record('sessionGetContext', { history: [], token_count: 0 }),
      sessionClearContext: record('sessionClearContext', { cleared: true }),
      sessionImportContext: record('sessionImportContext', { imported: true }),
      sessionUndoHistory: record('sessionUndoHistory', { undone_turns: 1, cut_index: 0 }),
      sessionGetPlan: record('sessionGetPlan', { id: 'p1', content: '', path: '/p.md' }),
      sessionClearPlan: record('sessionClearPlan', { cleared: true }),
      sessionActivateSkill: record('sessionActivateSkill', { stop_reason: 'EndTurn', steps: 1 }),
      sessionReconnectMcpServer: record('sessionReconnectMcpServer', { name: 'x', status: 'failed', tool_count: 0 }),
      sessionGetMcpStartupMetrics: record('sessionGetMcpStartupMetrics', { duration_ms: 12 }),
      sessionCancelShellCommand: record('sessionCancelShellCommand', { cancelled: false }),
      sessionInit: record('sessionInit', { ok: true }),
      cronList: record('cronList', { tasks: [] }),
      bgOutput: record('bgOutput', { preview: 'out' }),
      bgStop: record('bgStop', { ok: true }),
      bgList: record('bgList', []),
      sessionList: record('sessionList', { sessions: [] }),
      pluginList: record('pluginList', { plugins: [] }),
      pluginGet: record('pluginGet', null),
      pluginInstall: record('pluginInstall', { id: 'p1', display_name: 'p', version: '1', enabled: true }),
      pluginSetEnabled: record('pluginSetEnabled', { id: 'p1', enabled: true }),
      pluginSetMcpEnabled: record('pluginSetMcpEnabled', null),
      pluginRemove: record('pluginRemove', { removed: true }),
      pluginReload: record('pluginReload', { ok: true }),
      pluginListCommands: record('pluginListCommands', { commands: [] }),
      pluginActivateCommand: record('pluginActivateCommand', { accepted: true }),
      bgDetach: record('bgDetach', null),
      permissionSetMode: record('permissionSetMode'),
    };
    const ops = nativeEngineOpsFromRustLoop(fakeRustLoop as unknown as RustLoopSessionApi);

    await ops.setModel?.('S', 'm');
    await ops.setThinking?.('S', 'high');
    await ops.runShell?.('S', 'echo', 5, 'cmd1');
    await ops.steer?.('S', [{ type: 'text', text: 'hi' }]);
    await ops.addAdditionalDir?.('S', '/d');
    await ops.removeAdditionalDir?.('S', '/d');
    await ops.updateMetadata?.('S', { a: 1 });
    await ops.goalCreate?.('S', { objective: 'x', replace: true });
    await ops.goalGet?.('S');
    await ops.goalPause?.('S', 'why');
    await ops.goalResume?.('S');
    await ops.goalCancel?.('S');
    await ops.setSwarmMode?.('S', true, 'manual');
    await ops.setPlanMode?.('S', true);
    await ops.getStatus?.('S');
    await ops.listMcpServers?.('S');
    await ops.listSkills?.('S');
    await ops.getWarnings?.('S');
    await ops.getUsage?.('S');
    await ops.compact?.('S', 'focus on the bug');
    await ops.cancelCompaction?.('S');
    await ops.getContext?.('S');
    await ops.clearContext?.('S');
    await ops.importContext?.('S', 'txt', 'src');
    await ops.undoHistory?.('S', 2);
    await ops.getPlan?.('S');
    await ops.clearPlan?.('S');
    await ops.activateSkill?.('S', 'brainstorm', 'args');
    await ops.reconnectMcpServer?.('S', 'x');
    await ops.getMcpStartupMetrics?.('S');
    await ops.cancelShellCommand?.('S', 'cmd1');
    await ops.init?.('S');
    await ops.getCronTasks?.();
    await ops.getBackgroundTaskOutput?.('t1');
    await ops.stopBackgroundTask?.('t1', 'why');
    await ops.listBackgroundTasks?.();
    await ops.listSessions?.(10, 0);
    await ops.listPlugins?.();
    await ops.getPluginInfo?.('p1');
    await ops.installPlugin?.('/tmp/p');
    await ops.setPluginEnabled?.('p1', false);
    await ops.setPluginMcpServerEnabled?.('p1', 'srv', false);
    await ops.removePlugin?.('p1');
    await ops.reloadPlugins?.();
    await ops.listPluginCommands?.('p1');
    await ops.activatePluginCommand?.('S', 'p1', 'review', 'focus');
    await ops.detachBackgroundTask?.('t1');
    await ops.setPermissionMode?.('S', 'manual');

    expect(calls).toEqual([
      ['sessionSetModel', ['S', 'm']],
      ['sessionSetThinking', ['S', 'high']],
      ['sessionRunShell', ['S', 'echo', 5, 'cmd1']],
      ['sessionSteer', ['S', [{ type: 'text', text: 'hi' }]]],
      ['sessionAddAdditionalDir', ['S', '/d']],
      ['sessionRemoveAdditionalDir', ['S', '/d']],
      ['sessionUpdateMetadata', ['S', { a: 1 }]],
      ['sessionGoalCreate', ['S', { objective: 'x', replace: true }]],
      ['sessionGoalGet', ['S']],
      ['sessionGoalPause', ['S', 'why']],
      ['sessionGoalResume', ['S', undefined]],
      ['sessionGoalCancel', ['S']],
      ['sessionSetSwarmMode', ['S', true, 'manual']],
      ['sessionSetPlanMode', ['S', true]],
      ['sessionGetStatus', ['S']],
      ['sessionListMcpServers', ['S']],
      ['sessionListSkills', ['S']],
      ['sessionGetWarnings', ['S']],
      ['sessionGetUsage', ['S']],
      ['sessionCompact', ['S', 'focus on the bug']],
      ['sessionCancelCompaction', ['S']],
      ['sessionGetContext', ['S']],
      ['sessionClearContext', ['S']],
      ['sessionImportContext', ['S', 'txt', 'src']],
      ['sessionUndoHistory', ['S', 2]],
      ['sessionGetPlan', ['S']],
      ['sessionClearPlan', ['S']],
      ['sessionActivateSkill', ['S', 'brainstorm', 'args']],
      ['sessionReconnectMcpServer', ['S', 'x']],
      ['sessionGetMcpStartupMetrics', ['S']],
      ['sessionCancelShellCommand', ['S', 'cmd1']],
      ['sessionInit', ['S']],
      ['cronList', []],
      ['bgOutput', ['t1']],
      ['bgStop', ['t1', 'why']],
      ['bgList', []],
      ['sessionList', [10, 0]],
      ['pluginList', []],
      ['pluginGet', ['p1']],
      ['pluginInstall', ['/tmp/p']],
      ['pluginSetEnabled', ['p1', false]],
      ['pluginSetMcpEnabled', ['p1', 'srv', false]],
      ['pluginRemove', ['p1']],
      ['pluginReload', []],
      ['pluginListCommands', ['p1']],
      ['pluginActivateCommand', [{ sessionId: 'S', pluginId: 'p1', commandName: 'review', args: 'focus' }]],
      ['bgDetach', ['t1']],
      // permission is process-wide: session id dropped, only the mode forwarded.
      ['permissionSetMode', ['manual']],
    ]);
  });
});
