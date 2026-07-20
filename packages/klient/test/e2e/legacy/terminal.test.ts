/**
 * Live-server invariant for the v1 terminal surface (REST + WS controls — no
 * `/api/v2` equivalent): create/list/get a terminal, attach + input over WS,
 * observe `terminal_output`, resize, close with `terminal_exit`.
 *
 * Converted from the retired scenario `11-terminal.ts`. Skips when no server
 * is reachable at `KIMI_SERVER_URL`.
 */
import { describe, expect, it } from 'vitest';

import { DaemonClient, type AnyFrame } from '../harness/index.js';
import { fetchWithReport } from '../harness/report.js';
import { createCaseLogger } from './log.js';

const BASE_URL = process.env['KIMI_SERVER_URL'] ?? 'http://127.0.0.1:58627';
const API_PREFIX = '/api/v1';
const TERMINAL_SHELL = process.env['KIMI_SERVER_E2E_TERMINAL_SHELL'] ?? '/bin/sh';
const OUTPUT_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 5_000;
const CANARY = `KIMI_KLIENT_E2E_TERMINAL_${process.pid}_${Date.now()}`;

async function daemonReachable(): Promise<boolean> {
  try {
    const res = await fetchWithReport(`${BASE_URL}${API_PREFIX}/meta`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const reachable = await daemonReachable();
const describeLive = reachable ? describe : describe.skip;

interface TerminalOutputPayload {
  data: string;
}

function isTerminalOutputFor(frame: AnyFrame, sid: string, terminalId: string): boolean {
  const terminalFrame = frame as AnyFrame & { terminal_id?: string };
  return (
    frame.type === 'terminal_output' &&
    frame.session_id === sid &&
    terminalFrame.terminal_id === terminalId
  );
}

function isTerminalExitFor(sid: string, terminalId: string): (frame: AnyFrame) => boolean {
  return (frame) => {
    const terminalFrame = frame as AnyFrame & { terminal_id?: string };
    return (
      frame.type === 'terminal_exit' &&
      frame.session_id === sid &&
      terminalFrame.terminal_id === terminalId
    );
  };
}

function toShellOctalEscapes(value: string): string {
  return Array.from(value)
    .map((char) => `\\${char.codePointAt(0)!.toString(8).padStart(3, '0')}`)
    .join('');
}

function payloadOf<T>(frame: AnyFrame): T {
  if (frame.payload === undefined) throw new Error(`${frame.type} frame should carry payload`);
  return frame.payload as T;
}

describeLive('legacy: terminal controls', () => {
  it('terminal output, resize, and close round-trip', async () => {
    const log = createCaseLogger('legacy: terminal controls');
    const client = new DaemonClient({ baseUrl: BASE_URL });

    let sid: string | undefined;
    let terminalId: string | undefined;
    let terminalClosed = false;

    try {
      const session = await client.createSession({
        title: 'klient-e2e terminal',
        metadata: { cwd: process.cwd(), scenario: 'terminal' },
      });
      sid = session.id;
      const sessionId = session.id;
      log('session created', { session_id: sessionId });

      await client.connect();
      await client.subscribe(sessionId);

      const terminal = await client.createTerminal(sessionId, {
        shell: TERMINAL_SHELL,
        cols: 80,
        rows: 24,
      });
      terminalId = terminal.id;
      expect(terminal.session_id).toBe(sessionId);
      expect(terminal.status).toBe('running');
      expect(terminal.cols).toBe(80);
      expect(terminal.rows).toBe(24);
      log('terminal created', { id: terminal.id, shell: terminal.shell });

      const listed = await client.listTerminals(sessionId);
      expect(listed.items.some((item) => item.id === terminal.id)).toBe(true);

      const observedOutput: string[] = [];
      const unsubscribe = client.onFrame((frame) => {
        if (!isTerminalOutputFor(frame, sessionId, terminal.id)) return;
        observedOutput.push(payloadOf<TerminalOutputPayload>(frame).data);
      });

      try {
        const attach = await client.attachTerminal(sessionId, terminal.id, { sinceSeq: 0 });
        expect(attach.attached).toBe(true);
        expect(typeof attach.replayed).toBe('number');
        log('terminal attached', attach);

        const input = `printf '%b\\n' '${toShellOctalEscapes(CANARY)}'\n`;
        const inputAck = await client.writeTerminalInput(sessionId, terminal.id, input);
        expect(inputAck).toEqual({ accepted: true });

        const deadline = Date.now() + OUTPUT_TIMEOUT_MS;
        let text = '';
        while (Date.now() < deadline) {
          text = observedOutput.join('');
          if (text.includes(CANARY)) break;
          await new Promise((resolve) => {
            setTimeout(resolve, 25);
          });
        }
        expect(text).toContain(CANARY);
        log('terminal output observed', { matched: CANARY });

        const resizeAck = await client.resizeTerminal(sessionId, terminal.id, 100, 31);
        expect(resizeAck).toEqual({ resized: true });
        const resized = await client.getTerminal(sessionId, terminal.id);
        expect(resized.cols).toBe(100);
        expect(resized.rows).toBe(31);
        log('terminal resized', { cols: resized.cols, rows: resized.rows });

        const exitFramePromise = client.waitForFrame(isTerminalExitFor(sessionId, terminal.id), {
          timeoutMs: EXIT_TIMEOUT_MS,
        });
        const closeAck = await client.closeTerminalControl(sessionId, terminal.id);
        terminalClosed = true;
        expect(closeAck).toEqual({ closed: true });
        await exitFramePromise;
        log('terminal exit frame received', {});

        const closed = await client.getTerminal(sessionId, terminal.id);
        expect(closed.status).toBe('exited');
      } finally {
        unsubscribe();
      }
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
  }, 60_000);
});
