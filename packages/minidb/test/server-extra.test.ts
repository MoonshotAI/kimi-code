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

// Accumulate reply bytes until `done` accepts them (replies may span chunks).
function collectUntil(sock: net.Socket, done: (s: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for reply; got ${buf.length} bytes`)), 20_000);
    sock.on('data', (d) => {
      buf += d.toString();
      if (done(buf)) {
        clearTimeout(timer);
        resolve(buf);
      }
    });
  });
}

test('RESP: a client aborting mid-large-reply does not kill the server', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    sock.on('error', () => {}); // the test client itself may see the RST
    const big = 'x'.repeat(4 * 1024 * 1024);
    assert.equal(await send(sock, encode('SET', 'big', big)), '+OK\r\n');
    // Ask for the large value, then reset the connection without reading the
    // reply: the server hits EPIPE/ECONNRESET while writing it out.
    sock.write(encode('GET', 'big'));
    await new Promise((r) => setTimeout(r, 20));
    sock.destroy();
    // Give the server a moment to hit the write failure, then prove a fresh
    // connection is still being served.
    await new Promise((r) => setTimeout(r, 100));
    const sock2 = await connect(srv.port);
    assert.equal(await send(sock2, encode('PING')), '+PONG\r\n');
    sock2.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: an oversized request gets -ERR and the connection recovers', { timeout: 30_000 }, async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    // 65MB of bulk payload crosses the parser's 64MB cap.
    const big = Buffer.alloc(65 * 1024 * 1024, 'x'.charCodeAt(0));
    const head = Buffer.from(`*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$${big.length}\r\n`);
    sock.write(Buffer.concat([head, big, Buffer.from('\r\n')]));
    // Pipelined right behind it: once the parser recovers from the -ERR this
    // fresh small command must still be answered.
    sock.write(encode('PING'));
    const data = await collectUntil(sock, (s) => s.includes('+PONG'));
    const tooLarge = data.indexOf('too large');
    const pong = data.indexOf('+PONG');
    assert.ok(tooLarge !== -1, `expected a too-large -ERR, got ${JSON.stringify(data.slice(0, 120))}`);
    assert.ok(pong > tooLarge, 'PING after the oversized request must be answered');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP: one bad command does not starve its pipelined siblings', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    // The 129-byte key exceeds MAX_KEY_LEN so SET throws inside the handler;
    // the two PINGs in the very same chunk must still be answered, in order.
    const key = 'k'.repeat(129);
    sock.write(encode('SET', key, 'v') + encode('PING') + encode('PING'));
    const data = await collectUntil(sock, (s) => s.endsWith('+PONG\r\n+PONG\r\n'));
    assert.match(data, /^-ERR [^\r]*\r\n\+PONG\r\n\+PONG\r\n$/);
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
