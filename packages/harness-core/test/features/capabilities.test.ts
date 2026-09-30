import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { memorySessionSpace, createHarness, type AppHandle } from '@moonshot-ai/agent-core';

import {
  CapabilitiesRef,
  CapabilityError,
  createCapabilities,
  createKimiCuEntry,
  createKimiWebbridgeEntry,
  elevatedDittoScript,
  parsePermissionStatus,
  parseWindowsDoctorOutput,
  readAppBundleVersion,
  windowsPowerShellPath,
  type CapabilitiesFace,
  type CapabilityDetectResult,
  type CapabilityEntry,
  type CapabilityEntryContext,
  type CapabilityInstallReporter,
  type CapabilityPluginsPort,
  type CapabilityPluginSummary,
  type CapabilityStatus,
} from '#/features/capabilities/index';
import {
  HostFsError,
  type HostFileStat,
  type OsEnvironmentPort,
  type OsFsPort,
  type OsHost,
  type OsProcess,
  type OsProcessPort,
} from '#/features/os/host/index';

const apps: AppHandle[] = [];
const tempDirs: string[] = [];

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'capabilities-test-'));
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.disposeAsync()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  await rm(root, { recursive: true, force: true });
});

function fakeProc(code: number, stdout = '', stderr = ''): OsProcess {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
  return {
    pid: 1234,
    exitCode: code,
    stdin: { write: () => {}, end: () => {} },
    stdout: (async function* () {
      if (stdout !== '') yield encode(stdout);
    })(),
    stderr: (async function* () {
      if (stderr !== '') yield encode(stderr);
    })(),
    wait: () => Promise.resolve(code),
    kill: () => Promise.resolve(),
    dispose: () => undefined,
  };
}

function fakeProcess(
  script: Array<{ match: string; code: number; stdout?: string; stderr?: string; hang?: boolean }> = [],
): { port: OsProcessPort; calls: string[] } {
  const calls: string[] = [];
  const port: OsProcessPort = {
    spawn: (command, args = []) => {
      const key = `${command} ${args.join(' ')}`;
      calls.push(key);
      const hit = script.find((s) => key.includes(s.match));
      if (hit?.hang === true) {
        return Promise.resolve({
          ...fakeProc(0),
          stdout: (async function* () {})(),
          stderr: (async function* () {})(),
          wait: () => new Promise<number>(() => {}),
        });
      }
      return Promise.resolve(fakeProc(hit?.code ?? 0, hit?.stdout ?? '', hit?.stderr ?? ''));
    },
  };
  return { port, calls };
}

function notFoundFsError(path: string, op: string): HostFsError {
  return new HostFsError('os.fs.not_found', 'path does not exist', { details: { path, op } });
}

function fakeFs(existing: readonly string[] = [], contents: Readonly<Record<string, string>> = {}): OsFsPort {
  const present = new Set(existing);
  const statPath = (p: string): Promise<HostFileStat> => {
    if (!present.has(p)) return Promise.reject(notFoundFsError(p, 'stat'));
    const content = contents[p];
    return Promise.resolve({
      isFile: content !== undefined,
      isDirectory: content === undefined,
      size: content?.length ?? 0,
    });
  };
  const fail = (): never => {
    throw new Error('unexpected fs call');
  };
  return {
    readText: (p) => {
      const content = contents[p];
      if (content === undefined) return Promise.reject(notFoundFsError(p, 'readText'));
      return Promise.resolve(content);
    },
    writeText: fail,
    appendText: fail,
    readBytes: fail,
    writeBytes: fail,
    readLines: fail as OsFsPort['readLines'],
    createExclusive: fail,
    stat: statPath,
    lstat: statPath,
    readdir: fail,
    mkdir: fail,
    remove: fail,
    rename: fail,
    realpath: (p) => Promise.resolve(p),
  };
}

function nodeFs(): OsFsPort {
  const statPath = async (p: string): Promise<HostFileStat> => {
    try {
      const stats = await stat(p);
      return { isFile: stats.isFile(), isDirectory: stats.isDirectory(), size: stats.size };
    } catch (error) {
      throw notFoundFsError(p, 'stat');
    }
  };
  const fail = (): never => {
    throw new Error('unexpected fs call');
  };
  return {
    readText: async (p) => {
      try {
        return await readFile(p, 'utf8');
      } catch {
        throw notFoundFsError(p, 'readText');
      }
    },
    writeText: fail,
    appendText: fail,
    readBytes: fail,
    writeBytes: fail,
    readLines: fail as OsFsPort['readLines'],
    createExclusive: fail,
    stat: statPath,
    lstat: statPath,
    readdir: fail,
    mkdir: fail,
    remove: fail,
    rename: fail,
    realpath: (p) => Promise.resolve(p),
  };
}

