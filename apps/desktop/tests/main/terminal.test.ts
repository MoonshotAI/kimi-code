import { describe, it, expect } from 'vitest';

import {
  createTerminalManager,
  defaultShellEnv,
  resolveDefaultShell,
  type PtyProcess,
  type SpawnPty,
  type TerminalManagerDeps,
} from '../../src/main/terminal';

class FakePty implements PtyProcess {
  written: string[] = [];
  resized: Array<[number, number]> = [];
  killed = false;
  private dataListener: ((data: string) => void) | null = null;
  private exitListener: ((event: { exitCode: number }) => void) | null = null;

  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resized.push([cols, rows]);
  }
  kill(): void {
    this.killed = true;
  }
  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
  }
  onExit(listener: (event: { exitCode: number }) => void): void {
    this.exitListener = listener;
  }
  emitData(data: string): void {
    this.dataListener?.(data);
  }
  emitExit(exitCode: number): void {
    this.exitListener?.({ exitCode });
  }
}

function makeDeps(overrides: Partial<TerminalManagerDeps> = {}) {
  const ptys: FakePty[] = [];
  const spawns: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
  const spawnPty: SpawnPty = (file, args, options) => {
    const pty = new FakePty();
    ptys.push(pty);
    spawns.push({ file, args, options: options as Record<string, unknown> });
    return pty;
  };
  const output: Array<[string, string]> = [];
  const exits: Array<[string, number | null]> = [];
  const deps: TerminalManagerDeps = {
    platform: 'darwin',
    env: { SHELL: '/bin/zsh', HOME: '/home/u' },
    homeDir: '/home/u',
    locale: 'zh-CN',
    spawnPty,
    pathExists: () => true,
    isDirectory: (p) => p === '/work' || p === '/home/u',
    pushOutput: (id, data) => output.push([id, data]),
    pushExit: (id, exitCode) => exits.push([id, exitCode]),
    ...overrides,
  };
  return { deps, ptys, spawns, output, exits };
}

describe('resolveDefaultShell', () => {
  const exists = (paths: string[]) => (p: string) => paths.includes(p);

  it('prefers $SHELL on macOS/Linux, falling back per platform', () => {
    expect(resolveDefaultShell('darwin', { SHELL: '/bin/zsh' }, () => false)).toBe('/bin/zsh');
    expect(resolveDefaultShell('linux', { SHELL: '/usr/bin/fish' }, () => false)).toBe('/usr/bin/fish');
    expect(resolveDefaultShell('darwin', {}, () => false)).toBe('/bin/zsh');
    expect(resolveDefaultShell('linux', {}, () => false)).toBe('/bin/sh');
  });

  it('follows the pwsh → powershell → cmd chain on Windows', () => {
    const pf = 'C:\\Program Files';
    const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    // pwsh in Program Files wins.
    expect(
      resolveDefaultShell('win32', { ProgramFiles: pf }, exists([pwsh, powershell])),
    ).toBe(pwsh);
    // pwsh only on PATH is found too.
    expect(
      resolveDefaultShell(
        'win32',
        { ProgramFiles: pf, PATH: 'C:\\Tools;C:\\Other' },
        exists(['C:\\Tools\\pwsh.exe', powershell]),
      ),
    ).toBe('C:\\Tools\\pwsh.exe');
    // No pwsh → Windows PowerShell from System32.
    expect(resolveDefaultShell('win32', { ProgramFiles: pf }, exists([powershell]))).toBe(powershell);
    // Nothing detected → COMSPEC (cmd).
    expect(
      resolveDefaultShell('win32', { ProgramFiles: pf, COMSPEC: 'C:\\Windows\\System32\\cmd.exe' }, () => false),
    ).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(resolveDefaultShell('win32', { ProgramFiles: pf }, () => false)).toBe('cmd.exe');
  });
});

describe('defaultShellEnv', () => {
  it('pins LANG from the locale when nothing locale-ish is set (POSIX)', () => {
    expect(defaultShellEnv('darwin', 'zh-CN', { HOME: '/u' })['LANG']).toBe('zh_CN.UTF-8');
    expect(defaultShellEnv('linux', 'en-US', { HOME: '/u' })['LANG']).toBe('en_US.UTF-8');
  });

  it('leaves an existing LANG or LC_ALL alone', () => {
    expect(defaultShellEnv('darwin', 'zh-CN', { LANG: 'ja_JP.UTF-8' })['LANG']).toBe('ja_JP.UTF-8');
    expect(defaultShellEnv('darwin', 'zh-CN', { LC_ALL: 'C' })['LANG']).toBeUndefined();
  });

  it('does not touch Windows', () => {
    expect(defaultShellEnv('win32', 'zh-CN', { HOME: '/u' })['LANG']).toBeUndefined();
  });

  it('drops non-string env values', () => {
    const env = defaultShellEnv('darwin', 'en', { A: '1', B: undefined });
    expect(env).toEqual({ A: '1', LANG: 'en_US.UTF-8' });
  });
});

