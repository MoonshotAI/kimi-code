import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import type { ExecutorArtifact, ExecutorArtifactLocator } from '../src/client/artifactLocator';
import {
  ExecutorInstallError,
  installExecutor,
  type LocalRunner,
  type LocalRunRequest,
  type LocalRunResult,
} from '../src/client/executorInstaller';
import type { LauncherSpec } from '../src/client/launchers';

const SSH_PREFIX = [
  '-T',
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=3',
  '-o',
  'StrictHostKeyChecking=accept-new',
];
const SCP_PREFIX = SSH_PREFIX.slice(1);

const BINARY_BYTES = new TextEncoder().encode('fake-kimi-sea-binary\n');
const ARTIFACT: ExecutorArtifact = {
  version: '1.2.3',
  filename: 'kimi-code-linux-x64',
  url: 'https://cdn.example.test/binaries/1.2.3/kimi-code-linux-x64',
  sha256: createHash('sha256').update(BINARY_BYTES).digest('hex'),
};

function goodFetch(): typeof fetch {
  return vi.fn(async () => new Response(BINARY_BYTES, { status: 200 })) as unknown as typeof fetch;
}

function fixedLocator(artifact: ExecutorArtifact = ARTIFACT): ExecutorArtifactLocator {
  return { locate: vi.fn(async () => artifact) };
}

function ok(partial: Partial<LocalRunResult> = {}): LocalRunResult {
  return { code: 0, signal: null, stdout: '', stderr: '', ...partial };
}

function failed(code: number, stderr: string): LocalRunResult {
  return { code, signal: null, stdout: '', stderr };
}

interface RecordedRequest {
  readonly program: string;
  readonly args: readonly string[];
}

interface FakeRemoteOptions {
  readonly uname?: string;
  readonly home?: string;
  readonly preinstalled?: string;
  readonly versionAfterInstall?: string;
  readonly fail?: Partial<
    Record<'probe' | 'prepare' | 'upload' | 'activate' | 'version', LocalRunResult>
  >;
}

// A stateful fake of the target: the executor becomes runnable only after the
// activate step succeeds, mirroring what a real ssh host / container does.
function createFakeRunner(options: FakeRemoteOptions = {}): {
  runner: LocalRunner;
  requests: RecordedRequest[];
  uploaded: () => RecordedRequest[];
  uploadedBytes: Buffer[];
} {
  const requests: RecordedRequest[] = [];
  const uploadedBytes: Buffer[] = [];
  let installedVersion = options.preinstalled;
  const uname = options.uname ?? 'Linux x86_64';
  const runner: LocalRunner = async (request: LocalRunRequest) => {
    requests.push({ program: request.program, args: request.args });
    const fail = options.fail;
    const last = request.args.at(-1) ?? '';
    if (request.program === 'ssh') {
      if (last === 'uname -sm') return fail?.probe ?? ok({ stdout: `${uname}\n` });
      if (last.endsWith('--version')) {
        if (fail?.version !== undefined) return fail.version;
        return installedVersion === undefined
          ? failed(127, 'kimi: command not found')
          : ok({ stdout: `${installedVersion}\n` });
      }
      if (last.startsWith('mkdir -p')) return fail?.prepare ?? ok();
      if (last.startsWith('chmod 755')) {
        if (fail?.activate !== undefined) return fail.activate;
        installedVersion = options.versionAfterInstall ?? ARTIFACT.version;
        return ok();
      }
      if (last.startsWith('rm -f')) return ok();
    }
    if (request.program === 'scp') {
      if (fail?.upload !== undefined) return fail.upload;
      const sourcePath = request.args.at(-2);
      if (sourcePath !== undefined) uploadedBytes.push(await readFile(sourcePath));
      return ok();
    }
    if (request.program === 'docker') {
      const args = request.args;
      if (args.includes('cp')) return fail?.upload ?? ok();
      if (args.some((arg) => arg.includes('uname -sm'))) {
        return fail?.probe ?? ok({ stdout: `${uname}\n${options.home ?? '/root'}` });
      }
      if (args.includes('--version')) {
        if (fail?.version !== undefined) return fail.version;
        return installedVersion === undefined
          ? failed(126, 'executable file not found')
          : ok({ stdout: `${installedVersion}\n` });
      }
      if (args.includes('mkdir')) return fail?.prepare ?? ok();
      if (args.some((arg) => arg.startsWith('chmod 755'))) {
        if (fail?.activate !== undefined) return fail.activate;
        installedVersion = options.versionAfterInstall ?? ARTIFACT.version;
        return ok();
      }
      if (args.includes('rm')) return ok();
    }
    throw new Error(`unexpected request: ${request.program} ${request.args.join(' ')}`);
  };
  return {
    runner,
    requests,
    uploaded: () => requests.filter((r) => r.program === 'scp' || r.args.includes('cp')),
    uploadedBytes,
  };
}

