import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import type { ContentPart } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

// Dynamic-import contract: locks the Agent <-> HookEngine integration shape
// (engine ctor, trigger surface, summary, wire callbacks, event helpers,
// config round-trip) before the implementation lands.
const ENGINE_MODULE = '../../src/session/hooks/engine' as string;
const CONFIG_MODULE = '../../src/config' as string;

type HookDef = {
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
};

interface HookResult {
  action: 'allow' | 'block';
  reason?: string;
  stdout?: string;
  stderr?: string;
}

type HookMatcherValue = string | readonly ContentPart[];

interface HookEngineInstance {
  trigger: (
    event: string,
    args?: { matcherValue?: HookMatcherValue; inputData?: Record<string, unknown> },
  ) => Promise<HookResult[]>;
  summary: Record<string, number>;
}

interface HookEngineCtor {
  new (
    hooks: HookDef[],
    options?: {
      cwd?: string;
      onTriggered?: (event: string, target: string, count: number) => void;
      onResolved?: (
        event: string,
        target: string,
        action: string,
        reason: string | undefined,
        durationMs: number,
      ) => void;
    },
  ): HookEngineInstance;
}

async function importEngine(): Promise<HookEngineCtor> {
  const mod = (await import(ENGINE_MODULE)) as { HookEngine: HookEngineCtor };
  return mod.HookEngine;
}

