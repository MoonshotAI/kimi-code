import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RequestError } from '@agentclientprotocol/sdk';
import { isHostFsNotDirectory, isHostFsNotFound } from '@moonshot-ai/agent-core-v2/os/interface/hostFsErrors';
import { afterEach, describe, expect, it } from 'vitest';

import { AcpHostFileSystem } from '../src/acp-fs/acpFsService';
import type { IAcpConnection } from '../src/acp-fs/acpConnection';

interface FakeClient {
  readTextFile: (params: { sessionId: string; path: string }) => Promise<{ content: string }>;
  writeTextFile: (params: {
    sessionId: string;
    path: string;
    content: string;
  }) => Promise<unknown>;
}

function makeConnection(
  client: FakeClient,
  capabilities: { read?: boolean; write?: boolean } = { read: true, write: true },
): IAcpConnection {
  return {
    _serviceBrand: undefined,
    bound: true,
    fsReadTextFile: capabilities.read === true,
    fsWriteTextFile: capabilities.write === true,
    terminalEnabled: false,
    bind: () => {},
    get: () => client as never,
    bindFsCapabilities: () => {},
    bindTerminalCapability: () => {},
    notifyTerminalCreated: () => {},
    onTerminalCreated: () => () => {},
  };
}

function makeFileSystem(
  client: FakeClient,
  capabilities?: { read?: boolean; write?: boolean },
): AcpHostFileSystem {
  return new AcpHostFileSystem(
    { sessionId: 'session-test' } as never,
    makeConnection(client, capabilities),
  );
}

describe('AcpHostFileSystem', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      tempDir = undefined;
    }
  });

  it('bridges append through client read-modify-write', async () => {
    const writes: string[] = [];
    const fs = makeFileSystem({
      readTextFile: async () => ({ content: 'old:' }),
      writeTextFile: async ({ content }) => {
        writes.push(content);
      },
    });

    await fs.appendText('/buffer.txt', 'new');

    expect(writes).toEqual(['old:new']);
  });

  it('creates a client file when append read reports resource not found', async () => {
    const writes: string[] = [];
    const fs = makeFileSystem({
      readTextFile: async () => {
        throw RequestError.resourceNotFound('/buffer.txt');
      },
      writeTextFile: async ({ content }) => {
        writes.push(content);
      },
    });

    await fs.appendText('/buffer.txt', 'fresh');

    expect(writes).toEqual(['fresh']);
  });

  it('maps a client read resource-not-found failure to a host filesystem error', async () => {
    const fs = makeFileSystem({
      readTextFile: async () => {
        throw RequestError.resourceNotFound('/missing-plan.md');
      },
      writeTextFile: async () => {},
    });

    const rejection = await fs.readText('/missing-plan.md').catch((error: unknown) => error);

    expect(isHostFsNotFound(rejection)).toBe(true);
  });

  it('does not write after a non-not-found client read failure', async () => {
    const writes: string[] = [];
    const failure = new Error('transport failed');
    const fs = makeFileSystem({
      readTextFile: async () => {
        throw failure;
      },
      writeTextFile: async ({ content }) => {
        writes.push(content);
      },
    });

    await expect(fs.appendText('/buffer.txt', 'new')).rejects.toBe(failure);
    expect(writes).toEqual([]);
  });

  it('bridges valid UTF-8 writeBytes through client text write', async () => {
    const writes: string[] = [];
    const fs = makeFileSystem({
      readTextFile: async () => ({ content: '' }),
      writeTextFile: async ({ content }) => {
        writes.push(content);
      },
    });

    await fs.writeBytes('/buffer.txt', new TextEncoder().encode('你好'));

    expect(writes).toEqual(['你好']);
  });

  it('keeps invalid UTF-8 writeBytes on the local binary backend', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'acp-fs-'));
    const path = join(tempDir, 'binary.dat');
    const fs = makeFileSystem({
      readTextFile: async () => ({ content: '' }),
      writeTextFile: async () => {
        throw new Error('must not use client text write');
      },
    });

    await fs.writeBytes(path, Uint8Array.from([0xff, 0xfe]));

    expect(Array.from(await readFile(path))).toEqual([0xff, 0xfe]);
  });

  it('falls back to the local filesystem when text capabilities are unavailable', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'acp-fs-'));
    const path = join(tempDir, 'buffer.txt');
    await writeFile(path, 'old:');
    const fs = makeFileSystem(
      {
        readTextFile: async () => ({ content: 'client content' }),
        writeTextFile: async () => {
          throw new Error('must not use client text write');
        },
      },
      { read: false, write: false },
    );

    await fs.appendText(path, 'new');

    expect(await readFile(path, 'utf8')).toBe('old:new');
  });

  it('reports a client write failure under a missing local parent as not found', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'acp-fs-'));
    const fs = makeFileSystem({
      readTextFile: async () => ({ content: '' }),
      writeTextFile: async () => {
        throw new Error('client cannot create parents');
      },
    });

    const rejection = await fs.writeText(join(tempDir, 'missing', 'new.txt'), 'x').catch((error: unknown) => error);

    expect(isHostFsNotFound(rejection)).toBe(true);
  });

  it('reports a client write failure under a file parent as not a directory', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'acp-fs-'));
    await writeFile(join(tempDir, 'file'), '');
    const failure = new Error('client write failed');
    const fs = makeFileSystem({
      readTextFile: async () => ({ content: '' }),
      writeTextFile: async () => {
        throw failure;
      },
    });

    const rejection = await fs.writeText(join(tempDir, 'file', 'new.txt'), 'x').catch((error: unknown) => error);

    expect(isHostFsNotDirectory(rejection)).toBe(true);
  });

  it('keeps the client write failure when the local parent exists', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'acp-fs-'));
    const failure = new Error('client write failed');
    const fs = makeFileSystem({
      readTextFile: async () => ({ content: '' }),
      writeTextFile: async () => {
        throw failure;
      },
    });

    await expect(fs.writeText(join(tempDir, 'new.txt'), 'x')).rejects.toBe(failure);
  });
});
