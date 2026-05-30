import { Readable, Writable } from 'node:stream';

import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

import { KimiAcpAgent } from './agent';

export interface RunAcpServerOptions {
  readonly version: string;
}

export async function runAcpServer(options: RunAcpServerOptions): Promise<void> {
  let agent: KimiAcpAgent | undefined;
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  const connection = new AgentSideConnection((conn) => {
    agent = new KimiAcpAgent({
      connection: conn,
      version: options.version,
    });
    return agent;
  }, ndJsonStream(output, input));

  try {
    await connection.closed;
  } finally {
    await agent?.close();
  }
}
