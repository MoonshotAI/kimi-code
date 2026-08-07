import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { Readable, type Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  type AgentTask,
  type AgentTaskInfo,
  type AgentTaskOutputSnapshot,
  type ForegroundTaskReleaseReason,
  IAgentTaskService,
  type RegisterAgentTaskOptions,
} from '#/agent/task/task';
import type { AgentTaskSettlement, AgentTaskSink } from '#/agent/task/types';
import { type ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import type { IProcess, ISessionProcessRunner } from '#/session/process/processRunner';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import type { IConfigService } from '#/app/config/config';
import { type BashInput } from '#/agent/tools/os/bash/bash';
import { BashTool } from '#/agent/tools/os/bash/bashTool';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';
import {
  fixBashCommand,
  gitBashInstallRoot,
  withMsystemNeutralized,
} from '#/agent/tools/os/bash/windowsBashFix';

// Every fallback-table command name covered by the guard assertions below.
const FALLBACK_NAMES = [
  'rev',
  'zip',
  'nc',
  'netcat',
  'tree',
  'watch',
  'killall',
  'pidof',
  'column',
  'tasklist',
  'taskkill',
  'systeminfo',
  'copy',
  'move',
  'del',
  'erase',
  'ren',
  'rename',
  'rd',
  'md',
  'chdir',
  'cls',
  'xcopy',
  'mklink',
  'findstr',
  'fc',
  'where',
  'wget',
  'open',
  'xdg-open',
  'pbcopy',
  'pbpaste',
  'xclip',
  'xsel',
  'wl-copy',
  'wl-paste',
  'say',
  'gtimeout',
  'gawk',
  'python3',
  'pip3',
] as const;

const posixEnv: IHostEnvironment = {
  _serviceBrand: undefined,
  osKind: 'Linux',
  osArch: 'arm64',
  osVersion: 'test',
  shellPath: '/bin/bash',
  shellName: 'bash',
  pathClass: 'posix',
  homeDir: '/home/test',
  ready: Promise.resolve(),
};

const windowsBashEnv: IHostEnvironment = {
  _serviceBrand: undefined,
  osKind: 'Windows',
  osArch: 'x64',
  osVersion: 'test',
  shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
  shellName: 'bash',
  pathClass: 'win32',
  homeDir: 'C:\\Users\\test',
  ready: Promise.resolve(),
};

describe('fixBashCommand — non-Windows passthrough', () => {
  it.each(['linux', 'darwin'] as const)('returns %s input byte-for-byte unchanged', (platform) => {
    for (const command of ['rev x', 'cat C:\\a', 'tree D:\\repo', 'ls >nul']) {
      const result = fixBashCommand(command, platform);
      expect(result.command).toBe(command);
      expect(result.replacements).toEqual([]);
      expect(result.pathChanges).toEqual([]);
      expect(result.changed).toBe(false);
    }
  });
});

describe('fixBashCommand — Windows path rewrites', () => {
  it.each([
    ['cat src\\a.py', 'cat src/a.py'],
    ['cat src\\a\\b.py', 'cat src/a/b.py'],
    ['D:\\repo\\src', 'D:/repo/src'],
    ['\\\\server\\share\\x', '//server/share/x'],
    ['cat ~\\Desktop', 'cat ~/Desktop'],
    ['cat .\\build\\a', 'cat ./build/a'],
    ['cat ..\\..\\x', 'cat ../../x'],
    ['cat dir\\sub\\file.txt', 'cat dir/sub/file.txt'],
    ['echo D:\\x\\*.txt', 'echo D:/x/*.txt'],
    ['echo D:\\my\\ dir\\x', 'echo "D:/my dir/x"'],
    // Blanket conversion (reference `_prepare_bash_cmd`): unquoted \X pairs
    // become /X even for words the conservative walker would not recognize.
    ['echo a\\nb', 'echo a/nb'],
    ['echo foo\\bar', 'echo foo/bar'],
    ['echo \\033\\015', 'echo /033/015'],
    ['echo x\\n\\t', 'echo x/n/t'],
  ])('rewrites %s -> %s', (before, after) => {
    const result = fixBashCommand(before, 'win32');
    expect(result.command).toBe(after);
    expect(result.changed).toBe(true);
    expect(result.pathChanges.length).toBeGreaterThan(0);
  });

  it('records single-backslash relative paths in pathChanges', () => {
    const result = fixBashCommand('cat src\\a.py', 'win32');
    expect(result.pathChanges).toContain('src\\a.py');
  });

  it.each([
    'echo "D:\\a\\b"',
    "echo 'D:\\a'",
    // Escaped metacharacters are preserved by the blanket pass.
    'echo a\\ b',
    'echo a\\(b',
  ])('leaves quoted or escaped word %s untouched', (command) => {
    const result = fixBashCommand(command, 'win32');
    expect(result.command).toBe(command);
    expect(result.changed).toBe(false);
  });
});

describe('fixBashCommand — fallback mapping', () => {
  it.each(FALLBACK_NAMES)('defines a guarded fallback for %s', (name) => {
    const result = fixBashCommand(`${name} x`, 'win32');
    expect(result.command).toContain(`if ! command -v ${name}`);
    expect(result.command).toContain(`${name}() {`);
    expect(result.command).toContain('; fi');
    expect(result.replacements).toContain(name);
    expect(result.changed).toBe(true);
  });

  it.each(['pip3', 'python3'])('guards %s against Microsoft Store stubs', (name) => {
    const result = fixBashCommand(`${name} --version`, 'win32');
    expect(result.command).toContain('WindowsApps');
    expect(result.command).toContain(`$(type -P ${name}) == *WindowsApps*`);
  });

  it('gawk delegates to awk', () => {
    const result = fixBashCommand('gawk x', 'win32');
    expect(result.command).toContain('awk "$@"');
  });

  it('netcat shares the nc fallback body', () => {
    const nc = fixBashCommand('nc x', 'win32').command;
    const netcat = fixBashCommand('netcat x', 'win32').command.replaceAll('netcat', 'nc');
    expect(netcat).toBe(nc);
  });

  it.each([
    ["'rev' x", true],
    ['\\rev x', true],
    ['r""ev x', true],
    ['echo rev', false],
  ])('detects quoted/escaped command words (%s)', (command, detected) => {
    const result = fixBashCommand(command, 'win32');
    expect(result.replacements.includes('rev')).toBe(detected);
  });
});

describe('fixBashCommand — cd /d', () => {
  it.each([
    ['cd /d D:\\repo', 'cd D:/repo'],
    ['cd /d D:\\a && ls', 'cd D:/a && ls'],
  ])('drops the /d flag: %s -> %s', (before, after) => {
    const result = fixBashCommand(before, 'win32');
    expect(result.command).toBe(after);
    expect(result.pathChanges).toContain('cd /d');
    expect(result.changed).toBe(true);
  });

  it.each(['cd /d', 'cd /d; ls', 'cd /d\nls'])('leaves %s untouched', (command) => {
    const result = fixBashCommand(command, 'win32');
    expect(result.command).toBe(command);
    expect(result.changed).toBe(false);
  });
});

describe('fixBashCommand — nul redirect', () => {
  it.each([
    ['ls >nul', 'ls >/dev/null'],
    ['ls > NUL', 'ls > /dev/null'],
    ['ls 2>nul', 'ls 2>/dev/null'],
    ['ls &>nul', 'ls &>/dev/null'],
    ['ls >>nul', 'ls >>/dev/null'],
    ['ls 2>nul | grep x', 'ls 2>/dev/null | grep x'],
  ])('rewrites %s -> %s', (before, after) => {
    expect(fixBashCommand(before, 'win32').command).toBe(after);
  });

  it.each(['ls >null', 'cat nul.txt', "echo 'nul'"])('leaves %s unchanged', (command) => {
    expect(fixBashCommand(command, 'win32').command).toBe(command);
  });
});

describe('fixBashCommand — shell-aware no-rewrites', () => {
  it('keeps heredoc body backslashes as data', () => {
    const command = 'cat <<EOF\nC:\\x\nEOF';
    const result = fixBashCommand(command, 'win32');
    expect(result.command).toBe(command);
    expect(result.changed).toBe(false);
  });

  it('keeps comment backslashes as data', () => {
    const command = '# D:\\x\necho ok';
    const result = fixBashCommand(command, 'win32');
    expect(result.command).toBe(command);
    expect(result.changed).toBe(false);
  });

  it('keeps double-quoted paths untouched', () => {
    const command = 'echo "D:\\a"';
    expect(fixBashCommand(command, 'win32').command).toBe(command);
  });

  it('rewrites the inner path of a command substitution', () => {
    expect(fixBashCommand('$(echo D:\\x)', 'win32').command).toBe('$(echo D:/x)');
  });

  it('rewrites unquoted array element paths', () => {
    expect(fixBashCommand('arr=(D:\\x\\y)', 'win32').command).toBe('arr=(D:/x/y)');
  });
});

describe('fixBashCommand — degrade on pathological input', () => {
  it('never throws on absurdly nested input', () => {
    const deep = '$('.repeat(5000) + 'echo x' + ')'.repeat(5000);
    expect(() => fixBashCommand(deep, 'win32')).not.toThrow();
    const result = fixBashCommand(deep, 'win32');
    expect(typeof result.command).toBe('string');
  });

  it('never throws on a huge command', () => {
    const big = 'echo x; '.repeat(100_000);
    expect(() => fixBashCommand(big, 'win32')).not.toThrow();
  });

  it('never throws on a wall of backslashes', () => {
    const slashes = '\\'.repeat(100_000);
    expect(() => fixBashCommand(slashes, 'win32')).not.toThrow();
  });
});

describe('fixBashCommand — parser fast path', () => {
  it.each([
    'ls -la',
    'git status',
    'npm test',
    'echo hi',
    'grep -r pattern src',
    'cat file.txt | head -5',
    'if true; then echo ok; fi',
    'pnpm install --frozen-lockfile',
  ])('returns %s byte-for-byte unchanged', (command) => {
    const result = fixBashCommand(command, 'win32');
    expect(result.command).toBe(command);
    expect(result.changed).toBe(false);
    expect(result.replacements).toEqual([]);
    expect(result.pathChanges).toEqual([]);
  });

  it('sends conservative signals through the full pipeline unchanged', () => {
    // Quoted/expanded words could hide a fallback command name, so they are
    // never fast-pathed; the pipeline still leaves them byte-for-byte intact.
    for (const command of ['echo "$HOME"', "echo 'a b'", 'printf "%s" hi']) {
      const result = fixBashCommand(command, 'win32');
      expect(result.command).toBe(command);
      expect(result.changed).toBe(false);
    }
  });
});

describe('fixBashCommand — fallback-body smoke', () => {
  it.each([
    ['zip', 'Compress-Archive'],
    ['tasklist', 'Get-Process'],
    ['tree', 'perl'],
    ['wget', 'curl'],
    ['gtimeout', 'timeout'],
    ['pgrep', 'Get-Process'],
    ['mklink', 'ln -s'],
    ['taskkill', 'Stop-Process'],
  ])('%s delegates to %s', (name, delegate) => {
    expect(fixBashCommand(`${name} x`, 'win32').command).toContain(delegate);
  });
});

/**
 * Create a fake Git for Windows install root under the test cwd and return a
 * `bash.exe` path pointing into it. The fixture uses cwd-relative backslash
 * strings, so the same code works on Windows (real nested directories) and on
 * POSIX CI (literal backslash names); cleanup removes both layouts.
 */
function gitBashFixture(withMarker: boolean): {
  root: string;
  bashPath: string;
  cleanup: () => void;
} {
  const root = `msystem-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (withMarker) {
    mkdirSync(`${root}\\cmd`, { recursive: true });
    writeFileSync(`${root}\\cmd\\git.exe`, '', 'utf8');
  } else {
    mkdirSync(`${root}\\bin`, { recursive: true });
  }
  return {
    root,
    bashPath: `${root}\\bin\\bash.exe`,
    cleanup: () => {
      rmSync(`${root}\\cmd`, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('gitBashInstallRoot — Git Bash layout detection', () => {
  it.each([
    ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git'],
    ['C:\\Program Files\\Git\\usr\\bin\\bash.exe', 'C:\\Program Files\\Git'],
    ['C:\\Users\\me\\.kimi\\git\\bin\\bash.exe', 'C:\\Users\\me\\.kimi\\git'],
    ['C:\\msys64\\usr\\bin\\bash.exe', 'C:\\msys64'],
    ['D:\\Git\\cmd\\bash.exe', null], // not under `bin`
    ['C:\\tools\\bash.exe', null], // no `bin` segment
    ['bin\\bash.exe', null], // no install root
    ['', null],
  ])('%s -> %s', (bashPath, expected) => {
    expect(gitBashInstallRoot(bashPath)).toBe(expected);
  });
});

describe('withMsystemNeutralized — MSYSTEM neutralization', () => {
  it.each(['linux', 'darwin'])('returns %s commands unchanged', (platform) => {
    expect(
      withMsystemNeutralized('echo hi', 'C:\\Program Files\\Git\\bin\\bash.exe', platform),
    ).toBe('echo hi');
  });

  it('leaves non-Git-Bash-shaped bash paths unchanged on win32', () => {
    expect(withMsystemNeutralized('echo hi', 'C:\\tools\\bash.exe', 'win32')).toBe('echo hi');
  });

  it('prepends the neutralization when the cmd\\git.exe marker exists', () => {
    const fixture = gitBashFixture(true);
    try {
      expect(withMsystemNeutralized('echo hi', fixture.bashPath, 'win32')).toBe(
        'export MSYSTEM=; echo hi',
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('leaves the command unchanged when the marker is absent', () => {
    const fixture = gitBashFixture(false);
    try {
      expect(withMsystemNeutralized('echo hi', fixture.bashPath, 'win32')).toBe('echo hi');
    } finally {
      fixture.cleanup();
    }
  });

  it('recognizes the usr/bin layout when the marker exists', () => {
    const fixture = gitBashFixture(true);
    try {
      expect(
        withMsystemNeutralized('echo hi', `${fixture.root}\\usr\\bin\\bash.exe`, 'win32'),
      ).toBe('export MSYSTEM=; echo hi');
    } finally {
      fixture.cleanup();
    }
  });

  it('caches the marker probe per install root', () => {
    const withMarker = gitBashFixture(true);
    const withoutMarker = gitBashFixture(false);
    try {
      expect(withMsystemNeutralized('echo a', withMarker.bashPath, 'win32')).toBe(
        'export MSYSTEM=; echo a',
      );
      expect(withMsystemNeutralized('echo b', withoutMarker.bashPath, 'win32')).toBe('echo b');
      // Repeated calls are served from the cache and stay consistent per root.
      expect(withMsystemNeutralized('echo c', withMarker.bashPath, 'win32')).toBe(
        'export MSYSTEM=; echo c',
      );
      expect(withMsystemNeutralized('echo d', withoutMarker.bashPath, 'win32')).toBe('echo d');
    } finally {
      withMarker.cleanup();
      withoutMarker.cleanup();
    }
  });
});

describe('BashTool integration — fixer pipeline', () => {
  function fakeProcess(): IProcess {
    return {
      stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      pid: 321,
      exitCode: 0,
      wait: vi.fn(async () => 0),
      kill: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };
  }

  /** Minimal task service: registers the real ProcessTask, settles on exit. */
  function createMinimalTaskService(): IAgentTaskService {
    const settled = new Map<string, AgentTaskSettlement>();
    let counter = 0;
    const service: Partial<IAgentTaskService> = {
      registerTask(task: AgentTask, options?: RegisterAgentTaskOptions): string {
        counter += 1;
        const taskId = `bash-${String(counter).padStart(8, '0')}`;
        const controller = new AbortController();
        const sink: AgentTaskSink = {
          signal: controller.signal,
          appendOutput: () => {},
          settle: async (settlement) => {
            settled.set(taskId, settlement);
            return true;
          },
        };
        if (options?.signal !== undefined) {
          options.signal.addEventListener('abort', () => controller.abort(), { once: true });
        }
        void Promise.resolve(task.start(sink)).catch(() => {});
        return taskId;
      },
      getTask(taskId: string): AgentTaskInfo | undefined {
        const settlement = settled.get(taskId);
        return {
          kind: 'process',
          taskId,
          description: 'fake',
          status: settlement === undefined ? 'running' : settlement.status,
          startedAt: 0,
          endedAt: settlement === undefined ? null : 0,
          stopReason: settlement?.stopReason,
          pid: 321,
          command: 'fake',
          exitCode: settlement?.status === 'completed' ? 0 : null,
        } as unknown as AgentTaskInfo;
      },
      persistOutput: () => {},
      getOutputSnapshot: async (): Promise<AgentTaskOutputSnapshot> => ({
        outputPath: undefined,
        outputSizeBytes: 0,
        previewBytes: 0,
        truncated: false,
        fullOutputAvailable: true,
        preview: '',
      }),
      waitForForegroundRelease: async (): Promise<ForegroundTaskReleaseReason | undefined> =>
        'terminal',
    };
    return service as IAgentTaskService;
  }

  function stubToolPolicy(): IAgentToolPolicyService {
    return { _serviceBrand: undefined, isToolActive: () => true } as unknown as IAgentToolPolicyService;
  }

  function stubConfig(): IConfigService {
    return { _serviceBrand: undefined, get: () => undefined } as unknown as IConfigService;
  }

  function createTestCtx(cwd = '/workspace'): ISessionContext {
    return makeSessionContext({
      sessionId: 's',
      workspaceId: 'w',
      sessionDir: cwd,
      sessionScope: 'sessions/w/s',
      cwd,
    });
  }

  async function spawnedArgv(
    env: IHostEnvironment,
    command: string,
  ): Promise<readonly [argv: readonly string[], envArg?: Record<string, string>]> {
    const exec = vi.fn().mockResolvedValue(fakeProcess());
    const runner = { exec } as unknown as ISessionProcessRunner;
    const tool = new BashTool(
      runner,
      env,
      createTestCtx(env.osKind === 'Windows' ? 'C:\\work' : '/work'),
      createMinimalTaskService(),
      stubToolPolicy(),
      stubConfig(),
    );
    await executeTool(tool, { turnId: 0, toolCallId: 'call_bash', args: { command, timeout: 1000 }, signal: new AbortController().signal });
    const call = exec.mock.calls[0] as [readonly string[], { env?: Record<string, string> }] | undefined;
    return [call?.[0] ?? [], call?.[1]?.env];
  }

  it('prepends the fallback and rewrites paths/nul on Windows', async () => {
    const [argv, envArg] = await spawnedArgv(windowsBashEnv, 'rev C:\\work\\a.txt 2>nul');
    const wrapped = argv[2]!;
    expect(wrapped).toContain('rev() {');
    expect(wrapped).toContain('C:/work/a.txt');
    expect(wrapped).toContain('2>/dev/null');
    expect(wrapped).not.toContain('2>nul');
    // MSYS path conversion is disabled for the bash subprocess on Windows.
    expect(envArg?.['MSYS_NO_PATHCONV']).toBe('1');
    expect(envArg?.['MSYS2_ARG_CONV_EXCL']).toBe('*');
  });

  it('passes the command through untouched on Linux', async () => {
    const [argv] = await spawnedArgv(posixEnv, 'rev C:\\work\\a.txt 2>nul');
    expect(argv[2]).toBe("cd '/work' && rev C:\\work\\a.txt 2>nul");
  });

  it('keeps the existing nul-redirect behavior in the spawned argv', async () => {
    const [argv] = await spawnedArgv(windowsBashEnv, 'echo ok 2>nul');
    expect(argv[2]).toBe("cd '/c/work' && echo ok 2>/dev/null");
  });

  it('prepends MSYSTEM neutralization for a Git Bash install', async () => {
    const fixture = gitBashFixture(true);
    try {
      const [argv] = await spawnedArgv(
        { ...windowsBashEnv, shellPath: fixture.bashPath },
        'echo hi',
      );
      expect(argv[2]).toBe('export MSYSTEM=; cd \'/c/work\' && echo hi');
    } finally {
      fixture.cleanup();
    }
  });
});

function isPromiseLike(value: ToolExecution | Promise<ToolExecution>): value is Promise<ToolExecution> {
  return typeof (value as Promise<ToolExecution>).then === 'function';
}

async function executeTool(
  tool: BashTool,
  ctx: {
    turnId: number;
    toolCallId: string;
    args: BashInput;
    signal: AbortSignal;
  },
): Promise<ExecutableToolResult> {
  const { args, ...executionContext } = ctx;
  const resolved = tool.resolveExecution(args);
  const execution = isPromiseLike(resolved) ? await resolved : resolved;
  if (execution.isError === true) return execution;
  return execution.execute(executionContext as ExecutableToolContext);
}
