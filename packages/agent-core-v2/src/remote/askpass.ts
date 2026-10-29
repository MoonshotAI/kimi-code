import { createConnection } from 'node:net';

export const SSH_ASKPASS_PORT_ENV = 'KIMI_CODE_SSH_ASKPASS_PORT';
export const SSH_ASKPASS_TOKEN_ENV = 'KIMI_CODE_SSH_ASKPASS_TOKEN';

export function isSshAskpassEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[SSH_ASKPASS_PORT_ENV] !== undefined && env[SSH_ASKPASS_TOKEN_ENV] !== undefined;
}

export function runSshAskpass(env: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  const port = Number(env[SSH_ASKPASS_PORT_ENV]);
  const token = env[SSH_ASKPASS_TOKEN_ENV];
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || token === undefined || token.length === 0) {
    return Promise.resolve(1);
  }
  return new Promise((resolve) => {
    let response = '';
    let settled = false;
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (code: number, value?: string) => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.destroy();
      if (value === undefined) {
        resolve(code);
      } else {
        process.stdout.write(`${value}\n`, () => {
          resolve(code);
        });
      }
    };
    socket.setEncoding('utf8');
    socket.setTimeout(10_000, () => {
      finish(1);
    });
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ token })}\n`);
    });
    socket.on('data', (chunk: string) => {
      response += chunk;
      if (response.length > 64 * 1024) finish(1);
    });
    socket.on('end', () => {
      try {
        const result = JSON.parse(response) as { value?: unknown };
        if (typeof result.value !== 'string') {
          finish(1);
          return;
        }
        finish(0, result.value);
      } catch {
        finish(1);
      }
    });
    socket.on('error', () => {
      finish(1);
    });
  });
}
