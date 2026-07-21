import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { ContentPart } from '#/kosong/contract/message';
import { describe, expect, it, vi } from 'vitest';

import { makeHookRunner } from '../../agent/externalHooks/runner-stub';

function nodeCommand(source: string): string {
  return `node -e ${JSON.stringify(source.replaceAll(/\s*\n\s*/g, ' '))}`;
}

describe('ExternalHooksRunnerService', () => {
  it('fires a hook whose matcher regex matches the matcher value', async () => {
    const runner = makeHookRunner([
      { event: 'PreToolUse', matcher: 'Bash|Write', command: nodeCommand('process.exit(0);'), timeout: 5 },
      { event: 'PreToolUse', matcher: 'Read', command: nodeCommand('process.exit(2);'), timeout: 5 },
      { event: 'Stop', matcher: '', command: nodeCommand('process.stdout.write("done");'), timeout: 5 },
    ]);

    const results = await runner.trigger('PreToolUse', {
      matcherValue: 'Bash',
      inputData: { toolName: 'Bash' },
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe('allow');
  });

  it('returns no results when no hook matcher matches the matcher value', async () => {
    const runner = makeHookRunner([
      { event: 'PreToolUse', matcher: 'Bash|Write', command: nodeCommand('process.exit(0);'), timeout: 5 },
      { event: 'PreToolUse', matcher: 'Read', command: nodeCommand('process.exit(2);'), timeout: 5 },
    ]);

    const results = await runner.trigger('PreToolUse', { matcherValue: 'Grep', inputData: {} });
    expect(results).toHaveLength(0);
  });

  it('maps exit code 2 to a block action', async () => {
    const runner = makeHookRunner([
      { event: 'PreToolUse', matcher: 'Read', command: nodeCommand('process.exit(2);'), timeout: 5 },
    ]);

    const results = await runner.trigger('PreToolUse', { matcherValue: 'Read', inputData: {} });
    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe('block');
  });

  it('exposes a triggerBlock helper for block decisions', async () => {
    const runner = makeHookRunner([
      {
        event: 'PreToolUse',
        matcher: 'Read',
        command: nodeCommand('process.stderr.write("blocked"); process.exit(2);'),
        timeout: 5,
      },
    ]);

    await expect(
      runner.triggerBlock('PreToolUse', { matcherValue: 'Read', inputData: {} }),
    ).resolves.toEqual({ block: true, reason: 'blocked' });
  });

  it('fills a default triggerBlock reason when the hook result has none', async () => {
    const runner = makeHookRunner([
      { event: 'PreToolUse', matcher: 'Read', command: nodeCommand('process.exit(2);'), timeout: 5 },
    ]);

    await expect(
      runner.triggerBlock('PreToolUse', { matcherValue: 'Read', inputData: {} }),
    ).resolves.toEqual({ block: true, reason: 'Blocked by PreToolUse hook' });
  });

  it('aborts a running hook when the trigger signal aborts', async () => {
    const abortController = new AbortController();
    const runner = makeHookRunner([
      { event: 'PreToolUse', matcher: 'Bash', command: nodeCommand('setTimeout(() => {}, 10000);'), timeout: 5 },
    ]);
    const startedAt = Date.now();
    setTimeout(() => {
      abortController.abort();
    }, 50);

    const results = await runner.trigger('PreToolUse', {
      matcherValue: 'Bash',
      inputData: {},
      signal: abortController.signal,
    });

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe('allow');
    expect(results[0]?.timedOut).toBeUndefined();
  });

  it('serializes camelCase inputData as snake_case for hook stdin', async () => {
    const runner = makeHookRunner([
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        command: nodeCommand([
          'let input = "";',
          'process.stdin.on("data", (chunk) => { input += chunk; });',
          'process.stdin.on("end", () => {',
          '  const parsed = JSON.parse(input);',
          '  process.stdout.write(String(parsed.tool_name) + " " + String(parsed.tool_call_id));',
          '});',
        ].join('\n')),
        timeout: 5,
      },
    ]);

    const results = await runner.trigger('PreToolUse', {
      matcherValue: 'Bash',
      inputData: { toolName: 'Bash', toolCallId: 'call_1' },
    });

    expect(results[0]?.stdout?.trim()).toBe('Bash call_1');
  });

  it('adds sessionId, cwd, and hookEventName from runner context', async () => {
    const runner = makeHookRunner(
      [
        {
          event: 'SessionStart',
          command: nodeCommand([
            'let input = "";',
            'process.stdin.on("data", (chunk) => { input += chunk; });',
            'process.stdin.on("end", () => {',
            '  const parsed = JSON.parse(input);',
            '  process.stdout.write(String(parsed.hook_event_name) + " " + String(parsed.session_id) + " " + String(parsed.cwd));',
            '});',
          ].join('\n')),
          timeout: 5,
        },
      ],
      { cwd: '/tmp' },
    );

    const results = await runner.trigger('SessionStart', { sessionId: 'ses_123' });
    expect(results[0]?.stdout?.trim()).toBe('SessionStart ses_123 /tmp');
  });

  it('runs hooks with per-hook cwd and env overrides', async () => {
    const runner = makeHookRunner(
      [
        {
          event: 'PreToolUse',
          command: nodeCommand('process.stdout.write(process.cwd() + " " + String(process.env.PLUGIN_HOOK_TEST));'),
          timeout: 5,
          cwd: realpathSync(tmpdir()),
          env: { PLUGIN_HOOK_TEST: 'plugin-env' },
        },
      ],
      { cwd: '/var/tmp' },
    );

    const results = await runner.trigger('PreToolUse', { matcherValue: '', inputData: {} });
    expect(results[0]?.stdout?.trim()).toBe(`${realpathSync(tmpdir())} plugin-env`);
  });

  it('treats an empty matcher string as a catch-all for any matcher value', async () => {
    const runner = makeHookRunner([
      { event: 'Stop', matcher: '', command: nodeCommand('process.stdout.write("done");'), timeout: 5 },
    ]);

    const results = await runner.trigger('Stop', { matcherValue: 'anything', inputData: {} });
    expect(results).toHaveLength(1);
  });

  it('matches ContentPart matcher values against their text content', async () => {
    const input = [
      { type: 'text', text: 'hello' },
      { type: 'image_url', imageUrl: { url: 'file:///tmp/a.png' } },
      { type: 'text', text: 'world' },
    ] satisfies readonly ContentPart[];
    const runner = makeHookRunner([
      { event: 'UserPromptSubmit', matcher: 'hello world', command: nodeCommand('process.exit(0);'), timeout: 5 },
    ]);

    const results = await runner.trigger('UserPromptSubmit', { matcherValue: input, inputData: {} });
    expect(results).toHaveLength(1);
  });

  it('returns no results for events that have no registered hooks', async () => {
    const runner = makeHookRunner([
      { event: 'PreToolUse', matcher: 'Bash', command: 'echo 1' },
    ]);

    const results = await runner.trigger('UserPromptSubmit', { matcherValue: '', inputData: {} });
    expect(results).toHaveLength(0);
  });

  it('dedupes hooks with identical command strings so they only fire once', async () => {
    const command = nodeCommand('process.stdout.write("once");');
    const runner = makeHookRunner([
      { event: 'Stop', command, timeout: 5 },
      { event: 'Stop', command, timeout: 5 },
    ]);

    const results = await runner.trigger('Stop', { inputData: {} });
    expect(results).toHaveLength(1);
  });

  it('does not dedupe hooks that share a command but have different cwd', async () => {
    const command = nodeCommand('process.stdout.write(process.cwd() + "\\n");');
    const runner = makeHookRunner([
      { event: 'Stop', command, timeout: 5, cwd: process.cwd() },
      { event: 'Stop', command, timeout: 5, cwd: tmpdir() },
    ]);

    const results = await runner.trigger('Stop', { inputData: {} });
    expect(results).toHaveLength(2);
    expect(new Set(results.map((result) => result.stdout?.trim()))).toEqual(
      new Set([realpathSync(process.cwd()), realpathSync(tmpdir())]),
    );
  });

  it('silently skips hooks whose matcher is not a valid regex', async () => {
    const runner = makeHookRunner([
      { event: 'PreToolUse', matcher: '[invalid', command: nodeCommand('process.exit(0);'), timeout: 5 },
    ]);

    const results = await runner.trigger('PreToolUse', { matcherValue: 'Bash', inputData: {} });
    expect(results).toHaveLength(0);
  });

  it('fails open when trigger input preparation throws', async () => {
    const inputData = {};
    Object.defineProperty(inputData, 'broken', {
      enumerable: true,
      get() {
        throw new Error('broken input');
      },
    });
    const runner = makeHookRunner([
      { event: 'PreToolUse', matcher: 'Bash', command: nodeCommand('process.stdout.write("should-not-run");') },
    ]);

    await expect(
      runner.trigger('PreToolUse', { matcherValue: 'Bash', inputData }),
    ).resolves.toEqual([]);
    await expect(
      runner.triggerBlock('PreToolUse', { matcherValue: 'Bash', inputData }),
    ).resolves.toBeUndefined();
  });

  it('fails open when fireAndForgetTrigger sees a synchronous trigger error', async () => {
    const runner = makeHookRunner([]);
    vi.spyOn(runner, 'trigger').mockImplementation(() => {
      throw new Error('trigger failed');
    });

    await expect(runner.fireAndForgetTrigger('Notification')).resolves.toEqual([]);
  });

  it('invokes onTriggered with (event,target,count) and onResolved with (event,target,action)', async () => {
    const triggered: Array<[string, string, number]> = [];
    const resolved: Array<[string, string, string]> = [];
    const runner = makeHookRunner(
      [{ event: 'PreToolUse', matcher: 'Bash', command: nodeCommand('process.exit(0);'), timeout: 5 }],
      {
        onTriggered: (event, target, count) => triggered.push([event, target, count]),
        onResolved: (event, target, action) => resolved.push([event, target, action]),
      },
    );

    await runner.trigger('PreToolUse', { matcherValue: 'Bash', inputData: {} });

    expect(triggered).toEqual([['PreToolUse', 'Bash', 1]]);
    expect(resolved).toEqual([['PreToolUse', 'Bash', 'allow']]);
  });

  it('preserves a block result even when lifecycle callbacks throw', async () => {
    const runner = makeHookRunner(
      [{ event: 'PreToolUse', matcher: 'Read', command: nodeCommand('process.exit(2);'), timeout: 5 }],
      {
        onTriggered: () => {
          throw new Error('trigger telemetry failed');
        },
        onResolved: () => {
          throw new Error('resolve telemetry failed');
        },
      },
    );

    const results = await runner.trigger('PreToolUse', { matcherValue: 'Read', inputData: {} });
    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe('block');
  });
});
