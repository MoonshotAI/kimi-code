import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { ExecutorArtifact, ExecutorArtifactLocator } from '../src/client/artifactLocator';
import { CdnExecutorArtifactLocator } from '../src/client/artifactLocator';
import {
  classifyHandshakeFailure,
  connectWithGuidance,
  missingExecutorGuidance,
  upgradeExecutorGuidance,
} from '../src/client/connectGuidance';
import { HandshakeError } from '../src/client/connection';
import type { LocalRunner, LocalRunRequest } from '../src/client/executorDetect';
import type { LauncherSpec } from '../src/client/launchers';

const SSH: LauncherSpec = { type: 'ssh', host: 'dev-box' };
const DOCKER: LauncherSpec = { type: 'docker', container: 'myapp-dev' };
const COMMAND: LauncherSpec = {
  type: 'command',
  program: '/usr/bin/sandbox',
  args: ['ssh', 'i-1', '--', '/home/me/.kimi-code/bin/kimi', 'exec-server', '--listen', 'stdio'],
};

const BINARY_BYTES = new TextEncoder().encode('fake-kimi-sea-binary\n');
const ARTIFACT: ExecutorArtifact = {
  version: '1.2.3',
  filename: 'kimi-code-linux-x64',
  url: 'https://cdn.example.test/binaries/1.2.3/kimi-code-linux-x64',
  sha256: createHash('sha256').update(BINARY_BYTES).digest('hex'),
};

function fixedLocator(): ExecutorArtifactLocator & { locate: ReturnType<typeof vi.fn> } {
  return { locate: vi.fn(async () => ARTIFACT) };
}

function unameRunner(stdout = 'Linux x86_64\n/home/test\n'): { runner: LocalRunner; requests: LocalRunRequest[] } {
  const requests: LocalRunRequest[] = [];
  const runner: LocalRunner = async (request: LocalRunRequest) => {
    requests.push(request);
    return { code: 0, signal: null, stdout, stderr: '' };
  };
  return { runner, requests };
}

function missingExecutorError(exitCode: number | null = 127): HandshakeError {
  return new HandshakeError(
    `executor process exited before the handshake completed (code ${exitCode ?? 'null'}, signal null): kimi: command not found`,
    { kind: 'executor-exit', exitCode },
  );
}

function incompatibleError(): HandshakeError {
  return new HandshakeError(
    'executor version 0.0.4 is below the minimum 0.1.0; upgrade the remote executor (kimi exec-server) and retry',
    { kind: 'incompatible', executorVersion: '0.0.4', minExecutorVersion: '0.1.0' },
  );
}

describe('classifyHandshakeFailure', () => {
  it('classifies executor exits by code', () => {
    expect(classifyHandshakeFailure(missingExecutorError(127))).toBe('missing');
    expect(classifyHandshakeFailure(missingExecutorError(126))).toBe('missing');
    expect(classifyHandshakeFailure(missingExecutorError(255))).toBe('other');
    expect(classifyHandshakeFailure(missingExecutorError(null))).toBe('other');
  });

  it('classifies timeouts and version gates', () => {
    expect(
      classifyHandshakeFailure(
        new HandshakeError('initialize timed out after 10000ms', { kind: 'timeout' }),
      ),
    ).toBe('timeout');
    expect(classifyHandshakeFailure(incompatibleError())).toBe('incompatible');
  });

  it('treats plain errors and kind-less handshake errors as other', () => {
    expect(classifyHandshakeFailure(new Error('boom'))).toBe('other');
    expect(classifyHandshakeFailure(new HandshakeError('initialize response must be an object'))).toBe(
      'other',
    );
  });
});

