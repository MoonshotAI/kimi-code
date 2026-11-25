import { describe, expect, it } from 'vitest';

import {
  buildHookSpawnOptions,
  HOOK_BLOCK_REASON_MAX_CHARS,
  HOOK_CONTEXT_MAX_CHARS,
  HOOK_STREAM_MAX_CHARS,
  runHook,
} from '#/features/externalHooks/internal/runHook';
import {
  renderUserPromptHookBlockResult,
  renderUserPromptHookResult,
} from '#/features/externalHooks/internal/userPrompt';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';

const hostProcess = new HostProcessService();

function nodeCommand(source: string): string {
  return `node -e ${JSON.stringify(source.replaceAll(/\s*\n\s*/g, ' '))}`;
}

describe('runHook process runner', () => {
  it('returns allow when the hook exits 0 and captures stdout', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write("ok\\n");'),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
    expect(result.stdout?.trim()).toBe('ok');
  });

  it('parses stdout JSON message into a hook result message', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write(JSON.stringify({ message: "hook says hi" }));'),
      {},
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
    expect(result.message).toBe('hook says hi');
    expect(result.structuredOutput).toBe(true);
  });

  it('marks structured stdout JSON without message as empty hook output', async () => {
    const emptyObject = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write("{}");'),
      {},
      { timeout: 5 },
    );
    expect(emptyObject.action).toBe('allow');
    expect(emptyObject.message).toBeUndefined();
    expect(emptyObject.structuredOutput).toBe(true);

    const emptyHookSpecificOutput = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write(JSON.stringify({ hookSpecificOutput: {} }));'),
      {},
      { timeout: 5 },
    );
    expect(emptyHookSpecificOutput.action).toBe('allow');
    expect(emptyHookSpecificOutput.message).toBeUndefined();
    expect(emptyHookSpecificOutput.structuredOutput).toBe(true);

    expect(renderUserPromptHookResult([emptyObject, emptyHookSpecificOutput])).toBeUndefined();

    const continueOnly = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write(JSON.stringify({ continue: true }));'),
      {},
      { timeout: 5 },
    );
    expect(renderUserPromptHookResult([continueOnly])).toBeUndefined();

    const plainText = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write("hook note");'),
      {},
      { timeout: 5 },
    );
    const secondNote = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write("second note");'),
      {},
      { timeout: 5 },
    );
    const rendered = renderUserPromptHookResult([plainText, secondNote]);
    expect(rendered?.messages).toEqual(['hook note', 'second note']);
    expect(rendered?.parts).toEqual([
      {
        type: 'text',
        text: '<hook_result hook_event="UserPromptSubmit">\nhook note\n</hook_result>',
        meta: { contentType: 'text/xml', source: 'user prompt submit hook' },
      },
      {
        type: 'text',
        text: '<hook_result hook_event="UserPromptSubmit">\nsecond note\n</hook_result>',
        meta: { contentType: 'text/xml', source: 'user prompt submit hook' },
      },
    ]);
  });

  it('returns block when the hook exits 2 and captures stderr as the reason', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.stderr.write("blocked\\n"); process.exit(2);'),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('block');
    expect(result.reason).toContain('blocked');
  });

  it('returns allow on non-zero, non-2 exit codes', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.exit(1);'),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
  });

  it('returns allow with timedOut=true when the command exceeds the timeout', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('setTimeout(() => {}, 10000);'),
      { tool_name: 'Bash' },
      { timeout: 0.05 },
    );

    expect(result.action).toBe('allow');
    expect(result.timedOut).toBe(true);
  });

  it('parses stdout JSON permissionDecision=deny into a block result with the supplied reason', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand(
        'process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "use rg" } }));',
      ),
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('block');
    expect(result.reason).toBe('use rg');
  });

  it('caps captured stdout at the stream limit and truncates plain-text prompt context', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write("a".repeat(1_100_000));'),
      {},
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
    expect(result.stdout?.length).toBeLessThanOrEqual(HOOK_STREAM_MAX_CHARS + 20);
    expect(result.stdout).toContain('[truncated]');

    const rendered = renderUserPromptHookResult([result]);
    expect(rendered?.messages).toHaveLength(1);
    expect(rendered?.messages[0]?.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX_CHARS + 20);
    expect(rendered?.messages[0]).toContain('[truncated]');
  });

  it('truncates plain-text and structured allow messages to the context limit', async () => {
    const plain = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write("b".repeat(20_000));'),
      {},
      { timeout: 5 },
    );
    const structured = await runHook(
      hostProcess,
      nodeCommand('process.stdout.write(JSON.stringify({ message: "c".repeat(20_000) }));'),
      {},
      { timeout: 5 },
    );

    expect(plain.stdout).toHaveLength(20_000);
    expect(structured.structuredOutput).toBe(true);
    expect(structured.message?.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX_CHARS + 20);
    expect(structured.message).toContain('[truncated]');

    const rendered = renderUserPromptHookResult([plain, structured]);
    expect(rendered?.messages).toHaveLength(2);
    for (const message of rendered?.messages ?? []) {
      expect(message.length).toBeLessThanOrEqual(HOOK_CONTEXT_MAX_CHARS + 20);
      expect(message).toContain('[truncated]');
    }
  });

  it('truncates block reasons from stderr and structured JSON to the reason limit', async () => {
    const fromStderr = await runHook(
      hostProcess,
      nodeCommand('process.stderr.write("d".repeat(10_000)); process.exitCode = 2;'),
      {},
      { timeout: 5 },
    );
    expect(fromStderr.action).toBe('block');
    expect(fromStderr.reason?.length).toBeLessThanOrEqual(HOOK_BLOCK_REASON_MAX_CHARS + 20);
    expect(fromStderr.reason).toContain('[truncated]');
    const blocked = renderUserPromptHookBlockResult([fromStderr]);
    expect(blocked?.message.length).toBeLessThanOrEqual(HOOK_BLOCK_REASON_MAX_CHARS + 20);
    expect(blocked?.message).toContain('[truncated]');

    const fromJson = await runHook(
      hostProcess,
      nodeCommand(
        'process.stdout.write(JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "e".repeat(10_000) } }));',
      ),
      {},
      { timeout: 5 },
    );
    expect(fromJson.action).toBe('block');
    expect(fromJson.reason?.length).toBeLessThanOrEqual(HOOK_BLOCK_REASON_MAX_CHARS + 20);
    expect(fromJson.reason).toContain('[truncated]');
  });

  it('writes the input payload to the hook process stdin as JSON', async () => {
    const result = await runHook(
      hostProcess,
      nodeCommand([
        'let input = "";',
        'process.stdin.on("data", (chunk) => { input += chunk; });',
        'process.stdin.on("end", () => {',
        '  const parsed = JSON.parse(input);',
        '  process.stdout.write(parsed.tool_name);',
        '});',
      ].join('\n')),
      { tool_name: 'Write' },
      { timeout: 5 },
    );

    expect(result.stdout?.trim()).toBe('Write');
  });
});

describe('buildHookSpawnOptions (Windows console-window regression)', () => {
  it('sets windowsHide:true so hooks do not flash a console on Windows', () => {
    expect(buildHookSpawnOptions({}).windowsHide).toBe(true);
  });

  it('runs through the shell with stdio piped', () => {
    const options = buildHookSpawnOptions({});
    expect(options.shell).toBe(true);
    expect(options.stdio).toBe('pipe');
  });

  it('merges hook env onto process.env and forwards cwd', () => {
    const options = buildHookSpawnOptions({ cwd: '/repo', env: { FOO: 'bar' } });
    expect(options.cwd).toBe('/repo');
    expect(options.env).toMatchObject({ FOO: 'bar' });
  });
});
