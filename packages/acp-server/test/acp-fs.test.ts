import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RequestError } from '@agentclientprotocol/sdk';
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

  it('keeps non-text writeBytes on the local binary backend', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'acp-fs-'));
    const path = join(tempDir, 'binary.dat');
    const fs = makeFileSystem({
      readTextFile: async () => ({ content: '' }),
      writeTextFile: async () => {
        throw new Error('must not use client text write');
      },
    });

    await fs.writeBytes(path, Uint8Array.from([0x00, 0xd8]));

    expect(Array.from(await readFile(path))).toEqual([0x00, 0xd8]);
  });

  it('keeps NUL-bearing but UTF-8-decodable writeBytes on the local binary backend', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'acp-fs-'));
    const path = join(tempDir, 'binary.dat');
    const fs = makeFileSystem({
      readTextFile: async () => ({ content: '' }),
      writeTextFile: async () => {
        throw new Error('must not use client text write');
      },
    });

    await fs.writeBytes(path, Uint8Array.from([0x00, 0x01]));

    expect(Array.from(await readFile(path))).toEqual([0x00, 0x01]);
  });

  it('keeps writeBytes local when a NUL sits past the leading sample window', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'acp-fs-'));
    const path = join(tempDir, 'tail-nul.dat');
    const fs = makeFileSystem({
      readTextFile: async () => ({ content: '' }),
      writeTextFile: async () => {
        throw new Error('must not use client text write');
      },
    });
    const payload = new Uint8Array(600).fill(0x61);
    payload[550] = 0x00;

    await fs.writeBytes(path, payload);

    expect(Array.from(await readFile(path))).toEqual(Array.from(payload));
  });

  it('keeps the exclusive guarantee when a NUL sits past the leading sample window', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'acp-fs-'));
    const path = join(tempDir, 'tail-nul.dat');
    const writes: string[] = [];
    const fs = makeFileSystem({
      readTextFile: async () => {
        throw RequestError.resourceNotFound(path);
      },
      writeTextFile: async ({ content }) => {
        writes.push(content);
      },
    });
    const payload = new Uint8Array(600).fill(0x61);
    payload[550] = 0x00;

    const created = await fs.createExclusive(path, payload);

    expect(created).toBe(true);
    expect(writes).toEqual([]);
    expect(Array.from(await readFile(path))).toEqual(Array.from(payload));
  });

  it('keeps BOM-less UTF-16 writeBytes on the local binary backend', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'acp-fs-'));
    const path = join(tempDir, 'bomless-utf16.txt');
    const fs = makeFileSystem({
      readTextFile: async () => ({ content: '' }),
      writeTextFile: async () => {
        throw new Error('must not use client text write');
      },
    });
    const payload = new Uint8Array(Buffer.from('你好abc', 'utf16le'));

    await fs.writeBytes(path, payload);

    expect(Array.from(await readFile(path))).toEqual(Array.from(payload));
  });

  it('keeps the exclusive guarantee for BOM-less UTF-16 payloads', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'acp-fs-'));
    const path = join(tempDir, 'local.dat');
    await writeFile(path, Uint8Array.from([0x01, 0x02]));
    const writes: string[] = [];
    const fs = makeFileSystem({
      readTextFile: async () => {
        throw RequestError.resourceNotFound(path);
      },
      writeTextFile: async ({ content }) => {
        writes.push(content);
      },
    });
    const payload = new Uint8Array(Buffer.from('你好abc', 'utf16le'));

    const created = await fs.createExclusive(path, payload);

    expect(created).toBe(false);
    expect(writes).toEqual([]);
    expect(Array.from(await readFile(path))).toEqual([0x01, 0x02]);
  });

  it('reports a client-only file as taken for binary exclusive creates', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'acp-fs-'));
    const path = join(tempDir, 'client-only.dat');
    const writes: string[] = [];
    const fs = makeFileSystem({
      readTextFile: async () => ({ content: 'existing' }),
      writeTextFile: async ({ content }) => {
        writes.push(content);
      },
    });
    const payload = Uint8Array.from([0x00, 0xd8]);

    const created = await fs.createExclusive(path, payload);

    expect(created).toBe(false);
    expect(writes).toEqual([]);
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a local-only file as taken for text exclusive creates', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'acp-fs-'));
    const path = join(tempDir, 'local-only.txt');
    await writeFile(path, 'local');
    const writes: string[] = [];
    const fs = makeFileSystem({
      readTextFile: async () => {
        throw RequestError.resourceNotFound(path);
      },
      writeTextFile: async ({ content }) => {
        writes.push(content);
      },
    });

    const created = await fs.createExclusive(path, new TextEncoder().encode('fresh'));

    expect(created).toBe(false);
    expect(writes).toEqual([]);
    expect((await readFile(path)).toString('utf8')).toBe('local');
  });

  it('appends to the local file when the client has no buffer for a local-only path', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'acp-fs-'));
    const path = join(tempDir, 'local-only.txt');
    await writeFile(path, 'local:');
    const writes: string[] = [];
    const fs = makeFileSystem({
      readTextFile: async () => {
        throw RequestError.resourceNotFound(path);
      },
      writeTextFile: async ({ content }) => {
        writes.push(content);
      },
    });

    await fs.appendText(path, 'new');

    expect(writes).toEqual([]);
    expect((await readFile(path)).toString('utf8')).toBe('local:new');
  });

  it.skipIf(process.platform === 'win32')(
    'treats a dangling symlink as an existing local entry for text exclusive creates',
    async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'acp-fs-'));
      const path = join(tempDir, 'dangling.txt');
      await symlink(join(tempDir, 'missing-target'), path);
      const writes: string[] = [];
      const fs = makeFileSystem({
        readTextFile: async () => {
          throw RequestError.resourceNotFound(path);
        },
        writeTextFile: async ({ content }) => {
          writes.push(content);
        },
      });

      const created = await fs.createExclusive(path, new TextEncoder().encode('fresh'));

      expect(created).toBe(false);
      expect(writes).toEqual([]);
    },
  );

  it('bridges BOM-less UTF-16 bytes that are also valid UTF-8 as UTF-8 text', async () => {
    const writes: string[] = [];
    const fs = makeFileSystem({
      readTextFile: async () => ({ content: '' }),
      writeTextFile: async ({ content }) => {
        writes.push(content);
      },
    });

    await fs.writeBytes('/buffer.txt', new Uint8Array(Buffer.from('你好世界', 'utf16le')));

    expect(writes).toEqual(['`O}Y\u0016NLu']);
  });

  it('bridges UTF-16LE writeBytes through client text write keeping the BOM', async () => {
    const writes: string[] = [];
    const fs = makeFileSystem({
      readTextFile: async () => ({ content: '' }),
      writeTextFile: async ({ content }) => {
        writes.push(content);
      },
    });
    const payload = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('你好', 'utf16le'),
    ]);

    await fs.writeBytes('/buffer.txt', payload);

    expect(writes).toEqual(['\uFEFF你好']);
  });

  it('bridges UTF-16BE writeBytes through client text write keeping the BOM', async () => {
    const writes: string[] = [];
    const fs = makeFileSystem({
      readTextFile: async () => ({ content: '' }),
      writeTextFile: async ({ content }) => {
        writes.push(content);
      },
    });
    const le = Buffer.from('hi', 'utf16le');
    const be = Buffer.alloc(le.length);
    for (let i = 0; i + 1 < le.length; i += 2) {
      be[i] = le[i + 1]!;
      be[i + 1] = le[i]!;
    }
    const payload = Buffer.concat([Buffer.from([0xfe, 0xff]), be]);

    await fs.writeBytes('/buffer.txt', payload);

    expect(writes).toEqual(['\uFEFFhi']);
  });

  it('bridges a UTF-8 BOM writeBytes through client text write keeping the BOM', async () => {
    const writes: string[] = [];
    const fs = makeFileSystem({
      readTextFile: async () => ({ content: '' }),
      writeTextFile: async ({ content }) => {
        writes.push(content);
      },
    });
    const payload = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('hi', 'utf8'),
    ]);

    await fs.writeBytes('/buffer.txt', payload);

    expect(writes).toEqual(['\uFEFFhi']);
  });

  it('reports false without writing when exclusive create finds a client file', async () => {
    const writes: string[] = [];
    const fs = makeFileSystem({
      readTextFile: async () => ({ content: 'existing' }),
      writeTextFile: async ({ content }) => {
        writes.push(content);
      },
    });

    const created = await fs.createExclusive('/buffer.txt', new TextEncoder().encode('data'));

    expect(created).toBe(false);
    expect(writes).toEqual([]);
  });

  it('creates through the client when exclusive create reads resource not found', async () => {
    const writes: string[] = [];
    const fs = makeFileSystem({
      readTextFile: async () => {
        throw RequestError.resourceNotFound('/buffer.txt');
      },
      writeTextFile: async ({ content }) => {
        writes.push(content);
      },
    });
    const payload = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('fresh', 'utf8'),
    ]);

    const created = await fs.createExclusive('/buffer.txt', payload);

    expect(created).toBe(true);
    expect(writes).toEqual(['\uFEFFfresh']);
  });

  it('propagates non-not-found client read failures from exclusive create', async () => {
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

    await expect(fs.createExclusive('/buffer.txt', new TextEncoder().encode('x'))).rejects.toBe(
      failure,
    );
    expect(writes).toEqual([]);
  });

  it('keeps the exclusive guarantee for binary payloads instead of truncating local files', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'acp-fs-'));
    const path = join(tempDir, 'local.dat');
    await writeFile(path, Uint8Array.from([0x01, 0x02]));
    const writes: string[] = [];
    const fs = makeFileSystem({
      readTextFile: async () => {
        throw RequestError.resourceNotFound(path);
      },
      writeTextFile: async ({ content }) => {
        writes.push(content);
      },
    });

    const created = await fs.createExclusive(path, Uint8Array.from([0x00, 0xd8]));

    expect(created).toBe(false);
    expect(writes).toEqual([]);
    expect(Array.from(await readFile(path))).toEqual([0x01, 0x02]);
  });

  it('keeps the exclusive guarantee for UTF-8-decodable binary payloads', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'acp-fs-'));
    const path = join(tempDir, 'local.dat');
    await writeFile(path, Uint8Array.from([0x01, 0x02]));
    const writes: string[] = [];
    const fs = makeFileSystem({
      readTextFile: async () => {
        throw RequestError.resourceNotFound(path);
      },
      writeTextFile: async ({ content }) => {
        writes.push(content);
      },
    });

    const created = await fs.createExclusive(path, Uint8Array.from([0x00, 0x01]));

    expect(created).toBe(false);
    expect(writes).toEqual([]);
    expect(Array.from(await readFile(path))).toEqual([0x01, 0x02]);
  });

  it('creates binary payloads on the local backend when the path is free', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'acp-fs-'));
    const path = join(tempDir, 'fresh.dat');
    const fs = makeFileSystem({
      readTextFile: async () => {
        throw RequestError.resourceNotFound(path);
      },
      writeTextFile: async () => {
        throw new Error('must not use client text write');
      },
    });

    const created = await fs.createExclusive(path, Uint8Array.from([0x00, 0xd8]));

    expect(created).toBe(true);
    expect(Array.from(await readFile(path))).toEqual([0x00, 0xd8]);
  });

  it('keeps UTF-32 BOM writeBytes on the local binary backend', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'acp-fs-'));
    const path = join(tempDir, 'utf32.txt');
    const fs = makeFileSystem({
      readTextFile: async () => ({ content: '' }),
      writeTextFile: async () => {
        throw new Error('must not use client text write');
      },
    });
    const payload = Uint8Array.from([0xff, 0xfe, 0x00, 0x00, 0x61, 0x00, 0x00, 0x00]);

    await fs.writeBytes(path, payload);

    expect(Array.from(await readFile(path))).toEqual([...payload]);
  });

  it('creates exclusively on the local backend without text capabilities', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'acp-fs-'));
    const path = join(tempDir, 'created.txt');
    const fs = makeFileSystem(
      {
        readTextFile: async () => ({ content: '' }),
        writeTextFile: async () => {
          throw new Error('must not use client text write');
        },
      },
      { read: false, write: false },
    );

    const first = await fs.createExclusive(path, new TextEncoder().encode('one'));
    const second = await fs.createExclusive(path, new TextEncoder().encode('two'));

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('one');
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
});