const SSH: LauncherSpec & { readonly type: 'ssh' } = { type: 'ssh', host: 'dev-box' };
const DOCKER: LauncherSpec & { readonly type: 'docker' } = { type: 'docker', container: 'myapp-dev' };

function installOptions(
  launcher: LauncherSpec & { readonly type: 'ssh' | 'docker' },
  runner: LocalRunner,
  overrides: Record<string, unknown> = {},
) {
  return {
    launcher,
    runner,
    locator: fixedLocator(),
    fetchImpl: goodFetch(),
    version: '1.2.3',
    ...overrides,
  };
}

describe('installExecutor — ssh', () => {
  it('installs via probe, verified download, scp to a tmp path, then atomic chmod+rename', async () => {
    const fake = createFakeRunner();
    const progress: string[] = [];
    const result = await installExecutor({
      ...installOptions(SSH, fake.runner),
      onProgress: (line) => {
        progress.push(line);
      },
    });

    expect(result).toEqual({
      remoteBin: '~/.kimi-code/bin/kimi',
      version: '1.2.3',
      target: 'linux-x64',
      alreadyInstalled: false,
    });

    const [probe, existing, prepare, upload, activate, postCheck] = fake.requests;
    expect(probe).toEqual({ program: 'ssh', args: [...SSH_PREFIX, 'dev-box', 'uname -sm'] });
    expect(existing).toEqual({
      program: 'ssh',
      args: [...SSH_PREFIX, 'dev-box', '"$HOME"/.kimi-code/bin/kimi --version'],
    });
    expect(prepare).toEqual({
      program: 'ssh',
      args: [...SSH_PREFIX, 'dev-box', 'mkdir -p "$HOME"/.kimi-code/bin'],
    });

    expect(upload!.program).toBe('scp');
    const scpTarget = upload!.args.at(-1)!;
    expect(scpTarget).toMatch(
      /^dev-box:"\$HOME"\/\.kimi-code\/bin\/\.kimi-install-[0-9a-f-]{36}$/,
    );
    const scpSource = upload!.args.at(-2)!;
    expect(fake.uploadedBytes).toHaveLength(1);
    expect(Buffer.compare(fake.uploadedBytes[0]!, Buffer.from(BINARY_BYTES))).toBe(0);
    await expect(stat(scpSource)).rejects.toThrow();

    const tmpExpr = scpTarget.slice('dev-box:'.length);
    expect(activate).toEqual({
      program: 'ssh',
      args: [
        ...SSH_PREFIX,
        'dev-box',
        `chmod 755 ${tmpExpr} && mv -f ${tmpExpr} "$HOME"/.kimi-code/bin/kimi`,
      ],
    });
    expect(postCheck).toEqual({
      program: 'ssh',
      args: [...SSH_PREFIX, 'dev-box', '"$HOME"/.kimi-code/bin/kimi --version'],
    });
    expect(progress.some((line) => line.includes('verified sha256'))).toBe(true);
  });

  it('shell-quotes a custom remoteBin in every remote command', async () => {
    const fake = createFakeRunner();
    const launcher: LauncherSpec & { readonly type: 'ssh' } = {
      type: 'ssh',
      host: 'dev-box',
      remoteBin: '/opt/kimi/bin/kimi',
    };
    const result = await installExecutor(installOptions(launcher, fake.runner));

    expect(result.remoteBin).toBe('/opt/kimi/bin/kimi');
    const [, existing, prepare, upload, activate] = fake.requests;
    expect(existing!.args.at(-1)).toBe(`'/opt/kimi/bin/kimi' --version`);
    expect(prepare!.args.at(-1)).toBe(`mkdir -p '/opt/kimi/bin'`);
    const scpTarget = upload!.args.at(-1)!;
    expect(scpTarget).toMatch(/^dev-box:'\/opt\/kimi\/bin\/\.kimi-install-[0-9a-f-]{36}'$/);
    const tmpExpr = scpTarget.slice('dev-box:'.length);
    expect(activate!.args.at(-1)).toBe(
      `chmod 755 ${tmpExpr} && mv -f ${tmpExpr} '/opt/kimi/bin/kimi'`,
    );
  });

  it('skips the install when a usable executor is already present', async () => {
    const fake = createFakeRunner({ preinstalled: '1.2.3' });
    const locator = fixedLocator();
    const fetchImpl = goodFetch();
    const result = await installExecutor({
      ...installOptions(SSH, fake.runner),
      locator,
      fetchImpl,
    });

    expect(result.alreadyInstalled).toBe(true);
    expect(result.version).toBe('1.2.3');
    expect(locator.locate).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fake.uploaded()).toEqual([]);
  });

  it('reinstalls when the installed executor is below the minimum', async () => {
    const fake = createFakeRunner({ preinstalled: '0.0.1' });
    const result = await installExecutor(installOptions(SSH, fake.runner));

    expect(result.alreadyInstalled).toBe(false);
    expect(result.version).toBe('1.2.3');
    expect(fake.uploaded()).toHaveLength(1);
  });
});

