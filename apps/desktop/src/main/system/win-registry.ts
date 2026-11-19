import { spawn } from 'node:child_process';

export type RegQuery = (key: string, valueName: string | null) => Promise<string | null>;

const CMD_EXE = 'cmd.exe';
const REG_EXE = 'reg.exe';
const QUERY_TIMEOUT_MS = 2000;

export function buildRegQueryCommand(args: string[]): string {
  const quoted = args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg));
  return `chcp 65001>nul & ${REG_EXE} ${quoted.join(' ')}`;
}

function runRegQuery(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(CMD_EXE, ['/c', buildRegQueryCommand(args)], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, QUERY_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.once('error', () => finish(null));
    child.once('close', (code) =>
      finish(code === 0 ? Buffer.concat(chunks).toString('utf-8') : null),
    );
  });
}

export function parseRegOutput(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/.exec(line.trimEnd());
    const value = match?.[1];
    if (value !== undefined) return value;
  }
  return null;
}

export function createRegQuery(
  run: (args: string[]) => Promise<string | null> = runRegQuery,
): RegQuery {
  const cache = new Map<string, Promise<string | null>>();
  return (key, valueName) => {
    const cacheKey = `${key}::${valueName ?? ''}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;
    const args =
      valueName === null ? ['query', key, '/ve'] : ['query', key, '/v', valueName];
    const result = run(args).then((output) => (output === null ? null : parseRegOutput(output)));
    cache.set(cacheKey, result);
    void result.then((value) => {
      if (value === null) cache.delete(cacheKey);
    });
    return result;
  };
}

export const queryRegValue: RegQuery = createRegQuery();
