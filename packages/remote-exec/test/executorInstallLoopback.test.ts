import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  CdnExecutorArtifactLocator,
  releaseTargetKey,
} from '../src/client/artifactLocator';
import {
  ExecutorInstallError,
  installExecutor,
} from '../src/client/executorInstaller';

// Local-loopback install: fake `ssh`/`scp` binaries on PATH map the "remote"
// onto a local directory (FAKE_REMOTE_HOME), so the REAL defaultLocalRunner,
// the REAL CdnExecutorArtifactLocator over a real HTTP server, the REAL
// download+sha256 verification and the REAL tmp+rename all run unmocked.

const HOST_OS_KIND = process.platform === 'darwin' ? 'macOS' : process.platform === 'linux' ? 'Linux' : undefined;
const HOST_TARGET =
  HOST_OS_KIND === undefined ? undefined : releaseTargetKey({ osKind: HOST_OS_KIND, osArch: process.arch });

const EXECUTOR_STUB = `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then echo "1.2.3"; exit 0; fi
exit 2
`;

const FAKE_SSH = `#!/usr/bin/env bash
cmd="\${@: -1}"
HOME="$FAKE_REMOTE_HOME" sh -c "$cmd"
`;

const FAKE_SCP = `#!/usr/bin/env bash
# SFTP-protocol semantics: the remote path is used verbatim — no shell, no
# expansion (OpenSSH ≥ 9.0 default). A target like "$HOME"/... must fail here.
args=("$@")
src="\${args[-2]}"
dst="\${args[-1]}"
remote="\${dst#*:}"
cp "$src" "$remote"
`;

interface LoopbackContext {
  readonly remoteHome: string;
  readonly cdnBaseUrl: string;
  readonly filename: string;
  readonly cleanup: () => Promise<void>;
}

async function startLoopback(options: {
  readonly manifestSha256?: string;
  readonly target: string;
}): Promise<LoopbackContext> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-install-loopback-'));
  const remoteHome = join(root, 'remote-home');
  const fakeBin = join(root, 'bin');
  await mkdir(remoteHome, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(fakeBin, 'ssh'), FAKE_SSH, { mode: 0o755 });
  await writeFile(join(fakeBin, 'scp'), FAKE_SCP, { mode: 0o755 });

  const filename = `kimi-code-${options.target}`;
  const sha256 = options.manifestSha256 ?? createHash('sha256').update(EXECUTOR_STUB).digest('hex');
  const manifest = JSON.stringify({
    version: '1.2.3',
    tag: 'v1.2.3',
    platforms: { [options.target]: { filename, checksum: sha256 } },
  });
  const server: Server = createServer((req, res) => {
    if (req.url === '/binaries/1.2.3/manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(manifest);
      return;
    }
    if (req.url === `/binaries/1.2.3/${filename}`) {
      res.writeHead(200).end(EXECUTOR_STUB);
      return;
    }
    res.writeHead(404).end('not found');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address !== 'object') {
    throw new Error('loopback server has no address');
  }

  vi.stubEnv('PATH', `${fakeBin}:${process.env['PATH'] ?? ''}`);
  vi.stubEnv('FAKE_REMOTE_HOME', remoteHome);

  return {
    remoteHome,
    cdnBaseUrl: `http://127.0.0.1:${String(address.port)}`,
    filename,
    cleanup: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe.skipIf(HOST_TARGET === undefined)('installExecutor — local loopback', () => {
  const contexts: LoopbackContext[] = [];
  const target = HOST_TARGET as string;

  afterAll(async () => {
    vi.unstubAllEnvs();
    await Promise.all(contexts.map((context) => context.cleanup()));
  });

  it('installs end-to-end: probe, verified download, scp, atomic rename, post-check', async () => {
    const context = await startLoopback({ target });
    contexts.push(context);
    const locator = new CdnExecutorArtifactLocator({ cdnBaseUrl: context.cdnBaseUrl });
    const progress: string[] = [];

    const result = await installExecutor({
      launcher: { type: 'ssh', host: 'loopback' },
      locator,
      version: '1.2.3',
      onProgress: (line) => {
        progress.push(line);
      },
    });

    expect(result).toEqual({
      remoteBin: '~/.kimi-code/bin/kimi',
      version: '1.2.3',
      target,
      alreadyInstalled: false,
    });
    const installed = join(context.remoteHome, '.kimi-code', 'bin', 'kimi');
    expect((await stat(installed)).isFile()).toBe(true);
    expect(await readFile(installed, 'utf8')).toBe(EXECUTOR_STUB);
    const dirEntries = await readdir(join(context.remoteHome, '.kimi-code', 'bin'));
    expect(dirEntries).toEqual(['kimi']);
    expect(progress.some((line) => line.includes('verified sha256'))).toBe(true);

    const again = await installExecutor({
      launcher: { type: 'ssh', host: 'loopback' },
      locator,
      version: '1.2.3',
    });
    expect(again.alreadyInstalled).toBe(true);
  });

  it('rejects a tampered checksum and leaves no executor behind', async () => {
    const context = await startLoopback({
      target,
      manifestSha256: '0'.repeat(64),
    });
    contexts.push(context);
    const locator = new CdnExecutorArtifactLocator({ cdnBaseUrl: context.cdnBaseUrl });

    const error = await installExecutor({
      launcher: { type: 'ssh', host: 'loopback' },
      locator,
      version: '1.2.3',
    }).catch((installError: unknown) => installError);

    expect(error).toBeInstanceOf(ExecutorInstallError);
    expect((error as ExecutorInstallError).step).toBe('download');
    expect((error as ExecutorInstallError).message).toContain('checksum mismatch');
    await expect(stat(join(context.remoteHome, '.kimi-code', 'bin', 'kimi'))).rejects.toThrow();
  });
});