describe('HookEngine integration', () => {
  it('blocks a dangerous Shell command and allows a safe one via a PreToolUse script hook', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-hooks-int-'));
    const script = join(dir, 'block-rm.cjs');
    // Node script body (avoids bash-only syntax so the test runs on Windows).
    writeFileSync(
      script,
      [
        "let s='';",
        "process.stdin.on('data',d=>s+=d);",
        "process.stdin.on('end',()=>{try{const o=JSON.parse(s);const c=(o.tool_input&&o.tool_input.command)||'';if(/rm -rf/.test(c)){process.stderr.write('Blocked: rm -rf');process.exit(2);}process.exit(0);}catch(e){}});",
      ].join('\n'),
      'utf-8',
    );

    const HookEngine = await importEngine();
    const engine = new HookEngine(
      [{ event: 'PreToolUse', matcher: 'Shell', command: `${process.execPath} ${script}`, timeout: 5 }],
      { cwd: dir },
    );

    const safe = await engine.trigger('PreToolUse', {
      matcherValue: 'Shell',
      inputData: { tool_name: 'Shell', tool_input: { command: 'ls -la' } },
    });
    expect(safe.every((r) => r.action === 'allow')).toBe(true);

    const dangerous = await engine.trigger('PreToolUse', {
      matcherValue: 'Shell',
      inputData: { tool_name: 'Shell', tool_input: { command: 'rm -rf /' } },
    });
    expect(dangerous.some((r) => r.action === 'block')).toBe(true);
    expect(dangerous[0]?.reason).toContain('rm -rf');
  });

  it('honors a Stop hook returning permissionDecision=deny by producing a block result with reason', async () => {
    const HookEngine = await importEngine();
    const engine = new HookEngine([
      {
        event: 'Stop',
        command:
          "node -e \"process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:'deny',permissionDecisionReason:'tests not written'}}))\"",
        timeout: 5,
      },
    ]);
    const results = await engine.trigger('Stop', { inputData: { stop_hook_active: false } });
    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe('block');
    expect(results[0]?.reason).toContain('tests not written');
  });

  it('fires a Notification hook only when its matcher equals the notification matcher value', async () => {
    const HookEngine = await importEngine();
    const engine = new HookEngine([
      { event: 'Notification', matcher: 'task_completed', command: 'echo notified', timeout: 5 },
      { event: 'Notification', matcher: 'other_type', command: 'echo other', timeout: 5 },
    ]);
    const results = await engine.trigger('Notification', {
      matcherValue: 'task_completed',
      inputData: { notification_type: 'task_completed', title: 'Done' },
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.stdout?.trim()).toBe('notified');
  });

  it('runs multiple hooks for the same event in parallel and collects every result', async () => {
    const HookEngine = await importEngine();
    const engine = new HookEngine([
      { event: 'PostToolUse', matcher: 'WriteFile', command: 'echo hook1', timeout: 5 },
      { event: 'PostToolUse', matcher: 'WriteFile', command: 'echo hook2', timeout: 5 },
    ]);
    const results = await engine.trigger('PostToolUse', {
      matcherValue: 'WriteFile',
      inputData: { tool_name: 'WriteFile' },
    });
    expect(results).toHaveLength(2);
    const outputs = new Set(results.map((r) => r.stdout?.trim()));
    expect(outputs).toEqual(new Set(['hook1', 'hook2']));
  });

  it('round-trips hook definitions through the TOML config loader', async () => {
    const config = (await import(CONFIG_MODULE)) as {
      parseConfigString: (text: string, source?: string) => { hooks?: HookDef[] };
    };
    const toml = `
[[hooks]]
event = "PreToolUse"
matcher = "Shell"
command = "echo ok"

[[hooks]]
event = "Notification"
matcher = "permission_prompt"
command = "notify-send Kimi"
timeout = 5
`;
    const parsed = config.parseConfigString(toml, 'hooks.toml');
    expect(parsed.hooks).toHaveLength(2);
    expect(parsed.hooks?.[0]?.event).toBe('PreToolUse');
    expect(parsed.hooks?.[1]?.event).toBe('Notification');
    expect(parsed.hooks?.[1]?.timeout).toBe(5);
  });

  it('exposes a summary map of event name to registered hook count', async () => {
    const HookEngine = await importEngine();
    const engine = new HookEngine([
      { event: 'PreToolUse', matcher: 'Shell', command: 'echo 1' },
      { event: 'PreToolUse', matcher: 'WriteFile', command: 'echo 2' },
      { event: 'Stop', command: 'echo 3' },
    ]);
    expect(engine.summary).toEqual({ PreToolUse: 2, Stop: 1 });
  });

  it('feeds the SessionStart source field through stdin and filters by the startup matcher', async () => {
    const HookEngine = await importEngine();
    const engine = new HookEngine([
      {
        event: 'SessionStart',
        matcher: 'startup',
        command:
          'node -e "let s=\\"\\";process.stdin.on(\\"data\\",d=>s+=d);process.stdin.on(\\"end\\",()=>{const o=JSON.parse(s);process.stdout.write(o.source||\\"\\");})"',
        timeout: 5,
      },
    ]);

    const matched = await engine.trigger('SessionStart', {
      matcherValue: 'startup',
      inputData: { sessionId: 'test-123', cwd: '/tmp', source: 'startup' },
    });
    expect(matched).toHaveLength(1);
    expect(matched[0]?.stdout?.trim()).toBe('startup');

    const unmatched = await engine.trigger('SessionStart', {
      matcherValue: 'resume',
      inputData: { sessionId: 'test-123', cwd: '/tmp', source: 'resume' },
    });
    expect(unmatched).toHaveLength(0);
  });

  it('fires a PostToolUseFailure hook with the tool error in the payload', async () => {
    const HookEngine = await importEngine();
    const engine = new HookEngine([
      {
        event: 'PostToolUseFailure',
        matcher: 'Shell',
        command: 'echo failure_caught',
        timeout: 5,
      },
    ]);
    const results = await engine.trigger('PostToolUseFailure', {
      matcherValue: 'Shell',
      inputData: { tool_name: 'Shell', tool_input: {}, error: 'command not found' },
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe('allow');
    expect(results[0]?.stdout).toContain('failure_caught');
  });

  it('blocks a UserPromptSubmit prompt when the hook exits 2 and returns the reason to the user', async () => {
    const HookEngine = await importEngine();
    const engine = new HookEngine([
      {
        event: 'UserPromptSubmit',
        command: "node -e \"process.stderr.write('no profanity');process.exit(2)\"",
        timeout: 5,
      },
    ]);
    const results = await engine.trigger('UserPromptSubmit', {
      inputData: { prompt: 'bad words here' },
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe('block');
    expect(results[0]?.reason).toContain('no profanity');
  });

  it('fires a StopFailure hook on chat provider errors with the error_type field present', async () => {
    const HookEngine = await importEngine();
    const engine = new HookEngine([
      { event: 'StopFailure', command: 'echo error_logged', timeout: 5 },
    ]);
    const results = await engine.trigger('StopFailure', {
      inputData: { error_type: 'ChatProviderError', error_message: 'rate limited' },
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.stdout).toContain('error_logged');
  });

  it('fires a SessionEnd hook only for the matching reason matcher', async () => {
    const HookEngine = await importEngine();
    const engine = new HookEngine([
      { event: 'SessionEnd', matcher: 'exit', command: 'echo goodbye', timeout: 5 },
    ]);

    const matched = await engine.trigger('SessionEnd', {
      matcherValue: 'exit',
      inputData: { session_id: 's1', reason: 'exit' },
    });
    expect(matched).toHaveLength(1);

    const unmatched = await engine.trigger('SessionEnd', {
      matcherValue: 'clear',
      inputData: { session_id: 's1', reason: 'clear' },
    });
    expect(unmatched).toHaveLength(0);
  });

  it('fires a SubagentStart hook with the agent_name payload field', async () => {
    const HookEngine = await importEngine();
    const engine = new HookEngine([
      {
        event: 'SubagentStart',
        matcher: 'coder',
        command: 'echo agent_starting',
        timeout: 5,
      },
    ]);
    const results = await engine.trigger('SubagentStart', {
      matcherValue: 'coder',
      inputData: { agent_name: 'coder', prompt: 'Fix the bug' },
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.stdout).toContain('agent_starting');
  });

  it('fires a SubagentStop hook on subagent completion', async () => {
    const HookEngine = await importEngine();
    const engine = new HookEngine([
      { event: 'SubagentStop', matcher: 'coder', command: 'echo agent_done', timeout: 5 },
    ]);
    const results = await engine.trigger('SubagentStop', {
      matcherValue: 'coder',
      inputData: { agent_name: 'coder', response: 'Bug fixed' },
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.stdout).toContain('agent_done');
  });

  it('fires PreCompact and PostCompact hooks around compaction with trigger and token payloads', async () => {
    const HookEngine = await importEngine();
    const engine = new HookEngine([
      { event: 'PreCompact', matcher: 'auto', command: 'echo pre_compact', timeout: 5 },
      { event: 'PostCompact', matcher: 'auto', command: 'echo post_compact', timeout: 5 },
    ]);

    const pre = await engine.trigger('PreCompact', {
      matcherValue: 'auto',
      inputData: { trigger: 'auto', token_count: 150000 },
    });
    expect(pre).toHaveLength(1);
    expect(pre[0]?.stdout).toContain('pre_compact');

    const post = await engine.trigger('PostCompact', {
      matcherValue: 'auto',
      inputData: { trigger: 'auto', estimated_token_count: 50000 },
    });
    expect(post).toHaveLength(1);
    expect(post[0]?.stdout).toContain('post_compact');
  });

  it('invokes onTriggered with (event,target,count) and onResolved with (event,target,action)', async () => {
    const HookEngine = await importEngine();
    const triggered: Array<[string, string, number]> = [];
    const resolved: Array<[string, string, string]> = [];
    const engine = new HookEngine(
      [{ event: 'PreToolUse', matcher: 'Shell', command: 'exit 0', timeout: 5 }],
      {
        onTriggered: (e, t, c) => triggered.push([e, t, c]),
        onResolved: (e, t, a) => resolved.push([e, t, a]),
      },
    );

    await engine.trigger('PreToolUse', { matcherValue: 'Shell', inputData: {} });

    expect(triggered).toEqual([['PreToolUse', 'Shell', 1]]);
    expect(resolved).toEqual([['PreToolUse', 'Shell', 'allow']]);
  });
});