describe('connectWithGuidance', () => {
  it('returns immediately when the first attempt succeeds', async () => {
    const runner = vi.fn() as unknown as LocalRunner;
    const attempt = vi.fn(async () => 'connected');

    const result = await connectWithGuidance(attempt, { launcher: SSH, runner });

    expect(result).toBe('connected');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(runner).not.toHaveBeenCalled();
  });

  it('fails a missing ssh executor with concrete install commands and never copies anything', async () => {
    const fake = unameRunner();
    const locator = fixedLocator();
    const attempt = vi.fn(async () => {
      throw missingExecutorError();
    });

    const error = await connectWithGuidance(attempt, {
      launcher: SSH,
      artifactLocator: locator,
      clientVersion: '1.2.3',
      runner: fake.runner,
    }).catch((error: unknown) => error);

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(HandshakeError);
    const message = (error as Error).message;
    expect(message).toContain('was not found on ssh:dev-box');
    expect(message).toContain('expected at ~/.kimi-code/bin/kimi');
    expect(message).toContain(`Install the executor (version 1.2.3, sha256 ${ARTIFACT.sha256}):`);
    expect(message).toContain(`curl -fL ${ARTIFACT.url} -o /tmp/kimi-install`);
    expect(message).toContain('scp /tmp/kimi-install dev-box:/tmp/kimi-install');
    expect(message).toContain(
      `ssh dev-box 'mkdir -p "/home/test/.kimi-code/bin" && chmod 755 /tmp/kimi-install && mv -f /tmp/kimi-install "/home/test/.kimi-code/bin/kimi"'`,
    );
    expect(message).toContain('Then reconnect the environment.');
    expect(locator.locate).toHaveBeenCalledWith({ osKind: 'Linux', osArch: 'x64' }, '1.2.3');
    // Detection only: the uname probe is the sole remote command — no scp, no
    // chmod/mv, no download.
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.program).toBe('ssh');
    expect(fake.requests[0]?.args.at(-1)).toBe('uname -sm; printf "%s\\n" "$HOME"');
  });

  it('resolves a custom tilde remoteBin in the printed commands through the probed remote home', async () => {
    const fake = unameRunner('Linux x86_64\n/home/me\n');
    const attempt = vi.fn(async () => {
      throw missingExecutorError();
    });

    const error = await connectWithGuidance(attempt, {
      launcher: { type: 'ssh', host: 'dev-box', remoteBin: '~/bin/kimi' },
      artifactLocator: fixedLocator(),
      clientVersion: '1.2.3',
      runner: fake.runner,
    }).catch((error: unknown) => error);

    const message = (error as Error).message;
    expect(message).toContain('expected at ~/bin/kimi');
    expect(message).toContain(
      `ssh dev-box 'mkdir -p "/home/me/bin" && chmod 755 /tmp/kimi-install && mv -f /tmp/kimi-install "/home/me/bin/kimi"'`,
    );
    expect(message).not.toContain('mv -f /tmp/kimi-install "~/bin/kimi"');
  });

  it('spells the destination through "$HOME" when the probe reports no home', async () => {
    const fake = unameRunner('Linux x86_64\n');
    const attempt = vi.fn(async () => {
      throw missingExecutorError();
    });

    const error = await connectWithGuidance(attempt, {
      launcher: SSH,
      artifactLocator: fixedLocator(),
      clientVersion: '1.2.3',
      runner: fake.runner,
    }).catch((error: unknown) => error);

    expect((error as Error).message).toContain(
      `ssh dev-box 'mkdir -p "$HOME/.kimi-code/bin" && chmod 755 /tmp/kimi-install && mv -f /tmp/kimi-install "$HOME/.kimi-code/bin/kimi"'`,
    );
  });

  it('targets a custom ssh remoteBin in the printed commands', async () => {
    const fake = unameRunner();
    const attempt = vi.fn(async () => {
      throw missingExecutorError();
    });

    const error = await connectWithGuidance(attempt, {
      launcher: { type: 'ssh', host: 'dev-box', remoteBin: '/opt/kimi/bin/kimi' },
      artifactLocator: fixedLocator(),
      clientVersion: '1.2.3',
      runner: fake.runner,
    }).catch((error: unknown) => error);

    const message = (error as Error).message;
    expect(message).toContain('expected at /opt/kimi/bin/kimi');
    expect(message).toContain(
      `ssh dev-box 'mkdir -p "/opt/kimi/bin" && chmod 755 /tmp/kimi-install && mv -f /tmp/kimi-install "/opt/kimi/bin/kimi"'`,
    );
  });

  it('resolves the docker tilde remoteBin before detecting, then prints docker cp guidance', async () => {
    const requests: LocalRunRequest[] = [];
    const runner: LocalRunner = async (request: LocalRunRequest) => {
      requests.push(request);
      if (request.args.at(-1) === 'printf "%s" "$HOME"') {
        return { code: 0, signal: null, stdout: '/root', stderr: '' };
      }
      if (request.args.at(-1) === 'uname -sm; printf "%s\\n" "$HOME"') {
        return { code: 0, signal: null, stdout: 'Linux x86_64\n/root\n', stderr: '' };
      }
      throw new Error(`unexpected probe: ${request.args.join(' ')}`);
    };
    const attempt = vi.fn(async () => {
      throw missingExecutorError(126);
    });

    const error = await connectWithGuidance(attempt, {
      launcher: DOCKER,
      artifactLocator: fixedLocator(),
      clientVersion: '1.2.3',
      runner,
    }).catch((error: unknown) => error);

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledWith({ ...DOCKER, remoteBin: '/root/.kimi-code/bin/kimi' });
    const message = (error as Error).message;
    expect(message).toContain('was not found on docker:myapp-dev');
    expect(message).toContain('expected at /root/.kimi-code/bin/kimi');
    expect(message).toContain('docker cp /tmp/kimi-install myapp-dev:/tmp/kimi-install');
    expect(message).toContain(
      `docker exec myapp-dev sh -c 'mkdir -p "/root/.kimi-code/bin" && chmod 755 /tmp/kimi-install && mv -f /tmp/kimi-install "/root/.kimi-code/bin/kimi"'`,
    );
    expect(message).toContain('preinstall the executor in the image');
    // Only the two probes ran — no docker cp / chmod / mv was executed.
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.args.includes('cp')).toBe(false);
    }
  });

  it('renders the docker context on the printed docker commands', async () => {
    const fake = unameRunner();
    const attempt = vi.fn(async () => {
      throw missingExecutorError(126);
    });

    const error = await connectWithGuidance(attempt, {
      launcher: { type: 'docker', container: 'myapp-dev', context: 'orbstack', remoteBin: '/usr/local/bin/kimi' },
      artifactLocator: fixedLocator(),
      clientVersion: '1.2.3',
      runner: fake.runner,
    }).catch((error: unknown) => error);

    const message = (error as Error).message;
    expect(message).toContain('docker --context orbstack cp /tmp/kimi-install myapp-dev:/tmp/kimi-install');
    expect(message).toContain(
      `docker --context orbstack exec myapp-dev sh -c 'mkdir -p "/usr/local/bin" && chmod 755 /tmp/kimi-install && mv -f /tmp/kimi-install "/usr/local/bin/kimi"'`,
    );
  });

  it('keeps the unresolved docker remoteBin in the guidance when the home probe fails', async () => {
    const requests: LocalRunRequest[] = [];
    const runner: LocalRunner = async (request: LocalRunRequest) => {
      requests.push(request);
      if (request.args.at(-1) === 'printf "%s" "$HOME"') {
        return { code: 1, signal: null, stdout: '', stderr: 'Error: No such container: myapp-dev' };
      }
      if (request.args.at(-1) === 'uname -sm; printf "%s\\n" "$HOME"') {
        return { code: 0, signal: null, stdout: 'Linux x86_64\n', stderr: '' };
      }
      throw new Error(`unexpected probe: ${request.args.join(' ')}`);
    };
    const attempt = vi.fn(async () => {
      throw missingExecutorError(126);
    });

    const error = await connectWithGuidance(attempt, {
      launcher: DOCKER,
      artifactLocator: fixedLocator(),
      clientVersion: '1.2.3',
      runner,
    }).catch((error: unknown) => error);

    expect(attempt).toHaveBeenCalledWith(DOCKER);
    const message = (error as Error).message;
    expect(message).toContain('expected at ~/.kimi-code/bin/kimi');
    expect(message).toContain(
      `docker exec myapp-dev sh -c 'mkdir -p "$HOME/.kimi-code/bin" && chmod 755 /tmp/kimi-install && mv -f /tmp/kimi-install "$HOME/.kimi-code/bin/kimi"'`,
    );
  });

  it('falls back to generic guidance when no artifact locator is configured', async () => {
    const runner = vi.fn() as unknown as LocalRunner;
    const attempt = vi.fn(async () => {
      throw missingExecutorError();
    });

    const error = await connectWithGuidance(attempt, { launcher: SSH, runner }).catch(
      (error: unknown) => error,
    );

    const message = (error as Error).message;
    expect(message).toContain('Install the executor manually:');
    expect(message).toContain('release CDN');
    expect(message).toContain('<cdnBase>/binaries/<version>/manifest.json');
    expect(message).toContain('scp <kimi-binary> dev-box:/tmp/kimi-install');
    // No locator means no platform probe either — detection stays the connect.
    expect(runner).not.toHaveBeenCalled();
  });

  it('falls back to generic guidance when the client version is unknown', async () => {
    const runner = vi.fn() as unknown as LocalRunner;
    const attempt = vi.fn(async () => {
      throw missingExecutorError();
    });

    const error = await connectWithGuidance(attempt, {
      launcher: SSH,
      artifactLocator: fixedLocator(),
      runner,
    }).catch((error: unknown) => error);

    expect((error as Error).message).toContain('Install the executor manually:');
    expect(runner).not.toHaveBeenCalled();
  });

  it('falls back to generic guidance when the platform probe fails', async () => {
    const runner: LocalRunner = async () => ({
      code: 255,
      signal: null,
      stdout: '',
      stderr: 'ssh: connect to host dev-box port 22: Connection refused',
    });
    const attempt = vi.fn(async () => {
      throw missingExecutorError();
    });

    const error = await connectWithGuidance(attempt, {
      launcher: SSH,
      artifactLocator: fixedLocator(),
      clientVersion: '1.2.3',
      runner,
    }).catch((error: unknown) => error);

    const message = (error as Error).message;
    expect(message).toContain('Install the executor manually:');
    expect(message).toContain('code 127');
  });

  it('falls back to generic guidance when the locate fails', async () => {
    const fake = unameRunner();
    const locator: ExecutorArtifactLocator = {
      locate: vi.fn(async () => {
        throw new Error('manifest HTTP 404');
      }),
    };
    const attempt = vi.fn(async () => {
      throw missingExecutorError();
    });

    const error = await connectWithGuidance(attempt, {
      launcher: SSH,
      artifactLocator: locator,
      clientVersion: '1.2.3',
      runner: fake.runner,
    }).catch((error: unknown) => error);

    expect((error as Error).message).toContain('Install the executor manually:');
  });

  it('answers a handshake timeout with timeout wording plus install guidance', async () => {
    const fake = unameRunner();
    const attempt = vi.fn(async () => {
      throw new HandshakeError('initialize timed out after 10000ms', { kind: 'timeout' });
    });

    const error = await connectWithGuidance(attempt, {
      launcher: SSH,
      artifactLocator: fixedLocator(),
      clientVersion: '1.2.3',
      runner: fake.runner,
    }).catch((error: unknown) => error);

    const message = (error as Error).message;
    expect(message).toContain('did not answer the handshake in time');
    expect(message).toContain('Install the executor');
    expect((error as HandshakeError).kind).toBe('timeout');
  });

  it('answers a too-old executor with upgrade guidance, not an install', async () => {
    const fake = unameRunner();
    const attempt = vi.fn(async () => {
      throw incompatibleError();
    });

    const error = await connectWithGuidance(attempt, {
      launcher: SSH,
      artifactLocator: fixedLocator(),
      clientVersion: '1.2.3',
      runner: fake.runner,
    }).catch((error: unknown) => error);

    expect(attempt).toHaveBeenCalledTimes(1);
    const message = (error as Error).message;
    expect(message).toContain('reports version 0.0.4');
    expect(message).toContain('below the required minimum 0.1.0');
    expect(message).toContain(`Upgrade the executor (install version 1.2.3, sha256 ${ARTIFACT.sha256}):`);
    expect(message).toContain('scp /tmp/kimi-install dev-box:/tmp/kimi-install');
    expect(message).not.toContain('was not found');
    expect((error as HandshakeError).executorVersion).toBe('0.0.4');
  });

  it('fails a missing executor on a command environment with manual guidance and no probe', async () => {
    const runner = vi.fn() as unknown as LocalRunner;
    const attempt = vi.fn(async () => {
      throw missingExecutorError();
    });

    const error = await connectWithGuidance(attempt, {
      launcher: COMMAND,
      artifactLocator: fixedLocator(),
      clientVersion: '1.2.3',
      runner,
    }).catch((error: unknown) => error);

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(runner).not.toHaveBeenCalled();
    const message = (error as Error).message;
    expect(message).toContain('was not found on command:/usr/bin/sandbox');
    expect(message).toContain('place it at the absolute path your launcher command invokes');
    expect(message).toContain('Then reconnect the environment.');
  });

  it('answers a too-old executor on a command environment with generic upgrade guidance', async () => {
    const runner = vi.fn() as unknown as LocalRunner;
    const attempt = vi.fn(async () => {
      throw incompatibleError();
    });

    const error = await connectWithGuidance(attempt, {
      launcher: COMMAND,
      artifactLocator: fixedLocator(),
      clientVersion: '1.2.3',
      runner,
    }).catch((error: unknown) => error);

    expect(runner).not.toHaveBeenCalled();
    const message = (error as Error).message;
    expect(message).toContain('reports version 0.0.4');
    expect(message).toContain('install it at the absolute path your launcher command invokes');
  });

  it('rethrows unclassified failures unchanged', async () => {
    const protocol = new HandshakeError('received a message before the initialize response');
    const attempt = vi.fn(async () => {
      throw protocol;
    });
    const error = await connectWithGuidance(attempt, {
      launcher: SSH,
      artifactLocator: fixedLocator(),
    }).catch((error: unknown) => error);
    expect(error).toBe(protocol);
  });
});