describe('installExecutor — docker', () => {
  it('installs via docker cp into the container-user absolute home path', async () => {
    const fake = createFakeRunner({ home: '/root' });
    const result = await installExecutor(installOptions(DOCKER, fake.runner));

    expect(result).toEqual({
      remoteBin: '/root/.kimi-code/bin/kimi',
      version: '1.2.3',
      target: 'linux-x64',
      alreadyInstalled: false,
    });

    const [probe, existing, prepare, upload, activate, postCheck] = fake.requests;
    expect(probe).toEqual({
      program: 'docker',
      args: ['exec', 'myapp-dev', 'sh', '-c', 'uname -sm; printf "\\n%s" "$HOME"'],
    });
    expect(existing).toEqual({
      program: 'docker',
      args: ['exec', 'myapp-dev', '/root/.kimi-code/bin/kimi', '--version'],
    });
    expect(prepare).toEqual({
      program: 'docker',
      args: ['exec', 'myapp-dev', 'mkdir', '-p', '/root/.kimi-code/bin'],
    });
    expect(upload).toEqual({
      program: 'docker',
      args: [
        'cp',
        expect.stringMatching(/kimi-code-linux-x64$/) as unknown as string,
        expect.stringMatching(/^myapp-dev:\/root\/\.kimi-code\/bin\/\.kimi-install-[0-9a-f-]{36}$/) as unknown as string,
      ],
    });
    const tmpPath = (upload!.args.at(-1)!).slice('myapp-dev:'.length);
    expect(activate).toEqual({
      program: 'docker',
      args: [
        'exec',
        'myapp-dev',
        'sh',
        '-c',
        'chmod 755 "$1" && mv -f "$1" "$2"',
        'kimi-install',
        tmpPath,
        '/root/.kimi-code/bin/kimi',
      ],
    });
    expect(postCheck).toEqual({
      program: 'docker',
      args: ['exec', 'myapp-dev', '/root/.kimi-code/bin/kimi', '--version'],
    });
  });

  it('honors the docker context on every docker invocation', async () => {
    const fake = createFakeRunner();
    const launcher: LauncherSpec & { readonly type: 'docker' } = {
      type: 'docker',
      container: 'myapp-dev',
      context: 'orbstack',
    };
    await installExecutor(installOptions(launcher, fake.runner));

    expect(fake.requests.length).toBeGreaterThan(0);
    for (const request of fake.requests) {
      expect(request.args.slice(0, 2)).toEqual(['--context', 'orbstack']);
    }
  });

  it('uses a custom remoteBin literally without tilde assumptions', async () => {
    const fake = createFakeRunner();
    const launcher: LauncherSpec & { readonly type: 'docker' } = {
      type: 'docker',
      container: 'myapp-dev',
      remoteBin: '/usr/local/bin/kimi',
    };
    const result = await installExecutor(installOptions(launcher, fake.runner));

    expect(result.remoteBin).toBe('/usr/local/bin/kimi');
    const [, existing, prepare, upload] = fake.requests;
    expect(existing).toEqual({
      program: 'docker',
      args: ['exec', 'myapp-dev', '/usr/local/bin/kimi', '--version'],
    });
    expect(prepare).toEqual({
      program: 'docker',
      args: ['exec', 'myapp-dev', 'mkdir', '-p', '/usr/local/bin'],
    });
    expect(upload!.args.at(-1)).toMatch(
      /^myapp-dev:\/usr\/local\/bin\/\.kimi-install-[0-9a-f-]{36}$/,
    );
  });
});

