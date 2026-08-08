import { describe, expect, it } from 'vitest';

import { buildHookSpawnOptions } from '../../src/session/hooks/runner';

const RUNNER_MODULE = '../../src/session/hooks/runner' as string;

interface HookResult {
  action: 'allow' | 'block';
  message?: string;
  reason?: string;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  structuredOutput?: boolean;
}

type RunHook = (
  command: string,
  input: Record<string, unknown>,
  options: { timeout: number; cwd?: string; failMode?: 'open' | 'closed' },
) => Promise<HookResult>;

async function importRunHook(): Promise<RunHook> {
  const mod = (await import(RUNNER_MODULE)) as { runHook: RunHook };
  return mod.runHook;
}

describe('runHook process runner', () => {
  it('returns allow when the hook exits 0 and captures stdout', async () => {
    const runHook = await importRunHook();
    const result = await runHook('echo ok', { tool_name: 'Shell' }, { timeout: 5 });
    expect(result.action).toBe('allow');
    expect(result.stdout?.trim()).toBe('ok');
  });

  it('parses stdout JSON message into a hook result message', async () => {
    const runHook = await importRunHook();
    const result = await runHook("node -e \"process.stdout.write(JSON.stringify({message:'hook says hi'}))\"", {}, { timeout: 5 });
    expect(result.action).toBe('allow');
    expect(result.message).toBe('hook says hi');
    expect(result.structuredOutput).toBe(true);
  });

  it('marks structured stdout JSON without message as empty hook output', async () => {
    const runHook = await importRunHook();

    const emptyObject = await runHook("node -e \"process.stdout.write('{}')\"", {}, { timeout: 5 });
    expect(emptyObject.action).toBe('allow');
    expect(emptyObject.message).toBeUndefined();
    expect(emptyObject.structuredOutput).toBe(true);

    const emptyHookSpecificOutput = await runHook(
      "node -e \"process.stdout.write(JSON.stringify({hookSpecificOutput:{}}))\"",
      {},
      { timeout: 5 },
    );
    expect(emptyHookSpecificOutput.action).toBe('allow');
    expect(emptyHookSpecificOutput.message).toBeUndefined();
    expect(emptyHookSpecificOutput.structuredOutput).toBe(true);
  });

  it('returns block when the hook exits 2 and captures stderr as the reason', async () => {
    const runHook = await importRunHook();
    const result = await runHook(
      "node -e \"process.stderr.write('blocked');process.exit(2)\"",
      { tool_name: 'Shell' },
      { timeout: 5 },
    );
    expect(result.action).toBe('block');
    expect(result.reason).toContain('blocked');
  });

  it('returns allow on non-zero, non-2 exit codes (e.g. exit 1)', async () => {
    const runHook = await importRunHook();
    const result = await runHook('exit 1', { tool_name: 'Shell' }, { timeout: 5 });
    expect(result.action).toBe('allow');
  });

  it('returns allow with timedOut=true when the command exceeds the timeout', async () => {
    const runHook = await importRunHook();
    const result = await runHook('sleep 10', { tool_name: 'Shell' }, { timeout: 0.05 });
    expect(result.action).toBe('allow');
    expect(result.timedOut).toBe(true);
  });

  it('parses stdout JSON permissionDecision=deny into a block result with the supplied reason', async () => {
    const runHook = await importRunHook();
    const cmd =
      "node -e \"process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:'deny',permissionDecisionReason:'use rg'}}))\"";
    const result = await runHook(cmd, { tool_name: 'Bash' }, { timeout: 5 });
    expect(result.action).toBe('block');
    expect(result.reason).toBe('use rg');
  });

  it('writes the input payload to the hook process stdin as JSON', async () => {
    const runHook = await importRunHook();
    const cmd =
      'node -e "let s=\\"\\";process.stdin.on(\\"data\\",d=>s+=d);process.stdin.on(\\"end\\",()=>{const o=JSON.parse(s);process.stdout.write(o.tool_name);})"';
    const result = await runHook(cmd, { tool_name: 'WriteFile' }, { timeout: 5 });
    expect(result.stdout?.trim()).toBe('WriteFile');
  });
});

// Regression coverage for the "every hook flashes an empty console window on
// Windows" bug. With `shell:true` and no `windowsHide`, Node allocates a
// visible console for each hook child process on Windows. The fix is to pass
// `windowsHide:true` (mirrors KAOS' `buildLocalSpawnOptions` and the runner's
// own taskkill spawn). The flag is only observable on Windows, so we assert
// the spawn options builder directly.
describe('runHook fail_mode=closed', () => {
  it('blocks on non-zero, non-2 exit codes', async () => {
    const runHook = await importRunHook();
    const result = await runHook(
      'node -e "process.exit(1)"',
      { tool_name: 'Bash' },
      { timeout: 5, failMode: 'closed' },
    );

    expect(result.action).toBe('block');
    expect(result.reason).toContain('fail_mode=closed');
  });

  it('blocks with timedOut=true when the command exceeds the timeout', async () => {
    const runHook = await importRunHook();
    const result = await runHook(
      'node -e "setTimeout(() => {}, 10000)"',
      { tool_name: 'Bash' },
      { timeout: 0.05, failMode: 'closed' },
    );

    expect(result.action).toBe('block');
    expect(result.timedOut).toBe(true);
    expect(result.reason).toContain('fail_mode=closed');
  });

  it('still allows a clean exit 0', async () => {
    const runHook = await importRunHook();
    const result = await runHook(
      'node -e "process.exit(0)"',
      { tool_name: 'Bash' },
      { timeout: 5, failMode: 'closed' },
    );

    expect(result.action).toBe('allow');
  });

  it('blocks when the hook process cannot be spawned', async () => {
    const runHook = await importRunHook();
    // An empty command makes spawn() throw synchronously, exercising the
    // spawn-failure branch without stubbing child_process.
    const result = await runHook('', { tool_name: 'Bash' }, { timeout: 5, failMode: 'closed' });

    expect(result.action).toBe('block');
    expect(result.reason).toContain('fail_mode=closed');
  });

  it('allows a spawn failure under the default fail-open mode', async () => {
    const runHook = await importRunHook();
    const result = await runHook('', { tool_name: 'Bash' }, { timeout: 5 });

    expect(result.action).toBe('allow');
  });

  it('blocks when the hook process dies by signal', async () => {
    const runHook = await importRunHook();
    const result = await runHook(
      'node -e "process.kill(process.pid, \'SIGKILL\')"',
      { tool_name: 'Bash' },
      { timeout: 5, failMode: 'closed' },
    );

    expect(result.action).toBe('block');
    expect(result.reason).toContain('fail_mode=closed');
  });

  it('allows signal death under the default fail-open mode', async () => {
    const runHook = await importRunHook();
    const result = await runHook(
      'node -e "process.kill(process.pid, \'SIGKILL\')"',
      { tool_name: 'Bash' },
      { timeout: 5 },
    );

    expect(result.action).toBe('allow');
  });

  it('still blocks exit 2 with the stderr reason, not the fail-closed reason', async () => {
    const runHook = await importRunHook();
    const result = await runHook(
      "node -e \"process.stderr.write('nope');process.exit(2)\"",
      { tool_name: 'Bash' },
      { timeout: 5, failMode: 'closed' },
    );

    expect(result.action).toBe('block');
    expect(result.reason).toBe('nope');
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