function fakeEnvironment(overrides: Partial<OsEnvironmentPort> = {}): OsEnvironmentPort {
  return {
    osKind: 'darwin',
    osArch: 'arm64',
    osVersion: '24.0.0',
    shellName: 'bash',
    shellPath: '/bin/bash',
    pathClass: 'posix',
    homeDir: join(root, 'user-home'),
    ready: Promise.resolve(),
    ...overrides,
  };
}

function fakeHost(overrides: Partial<OsHost> = {}): OsHost {
  return {
    process: fakeProcess().port,
    fs: fakeFs(),
    environment: fakeEnvironment(),
    ...overrides,
  };
}

interface FakeInstalledPlugin {
  readonly id: string;
  enabled: boolean;
  state: string;
  version?: string;
  mcpServerCount?: number;
  enabledMcpServerCount?: number;
}

function fakePlugins(
  installed: FakeInstalledPlugin[],
  onInstall?: () => void | Promise<void>,
): {
  port: CapabilityPluginsPort;
  installs: string[];
  enabledCalls: Array<{ id: string; enabled: boolean }>;
  mcpEnabledCalls: Array<{ id: string; server: string; enabled: boolean }>;
} {
  const installs: string[] = [];
  const enabledCalls: Array<{ id: string; enabled: boolean }> = [];
  const mcpEnabledCalls: Array<{ id: string; server: string; enabled: boolean }> = [];
  const summaryOf = (p: FakeInstalledPlugin): CapabilityPluginSummary => ({
    id: p.id,
    enabled: p.enabled,
    state: p.state,
    version: p.version,
    enabledMcpServerCount: p.enabledMcpServerCount ?? p.mcpServerCount ?? 0,
    mcpServerCount: p.mcpServerCount ?? 0,
  });
  const port: CapabilityPluginsPort = {
    listPlugins: () => Promise.resolve(installed.map(summaryOf)),
    installPlugin: async (source) => {
      installs.push(source);
      await onInstall?.();
      const id = source.includes('kimi-webbridge')
        ? 'kimi-webbridge'
        : source.includes('computer-use-windows')
          ? 'kimi-cu-win'
          : 'kimi-cu';
      const existing = installed.find((p) => p.id === id);
      if (existing === undefined) {
        const created: FakeInstalledPlugin = { id, enabled: true, state: 'ok' };
        installed.push(created);
        return summaryOf(created);
      }
      existing.state = 'ok';
      return summaryOf(existing);
    },
    setPluginEnabled: (id, enabled) => {
      enabledCalls.push({ id, enabled });
      const existing = installed.find((p) => p.id === id);
      if (existing !== undefined) existing.enabled = enabled;
      return Promise.resolve();
    },
    setPluginMcpServerEnabled: (id, server, enabled) => {
      mcpEnabledCalls.push({ id, server, enabled });
      const existing = installed.find((p) => p.id === id);
      if (existing !== undefined) {
        existing.enabledMcpServerCount = enabled ? (existing.mcpServerCount ?? 1) : 0;
      }
      return Promise.resolve();
    },
    getPluginInfo: (id) => {
      const existing = installed.find((p) => p.id === id);
      return Promise.resolve({
        mcpServers: [
          {
            name: 'server',
            enabled: (existing?.enabledMcpServerCount ?? existing?.mcpServerCount ?? 0) > 0,
          },
        ],
      });
    },
  };
  return { port, installs, enabledCalls, mcpEnabledCalls };
}

function makeCtx(overrides: Partial<CapabilityEntryContext> = {}): CapabilityEntryContext {
  return {
    platform: 'darwin',
    arch: 'arm64',
    kimiHomeDir: join(root, 'kimi-home'),
    userHomeDir: join(root, 'user-home'),
    plugins: fakePlugins([]).port,
    hostProcess: fakeProcess().port,
    fs: fakeFs(),
    ...overrides,
  };
}

function fakeEntry(overrides: {
  id: 'kimi-cu' | 'kimi-webbridge';
  pluginId?: string;
  supported?: boolean;
  detect?: CapabilityDetectResult;
  install?: (report: CapabilityInstallReporter) => Promise<string | undefined>;
}): CapabilityEntry {
  return {
    id: overrides.id,
    pluginId: overrides.pluginId,
    displayName: overrides.id,
    description: 'fake',
    supported: overrides.supported ?? true,
    detect: () => Promise.resolve(overrides.detect ?? { steps: [{ id: 'plugin', state: 'ok' }] }),
    install: overrides.install ?? (() => Promise.resolve(undefined)),
  };
}

