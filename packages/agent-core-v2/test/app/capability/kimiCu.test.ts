/**
 * `kimi-cu` capability entry — macOS and Windows platform selection,
 * layered detection, and install orchestration. Host effects are faked
 * (temp app bundle, scripted host processes, fake plugins).
 */

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IPluginService } from '#/app/plugin/plugin';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';
import type { CapabilityEntryContext } from '#/app/capability/entries/context';
import {
  createKimiCuEntry,
  elevatedDittoScript,
  parsePermissionStatus,
  parseWindowsDoctorOutput,
  readAppBundleVersion,
  windowsPowerShellPath,
  windowsPowerShell7Path,
} from '#/app/capability/entries/kimiCu';

function fakeProc(code: number, stdout = '', stderr = ''): IHostProcess {
  return {
    _serviceBrand: undefined,
    pid: 1234,
    exitCode: code,
    stdin: new Writable({
      write: (_c, _e, cb) => {
        cb();
      },
    }),
    stdout: Readable.from([stdout]),
    stderr: Readable.from([stderr]),
    wait: () => Promise.resolve(code),
    kill: () => Promise.resolve(),
    dispose: () => undefined,
  } as IHostProcess;
}

function fakeHostProcess(
  script: Array<{ match: string; code: number; stdout?: string; stderr?: string; hang?: boolean }>,
): { service: IHostProcessService; calls: string[] } {
  const calls: string[] = [];
  const service: IHostProcessService = {
    _serviceBrand: undefined,
    spawn: (command: string, args: readonly string[] = []) => {
      const key = `${command} ${args.join(' ')}`;
      calls.push(key);
      const hit = script.find((s) => key.includes(s.match));
      if (hit?.hang === true) {
        return Promise.resolve({
          _serviceBrand: undefined,
          pid: 1234,
          exitCode: null,
          stdin: new Writable({
            write: (_c, _e, cb) => {
              cb();
            },
          }),
          stdout: Readable.from(['']),
          stderr: Readable.from(['']),
          // Never settles — the caller's own timeout must fire.
          wait: () => new Promise<number>(() => {}),
          kill: () => Promise.resolve(),
          dispose: () => undefined,
        } as IHostProcess);
      }
      return Promise.resolve(fakeProc(hit?.code ?? 0, hit?.stdout ?? '', hit?.stderr ?? ''));
    },
  } as IHostProcessService;
  return { service, calls };
}

function fakePlugins(
  installed: Array<{ id: string; enabled: boolean; state: string; version?: string; enabledMcp?: number }>,
  onInstall?: () => void | Promise<void>,
): {
  service: IPluginService;
  installs: string[];
  enabledCalls: Array<{ id: string; enabled: boolean }>;
  mcpEnabledCalls: Array<{ id: string; server: string; enabled: boolean }>;
} {
  const installs: string[] = [];
  const enabledCalls: Array<{ id: string; enabled: boolean }> = [];
  const mcpEnabledCalls: Array<{ id: string; server: string; enabled: boolean }> = [];
  const service = {
    listPlugins: () =>
      Promise.resolve(
        installed.map((p) => ({
          id: p.id,
          displayName: p.id,
          version: p.version,
          enabled: p.enabled,
          state: p.state,
          skillCount: 1,
          mcpServerCount: 1,
          enabledMcpServerCount: p.enabledMcp ?? 1,
          hookCount: 0,
          commandCount: 0,
          hasErrors: false,
          source: 'zip-url',
        })),
      ),
    getPluginInfo: (input: { id: string }) => {
      const existing = installed.find((p) => p.id === input.id);
      return Promise.resolve({
        mcpServers: [
          {
            name: input.id === 'kimi-cu-win' ? 'win' : 'mac',
            runtimeName: input.id === 'kimi-cu-win' ? 'win' : 'mac',
            enabled: (existing?.enabledMcp ?? 1) === 1,
            transport: 'stdio',
          },
        ],
      } as never);
    },
    installPlugin: async (input: { source: string }) => {
      installs.push(input.source);
      await onInstall?.();
      const id = input.source.includes('computer-use-windows') ? 'kimi-cu-win' : 'kimi-cu';
      // Upsert semantics of the real manager: a new id installs enabled, an
      // existing record keeps its (possibly disabled) enabled flag.
      const existing = installed.find((p) => p.id === id);
      if (existing === undefined) {
        installed.push({ id, enabled: true, state: 'ok' });
        return { enabled: true, mcpServerCount: 1, enabledMcpServerCount: 1 } as never;
      }
      existing.state = 'ok';
      return {
        enabled: existing.enabled,
        mcpServerCount: 1,
        enabledMcpServerCount: existing.enabledMcp ?? 1,
      } as never;
    },
    setPluginEnabled: (input: { id: string; enabled: boolean }) => {
      enabledCalls.push(input);
      const existing = installed.find((p) => p.id === input.id);
      if (existing !== undefined) existing.enabled = input.enabled;
      return Promise.resolve();
    },
    setPluginMcpServerEnabled: (input: { id: string; server: string; enabled: boolean }) => {
      mcpEnabledCalls.push(input);
      const existing = installed.find((p) => p.id === input.id);
      if (existing !== undefined) existing.enabledMcp = input.enabled ? 1 : 0;
      return Promise.resolve();
    },
  } as unknown as IPluginService;
  return { service, installs, enabledCalls, mcpEnabledCalls };
}

