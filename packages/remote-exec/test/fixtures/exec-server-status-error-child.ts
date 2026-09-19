import { encodeFrame, LineFrameDecoder } from '../../src/protocol/codec';
import {
  ENVIRONMENT_STATUS_METHOD,
  INITIALIZE_METHOD,
  type InitializeResult,
  type RemoteEnvironmentInfo,
} from '../../src/protocol/methods';

// Answers the handshake like a healthy executor, then answers every
// environment/status ping with an error: a peer that is alive but unhealthy.
const environment: RemoteEnvironmentInfo = {
  osKind: 'Linux',
  osArch: 'x64',
  osVersion: 'test',
  shellName: 'bash',
  shellPath: '/bin/bash',
  pathClass: 'posix',
  homeDir: '/home/test',
  cwd: '/tmp',
  tempDir: '/tmp',
};

const decoder = new LineFrameDecoder();
process.stdin.on('data', (chunk: Buffer) => {
  for (const frame of decoder.push(chunk)) {
    const message = frame as { id?: number; method?: string };
    if (message.method === INITIALIZE_METHOD) {
      const result: InitializeResult = {
        executorVersion: process.env['EXEC_SERVER_VERSION'] ?? '0.0.0-test',
        environment,
        capabilities: {},
      };
      process.stdout.write(encodeFrame({ id: message.id, result }));
      continue;
    }
    if (message.method === ENVIRONMENT_STATUS_METHOD) {
      process.stdout.write(encodeFrame({ id: message.id, error: { code: -32000, message: 'executor is unhealthy' } }));
    }
  }
});
