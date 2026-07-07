// src/server.ts
//
// A minimal RESP (REdis Serialization Protocol) TCP front-end for MiniDb, so
// existing Redis clients (redis-cli, ioredis, ...) can talk to it.

import net from 'node:net';
import type { Socket } from 'node:net';
import { MiniDb } from './index.js';

const CRLF = '\r\n';
const NIL = `$-1${CRLF}`;

const reply = {
  ok: () => `+OK${CRLF}`,
  pong: () => `+PONG${CRLF}`,
  int: (n: number) => `:${n}${CRLF}`,
  err: (m: string) => `-ERR ${m}${CRLF}`,
  // Bulk replies carry raw bytes. Build a Buffer so non-ASCII / binary values
  // are written verbatim instead of being re-encoded as UTF-8 (which corrupted
  // them and desynced the protocol when `socket.write(string)` defaulted to
  // utf8).
  bulk: (v: unknown): Buffer => {
    if (v === undefined || v === null) return Buffer.from(NIL);
    const b = Buffer.isBuffer(v) ? v : Buffer.from(String(v as string));
    return Buffer.concat([Buffer.from(`$${b.length}${CRLF}`), b, Buffer.from(CRLF)]);
  },
  array: (items: unknown[]): Buffer => {
    const parts: Buffer[] = [Buffer.from(`*${items.length}${CRLF}`)];
    for (const it of items) parts.push(reply.bulk(it));
    return Buffer.concat(parts);
  },
};

class RespParser {
  private buf: Buffer = Buffer.alloc(0);
  private readonly maxBuf: number;

  constructor({ maxBuf = 64 * 1024 * 1024 }: { maxBuf?: number } = {}) {
    this.maxBuf = maxBuf;
  }

  *feed(chunk: Buffer): Generator<Buffer[]> {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.buf.length > this.maxBuf) {
      throw new Error(`RESP request too large (>${this.maxBuf} bytes)`);
    }
    while (this.buf.length) {
      const parsed = this.tryParse();
      if (!parsed) break;
      yield parsed;
    }
  }

  private tryParse(): Buffer[] | null {
    if (this.buf[0] !== 0x2a /* '*' */) {
      const idx = this.buf.indexOf(CRLF);
      if (idx === -1) return null;
      const line = this.buf.subarray(0, idx).toString();
      this.buf = this.buf.subarray(idx + 2);
      return line.split(' ').filter(Boolean).map((s) => Buffer.from(s));
    }

    let pos = 1;
    let end = this.buf.indexOf(CRLF, pos);
    if (end === -1) return null;
    const argc = Number(this.buf.subarray(pos, end).toString());
    pos = end + 2;

    const args: Buffer[] = [];
    for (let i = 0; i < argc; i++) {
      if (pos >= this.buf.length || this.buf[pos] !== 0x24 /* '$' */) return null;
      pos++;
      end = this.buf.indexOf(CRLF, pos);
      if (end === -1) return null;
      const len = Number(this.buf.subarray(pos, end).toString());
      pos = end + 2;
      if (this.buf.length - pos < len + 2) return null;
      args.push(this.buf.subarray(pos, pos + len));
      pos += len + 2;
    }
    this.buf = this.buf.subarray(pos);
    return args;
  }
}

async function handle(db: MiniDb<string>, args: Buffer[]): Promise<string | Buffer | null> {
  const cmd = args[0]!.toString().toUpperCase();
  const S = (i: number): string | undefined => (args[i] === undefined ? undefined : args[i]!.toString());

  switch (cmd) {
    case 'PING':
      return args[1] ? reply.bulk(S(1)) : reply.pong();
    case 'ECHO':
      return reply.bulk(S(1));
    case 'GET': {
      const v = db.get(S(1)!);
      return reply.bulk(v === undefined ? null : v);
    }
    case 'SET': {
      const key = S(1)!;
      const val = S(2)!;
      let ttl: number | undefined;
      for (let i = 3; i < args.length; i++) {
        const opt = S(i)!.toUpperCase();
        if (opt === 'EX') ttl = Number(S(++i)) * 1000;
        else if (opt === 'PX') ttl = Number(S(++i));
      }
      await db.set(key, val, ttl ? { ttl } : {});
      return reply.ok();
    }
    case 'DEL': {
      let n = 0;
      for (let i = 1; i < args.length; i++) if (await db.del(S(i)!)) n++;
      return reply.int(n);
    }
    case 'EXISTS':
      return reply.int(db.has(S(1)!) ? 1 : 0);
    case 'MGET': {
      const out: unknown[] = [];
      for (let i = 1; i < args.length; i++) {
        const v = db.get(S(i)!);
        out.push(v === undefined ? null : v);
      }
      return reply.array(out);
    }
    case 'MSET': {
      const entries: (readonly [string, string])[] = [];
      for (let i = 1; i + 1 < args.length; i += 2) entries.push([S(i)!, S(i + 1)!]);
      await db.mset(entries); // atomic batch (single WAL frame), like Redis MSET
      return reply.ok();
    }
    case 'TTL':
      return reply.int(Math.trunc(db.ttl(S(1)!) / 1000));
    case 'DBSIZE':
      return reply.int(db.size);
    case 'COMPACT':
      await db.compact();
      return reply.ok();
    case 'INFO':
      return reply.bulk(`minidb_version:0.0.1${CRLF}keys:${db.size}${CRLF}compactions:${db.stats.compactions}${CRLF}`);
    case 'QUIT':
      return null;
    default:
      return reply.err(`unknown command '${cmd}'`);
  }
}

export interface ServerOptions {
  dir: string;
  port?: number;
  host?: string;
  fsyncPolicy?: 'always' | 'everysec' | 'no';
}

export interface ServerHandle {
  server: net.Server;
  db: MiniDb<string>;
  close: () => Promise<void>;
  port: number;
  host: string;
}

export async function startServer({ dir, port = 6379, host = '127.0.0.1', fsyncPolicy = 'everysec' }: ServerOptions): Promise<ServerHandle> {
  const db = (await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy })) as MiniDb<string>;
  const server = net.createServer((socket: Socket) => {
    const parser = new RespParser();
    socket.on('data', (chunk: Buffer) => {
      void (async () => {
        try {
          for (const args of parser.feed(chunk)) {
            const res = await handle(db, args);
            if (res === null) {
              socket.end();
              return;
            }
            socket.write(res);
          }
        } catch (e) {
          socket.write(reply.err((e as Error).message));
        }
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const actualPort = (server.address() as net.AddressInfo).port;

  const close = async (): Promise<void> => {
    server.close();
    await db.close();
  };
  process.on('SIGINT', () => {
    void close().then(() => process.exit(0));
  });
  return { server, db, close, port: actualPort, host };
}

// Run directly: node --import tsx src/server.ts --dir ./data --port 6379
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const arg = (name: string, def: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? def : argv[i + 1]!;
  };
  const dir = arg('dir', './data');
  const port = Number(arg('port', '6379'));
  const fsyncPolicy = arg('fsync', 'everysec') as 'always' | 'everysec' | 'no';
  const { host, port: p } = await startServer({ dir, port, fsyncPolicy });
  console.log(`minidb RESP server listening on ${host}:${p} (dir=${dir}, fsync=${fsyncPolicy})`);
}
