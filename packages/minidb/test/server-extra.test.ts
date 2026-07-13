// Covers the RESP commands and parser paths not exercised by server.test.ts.
import { expect, test } from 'vitest';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-srv2-'));
}

function encode(...args: string[]) {
  let s = `*${args.length}\r\n`;
  for (const a of args) {
    const b = Buffer.from(a);
    s += `$${b.length}\r\n${a}\r\n`;
  }
  return s;
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

function send(sock: net.Socket, cmd: string | Buffer): Promise<string> {
  return new Promise((resolve) => {
    sock.once('data', (d) => resolve(d.toString()));
    sock.write(cmd);
  });
}

// Send a command and resolve when the server closes the connection (QUIT).
function sendUntilClose(sock: net.Socket, cmd: string | Buffer): Promise<void> {
  return new Promise((resolve) => {
    sock.once('close', () => resolve());
    sock.write(cmd);
  });
}

test('RESP: ECHO and PING with argument', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    assert.equal(await send(sock, encode('ECHO', 'hello')), '$5\r\nhello\r\n');
    assert.equal(await send(sock, encode('PING', 'hi')), '$2\r\nhi\r\n');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: EXISTS / MSET / MGET / TTL', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    assert.equal(await send(sock, encode('MSET', 'a', '1', 'b', '2')), '+OK\r\n');
    assert.equal(await send(sock, encode('EXISTS', 'a')), ':1\r\n');
    assert.equal(await send(sock, encode('EXISTS', 'z')), ':0\r\n');
    assert.equal(await send(sock, encode('MGET', 'a', 'b')), '*2\r\n$1\r\n1\r\n$1\r\n2\r\n');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: SET with EX / PX sets a TTL', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    assert.equal(await send(sock, encode('SET', 'ex', 'v', 'EX', '10')), '+OK\r\n');
    const ex = Number((await send(sock, encode('TTL', 'ex'))).slice(1));
    assert.ok(ex > 0 && ex <= 10, `EX ttl=${ex}`);

    assert.equal(await send(sock, encode('SET', 'px', 'v', 'PX', '5000')), '+OK\r\n');
    const px = Number((await send(sock, encode('TTL', 'px'))).slice(1));
    assert.ok(px > 0 && px <= 5, `PX ttl=${px}`);
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: INFO and COMPACT', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    await send(sock, encode('SET', 'k', 'v'));
    const info = await send(sock, encode('INFO'));
    assert.ok(info.includes('minidb_version:0.0.1'), info);
    assert.ok(info.includes('keys:1'), info);
    assert.equal(await send(sock, encode('COMPACT')), '+OK\r\n');
    const info2 = await send(sock, encode('INFO'));
    assert.ok(info2.includes('compactions:1'), info2);
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: QUIT closes the connection', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    await expect(sendUntilClose(sock, encode('QUIT'))).resolves.toBeUndefined();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: inline (non-array) command path', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    // Redis inline protocol: a bare line of space-separated tokens.
    assert.equal(await send(sock, 'PING\r\n'), '+PONG\r\n');
    assert.equal(await send(sock, 'SET foo bar\r\n'), '+OK\r\n');
    assert.equal(await send(sock, 'GET foo\r\n'), '$3\r\nbar\r\n');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