describe('createTerminalManager', () => {
  it('spawns the default shell with cwd, env and clamped dimensions', async () => {
    const { deps, spawns } = makeDeps();
    const manager = createTerminalManager(deps);
    const info = await manager.create({ cwd: '/work', cols: 5000, rows: 10 });
    expect(info.shell).toBe('zsh');
    expect(info.cwd).toBe('/work');
    expect(spawns).toHaveLength(1);
    const spawn = spawns[0]!;
    expect(spawn.file).toBe('/bin/zsh');
    expect(spawn.options['name']).toBe('xterm-256color');
    expect(spawn.options['cwd']).toBe('/work');
    expect(spawn.options['cols']).toBe(500);
    expect(spawn.options['rows']).toBe(10);
    expect((spawn.options['env'] as Record<string, string>)['LANG']).toBe('zh_CN.UTF-8');
  });

  it('reads a function locale lazily at create time', async () => {
    let locale = 'en-US';
    const { deps, spawns } = makeDeps({ locale: () => locale });
    const manager = createTerminalManager(deps);
    await manager.create({});
    expect((spawns[0]!.options['env'] as Record<string, string>)['LANG']).toBe('en_US.UTF-8');
    locale = 'zh-CN';
    await manager.create({});
    expect((spawns[1]!.options['env'] as Record<string, string>)['LANG']).toBe('zh_CN.UTF-8');
  });

  it('falls back to the home dir for a missing/invalid cwd, and defaults dimensions', async () => {
    const { deps, spawns } = makeDeps();
    const manager = createTerminalManager(deps);
    const bad = await manager.create({ cwd: '/nope' });
    expect(bad.cwd).toBe('/home/u');
    await manager.create({});
    expect(spawns[1]!.options['cols']).toBe(80);
    expect(spawns[1]!.options['rows']).toBe(24);
  });

  it('strips the .exe suffix for the shell label on Windows', async () => {
    const { deps } = makeDeps({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      pathExists: (p) => p === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    });
    const manager = createTerminalManager(deps);
    const info = await manager.create({});
    expect(info.shell).toBe('pwsh');
  });

  it('routes pty output and exit to the push callbacks', async () => {
    const { deps, ptys, output, exits } = makeDeps();
    const manager = createTerminalManager(deps);
    const info = await manager.create({});
    ptys[0]!.emitData('hello');
    expect(output).toEqual([[info.id, 'hello']]);
    ptys[0]!.emitExit(3);
    expect(exits).toEqual([[info.id, 3]]);
    // Exited terminals are dropped from the registry.
    expect(manager.size()).toBe(0);
  });

  it('writes input only to live terminals, truncating huge payloads', async () => {
    const { deps, ptys } = makeDeps();
    const manager = createTerminalManager(deps);
    const info = await manager.create({});
    manager.write(info.id, 'ls\n');
    expect(ptys[0]!.written).toEqual(['ls\n']);
    const huge = 'x'.repeat(1_100_000);
    manager.write(info.id, huge);
    expect(ptys[0]!.written[1]).toHaveLength(1_000_000);
    manager.write('unknown-id', 'nope');
    ptys[0]!.emitExit(0);
    manager.write(info.id, 'after-exit');
    expect(ptys[0]!.written).toHaveLength(2);
  });

  it('resizes with clamping', async () => {
    const { deps, ptys } = makeDeps();
    const manager = createTerminalManager(deps);
    const info = await manager.create({});
    manager.resize(info.id, 0, 9999);
    expect(ptys[0]!.resized).toEqual([[1, 500]]);
  });

  it('close kills the pty, is idempotent, and suppresses the late exit/data pushes', async () => {
    const { deps, ptys, exits, output } = makeDeps();
    const manager = createTerminalManager(deps);
    const info = await manager.create({});
    manager.close(info.id);
    expect(ptys[0]!.killed).toBe(true);
    expect(manager.size()).toBe(0);
    manager.close(info.id);
    // A real node-pty still fires exit/data asynchronously after kill() —
    // they must not reach a renderer whose tab is already gone.
    ptys[0]!.emitExit(0);
    ptys[0]!.emitData('late');
    expect(exits).toEqual([]);
    expect(output).toEqual([]);
  });

  it('write/resize tolerate a pty that dies mid-call', async () => {
    const { deps, ptys } = makeDeps();
    const manager = createTerminalManager(deps);
    const info = await manager.create({});
    ptys[0]!.write = () => {
      throw new Error('dead');
    };
    ptys[0]!.resize = () => {
      throw new Error('dead');
    };
    expect(() => manager.write(info.id, 'x')).not.toThrow();
    expect(() => manager.resize(info.id, 80, 24)).not.toThrow();
  });

  it('killAll sweeps every live terminal', async () => {
    const { deps, ptys } = makeDeps();
    const manager = createTerminalManager(deps);
    await manager.create({});
    await manager.create({});
    manager.killAll();
    expect(ptys.every((pty) => pty.killed)).toBe(true);
    expect(manager.size()).toBe(0);
  });

  it('kills a create superseded by a renderer navigation during the spawn', async () => {
    const { bumpTerminalGeneration } = await import('../../src/main/terminal');
    const made = makeDeps();
    const { deps, ptys } = made;
    deps.spawnPty = () => {
      bumpTerminalGeneration();
      const pty = new FakePty();
      ptys.push(pty);
      return pty;
    };
    const manager = createTerminalManager(deps);
    await expect(manager.create({})).rejects.toThrow('superseded');
    expect(ptys[0]!.killed).toBe(true);
    expect(manager.size()).toBe(0);
  });

  it('killStale sweeps only previous-generation terminals', async () => {
    const { deps, ptys } = makeDeps();
    const manager = createTerminalManager(deps);
    await manager.create({});
    const { bumpTerminalGeneration } = await import('../../src/main/terminal');
    bumpTerminalGeneration();
    await manager.create({});
    manager.killStale();
    expect(ptys[0]!.killed).toBe(true);
    expect(ptys[1]!.killed).toBe(false);
    expect(manager.size()).toBe(1);
  });

  it('a pty that throws on kill does not break close/killAll', async () => {
    const { deps, ptys } = makeDeps();
    const manager = createTerminalManager(deps);
    const info = await manager.create({});
    ptys[0]!.kill = () => {
      throw new Error('already dead');
    };
    expect(() => manager.close(info.id)).not.toThrow();
    const second = await manager.create({});
    void second;
    expect(() => manager.killAll()).not.toThrow();
  });
});