describe('parsePermissionStatus', () => {
  it('parses the machine-readable request-permissions output', () => {
    expect(parsePermissionStatus('permissions: accessibility=true screenRecording=true')).toEqual({
      accessibility: true,
      screenRecording: true,
    });
    expect(parsePermissionStatus('permissions: accessibility=true screenRecording=false')).toEqual({
      accessibility: true,
      screenRecording: false,
    });
    expect(parsePermissionStatus('permissionStatus: accessibility=false screenRecording=true')).toEqual({
      accessibility: false,
      screenRecording: true,
    });
    expect(parsePermissionStatus('unknown command')).toBeUndefined();
    expect(parsePermissionStatus('')).toBeUndefined();
  });
});

describe('parseWindowsDoctorOutput', () => {
  it('accepts only an MCP-capable embedded runtime', () => {
    expect(
      parseWindowsDoctorOutput(
        'version=0.2.14\r\nmcp=true\r\nhelper=embedded\r\nagent=running\r\n',
      ),
    ).toEqual({ version: '0.2.14' });
    expect(parseWindowsDoctorOutput('mcp=false\nhelper=embedded')).toBeUndefined();
    expect(parseWindowsDoctorOutput('mcp=true\nhelper=external')).toBeUndefined();
  });
});

describe('windowsPowerShellPath', () => {
  it('always resolves the system Windows PowerShell executable absolutely', () => {
    expect(windowsPowerShellPath('D:\\Windows')).toBe(
      'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    expect(path.win32.isAbsolute(windowsPowerShellPath('relative'))).toBe(true);
    expect(windowsPowerShell7Path('D:\\Program Files')).toBe(
      'D:\\Program Files\\PowerShell\\7\\pwsh.exe',
    );
    expect(path.win32.isAbsolute(windowsPowerShell7Path('relative'))).toBe(true);
  });
});

describe('elevatedDittoScript', () => {
  it('shell-quotes both paths so spaces and metacharacters stay literal', () => {
    // The elevated path runs the string through /bin/sh with administrator
    // privileges: every path must be exactly one literal argument.
    expect(elevatedDittoScript('/tmp/kimi cu/app', '/Applications/KimiCU.app')).toBe(
      "/usr/bin/ditto '/tmp/kimi cu/app' '/Applications/KimiCU.app'",
    );
    const script = elevatedDittoScript("$(touch /tmp/pwned); echo '", '/Applications/KimiCU.app');
    expect(script).toBe("/usr/bin/ditto '$(touch /tmp/pwned); echo '\\''' '/Applications/KimiCU.app'");
  });
});

describe('readAppBundleVersion', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kimi-cu-version-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads CFBundleShortVersionString from Info.plist', async () => {
    const plist = path.join(root, 'Info.plist');
    await writeFile(
      plist,
      `<?xml version="1.0"?><plist><dict>
<key>CFBundleShortVersionString</key>
<string>0.4.18</string>
</dict></plist>`,
    );
    expect(await readAppBundleVersion(plist)).toBe('0.4.18');
  });

  it('returns undefined for a missing file', async () => {
    expect(await readAppBundleVersion(path.join(root, 'nope.plist'))).toBeUndefined();
  });
});

