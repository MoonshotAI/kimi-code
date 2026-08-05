// src/utils/startup-trace.ts
//
// Debug-only startup phase tracer, enabled with KIMI_STARTUP_TRACE=1.
// Each call appends one `<elapsed-ms> <label>` line to the trace file
// (default /tmp/kimi-startup-trace.log, override with
// KIMI_STARTUP_TRACE_LOG=<path>), so a slow or BLOCKING startup phase
// (network preflight, slow fs, spawnSync) is visible by wall-clock even
// where a CPU profile would only show idle. Temporary instrumentation.

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const enabled = process.env['KIMI_STARTUP_TRACE'] !== undefined && process.env['KIMI_STARTUP_TRACE'] !== '';
const logPath = process.env['KIMI_STARTUP_TRACE_LOG'] ?? '/tmp/kimi-startup-trace.log';
const t0 = performance.now();
let prepared = false;

export function startupTrace(label: string): void {
  if (!enabled) return;
  if (!prepared) {
    prepared = true;
    try {
      mkdirSync(path.dirname(logPath), { recursive: true });
      appendFileSync(logPath, `--- ${new Date().toISOString()} pid=${process.pid} ---\n`);
    } catch {
      /* best effort */
    }
  }
  try {
    appendFileSync(logPath, `${(performance.now() - t0).toFixed(0).padStart(7)}ms ${label}\n`);
  } catch {
    /* best effort */
  }
}
