import { createServerLogger } from '@moonshot-ai/kap-server';
import { app } from 'electron';

import { createRendererLogWriter, type RendererLogWriter } from '../diagnostics/renderer-log';

const PINO_WARN = 40;
const PINO_ERROR = 50;
const ENVELOPE_KEYS = new Set(['level', 'time', 'msg', 'name', 'pid', 'hostname', 'v']);

export interface ServerLogPayload {
  level: 'warn' | 'error';
  message: string;
  detail?: Record<string, unknown>;
}

export function serverLogPayload(chunk: string): ServerLogPayload | null {
  let record: unknown;
  try {
    record = JSON.parse(chunk);
  } catch {
    return null;
  }
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return null;
  const fields = record as Record<string, unknown>;
  const level = fields['level'];
  if (typeof level !== 'number' || level < PINO_WARN) return null;
  const msg = fields['msg'];
  const detail: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ENVELOPE_KEYS.has(key)) detail[key] = value;
  }
  const payload: ServerLogPayload = {
    level: level >= PINO_ERROR ? 'error' : 'warn',
    message: typeof msg === 'string' && msg !== '' ? msg : '(no message)',
  };
  if (Object.keys(detail).length > 0) payload.detail = detail;
  return payload;
}

export function createServerLogStream(
  forward: RendererLogWriter = createRendererLogWriter(undefined, undefined, 'server'),
  mirror?: (chunk: string) => void,
): { write(chunk: string): void } {
  return {
    write(chunk: string): void {
      mirror?.(chunk);
      const payload = serverLogPayload(chunk);
      if (payload !== null) forward(payload);
    },
  };
}

function mirrorToStdout(chunk: string): void {
  try {
    process.stdout.write(chunk);
  } catch {
    return;
  }
}

export function createDesktopServerLogger(): ReturnType<typeof createServerLogger> {
  const packaged = app.isPackaged;
  return createServerLogger({
    level: packaged ? 'warn' : 'info',
    stream: createServerLogStream(undefined, packaged ? undefined : mirrorToStdout),
  });
}