describe('kimi-cu entry', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kimi-cu-entry-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function fakeAppBundle(): Promise<string> {
    const applicationsDir = path.join(root, 'Applications');
    const macosDir = path.join(applicationsDir, 'KimiCU.app', 'Contents', 'MacOS');
    await mkdir(macosDir, { recursive: true });
    const appBin = path.join(macosDir, 'kimi-cu');
    await writeFile(appBin, '#!/bin/sh\n');
    // Real bundles are executable; anything less reads as a broken install.
    await chmod(appBin, 0o755);
    await writeFile(
      path.join(applicationsDir, 'KimiCU.app', 'Contents', 'Info.plist'),
      '<key>CFBundleShortVersionString</key>\n<string>0.5.4</string>',
    );
    return applicationsDir;
  }

  function makeCtx(overrides: Partial<CapabilityEntryContext> = {}): CapabilityEntryContext {
    return {
      platform: 'darwin',
      arch: 'arm64',
      kimiHomeDir: path.join(root, 'kimi-home'),
      userHomeDir: path.join(root, 'user-home'),
      plugins: fakePlugins([]).service,
      hostProcess: fakeHostProcess([]).service,
      ...overrides,
    };
  }

  it('supports macOS and Windows x64 under one capability id', () => {
    expect(createKimiCuEntry(makeCtx()).supported).toBe(true);
    expect(createKimiCuEntry(makeCtx({ platform: 'linux' })).supported).toBe(false);
    expect(createKimiCuEntry(makeCtx({ platform: 'win32', arch: 'x64' }))).toMatchObject({
      id: 'kimi-cu',
      pluginId: 'kimi-cu-win',
      supported: true,
    });
    expect(createKimiCuEntry(makeCtx({ platform: 'win32', arch: 'arm64' })).supported).toBe(
      false,
    );
  });

  it('labels the Windows capability consistently with its installed plugin', () => {
    expect(createKimiCuEntry(makeCtx({ platform: 'win32', arch: 'x64' })).displayName).toBe(
      'Kimi Computer Use for Windows',
    );
  });

  it('detects the Windows plugin and signed runtime through doctor', async () => {
    const plugins = fakePlugins([
      { id: 'kimi-cu-win', enabled: true, state: 'ok', version: '0.2.14' },
    ]);
    const host = fakeHostProcess([
      {
        match: '-Command',
        code: 0,
        stdout: 'version=0.2.14\r\nmcp=true\r\nhelper=embedded\r\nagent=running\r\n',
      },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({
        platform: 'win32',
        arch: 'x64',
        plugins: plugins.service,
        hostProcess: host.service,
      }),
    );

    await expect(entry.detect()).resolves.toEqual({
      version: '0.2.14',
      steps: [
        { id: 'plugin', state: 'ok', detail: '0.2.14' },
        { id: 'runtime', state: 'ok', detail: '0.2.14' },
      ],
    });
    expect(host.calls).toHaveLength(1);
    expect(
      host.calls[0]?.startsWith(
        `${windowsPowerShellPath()} -NoProfile -NonInteractive -Command `,
      ),
    ).toBe(true);
  });

  it('installs Windows with the official setup script and shared plugin wiring', async () => {
    const plugins = fakePlugins([]);
    const calls: string[] = [];
    const doctorResults = [
      { code: 3, stdout: '', stderr: '' },
      {
        code: 0,
        stdout: 'version=0.2.14\r\nmcp=true\r\nhelper=embedded\r\nagent=running\r\n',
        stderr: '',
      },
    ];
    const hostProcess = {
      _serviceBrand: undefined,
      spawn: (command: string, args: readonly string[] = []) => {
        calls.push(`${command} ${args.join(' ')}`);
        if (args.some((arg) => arg.includes('Get-FileHash'))) {
          return Promise.resolve(fakeProc(0, 'PowerShell 5.1'));
        }
        if (args.some((arg) => arg.includes('setup_windows.ps1'))) {
          return Promise.resolve(fakeProc(0));
        }
        if (args.includes('-Command')) {
          const result = doctorResults.shift();
          return Promise.resolve(
            fakeProc(
              result?.code ?? 1,
              result?.stdout ?? '',
              result?.stderr ?? 'unexpected doctor',
            ),
          );
        }
        return Promise.resolve(fakeProc(1));
      },
    } as IHostProcessService;
    const fetchImpl = (() => {
      const bytes = new TextEncoder().encode("Write-Host 'official setup'");
      return Promise.resolve(
        new Response(bytes, {
          status: 200,
          headers: { 'content-length': String(bytes.length) },
        }),
      );
    }) as typeof fetch;
    const entry = createKimiCuEntry(
      makeCtx({
        platform: 'win32',
        arch: 'x64',
        plugins: plugins.service,
        hostProcess,
        fetchImpl,
      }),
    );
    const reports: Array<[string, number | undefined]> = [];

    await entry.install((step, percent) => reports.push([step, percent]));

    expect(plugins.installs).toEqual([
      'https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-plugin.zip',
    ]);
    expect(reports).toContainEqual(['plugin', undefined]);
    expect(reports).toContainEqual(['download', 0]);
    expect(reports).toContainEqual(['download', 100]);
    expect(reports).toContainEqual(['runtime', undefined]);
    expect(
      calls.some(
        (call) =>
          call.includes('-ExecutionPolicy Bypass -Command') &&
          call.includes('[Console]::OutputEncoding = $utf8') &&
          call.includes('setup_windows.ps1'),
      ),
    ).toBe(true);
    expect(calls.every((call) => call.startsWith(windowsPowerShellPath()))).toBe(true);
    expect(doctorResults).toEqual([]);
  });

  it('uses trusted PowerShell 7 when system PowerShell cannot run the installer', async () => {
    const plugins = fakePlugins([]);
    const calls: string[] = [];
    const doctorResults = [
      { code: 3, stdout: '', stderr: '' },
      {
        code: 0,
        stdout: 'version=0.2.14\r\nmcp=true\r\nhelper=embedded\r\nagent=running\r\n',
        stderr: '',
      },
    ];
    const hostProcess = {
      _serviceBrand: undefined,
      spawn: (command: string, args: readonly string[] = []) => {
        calls.push(`${command} ${args.join(' ')}`);
        if (args.some((arg) => arg.includes('Get-FileHash'))) {
          return Promise.resolve(
            command === windowsPowerShellPath()
              ? fakeProc(2, '', 'missing commands: Get-FileHash')
              : fakeProc(0, 'PowerShell 7.5.2'),
          );
        }
        if (args.some((arg) => arg.includes('setup_windows.ps1'))) {
          return Promise.resolve(fakeProc(0));
        }
        const result = doctorResults.shift();
        return Promise.resolve(
          fakeProc(result?.code ?? 1, result?.stdout ?? '', result?.stderr ?? 'unexpected doctor'),
        );
      },
    } as IHostProcessService;
    const entry = createKimiCuEntry(
      makeCtx({
        platform: 'win32',
        arch: 'x64',
        plugins: plugins.service,
        hostProcess,
        fetchImpl: (() =>
          Promise.resolve(
            new Response("Write-Host 'official setup'", {
              headers: { 'content-length': '27' },
            }),
          )) as typeof fetch,
      }),
    );

    await entry.install(() => undefined);

    expect(
      calls.some(
        (call) =>
          call.startsWith(windowsPowerShell7Path()) && call.includes('setup_windows.ps1'),
      ),
    ).toBe(true);
    expect(plugins.installs).toEqual([
      'https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-plugin.zip',
    ]);
  });

  it('keeps the Windows runtime detectable after installing through PowerShell 7', async () => {
    const plugins = fakePlugins([]);
    const calls: string[] = [];
    let runtimeInstalled = false;
    const hostProcess = {
      _serviceBrand: undefined,
      spawn: (command: string, args: readonly string[] = []) => {
        calls.push(`${command} ${args.join(' ')}`);
        if (command === windowsPowerShellPath()) {
          return Promise.reject(new Error('Windows PowerShell cannot launch'));
        }
        if (args.some((arg) => arg.includes('Get-FileHash'))) {
          return Promise.resolve(fakeProc(0, 'PowerShell 7.5.2'));
        }
        if (args.some((arg) => arg.includes('setup_windows.ps1'))) {
          runtimeInstalled = true;
          return Promise.resolve(fakeProc(0));
        }
        return Promise.resolve(
          runtimeInstalled
            ? fakeProc(
                0,
                'version=0.2.14\r\nmcp=true\r\nhelper=embedded\r\nagent=running\r\n',
              )
            : fakeProc(3),
        );
      },
    } as IHostProcessService;
    const entry = createKimiCuEntry(
      makeCtx({
        platform: 'win32',
        arch: 'x64',
        plugins: plugins.service,
        hostProcess,
        fetchImpl: (() =>
          Promise.resolve(
            new Response("Write-Host 'official setup'", {
              headers: { 'content-length': '27' },
            }),
          )) as typeof fetch,
      }),
    );

    await entry.install(() => undefined);

    await expect(entry.detect()).resolves.toEqual({
      version: '0.2.14',
      steps: [
        { id: 'plugin', state: 'ok' },
        { id: 'runtime', state: 'ok', detail: '0.2.14' },
      ],
    });
    expect(
      calls.some(
        (call) =>
          call.startsWith(windowsPowerShell7Path()) && call.includes('setup_windows.ps1'),
      ),
    ).toBe(true);
  });

  it('leaves plugin wiring untouched when no PowerShell can run the installer', async () => {
    const plugins = fakePlugins([]);
    let downloads = 0;
    const hostProcess = {
      _serviceBrand: undefined,
      spawn: (command: string, args: readonly string[] = []) => {
        if (args.some((arg) => arg.includes('Get-FileHash'))) {
          return Promise.resolve(
            fakeProc(2, '', `${command}: missing commands: Get-FileHash, Expand-Archive`),
          );
        }
        return Promise.resolve(fakeProc(3));
      },
    } as IHostProcessService;
    const entry = createKimiCuEntry(
      makeCtx({
        platform: 'win32',
        arch: 'x64',
        plugins: plugins.service,
        hostProcess,
        fetchImpl: (() => {
          downloads += 1;
          return Promise.reject(new Error('download should not start'));
        }) as typeof fetch,
      }),
    );

    await expect(entry.install(() => undefined)).rejects.toThrow(
      /requires Windows PowerShell 5\.1 or PowerShell 7.*Get-FileHash, Expand-Archive/,
    );

    expect(plugins.installs).toEqual([]);
    expect(downloads).toBe(0);
  });

  it('repairs a missing Windows runtime without replacing a healthy plugin', async () => {
    const plugins = fakePlugins([{ id: 'kimi-cu-win', enabled: true, state: 'ok' }]);
    const doctorResults = [
      { code: 3, stdout: '', stderr: '' },
      {
        code: 0,
        stdout: 'version=0.2.14\r\nmcp=true\r\nhelper=embedded\r\nagent=running\r\n',
        stderr: '',
      },
    ];
    const hostProcess = {
      _serviceBrand: undefined,
      spawn: (_command: string, args: readonly string[] = []) => {
        if (args.some((arg) => arg.includes('Get-FileHash'))) {
          return Promise.resolve(fakeProc(0, 'PowerShell 5.1'));
        }
        if (args.some((arg) => arg.includes('setup_windows.ps1'))) {
          return Promise.resolve(fakeProc(0));
        }
        const result = doctorResults.shift();
        return Promise.resolve(
          fakeProc(result?.code ?? 1, result?.stdout ?? '', result?.stderr ?? 'unexpected doctor'),
        );
      },
    } as IHostProcessService;
    const entry = createKimiCuEntry(
      makeCtx({
        platform: 'win32',
        arch: 'x64',
        plugins: plugins.service,
        hostProcess,
        fetchImpl: (() =>
          Promise.resolve(
            new Response("Write-Host 'official setup'", {
              headers: { 'content-length': '27' },
            }),
          )) as typeof fetch,
      }),
    );

    await entry.install(() => undefined);

    expect(plugins.installs).toEqual([]);
    expect(doctorResults).toEqual([]);
  });

  it('refreshes the Windows plugin when installation starts fully ready', async () => {
    const plugins = fakePlugins([{ id: 'kimi-cu-win', enabled: true, state: 'ok' }]);
    const doctorResults = [
      {
        code: 0,
        stdout: 'version=0.2.14\r\nmcp=true\r\nhelper=embedded\r\nagent=running\r\n',
        stderr: '',
      },
      {
        code: 0,
        stdout: 'version=0.2.14\r\nmcp=true\r\nhelper=embedded\r\nagent=running\r\n',
        stderr: '',
      },
    ];
    const hostProcess = {
      _serviceBrand: undefined,
      spawn: (_command: string, args: readonly string[] = []) => {
        if (args.some((arg) => arg.includes('Get-FileHash'))) {
          return Promise.resolve(fakeProc(0, 'PowerShell 5.1'));
        }
        if (args.some((arg) => arg.includes('setup_windows.ps1'))) {
          return Promise.resolve(fakeProc(0));
        }
        const result = doctorResults.shift();
        return Promise.resolve(
          fakeProc(result?.code ?? 1, result?.stdout ?? '', result?.stderr ?? 'unexpected doctor'),
        );
      },
    } as IHostProcessService;
    const entry = createKimiCuEntry(
      makeCtx({
        platform: 'win32',
        arch: 'x64',
        plugins: plugins.service,
        hostProcess,
        fetchImpl: (() =>
          Promise.resolve(
            new Response("Write-Host 'official setup'", {
              headers: { 'content-length': '27' },
            }),
          )) as typeof fetch,
      }),
    );

    await entry.install(() => undefined);

    expect(plugins.installs).toEqual([
      'https://cdn.kimi.com/kimi-computer-use-windows/latest/kimi-cu-win-plugin.zip',
    ]);
    expect(doctorResults).toEqual([]);
  });

  it('explains how to recover when Windows plugin files are still in use', async () => {
    const busy = Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
    const plugins = fakePlugins([], () => {
      throw busy;
    });
    const host = fakeHostProcess([
      {
        match: '-Command',
        code: 0,
        stdout: 'version=0.2.14\nmcp=true\nhelper=embedded\nagent=running\n',
      },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({
        platform: 'win32',
        arch: 'x64',
        plugins: plugins.service,
        hostProcess: host.service,
      }),
    );

    await expect(entry.install(() => undefined)).rejects.toThrow(
      'Kimi Computer Use plugin files are still in use by the current Kimi Code process. Restart Kimi Code, then install again.',
    );
  });

  it('does not reinstall a healthy Windows runtime when only the plugin is missing', async () => {
    const plugins = fakePlugins([]);
    const host = fakeHostProcess([
      {
        match: '-Command',
        code: 0,
        stdout: 'version=0.2.14\nmcp=true\nhelper=embedded\nagent=running\n',
      },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({
        platform: 'win32',
        arch: 'x64',
        plugins: plugins.service,
        hostProcess: host.service,
        fetchImpl: (() => Promise.reject(new Error('download should be skipped'))) as never,
      }),
    );
    const reports: string[] = [];

    await entry.install((step) => reports.push(step));

    expect(reports).toEqual(['plugin']);
    expect(host.calls).toHaveLength(1);
  });

  it('detects all four layers with details', async () => {
    const applicationsDir = await fakeAppBundle();
    const plugins = fakePlugins([{ id: 'kimi-cu', enabled: true, state: 'ok', version: '0.5.4' }]);
    const host = fakeHostProcess([
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1 (1=enabled); fallback plist exists=false' },
      { match: 'xpc-ping', code: 0, stdout: 'permissionStatus: accessibility=true screenRecording=false' },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({ applicationsDir, plugins: plugins.service, hostProcess: host.service }),
    );

    const detected = await entry.detect();
    expect(detected.version).toBe('0.5.4');
    expect(detected.steps).toEqual([
      { id: 'plugin', state: 'ok', detail: '0.5.4' },
      { id: 'app', state: 'ok', detail: '0.5.4' },
      { id: 'service', state: 'ok' },
      { id: 'permissions', state: 'missing', detail: 'screenRecording' },
    ]);
    expect(host.calls.some((call) => call.endsWith(' xpc-ping'))).toBe(true);
    expect(host.calls.some((call) => call.includes('request-permissions'))).toBe(false);
  });

  it('reports missing layers on a bare machine', async () => {
    const entry = createKimiCuEntry(makeCtx({ applicationsDir: path.join(root, 'Applications') }));
    const detected = await entry.detect();
    expect(detected.version).toBeUndefined();
    expect(detected.steps.map((s) => [s.id, s.state])).toEqual([
      ['plugin', 'missing'],
      ['app', 'missing'],
      ['service', 'missing'],
      ['permissions', 'missing'],
    ]);
  });

  it('rejects install on non-macOS before any side effect', async () => {
    const plugins = fakePlugins([]);
    const entry = createKimiCuEntry(makeCtx({ platform: 'linux', plugins: plugins.service }));
    await expect(entry.install(() => {})).rejects.toThrow(/only supported on macOS/);
    expect(plugins.installs).toEqual([]);
  });

  it('resumes a partial install without repeating completed runtime layers', async () => {
    const applicationsDir = await fakeAppBundle();
    const plugins = fakePlugins([]);
    const host = fakeHostProcess([
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1' },
      { match: 'xpc-ping', code: 0, stdout: 'permissionStatus: accessibility=true screenRecording=true' },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({
        applicationsDir,
        plugins: plugins.service,
        hostProcess: host.service,
        fetchImpl: (() => Promise.reject(new Error('download should be skipped'))) as never,
      }),
    );
    const reports: string[] = [];

    await entry.install((step) => reports.push(step));

    expect(plugins.installs).toHaveLength(1);
    expect(reports).toEqual(['plugin']);
    expect(host.calls.every((call) => call.includes('service-status') || call.includes('xpc-ping'))).toBe(true);
  });

  it('migrates the exact legacy standalone MCP registration after installing the plugin', async () => {
    const applicationsDir = await fakeAppBundle();
    const appBin = path.join(applicationsDir, 'KimiCU.app', 'Contents', 'MacOS', 'kimi-cu');
    const kimiHomeDir = path.join(root, 'kimi-home');
    await mkdir(kimiHomeDir, { recursive: true });
    await writeFile(
      path.join(kimiHomeDir, 'mcp.json'),
      `${JSON.stringify({
        mcpServers: {
          'kimi-cu': { command: appBin, args: ['mcp', '-s', 'user'] },
          custom: { command: 'custom-mcp', args: [] },
        },
      })}\n`,
    );
    const plugins = fakePlugins([]);
    const host = fakeHostProcess([
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1' },
      { match: 'xpc-ping', code: 0, stdout: 'permissionStatus: accessibility=true screenRecording=true' },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({
        applicationsDir,
        kimiHomeDir,
        plugins: plugins.service,
        hostProcess: host.service,
      }),
    );

    expect((await entry.detect()).steps).toContainEqual({
      id: 'legacy-mcp',
      state: 'missing',
      detail: 'duplicate standalone kimi-cu MCP registration',
      optional: true,
    });
    const reports: string[] = [];
    await entry.install((step) => reports.push(step));

    const migrated = JSON.parse(await readFile(path.join(kimiHomeDir, 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(migrated.mcpServers['kimi-cu']).toBeUndefined();
    expect(migrated.mcpServers['custom']).toEqual({ command: 'custom-mcp', args: [] });
    expect(reports).toEqual(['plugin', 'mcp-config']);
  });

  it('leaves the legacy MCP config untouched when it changes during setup', async () => {
    const applicationsDir = await fakeAppBundle();
    const appBin = path.join(applicationsDir, 'KimiCU.app', 'Contents', 'MacOS', 'kimi-cu');
    const kimiHomeDir = path.join(root, 'kimi-home');
    await mkdir(kimiHomeDir, { recursive: true });
    const configPath = path.join(kimiHomeDir, 'mcp.json');
    const legacy = { command: appBin, args: ['mcp', '-s', 'user'] };
    await writeFile(configPath, `${JSON.stringify({ mcpServers: { 'kimi-cu': legacy } })}\n`);
    const concurrentConfig = {
      mcpServers: {
        'kimi-cu': legacy,
        addedDuringSetup: { command: 'another-mcp', args: [] },
      },
    };
    const plugins = fakePlugins([], async () => {
      await writeFile(configPath, `${JSON.stringify(concurrentConfig, null, 2)}\n`);
    });
    const host = fakeHostProcess([
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1' },
      { match: 'xpc-ping', code: 0, stdout: 'permissionStatus: accessibility=true screenRecording=true' },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({
        applicationsDir,
        kimiHomeDir,
        plugins: plugins.service,
        hostProcess: host.service,
      }),
    );
    const reports: string[] = [];

    await entry.install((step) => reports.push(step));

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(concurrentConfig);
    expect(reports).toEqual(['plugin']);
  });

  it('does not migrate a customized standalone MCP registration', async () => {
    const applicationsDir = await fakeAppBundle();
    const appBin = path.join(applicationsDir, 'KimiCU.app', 'Contents', 'MacOS', 'kimi-cu');
    const kimiHomeDir = path.join(root, 'kimi-home');
    await mkdir(kimiHomeDir, { recursive: true });
    const configPath = path.join(kimiHomeDir, 'mcp.json');
    const custom = {
      mcpServers: {
        'kimi-cu': { command: appBin, args: ['mcp', '-s', 'user'], env: { CUSTOM: '1' } },
      },
    };
    await writeFile(configPath, `${JSON.stringify(custom)}\n`);
    const plugins = fakePlugins([]);
    const host = fakeHostProcess([
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1' },
      { match: 'xpc-ping', code: 0, stdout: 'permissionStatus: accessibility=true screenRecording=true' },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({
        applicationsDir,
        kimiHomeDir,
        plugins: plugins.service,
        hostProcess: host.service,
      }),
    );

    await entry.install(() => {});

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual(custom);
  });

  it('marks probe steps failed instead of throwing when the binary is wedged', async () => {
    const applicationsDir = await fakeAppBundle();
    const plugins = fakePlugins([]);
    const host = fakeHostProcess([
      { match: 'service-status', code: 0, hang: true },
      { match: 'xpc-ping', code: 0, hang: true },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({
        applicationsDir,
        plugins: plugins.service,
        hostProcess: host.service,
        detectProbeTimeoutMs: 5,
      }),
    );

    const detected = await entry.detect();
    expect(detected.steps.find((s) => s.id === 'service')).toEqual({
      id: 'service',
      state: 'failed',
      detail: expect.stringContaining('timed out'),
    });
    expect(detected.steps.find((s) => s.id === 'permissions')).toEqual({
      id: 'permissions',
      state: 'failed',
      detail: expect.stringContaining('timed out'),
    });

    // The install path uses the same detect — it must still repair the
    // wiring layer instead of dying on the wedged probes. The service
    // itself legitimately stays broken and reports the clean error.
    await expect(entry.install(() => {})).rejects.toThrow(/not running after install/);
    expect(plugins.installs).toHaveLength(1);
  });

  it('re-enables a previously disabled wiring plugin during setup', async () => {
    const applicationsDir = await fakeAppBundle();
    const plugins = fakePlugins([{ id: 'kimi-cu', enabled: false, state: 'ok', version: '0.5.4' }]);
    const host = fakeHostProcess([
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1' },
      { match: 'xpc-ping', code: 0, stdout: 'permissionStatus: accessibility=true screenRecording=true' },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({ applicationsDir, plugins: plugins.service, hostProcess: host.service }),
    );

    // Everything else ready, only the disabled wiring blocks readiness —
    // setup must not strand the capability at partial by leaving it off.
    await entry.install(() => {});
    expect(plugins.enabledCalls).toEqual([{ id: 'kimi-cu', enabled: true }]);
  });

  it('refreshes the wiring plugin when permissions are the only missing layer', async () => {
    const applicationsDir = await fakeAppBundle();
    const plugins = fakePlugins([
      { id: 'kimi-cu', enabled: true, state: 'ok', version: '0.5.4' },
    ]);
    const host = fakeHostProcess([
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1' },
      {
        match: 'xpc-ping',
        code: 0,
        stdout: 'permissionStatus: accessibility=true screenRecording=false',
      },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({ applicationsDir, plugins: plugins.service, hostProcess: host.service }),
    );

    await entry.install(() => {});

    expect(plugins.installs).toEqual([
      'https://cdn.kimi.com/kimi-computer-use/latest/kimi-cu-plugin.zip',
    ]);
  });

  it('continues the replacement when the old-binary cleanup hangs', async () => {
    const applicationsDir = await fakeAppBundle();
    const plugins = fakePlugins([{ id: 'kimi-cu', enabled: true, state: 'ok', version: '0.5.4' }]);
    const host = fakeHostProcess([
      // The wedged old binary makes `kimi-cu uninstall` hang — cleanup must
      // swallow the timeout (`|| true` semantics) instead of killing the
      // reinstall before ditto can replace the app.
      { match: 'uninstall', code: 0, hang: true },
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1' },
      { match: 'xpc-ping', code: 0, stdout: 'permissionStatus: accessibility=true screenRecording=true' },
    ]);
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-length': '3' },
        }),
      )) as never;
    // The fake ditto must materialize the copied binary: moveAppIntoPlace
    // rm's the old bundle first, and the post-install service check probes
    // the new one.
    const appBin = path.join(applicationsDir, 'KimiCU.app', 'Contents', 'MacOS', 'kimi-cu');
    const hostProcess = {
      spawn: async (command: string, args: readonly string[] = []) => {
        const proc = await host.service.spawn(command, args);
        if (command === 'ditto' && String(args.at(-1)).includes('KimiCU.app')) {
          await mkdir(path.dirname(appBin), { recursive: true });
          await writeFile(appBin, '#!/bin/sh\n');
          await chmod(appBin, 0o755);
        }
        return proc;
      },
    } as IHostProcessService;
    const entry = createKimiCuEntry(
      makeCtx({
        applicationsDir,
        plugins: plugins.service,
        hostProcess,
        fetchImpl,
        commandTimeoutMs: 5,
      }),
    );

    // Fully ready → explicit reinstall exercises the cleanup path.
    await entry.install(() => {});
    expect(host.calls.some((call) => call.includes('ditto'))).toBe(true);
    expect(host.calls.some((call) => call.includes('pkill') && call.includes('+mcp'))).toBe(false);
    expect(host.calls.some((call) => call.includes('pkill') && call.includes('+service'))).toBe(true);
  });

  it('reports the plugin layer missing when its MCP server is disabled', async () => {
    const plugins = fakePlugins([{ id: 'kimi-cu', enabled: true, state: 'ok', version: '0.5.4', enabledMcp: 0 }]);
    const entry = createKimiCuEntry(makeCtx({ plugins: plugins.service }));

    // The plugin toggle is on but the stdio MCP wrapper is off: readiness
    // must not claim ready — new sessions would get no Computer Use tools.
    const detected = await entry.detect();
    expect(detected.steps.find((s) => s.id === 'plugin')).toEqual({
      id: 'plugin',
      state: 'missing',
      detail: 'mcp 0/1 enabled',
    });
  });

  it('re-enables disabled MCP servers during setup', async () => {
    const applicationsDir = await fakeAppBundle();
    const plugins = fakePlugins([{ id: 'kimi-cu', enabled: true, state: 'ok', version: '0.5.4', enabledMcp: 0 }]);
    const host = fakeHostProcess([
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1' },
      { match: 'xpc-ping', code: 0, stdout: 'permissionStatus: accessibility=true screenRecording=true' },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({ applicationsDir, plugins: plugins.service, hostProcess: host.service }),
    );

    // Upsert preserves the per-server disabled state, so setup repairs it
    // explicitly — the plugin toggle alone is not enough.
    await entry.install(() => {});
    expect(plugins.mcpEnabledCalls).toEqual([{ id: 'kimi-cu', server: 'mac', enabled: true }]);
  });

  it('never stops the old service when the downloaded archive is corrupt', async () => {
    const plugins = fakePlugins([]);
    const host = fakeHostProcess([
      { match: 'ditto -x -k', code: 1, stderr: 'ditto: Not a zip file' },
    ]);
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(new TextEncoder().encode('<html>captive portal</html>'), {
          status: 200,
          headers: { 'content-length': '26' },
        }),
      )) as never;
    const entry = createKimiCuEntry(
      makeCtx({
        applicationsDir: path.join(root, 'Applications'),
        plugins: plugins.service,
        hostProcess: host.service,
        fetchImpl,
      }),
    );

    // A corrupt archive must fail before any teardown — a failed update
    // never breaks a previously working setup.
    await expect(entry.install(() => {})).rejects.toThrow(/Failed to unzip/);
    expect(host.calls.some((call) => call.includes('uninstall'))).toBe(false);
    expect(host.calls.some((call) => call.includes('bootout'))).toBe(false);
    expect(host.calls.some((call) => call.includes('pkill'))).toBe(false);
  });

  it('reads a bundle missing its Info.plist as a broken install', async () => {
    const applicationsDir = await fakeAppBundle();
    // Executable binary but the bundle metadata is gone (partial copy).
    await rm(path.join(applicationsDir, 'KimiCU.app', 'Contents', 'Info.plist'));
    const entry = createKimiCuEntry(makeCtx({ applicationsDir }));

    const detected = await entry.detect();
    expect(detected.steps.find((s) => s.id === 'app')?.state).toBe('missing');
  });

  it('reads a non-executable leftover app binary as a broken install', async () => {
    const applicationsDir = await fakeAppBundle();
    // An interrupted ditto leaves the binary present but not executable.
    await chmod(path.join(applicationsDir, 'KimiCU.app', 'Contents', 'MacOS', 'kimi-cu'), 0o644);
    const entry = createKimiCuEntry(makeCtx({ applicationsDir }));

    const detected = await entry.detect();
    expect(detected.steps.find((s) => s.id === 'app')).toEqual({
      id: 'app',
      state: 'missing',
      detail: 'not executable',
    });
  });
});
