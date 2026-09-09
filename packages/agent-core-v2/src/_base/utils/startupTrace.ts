import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const enabled =
  process.env['KIMI_STARTUP_TRACE'] !== undefined && process.env['KIMI_STARTUP_TRACE'] !== '';
const logPath = process.env['KIMI_STARTUP_TRACE_LOG'] ?? '/tmp/kimi-startup-trace.log';
let prepared = false;

export function startupTrace(label: string): void {
  if (!enabled) return;
  if (!prepared) {
    prepared = true;
    try {
      mkdirSync(path.dirname(logPath), { recursive: true });
      appendFileSync(logPath, `--- ${new Date().toISOString()} pid=${process.pid} ---\n`);
    } catch {}
  }
  try {
    appendFileSync(logPath, `${performance.now().toFixed(0).padStart(7)}ms ${label}\n`);
  } catch {}
}
