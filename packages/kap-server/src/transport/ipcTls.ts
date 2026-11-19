import { constants } from 'node:crypto';
import { connect, type SecureContextOptions, type TLSSocket } from 'node:tls';

export const IPC_PSK_IDENTITY = 'kimi-daemon';
export const IPC_TLS_OPTIONS = {
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.2',
  ciphers: 'ECDHE-PSK-CHACHA20-POLY1305',
  secureOptions: constants.SSL_OP_NO_TICKET | constants.SSL_OP_NO_RENEGOTIATION,
} as const satisfies SecureContextOptions;

export function connectIpcTls(path: string, psk: Buffer): TLSSocket {
  return connect({
    ...IPC_TLS_OPTIONS,
    path,
    rejectUnauthorized: false,
    pskCallback: () => ({ identity: IPC_PSK_IDENTITY, psk }),
  });
}
