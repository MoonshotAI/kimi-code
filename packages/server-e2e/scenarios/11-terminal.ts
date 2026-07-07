#!/usr/bin/env node
/**
 * Scenario 11 — server terminal REST + WS controls.
 *
 * Exercises:
 *   - POST /sessions/{id}/terminals
 *   - GET /sessions/{id}/terminals
 *   - GET /sessions/{id}/terminals/{terminal_id}
 *   - WS terminal_attach / terminal_input / terminal_resize / terminal_close
 *   - terminal_output and terminal_exit frames
 */
import assert from 'node:assert/strict';

import { DaemonClient, recordReportEvent, type AnyFrame } from '../src/index';

const KIMI_SERVER_URL = process.env['KIMI_SERVER_URL'] ?? 'http://127.0.0.1:58627';
const TERMINAL_SHELL = process.env['KIMI_SERVER_E2E_TERMINAL_SHELL'] ?? '/bin/sh';
const OUTPUT_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 5_000;
const CANARY = `KIMI_SERVER_E2E_TERMINAL_${process.pid}_${Date.now()}`;

async function main() {
  log('server', { base_url: KIMI_SERVER_URL, shell: TERMINAL_SHELL });
  const client = new DaemonClient({ baseUrl: KIMI_SERVER_URL });

  let sid: string | undefined;
  let terminalId: string | undefined;
  let terminalClosed = false;

  try {
    const session = await client.createSession({
      title: 'server-e2e terminal',
      metadata: { cwd: process.cwd(), scenario: '11-terminal' },
    });
    sid = session.id;
    const sessionId = session.id;
    log('session created', { session_id: sessionId, cwd: session.metadata.cwd });

    await client.connect();
    await client.subscribe(sessionId);
    log('ws subscribed', { session_id: sessionId });

    const terminal = await client.createTerminal(sessionId, {
      shell: TERMINAL_SHELL,
      cols: 80,
      rows: 24,
    });
    terminalId = terminal.id;
    assert.equal(terminal.session_id, sessionId);
    assert.equal(terminal.status, 'running');
    assert.equal(terminal.cols, 80);
    assert.equal(terminal.rows, 24);
    log('terminal created', terminalForLog(terminal));

    const listed = await client.listTerminals(sessionId);
    assert.ok(
      listed.items.some((item) => item.id === terminal.id),
      'terminal list should include the created terminal',
    );
    log('terminal list', {
      count: listed.items.length,
      ids: listed.items.map((item) => item.id),
    });

    const observedOutput: string[] = [];
    const unsubscribe = client.onFrame((frame) => {
      if (!isTerminalOutputFor(frame, sessionId, terminal.id)) return;
      observedOutput.push(payloadOf<TerminalOutputPayload>(frame).data);
    });

    try {
      const attach = await client.attachTerminal(sessionId, terminal.id, { sinceSeq: 0 });
      assert.equal(attach.attached, true);
      assert.equal(typeof attach.replayed, 'number');
      log('terminal attached', attach);

      const input = `printf '%b\\n' '${toShellOctalEscapes(CANARY)}'\n`;
      const inputAck = await client.writeTerminalInput(sessionId, terminal.id, input);
      assert.deepEqual(inputAck, { accepted: true });
      log('terminal input accepted', {
        input_bytes: input.length,
        expected_output: CANARY,
      });

      const output = await waitForTerminalText(observedOutput, CANARY, OUTPUT_TIMEOUT_MS);
      log('terminal output observed', {
        matched: CANARY,
        output_tail: printableTail(output),
      });

      const resizeAck = await client.resizeTerminal(sessionId, terminal.id, 100, 31);
      assert.deepEqual(resizeAck, { resized: true });
      const resized = await client.getTerminal(sessionId, terminal.id);
      assert.equal(resized.cols, 100);
      assert.equal(resized.rows, 31);
      log('terminal resized', terminalForLog(resized));

      const exitFramePromise = client.waitForFrame(isTerminalExitFor(sessionId, terminal.id), {
        timeoutMs: EXIT_TIMEOUT_MS,
      });
      const closeAck = await client.closeTerminalControl(sessionId, terminal.id);
      terminalClosed = true;
      assert.deepEqual(closeAck, { closed: true });
      log('terminal close ack', closeAck);

      const exitFrame = await exitFramePromise;
      log('terminal exit frame', frameForLog(exitFrame));

      const closed = await client.getTerminal(sessionId, terminal.id);
      assert.equal(closed.status, 'exited');
      log('terminal final state', terminalForLog(closed));
    } finally {
      unsubscribe();
    }

    writeLine(`✓ 11-terminal: terminal ${terminal.id} output, resize, and close round-tripped`);
  } finally {
    if (sid !== undefined && terminalId !== undefined && !terminalClosed) {
      try {
        await client.closeTerminal(sid, terminalId);
      } catch {
        // ignore
      }
    }
    try {
      if (sid) await client.archiveSession(sid);
    } catch {
      // ignore
    }
    await client.close();
  }
}

