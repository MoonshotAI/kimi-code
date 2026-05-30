import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('kimi acp stdio transport', () => {
  it('responds to initialize with JSON-RPC only on stdout', async () => {
    const homeDir = await makeTempDir();
    const result = await runSourceAcpOnce(homeDir, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: {
          name: 'stdio-test',
          version: '0.0.0',
        },
      },
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const message = JSON.parse(lines[0]!) as {
      readonly id?: unknown;
      readonly result?: { readonly protocolVersion?: unknown };
    };
    expect(message).toMatchObject({
      id: 1,
      result: {
        protocolVersion: 1,
      },
    });
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kimi-acp-stdio-'));
  tempDirs.push(dir);
  return dir;
}

async function runSourceAcpOnce(
  homeDir: string,
  message: Record<string, unknown>,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const appRoot = path.resolve(import.meta.dirname, '../..');
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      path.resolve(appRoot, '../../build/register-raw-text-loader.mjs'),
      path.join(appRoot, 'src/main.ts'),
      'acp',
    ],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        KIMI_CODE_HOME: homeDir,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  child.stdin.end(`${JSON.stringify(message)}\n`);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('timed out waiting for ACP initialize response'));
    }, 10_000);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}