interface MountedCapabilities {
  readonly app: AppHandle;
  readonly face: CapabilitiesFace;
  readonly spec: ReturnType<typeof createCapabilities>;
}

async function mountCapabilities(
  options: {
    host?: OsHost;
    entries?: readonly CapabilityEntry[];
    onWarn?: (
      message: string,
      payload?: { capabilityId: string; step?: string; error: unknown },
    ) => void;
  } = {},
): Promise<MountedCapabilities> {
  const spec = createCapabilities({
    homeDir: join(root, 'kimi-home'),
    host: options.host ?? fakeHost(),
    entries: options.entries,
    onWarn: options.onWarn,
  });
  const app = createHarness({ space: memorySessionSpace(), features: [spec] });
  apps.push(app);
  await app.ready();
  return { app, face: app.resolve(CapabilitiesRef), spec };
}

async function waitInstallSettled(face: CapabilitiesFace, id: string): Promise<CapabilityStatus> {
  for (let i = 0; i < 100; i += 1) {
    const status = await face.get(id);
    if (!status.install.running) return status;
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error('install never settled');
}

async function fakeAppBundle(): Promise<string> {
  const applicationsDir = join(root, 'Applications');
  const macosDir = join(applicationsDir, 'KimiCU.app', 'Contents', 'MacOS');
  await mkdir(macosDir, { recursive: true });
  const appBin = join(macosDir, 'kimi-cu');
  await writeFile(appBin, '#!/bin/sh\n');
  await chmod(appBin, 0o755);
  await writeFile(
    join(applicationsDir, 'KimiCU.app', 'Contents', 'Info.plist'),
    '<key>CFBundleShortVersionString</key>\n<string>0.5.4</string>',
  );
  return applicationsDir;
}

describe('capability parse helpers', () => {
  it('parses permission and doctor output, quotes ditto scripts, and reads bundle versions', async () => {
    expect(parsePermissionStatus('permissions: accessibility=true screenRecording=true')).toEqual({
      accessibility: true,
      screenRecording: true,
    });
    expect(parsePermissionStatus('permissionStatus: accessibility=false screenRecording=true')).toEqual({
      accessibility: false,
      screenRecording: true,
    });
    expect(parsePermissionStatus('unknown command')).toBeUndefined();

    expect(
      parseWindowsDoctorOutput('version=0.2.14\r\nmcp=true\r\nhelper=embedded\r\nagent=running\r\n'),
    ).toEqual({ version: '0.2.14' });
    expect(parseWindowsDoctorOutput('mcp=true\nhelper=embedded')).toEqual({});
    expect(parseWindowsDoctorOutput('mcp=false\nhelper=embedded')).toBeUndefined();
    expect(parseWindowsDoctorOutput('mcp=true\nhelper=external')).toBeUndefined();

    expect(elevatedDittoScript("$(touch /tmp/pwned); echo '", '/Applications/KimiCU.app')).toBe(
      "/usr/bin/ditto '$(touch /tmp/pwned); echo '\\''' '/Applications/KimiCU.app'",
    );

    const plist = join(root, 'Info.plist');
    await writeFile(
      plist,
      `<?xml version="1.0"?><plist><dict>
<key>CFBundleShortVersionString</key>
<string>0.4.18</string>
</dict></plist>`,
    );
    expect(await readAppBundleVersion(nodeFs(), plist)).toBe('0.4.18');
    expect(await readAppBundleVersion(nodeFs(), join(root, 'nope.plist'))).toBeUndefined();
  });
});

describe('capabilities feature', () => {
  it('lists entries with readiness computed from required steps', async () => {
    const { face } = await mountCapabilities({
      entries: [
        fakeEntry({
          id: 'kimi-cu',
          pluginId: 'kimi-cu-win',
          detect: { steps: [{ id: 'plugin', state: 'ok' }] },
        }),
        fakeEntry({
          id: 'kimi-webbridge',
          detect: {
            version: 'v1.11.3',
            steps: [
              { id: 'daemon', state: 'ok' },
              { id: 'skill', state: 'missing' },
              { id: 'extension', state: 'missing', optional: true },
            ],
          },
        }),
      ],
    });
    const list = await face.list();
    expect(list.map((c) => [c.id, c.state])).toEqual([
      ['kimi-cu', 'ready'],
      ['kimi-webbridge', 'partial'],
    ]);
    expect(list[0]?.pluginId).toBe('kimi-cu-win');

    const single = await mountCapabilities({
      entries: [
        fakeEntry({
          id: 'kimi-webbridge',
          detect: {
            version: 'v1.11.3',
            steps: [
              { id: 'daemon', state: 'ok' },
              { id: 'extension', state: 'missing', optional: true },
            ],
          },
        }),
      ],
    });
    const status = await single.face.get('kimi-webbridge');
    expect(status.state).toBe('ready');
    expect(status.version).toBe('v1.11.3');
  });

  it('reports not_installed and unsupported as-is and isolates detector failures', async () => {
    const { face } = await mountCapabilities({
      entries: [
        fakeEntry({ id: 'kimi-cu', detect: { steps: [{ id: 'plugin', state: 'missing' }] } }),
        fakeEntry({ id: 'kimi-webbridge', supported: false }),
      ],
    });
    const list = await face.list();
    expect(list.find((c) => c.id === 'kimi-cu')?.state).toBe('not_installed');
    const unsupported = list.find((c) => c.id === 'kimi-webbridge');
    expect(unsupported?.state).toBe('unsupported');
    expect(unsupported?.supported).toBe(false);

    const broken = fakeEntry({ id: 'kimi-cu' });
    const isolated = await mountCapabilities({
      entries: [
        {
          ...broken,
          detect: () => Promise.reject(new Error('probe timed out')),
        },
        fakeEntry({ id: 'kimi-webbridge', detect: { steps: [{ id: 'daemon', state: 'ok' }] } }),
      ],
    });
    const isolatedList = await isolated.face.list();
    expect(isolatedList.find((c) => c.id === 'kimi-webbridge')?.state).toBe('ready');
    const cu = isolatedList.find((c) => c.id === 'kimi-cu');
    expect(cu?.state).toBe('partial');
    expect(cu?.steps).toEqual([{ id: 'detect', state: 'failed', detail: 'probe timed out' }]);
  });

  it('throws capability.not_found for unknown ids', async () => {
    const { face } = await mountCapabilities({ entries: [] });
    await expect(face.get('nope')).rejects.toMatchObject({
      name: 'CapabilityError',
      code: 'capability.not_found',
      message: 'Capability "nope" is not registered',
    });
    await expect(face.install('nope')).rejects.toMatchObject({
      code: 'capability.not_found',
      message: 'Capability "nope" is not registered',
    });
    await expect(face.get('nope')).rejects.toBeInstanceOf(CapabilityError);
  });

  it('rejects install on an unsupported entry with the host platform in the message', async () => {
    const { face } = await mountCapabilities({
      entries: [fakeEntry({ id: 'kimi-cu', supported: false })],
    });
    await expect(face.install('kimi-cu')).rejects.toMatchObject({
      code: 'capability.unsupported',
      message: 'Capability "kimi-cu" is not supported on darwin/arm64',
    });
  });

  it('serializes installs, streams progress events, and clears on success', async () => {
    let release: (() => void) | undefined;
    const { app, face, spec } = await mountCapabilities({
      entries: [
        fakeEntry({
          id: 'kimi-cu',
          install: (report) => {
            report('download', 42);
            return new Promise<string | undefined>((resolve) => {
              release = () => {
                resolve(undefined);
              };
            });
          },
        }),
      ],
    });
    const seen: Array<{ id: string; install: { running: boolean; step?: string; percent?: number } }> = [];
    app.on(spec, 'capability.changed', (event) => {
      seen.push({ id: event.id, install: event.install });
    });

    const started = await face.install('kimi-cu');
    expect(started.install.running).toBe(true);

    await expect(face.install('kimi-cu')).rejects.toMatchObject({
      code: 'capability.install_in_progress',
      message: 'Capability "kimi-cu" is already being installed',
    });

    const during = await face.get('kimi-cu');
    expect(during.install).toEqual({ running: true, step: 'download', percent: 42 });

    release?.();
    const settled = await waitInstallSettled(face, 'kimi-cu');
    expect(settled.install.error).toBeUndefined();
    expect(seen[0]).toEqual({ id: 'kimi-cu', install: { running: true } });
    expect(seen).toContainEqual({
      id: 'kimi-cu',
      install: { running: true, step: 'download', percent: 42 },
    });
    expect(seen.at(-1)).toEqual({ id: 'kimi-cu', install: { running: false } });
  });

  it('surfaces install notes and errors through progress, warns on failure, and clears on retry', async () => {
    let attempts = 0;
    const warnings: Array<{ message: string; payload?: { capabilityId: string; step?: string; error: unknown } }> = [];
    const { face } = await mountCapabilities({
      onWarn: (message, payload) => {
        warnings.push({ message, payload: payload as { capabilityId: string; step?: string; error: unknown } });
      },
      entries: [
        fakeEntry({
          id: 'kimi-cu',
          install: (report) => {
            attempts += 1;
            if (attempts > 1) return Promise.resolve('user-skill-migrated');
            report('runtime');
            return Promise.reject(new Error('boom'));
          },
        }),
      ],
    });

    await face.install('kimi-cu');
    const failed = await waitInstallSettled(face, 'kimi-cu');
    expect(failed.install).toEqual({ running: false, error: 'boom' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe('capability install failed');
    expect(warnings[0]?.payload?.capabilityId).toBe('kimi-cu');
    expect(warnings[0]?.payload?.step).toBe('runtime');
    expect(warnings[0]?.payload?.error).toBeInstanceOf(Error);

    await face.install('kimi-cu');
    const retried = await waitInstallSettled(face, 'kimi-cu');
    expect(retried.install.error).toBeUndefined();
    expect(retried.install.note).toBe('user-skill-migrated');
    expect(attempts).toBe(2);
  });

  it('exposes no facade when mounted without an os host', async () => {
    const spec = createCapabilities({ homeDir: join(root, 'kimi-home') });
    const app = createHarness({ space: memorySessionSpace(), features: [spec] });
    apps.push(app);
    await app.ready();
    expect(app.resolve(CapabilitiesRef)).toBeUndefined();
  });
});

describe('kimi-cu entry', () => {
  it('detects all four layers with details on macOS', async () => {
    const appBin = '/apps/KimiCU.app/Contents/MacOS/kimi-cu';
    const infoPlist = '/apps/KimiCU.app/Contents/Info.plist';
    const plugins = fakePlugins([{ id: 'kimi-cu', enabled: true, state: 'ok', version: '1.2.3' }]);
    const host = fakeProcess([
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1' },
      {
        match: 'xpc-ping',
        code: 0,
        stdout: 'permissionStatus: accessibility=true screenRecording=true',
      },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({
        applicationsDir: '/apps',
        plugins: plugins.port,
        hostProcess: host.port,
        fs: fakeFs([appBin, infoPlist], {
          [appBin]: '#!/bin/sh\n',
          [infoPlist]: '<key>CFBundleShortVersionString</key>\n<string>0.5.4</string>',
        }),
      }),
    );

    await expect(entry.detect()).resolves.toEqual({
      version: '0.5.4',
      steps: [
        { id: 'plugin', state: 'ok', detail: '1.2.3' },
        { id: 'app', state: 'ok', detail: '0.5.4' },
        { id: 'service', state: 'ok' },
        { id: 'permissions', state: 'ok' },
      ],
    });
  });

  it('reports missing layers, mcp gaps, legacy registrations and permission details on a bare machine', async () => {
    const appBin = '/apps/KimiCU.app/Contents/MacOS/kimi-cu';
    const kimiHomeDir = '/kimi-home';
    const plugins = fakePlugins([
      {
        id: 'kimi-cu',
        enabled: true,
        state: 'ok',
        version: '1.2.3',
        mcpServerCount: 2,
        enabledMcpServerCount: 1,
      },
    ]);
    const host = fakeProcess([
      {
        match: 'xpc-ping',
        code: 0,
        stdout: 'permissions: accessibility=true screenRecording=false',
      },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({
        applicationsDir: '/apps',
        kimiHomeDir,
        plugins: plugins.port,
        hostProcess: host.port,
        fs: fakeFs([appBin, `${kimiHomeDir}/mcp.json`], {
          [appBin]: '#!/bin/sh\n',
          [`${kimiHomeDir}/mcp.json`]: `${JSON.stringify({
            mcpServers: { 'kimi-cu': { command: appBin, args: ['mcp'] } },
          })}\n`,
        }),
      }),
    );

    const detected = await entry.detect();
    expect(detected.version).toBe('1.2.3');
    expect(detected.steps).toEqual([
      { id: 'plugin', state: 'missing', detail: 'mcp 1/2 enabled' },
      {
        id: 'legacy-mcp',
        state: 'missing',
        detail: 'duplicate standalone kimi-cu MCP registration',
        optional: true,
      },
      { id: 'app', state: 'missing', detail: 'not executable' },
      { id: 'service', state: 'missing' },
      { id: 'permissions', state: 'missing', detail: 'screenRecording' },
    ]);
  });

  it('marks probe steps failed instead of throwing when the binary is wedged', async () => {
    const appBin = '/apps/KimiCU.app/Contents/MacOS/kimi-cu';
    const infoPlist = '/apps/KimiCU.app/Contents/Info.plist';
    const host = fakeProcess([
      { match: 'service-status', code: 0, hang: true },
      { match: 'xpc-ping', code: 0, hang: true },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({
        applicationsDir: '/apps',
        detectProbeTimeoutMs: 10,
        hostProcess: host.port,
        fs: fakeFs([appBin, infoPlist], {
          [infoPlist]: '<key>CFBundleShortVersionString</key>\n<string>0.5.4</string>',
        }),
      }),
    );

    const detected = await entry.detect();
    expect(detected.steps).toContainEqual({
      id: 'service',
      state: 'failed',
      detail: `command timed out after 10ms: ${appBin}`,
    });
    expect(detected.steps).toContainEqual({
      id: 'permissions',
      state: 'failed',
      detail: `command timed out after 10ms: ${appBin}`,
    });
  });

  it('detects the Windows plugin and runtime through the PowerShell doctor', async () => {
    const plugins = fakePlugins([{ id: 'kimi-cu-win', enabled: true, state: 'ok', version: '0.2.14' }]);
    const doctor = 'version=0.2.14\r\nmcp=true\r\nhelper=embedded\r\nagent=running\r\n';
    const host = fakeProcess([{ match: '-Command', code: 0, stdout: doctor }]);
    const entry = createKimiCuEntry(
      makeCtx({ platform: 'win32', arch: 'x64', plugins: plugins.port, hostProcess: host.port }),
    );

    await expect(entry.detect()).resolves.toEqual({
      version: '0.2.14',
      steps: [
        { id: 'plugin', state: 'ok', detail: '0.2.14' },
        { id: 'runtime', state: 'ok', detail: '0.2.14' },
      ],
    });
    expect(host.calls).toHaveLength(1);
    expect(host.calls[0]?.startsWith(`${windowsPowerShellPath()} -NoProfile -NonInteractive -Command `)).toBe(true);

    const missingHost = fakeProcess([{ match: '-Command', code: 3 }]);
    const missingEntry = createKimiCuEntry(
      makeCtx({ platform: 'win32', arch: 'x64', hostProcess: missingHost.port }),
    );
    const missingDetected = await missingEntry.detect();
    expect(missingDetected.steps[1]).toEqual({ id: 'runtime', state: 'missing' });
    expect(missingDetected.version).toBeUndefined();

    const fallbackHost = fakeProcess([
      { match: 'WindowsPowerShell', code: 1, stderr: 'boom' },
      { match: 'pwsh.exe', code: 0, stdout: doctor },
    ]);
    const fallbackEntry = createKimiCuEntry(
      makeCtx({ platform: 'win32', arch: 'x64', hostProcess: fallbackHost.port }),
    );
    const fallbackDetected = await fallbackEntry.detect();
    expect(fallbackDetected.steps[1]).toEqual({ id: 'runtime', state: 'ok', detail: '0.2.14' });
    expect(fallbackDetected.version).toBe('0.2.14');

    const garbageHost = fakeProcess([{ match: '-Command', code: 0, stdout: 'hello' }]);
    const garbageEntry = createKimiCuEntry(
      makeCtx({ platform: 'win32', arch: 'x64', hostProcess: garbageHost.port }),
    );
    const garbageDetected = await garbageEntry.detect();
    expect(garbageDetected.steps[1]).toEqual({
      id: 'runtime',
      state: 'failed',
      detail: 'doctor returned unexpected output',
    });
  });

  it('rejects install on unsupported platforms before any side effect', async () => {
    await expect(createKimiCuEntry(makeCtx({ platform: 'linux' })).install(() => {})).rejects.toThrow(
      'kimi-cu is only supported on macOS (current: linux)',
    );
    await expect(
      createKimiCuEntry(makeCtx({ platform: 'win32', arch: 'arm64' })).install(() => {}),
    ).rejects.toThrow('kimi-cu is only supported on macOS or Windows x64 (current: win32/arm64)');
    await expect(
      createKimiWebbridgeEntry(makeCtx({ arch: 'mips64' })).install(() => {}),
    ).rejects.toThrow('kimi-webbridge is not supported on darwin/mips64');
  });

  it('resumes a partial macOS install without repeating completed runtime layers', async () => {
    const applicationsDir = await fakeAppBundle();
    const plugins = fakePlugins([]);
    const host = fakeProcess([
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1' },
      {
        match: 'xpc-ping',
        code: 0,
        stdout: 'permissionStatus: accessibility=true screenRecording=true',
      },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({
        applicationsDir,
        plugins: plugins.port,
        hostProcess: host.port,
        fs: nodeFs(),
        fetchImpl: (() => Promise.reject(new Error('download should be skipped'))) as never,
      }),
    );
    const reports: string[] = [];

    await entry.install((step) => reports.push(step));

    expect(plugins.installs).toEqual([
      'https://cdn.kimi.com/kimi-computer-use/latest/kimi-cu-plugin.zip',
    ]);
    expect(reports).toEqual(['plugin']);
    expect(
      host.calls.every(
        (call) => call.includes('service-status') || call.includes('xpc-ping'),
      ),
    ).toBe(true);
  });

  it('migrates the exact legacy standalone MCP registration after installing the plugin', async () => {
    const applicationsDir = await fakeAppBundle();
    const appBin = join(applicationsDir, 'KimiCU.app', 'Contents', 'MacOS', 'kimi-cu');
    const kimiHomeDir = join(root, 'kimi-home');
    await mkdir(kimiHomeDir, { recursive: true });
    const configPath = join(kimiHomeDir, 'mcp.json');
    await writeFile(
      configPath,
      `${JSON.stringify({
        mcpServers: {
          'kimi-cu': { command: appBin, args: ['mcp', '-s', 'user'] },
          custom: { command: 'custom-mcp', args: [] },
        },
      })}\n`,
    );
    const plugins = fakePlugins([]);
    const host = fakeProcess([
      { match: 'service-status', code: 0, stdout: 'SMAppService status=1' },
      {
        match: 'xpc-ping',
        code: 0,
        stdout: 'permissionStatus: accessibility=true screenRecording=true',
      },
    ]);
    const entry = createKimiCuEntry(
      makeCtx({
        applicationsDir,
        kimiHomeDir,
        plugins: plugins.port,
        hostProcess: host.port,
        fs: nodeFs(),
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

    const migrated = JSON.parse(await readFile(configPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(migrated.mcpServers['kimi-cu']).toBeUndefined();
    expect(migrated.mcpServers['custom']).toEqual({ command: 'custom-mcp', args: [] });
    expect(reports).toEqual(['plugin', 'mcp-config']);
  });

  it('installs Windows with the official setup script and shared plugin wiring', async () => {
    const plugins = fakePlugins([]);
    const doctorResults = [
      { code: 3, stdout: '', stderr: '' },
      {
        code: 0,
        stdout: 'version=0.2.14\r\nmcp=true\r\nhelper=embedded\r\nagent=running\r\n',
        stderr: '',
      },
    ];
    const calls: string[] = [];
    const hostProcess: OsProcessPort = {
      spawn: (command, args = []) => {
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
            fakeProc(result?.code ?? 1, result?.stdout ?? '', result?.stderr ?? 'unexpected doctor'),
          );
        }
        return Promise.resolve(fakeProc(1));
      },
    };
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
        plugins: plugins.port,
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
});

describe('kimi-webbridge entry', () => {
  it('detects the daemon, skill plugin, standalone skill migration and extension states', async () => {
    const userHome = '/home/user';
    const kimiHome = '/kimi-home';
    const binPath = `${userHome}/.kimi-webbridge/bin/kimi-webbridge`;
    const plugins = fakePlugins([{ id: 'kimi-webbridge', enabled: true, state: 'ok', version: '1.11.3' }]);
    const fetchImpl = (async (url: string | URL) => {
      if (String(url) === 'http://127.0.0.1:10086/status') {
        return new Response(
          JSON.stringify({ running: true, version: '1.11.3', extension_connected: true }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }) as typeof fetch;
    const entry = createKimiWebbridgeEntry(
      makeCtx({
        kimiHomeDir: kimiHome,
        userHomeDir: userHome,
        plugins: plugins.port,
        fetchImpl,
        fs: fakeFs(
          [
            binPath,
            `${kimiHome}/skills/kimi-webbridge`,
            `${userHome}/.agents/skills/kimi-webbridge`,
          ],
          { [binPath]: '#!/bin/sh\n' },
        ),
      }),
    );

    await expect(entry.detect()).resolves.toEqual({
      version: '1.11.3',
      steps: [
        { id: 'daemon-binary', state: 'ok' },
        { id: 'daemon', state: 'ok', detail: '1.11.3' },
        { id: 'skill', state: 'ok', detail: '1.11.3' },
        {
          id: 'standalone-skill-migration',
          state: 'missing',
          detail: `${kimiHome}/skills/kimi-webbridge, ${userHome}/.agents/skills/kimi-webbridge`,
          optional: true,
        },
        { id: 'extension', state: 'ok', optional: true },
      ],
    });
  });

  it('reports a bare webbridge machine with the migration backup recorded', async () => {
    const userHome = '/home/user';
    const kimiHome = '/kimi-home';
    const plugins = fakePlugins([
      {
        id: 'kimi-webbridge',
        enabled: true,
        state: 'ok',
        version: '1.11.3',
        mcpServerCount: 2,
        enabledMcpServerCount: 1,
      },
    ]);
    const fetchImpl = (async () => {
      throw new Error('connection refused');
    }) as typeof fetch;
    const entry = createKimiWebbridgeEntry(
      makeCtx({
        kimiHomeDir: kimiHome,
        userHomeDir: userHome,
        plugins: plugins.port,
        fetchImpl,
        fs: fakeFs([`${kimiHome}/backups/kimi-webbridge-skills`]),
      }),
    );

    await expect(entry.detect()).resolves.toEqual({
      steps: [
        { id: 'daemon-binary', state: 'missing' },
        { id: 'daemon', state: 'missing' },
        { id: 'skill', state: 'missing', detail: 'mcp 1/2 enabled' },
        {
          id: 'standalone-skill-migration',
          state: 'ok',
          detail: `${kimiHome}/backups/kimi-webbridge-skills`,
          optional: true,
        },
        { id: 'extension', state: 'missing', optional: true },
      ],
    });
  });

  it('installs the binary, starts the daemon, wires the skill plugin and migrates standalone skills', async () => {
    const userHome = join(root, 'user-home');
    const kimiHome = join(root, 'kimi-home');
    const binPath = join(userHome, '.kimi-webbridge', 'bin', 'kimi-webbridge');
    await mkdir(join(kimiHome, 'skills', 'kimi-webbridge'), { recursive: true });
    await mkdir(join(userHome, '.agents', 'skills', 'kimi-webbridge'), { recursive: true });
    const plugins = fakePlugins([]);
    const host = fakeProcess([{ match: 'start', code: 0 }]);
    let statusCalls = 0;
    const statuses: Array<object | 'error'> = [
      'error',
      'error',
      { running: true, version: '9.9.9', extension_connected: false },
    ];
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      if (u === 'http://127.0.0.1:10086/status') {
        const step = statuses[Math.min(statusCalls, statuses.length - 1)];
        statusCalls += 1;
        if (step === 'error') throw new Error('connection refused');
        return new Response(JSON.stringify(step), { status: 200 });
      }
      if (u === 'https://cdn.kimi.com/webbridge/latest/releases/kimi-webbridge-darwin-arm64') {
        const bytes = new Uint8Array([1, 2, 3, 4]);
        return new Response(bytes, {
          status: 200,
          headers: { 'content-length': String(bytes.length) },
        });
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as typeof fetch;
    const entry = createKimiWebbridgeEntry(
      makeCtx({
        kimiHomeDir: kimiHome,
        userHomeDir: userHome,
        plugins: plugins.port,
        hostProcess: host.port,
        fetchImpl,
        fs: nodeFs(),
        resolveRegion: () => 'mainland-cn',
      }),
    );
    const reports: Array<[string, number | undefined]> = [];

    const note = await entry.install((step, percent) => reports.push([step, percent]));

    expect(note).toBe('user-skill-migrated');
    expect(await readFile(binPath)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(plugins.installs).toEqual([
      'https://code.kimi.com/kimi-code/plugins/official/kimi-webbridge.zip',
    ]);
    expect(host.calls).toEqual([`${binPath} start`]);
    expect(reports).toContainEqual(['download', 0]);
    expect(reports).toContainEqual(['download', 100]);
    expect([...new Set(reports.map(([step]) => step))]).toEqual([
      'download',
      'daemon',
      'skill',
      'standalone-skill-migration',
    ]);
    const backupRoot = join(kimiHome, 'backups', 'kimi-webbridge-skills');
    const migrated = await stat(join(backupRoot));
    expect(migrated.isDirectory()).toBe(true);
    await expect(stat(join(kimiHome, 'skills', 'kimi-webbridge'))).rejects.toThrow();
  });
});
