// test/server.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-srv-'));
}

function encode(...args) {
  let s = `*${args.length}\r\n`;
  for (const a of args) {
    const b = Buffer.from(a);
    s += `$${b.length}\r\n${a}\r\n`;
  }
  return s;
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

// Send one command and resolve with the next response chunk.
function send(sock, cmd) {
  return new Promise((resolve) => {
    sock.once('data', (d) => resolve(d.toString()));
    sock.write(cmd);
  });
}

test('RESP server: PING / SET / GET', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    assert.equal(await send(sock, encode('PING')), '+PONG\r\n');
    assert.equal(await send(sock, encode('SET', 'foo', 'bar')), '+OK\r\n');
    assert.equal(await send(sock, encode('GET', 'foo')), '$3\r\nbar\r\n');
    assert.equal(await send(sock, encode('GET', 'missing')), '$-1\r\n');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP server: MGET / DEL / DBSIZE', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    await send(sock, encode('SET', 'a', '1'));
    await send(sock, encode('SET', 'b', '2'));
    assert.equal(await send(sock, encode('MGET', 'a', 'b', 'z')), '*3\r\n$1\r\n1\r\n$1\r\n2\r\n$-1\r\n');
    assert.equal(await send(sock, encode('DBSIZE')), ':2\r\n');
    assert.equal(await send(sock, encode('DEL', 'a')), ':1\r\n');
    assert.equal(await send(sock, encode('DBSIZE')), ':1\r\n');
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('RESP server: unknown command returns an error', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await connect(srv.port);
    const r = await send(sock, encode('NOPE'));
    assert.ok(r.startsWith('-ERR'));
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