interface TerminalOutputPayload {
  data: string;
}

interface TerminalForLog {
  id: string;
  session_id: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  status: string;
  exit_code?: number | null;
}

function isTerminalOutputFor(
  frame: AnyFrame,
  sid: string,
  terminalId: string,
): boolean {
  const terminalFrame = frame as AnyFrame & { terminal_id?: string };
  return (
    frame.type === 'terminal_output' &&
    frame.session_id === sid &&
    terminalFrame.terminal_id === terminalId
  );
}

function isTerminalExitFor(
  sid: string,
  terminalId: string,
): (frame: AnyFrame) => boolean {
  return (frame) => {
    const terminalFrame = frame as AnyFrame & { terminal_id?: string };
    return (
      frame.type === 'terminal_exit' &&
      frame.session_id === sid &&
      terminalFrame.terminal_id === terminalId
    );
  };
}

async function waitForTerminalText(
  chunks: readonly string[],
  expected: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = chunks.join('');
    if (text.includes(expected)) return text;
    await sleep(25);
  }
  throw new Error(
    `terminal output did not include ${JSON.stringify(expected)} within ${timeoutMs}ms; ` +
      `output tail=${JSON.stringify(printableTail(chunks.join('')))}`,
  );
}

function toShellOctalEscapes(value: string): string {
  return Array.from(value)
    .map((char) => `\\${char.codePointAt(0)!.toString(8).padStart(3, '0')}`)
    .join('');
}

function payloadOf<T>(frame: AnyFrame): T {
  assert.ok(frame.payload !== undefined, `${frame.type} frame should carry payload`);
  return frame.payload as T;
}

function terminalForLog(terminal: TerminalForLog): Record<string, unknown> {
  return {
    id: terminal.id,
    session_id: terminal.session_id,
    cwd: terminal.cwd,
    shell: terminal.shell,
    cols: terminal.cols,
    rows: terminal.rows,
    status: terminal.status,
    exit_code: terminal.exit_code,
  };
}

function frameForLog(frame: AnyFrame): Record<string, unknown> {
  const terminalFrame = frame as AnyFrame & { terminal_id?: string };
  return {
    type: frame.type,
    session_id: frame.session_id,
    terminal_id: terminalFrame.terminal_id,
    seq: frame.seq,
    payload: frame.payload,
  };
}

function printableTail(text: string): string {
  return text
    .slice(-1000)
    .replaceAll('\r', '\\r')
    .replaceAll('\u001B', '\\x1B');
}

function log(label: string, value?: unknown): void {
  recordReportEvent({ kind: 'log', label: `terminal: ${label}`, value });
  if (value === undefined) {
    writeLine(`▶ terminal: ${label}`);
    return;
  }
  writeLine(`▶ terminal: ${label} ${JSON.stringify(value)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`✗ 11-terminal failed: ${formatError(error)}\n`);
  process.exit(1);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.stack ?? error.message}`;
  }
  return String(error);
}