describe('installExecutor — failure diagnosability', () => {
  it('names the step, argv and stderr when the probe fails', async () => {
    const fake = createFakeRunner({
      fail: { probe: failed(255, 'ssh: connect to host dev-box port 22: Connection refused') },
    });
    const error = await installExecutor(installOptions(SSH, fake.runner)).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(ExecutorInstallError);
    const installError = error as ExecutorInstallError;
    expect(installError.step).toBe('probe');
    expect(installError.message).toContain('Connection refused');
    expect(installError.message).toContain('uname -sm');
  });

  it('fails at the download step on a checksum mismatch before any upload', async () => {
    const fake = createFakeRunner();
    const badArtifact = { ...ARTIFACT, sha256: '0'.repeat(64) };
    const error = await installExecutor({
      ...installOptions(SSH, fake.runner),
      locator: fixedLocator(badArtifact),
    }).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(ExecutorInstallError);
    const installError = error as ExecutorInstallError;
    expect(installError.step).toBe('download');
    expect(installError.message).toContain('checksum mismatch');
    expect(installError.artifact).toEqual(badArtifact);
    expect(fake.uploaded()).toEqual([]);
    expect(fake.requests.some((r) => r.args.some((a) => a.startsWith('chmod')))).toBe(false);
  });

  it('fails at the upload step when scp fails and cleans up the remote tmp file', async () => {
    const fake = createFakeRunner({ fail: { upload: failed(1, 'scp: write failed: disk full') } });
    const error = await installExecutor(installOptions(SSH, fake.runner)).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(ExecutorInstallError);
    const installError = error as ExecutorInstallError;
    expect(installError.step).toBe('upload');
    expect(installError.message).toContain('disk full');
    const cleanup = fake.requests.find(
      (r) => r.program === 'ssh' && (r.args.at(-1) ?? '').startsWith('rm -f'),
    );
    expect(cleanup).toBeDefined();
    expect(cleanup!.args.at(-1)).toMatch(/\.kimi-install-/);
    expect(fake.requests.some((r) => (r.args.at(-1) ?? '').startsWith('chmod'))).toBe(false);
  });

  it('fails at the activate step when the remote chmod/mv fails', async () => {
    const fake = createFakeRunner({
      fail: { activate: failed(1, 'mv: cannot move: permission denied') },
    });
    const error = await installExecutor(installOptions(SSH, fake.runner)).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(ExecutorInstallError);
    expect((error as ExecutorInstallError).step).toBe('activate');
    expect((error as ExecutorInstallError).message).toContain('permission denied');
  });

  it('fails at the post-check step when the installed binary cannot run', async () => {
    const fake = createFakeRunner({ fail: { version: failed(127, 'kimi: command not found') } });
    const error = await installExecutor(installOptions(SSH, fake.runner)).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(ExecutorInstallError);
    const installError = error as ExecutorInstallError;
    expect(installError.step).toBe('post-check');
    expect(installError.message).toContain('failed to run');
  });

  it('fails at the post-check step when the installed version is below the minimum', async () => {
    const fake = createFakeRunner({ versionAfterInstall: '0.0.1' });
    const error = await installExecutor(installOptions(SSH, fake.runner)).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(ExecutorInstallError);
    const installError = error as ExecutorInstallError;
    expect(installError.step).toBe('post-check');
    expect(installError.message).toContain('below the minimum');
  });

  it('fails at the probe step for an unsupported target platform', async () => {
    const fake = createFakeRunner({ uname: 'FreeBSD x86_64' });
    const error = await installExecutor(installOptions(SSH, fake.runner)).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(ExecutorInstallError);
    expect((error as ExecutorInstallError).step).toBe('probe');
    expect((error as ExecutorInstallError).message).toContain('unsupported or unrecognized target');
  });

  it('fails at the probe step when the container home cannot be determined', async () => {
    const fake = createFakeRunner({ home: '' });
    const error = await installExecutor(installOptions(DOCKER, fake.runner)).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(ExecutorInstallError);
    const installError = error as ExecutorInstallError;
    expect(installError.step).toBe('probe');
    expect(installError.message).toContain('home directory');
  });
});