describe('guidance text', () => {
  it('missing-executor guidance for docker mentions docker cp and image preinstall', () => {
    const text = missingExecutorGuidance({
      launcher: DOCKER,
      failure: 'missing',
      artifact: ARTIFACT,
    });
    expect(text).toContain('docker cp /tmp/kimi-install myapp-dev:/tmp/kimi-install');
    expect(text).toContain('preinstall the executor in the image');
  });

  it('command guidance names the concrete manifest URL when a CDN locator and version are known', () => {
    const text = missingExecutorGuidance({
      launcher: COMMAND,
      failure: 'missing',
      artifactLocator: new CdnExecutorArtifactLocator({ cdnBaseUrl: 'https://cdn.example.test/kimi-code' }),
      clientVersion: '1.2.3',
    });
    expect(text).toContain('https://cdn.example.test/kimi-code/binaries/1.2.3/manifest.json');
  });

  it('command guidance falls back to the manifest pattern without a CDN locator', () => {
    const text = missingExecutorGuidance({ launcher: COMMAND, failure: 'missing' });
    expect(text).toContain('<cdnBase>/binaries/<version>/manifest.json');
  });

  it('upgrade guidance names the versions and stays distinct from missing guidance', () => {
    const text = upgradeExecutorGuidance({
      launcher: SSH,
      executorVersion: '0.0.4',
      minExecutorVersion: '0.1.0',
      artifact: ARTIFACT,
    });
    expect(text).toContain('version 0.0.4');
    expect(text).toContain('minimum 0.1.0');
    expect(text).toContain('Upgrade the executor');
    expect(text).toContain(ARTIFACT.url);
    expect(text).not.toContain('was not found');
  });
});
