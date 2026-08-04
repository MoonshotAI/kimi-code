import { homedir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { buildHookSpawnOptions, expandLeadingTilde, runHook } from '#/agent/externalHooks/runner';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';

const hostProcess = new HostProcessService();

function nodeCommand(source: string): string {
  return `node -e ${JSON.stringify(source.replace(/\s*\n\s*/g, ' '))}`;
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

// Regression coverage for the "one `~` in a hook path breaks EVERY tool call"
// bug. Hooks are spawned with `shell:true`; on POSIX that shell expands a
// word-leading `~`, but on Windows the shell is cmd.exe, which has no tilde
// concept — the literal `~` reaches the interpreter, which resolves it against
// the working directory and fails with ENOENT. Because a PreToolUse hook that
// cannot be found blocks the call it guards, a single mistyped path disables
// the whole session rather than just that hook.
describe('expandLeadingTilde', () => {
  const home = homedir();

  it('expands a command-leading ~/', () => {
    expect(expandLeadingTilde('~/hooks/x.py')).toBe(`${home}/hooks/x.py`);
  });

  it('expands a ~ that starts an argument', () => {
    expect(expandLeadingTilde('python3 ~/hooks/x.py')).toBe(`python3 ${home}/hooks/x.py`);
  });

  it('expands the backslash separator form, since the target shell is cmd.exe', () => {
    expect(expandLeadingTilde('python3 ~\\hooks\\x.py')).toBe(`python3 ${home}\\hooks\\x.py`);
  });

  it('expands a bare ~ word', () => {
    expect(expandLeadingTilde('cd ~')).toBe(`cd ${home}`);
    expect(expandLeadingTilde('cd ~ && ls')).toBe(`cd ${home} && ls`);
  });

  it('expands every word-leading occurrence, not just the first', () => {
    expect(expandLeadingTilde('cp ~/a ~/b')).toBe(`cp ${home}/a ${home}/b`);
  });

  it('leaves a ~ inside a word alone', () => {
    expect(expandLeadingTilde('script --flag=a~/b')).toBe('script --flag=a~/b');
    expect(expandLeadingTilde('cp file~/old dest')).toBe('cp file~/old dest');
  });

  it('leaves a quoted ~ alone, matching a POSIX shell', () => {
    expect(expandLeadingTilde('python3 "~/hooks/x.py"')).toBe('python3 "~/hooks/x.py"');
    expect(expandLeadingTilde("python3 '~/hooks/x.py'")).toBe("python3 '~/hooks/x.py'");
  });

  it('does not attempt ~user expansion', () => {
    expect(expandLeadingTilde('cat ~other/file')).toBe('cat ~other/file');
  });

  it('leaves a command with no tilde untouched', () => {
    expect(expandLeadingTilde('python3 hooks/x.py')).toBe('python3 hooks/x.py');
    expect(expandLeadingTilde('')).toBe('');
  });
});
