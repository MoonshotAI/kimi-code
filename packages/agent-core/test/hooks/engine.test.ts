import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';
import type { ContentPart } from '@moonshot-ai/kosong';

// Dynamic-import contract: locks the public shape of the future HookEngine
// without forcing TS module resolution to find a file that doesn't exist yet.
const ENGINE_MODULE = '../../src/session/hooks/engine' as string;

type HookDef = {
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
};

interface HookResult {
  action: 'allow' | 'block';
  reason?: string;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

interface HookBlockDecision {
  block: true;
  reason?: string;
}

type HookMatcherValue = string | readonly ContentPart[];

interface HookEngineCtor {
  new (
    hooks: HookDef[],
    options?: {
      cwd?: string;
      sessionId?: string;
      onTriggered?: (event: string, target: string, count: number) => void;
      onResolved?: (
        event: string,
        target: string,
        action: string,
        reason: string | undefined,
        durationMs: number,
      ) => void;
    },
  ): {
    trigger: (
      event: string,
      args?: {
        matcherValue?: HookMatcherValue;
        inputData?: Record<string, unknown>;
        signal?: AbortSignal;
      },
    ) => Promise<HookResult[]>;
    triggerBlock: (
      event: string,
      args?: {
        matcherValue?: HookMatcherValue;
        inputData?: Record<string, unknown>;
        signal?: AbortSignal;
      },
    ) => Promise<HookBlockDecision | undefined>;
    fireAndForgetTrigger: (
      event: string,
      args?: {
        matcherValue?: HookMatcherValue;
        inputData?: Record<string, unknown>;
        signal?: AbortSignal;
      },
    ) => Promise<HookResult[]>;
    summary: Record<string, number>;
  };
}

interface EngineModule {
  HookEngine: HookEngineCtor;
}

async function importEngine(): Promise<EngineModule> {
  return (await import(ENGINE_MODULE)) as EngineModule;
}

describe('HookEngine', () => {
  it('fires a PreToolUse hook whose matcher regex matches the matcher value', async () => {
    const { HookEngine } = await importEngine();
    const engine = new HookEngine([
      { event: 'PreToolUse', matcher: 'Shell|WriteFile', command: 'exit 0', timeout: 5 },
      { event: 'PreToolUse', matcher: 'ReadFile', command: 'exit 2', timeout: 5 },
      { event: 'Stop', matcher: '', command: 'echo done', timeout: 5 },
    ]);
    const results = await engine.trigger('PreToolUse', {
      matcherValue: 'Shell',
      inputData: { toolName: 'Shell' },
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe('allow');
  });

  it('returns no results when no hook matcher matches the matcher value', async () => {
    const { HookEngine } = await importEngine();
    const engine = new HookEngine([
      { event: 'PreToolUse', matcher: 'Shell|WriteFile', command: 'exit 0', timeout: 5 },
      { event: 'PreToolUse', matcher: 'ReadFile', command: 'exit 2', timeout: 5 },
    ]);
    const results = await engine.trigger('PreToolUse', {
      matcherValue: 'Grep',
      inputData: {},
    });
    expect(results).toHaveLength(0);
  });

  it('maps exit code 2 to a block action', async () => {
    const { HookEngine } = await importEngine();
    const engine = new HookEngine([
      { event: 'PreToolUse', matcher: 'ReadFile', command: 'exit 2', timeout: 5 },
    ]);
    const results = await engine.trigger('PreToolUse', {
      matcherValue: 'ReadFile',
      inputData: {},
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe('block');
  });

  it('exposes a triggerBlock helper for block decisions', async () => {
    const { HookEngine } = await importEngine();
    const engine = new HookEngine([
      {
        event: 'PreToolUse',
        matcher: 'ReadFile',
        command: 'node -e "process.stderr.write(\'blocked\'); process.exit(2)"',
        timeout: 5,
      },
    ]);

    await expect(
      engine.triggerBlock('PreToolUse', {
        matcherValue: 'ReadFile',
        inputData: {},
      }),
    ).resolves.toEqual({ block: true, reason: 'blocked' });
  });

  it('fills a default triggerBlock reason when the hook result has none', async () => {
    const { HookEngine } = await importEngine();
    const engine = new HookEngine([
      { event: 'PreToolUse', matcher: 'ReadFile', command: 'exit 2', timeout: 5 },
    ]);

    await expect(
      engine.triggerBlock('PreToolUse', {
        matcherValue: 'ReadFile',
        inputData: {},
      }),
    ).resolves.toEqual({ block: true, reason: 'Blocked by PreToolUse hook' });
  });

  it('aborts a running hook when the trigger signal aborts', async () => {
    const { HookEngine } = await importEngine();
    const abortController = new AbortController();
    const engine = new HookEngine([
      {
        event: 'PreToolUse',
        matcher: 'Shell',
        command: 'node -e "setTimeout(() => {}, 10000)"',
        timeout: 5,
      },
    ]);
    const startedAt = Date.now();
    setTimeout(() => {
      abortController.abort();
    }, 50);

    const results = await engine.trigger('PreToolUse', {
      matcherValue: 'Shell',
      inputData: {},
      signal: abortController.signal,
    });

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe('allow');
    expect(results[0]?.timedOut).toBeUndefined();
  });

  it('serializes camelCase inputData as snake_case for hook stdin', async () => {
    const { HookEngine } = await importEngine();
    const engine = new HookEngine([
      {
        event: 'PreToolUse',
        matcher: 'Shell',
        command:
          'node -e "let s=\\"\\";process.stdin.on(\\"data\\",d=>s+=d);process.stdin.on(\\"end\\",()=>{const o=JSON.parse(s);process.stdout.write(o.tool_name+\\" \\"+o.tool_call_id);})"',
        timeout: 5,
      },
    ]);

    const results = await engine.trigger('PreToolUse', {
      matcherValue: 'Shell',
      inputData: { toolName: 'Shell', toolCallId: 'call_1' },
    });

    expect(results[0]?.stdout?.trim()).toBe('Shell call_1');
  });

  it('adds sessionId, cwd, and hookEventName from engine context', async () => {
    const { HookEngine } = await importEngine();
    const engine = new HookEngine(
      [
        {
          event: 'SessionStart',
          command:
            'node -e "let s=\\"\\";process.stdin.on(\\"data\\",d=>s+=d);process.stdin.on(\\"end\\",()=>{const o=JSON.parse(s);process.stdout.write(o.hook_event_name+\\" \\"+o.session_id+\\" \\"+o.cwd);})"',
          timeout: 5,
        },
      ],
      {
        sessionId: 'ses_123',
        cwd: '/tmp',
      },
    );

    const results = await engine.trigger('SessionStart');

    expect(results[0]?.stdout?.trim()).toBe('SessionStart ses_123 /tmp');
  });

  it('treats an empty matcher string as a catch-all for any matcher value', async () => {
    const { HookEngine } = await importEngine();
    const engine = new HookEngine([
      { event: 'Stop', matcher: '', command: 'echo done', timeout: 5 },
    ]);
    const results = await engine.trigger('Stop', {
      matcherValue: 'anything',
      inputData: {},
    });
    expect(results).toHaveLength(1);
  });

  it('matches ContentPart matcher values against their text content', async () => {
    const { HookEngine } = await importEngine();
    const engine = new HookEngine([
      { event: 'UserPromptSubmit', matcher: 'hello world', command: 'exit 0', timeout: 5 },
    ]);
    const results = await engine.trigger('UserPromptSubmit', {
      matcherValue: [
        { type: 'text', text: 'hello' },
        { type: 'image_url', imageUrl: { url: 'file:///tmp/a.png' } },
        { type: 'text', text: 'world' },
      ],
      inputData: {},
    });
    expect(results).toHaveLength(1);
  });

  it('returns no results for events that have no registered hooks', async () => {
    const { HookEngine } = await importEngine();
    const engine = new HookEngine([
      { event: 'PreToolUse', matcher: 'Shell', command: 'exit 0', timeout: 5 },
    ]);
    const results = await engine.trigger('UserPromptSubmit', {
      matcherValue: '',
      inputData: {},
    });
    expect(results).toHaveLength(0);
  });

  it('dedupes hooks with identical command strings so they only fire once', async () => {
    const { HookEngine } = await importEngine();
    const engine = new HookEngine([
      { event: 'Stop', command: 'echo once', timeout: 5 },
      { event: 'Stop', command: 'echo once', timeout: 5 },
    ]);
    const results = await engine.trigger('Stop', { inputData: {} });
    expect(results).toHaveLength(1);
  });

  it('silently skips hooks whose matcher is not a valid regex', async () => {
    const { HookEngine } = await importEngine();
    const engine = new HookEngine([
      { event: 'PreToolUse', matcher: '[invalid', command: 'exit 0', timeout: 5 },
    ]);
    const results = await engine.trigger('PreToolUse', {
      matcherValue: 'Shell',
      inputData: {},
    });
    expect(results).toHaveLength(0);
  });

  it('fails open when trigger input preparation throws', async () => {
    const { HookEngine } = await importEngine();
    const inputData = {};
    Object.defineProperty(inputData, 'broken', {
      enumerable: true,
      get() {
        throw new Error('broken input');
      },
    });
    const engine = new HookEngine([{ event: 'PreToolUse', command: 'echo should-not-run' }]);

    await expect(
      engine.trigger('PreToolUse', {
        matcherValue: 'Bash',
        inputData,
      }),
    ).resolves.toEqual([]);
    await expect(
      engine.triggerBlock('PreToolUse', {
        matcherValue: 'Bash',
        inputData,
      }),
    ).resolves.toBeUndefined();
  });

  it('fails open when fireAndForgetTrigger sees a synchronous trigger error', async () => {
    const { HookEngine } = await importEngine();
    const engine = new HookEngine([]);
    vi.spyOn(engine, 'trigger').mockImplementation(() => {
        throw new Error('trigger failed');
    });

    await expect(engine.fireAndForgetTrigger('Notification')).resolves.toEqual([]);
  });

  it('preserves a PreToolUse block result even when telemetry throws (no fail-open)', async () => {
    // Safety-critical: a telemetry failure MUST NOT silently bypass a block.
    const telemetry = await import('../../src/utils/telemetry' as string).catch(() => null);
    const { HookEngine } = await importEngine();
    const engine = new HookEngine([
      { event: 'PreToolUse', matcher: 'ReadFile', command: 'exit 2', timeout: 5 },
    ]);

    const spy =
      telemetry && typeof (telemetry as { track?: unknown }).track === 'function'
        ? vi
            .spyOn(telemetry as { track: (...args: unknown[]) => unknown }, 'track')
            .mockImplementation(() => {
              throw new Error('telemetry broken');
            })
        : null;

    try {
      const results = await engine.trigger('PreToolUse', {
        matcherValue: 'ReadFile',
        inputData: {},
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.action).toBe('block');
    } finally {
      spy?.mockRestore();
    }
  });

  it('runs a hook with HookDef.cwd as the working directory', async () => {
    const { HookEngine } = await importEngine();
    const pluginCwd = tmpdir();
    const engine = new HookEngine(
      [
        {
          event: 'PreToolUse',
          command: 'node -e "process.stdout.write(process.cwd())"',
          timeout: 5,
          cwd: pluginCwd,
        },
      ],
      { cwd: process.cwd() },
    );
    const results = await engine.trigger('PreToolUse', { inputData: {} });
    expect(results[0]?.stdout).toBe(realpathSync(pluginCwd));
  });

  it('passes HookDef.env into the hook process environment', async () => {
    const { HookEngine } = await importEngine();
    const engine = new HookEngine([
      {
        event: 'PreToolUse',
        command: 'node -e "process.stdout.write(process.env.KIMI_PLUGIN_TEST ?? \'missing\')"',
        timeout: 5,
        env: { KIMI_PLUGIN_TEST: 'plugin-value' },
      },
    ]);
    const results = await engine.trigger('PreToolUse', { inputData: {} });
    expect(results[0]?.stdout).toBe('plugin-value');
  });

  it('does not dedupe hooks that share a command but have different cwd', async () => {
    const { HookEngine } = await importEngine();
    const engine = new HookEngine([
      { event: 'Stop', command: 'echo same', timeout: 5, cwd: process.cwd() },
      { event: 'Stop', command: 'echo same', timeout: 5, cwd: tmpdir() },
    ]);
    const results = await engine.trigger('Stop', { inputData: {} });
    expect(results).toHaveLength(2);
  });
});
