/**
 * Pet state reporter.
 *
 * Lives inside the CLI process (TUI or headless `-p` run) and mirrors the
 * current session's activity into `<dataDir>/pet/sessions/<sessionId>.json`
 * for the desktop-pet overlay to render. Writes are event-driven (no polling)
 * and gated on the overlay heartbeat, so a stopped pet costs nothing.
 */

import { rmSync } from 'node:fs';

import type { Event, Session } from '@moonshot-ai/kimi-code-sdk';

import { getPetOverlayHeartbeatFile, getPetSessionsDir } from './dirs';

import type { PetSessionState, PetSessionStatus } from './state';
import { isPetOverlayAlive, petSessionStateFile, writeJsonFileAtomicSync } from './state';

const STATUS_TEXT_MAX_LENGTH = 48;
/** Pure liveness refreshes (deltas) persist at most this often. */
const REFRESH_WRITE_INTERVAL_MS = 2_000;

export interface PetReporterSessionMeta {
  readonly sessionId: string;
  readonly cwd?: string;
}

export interface PetReporterOptions {
  readonly sessionsDir?: string;
  readonly heartbeatFile?: string;
  readonly now?: () => number;
}

type SessionEventSource = Pick<Session, 'onEvent'>;

export class PetReporter {
  private readonly sessionsDir: string;
  private readonly heartbeatFile: string;
  private readonly now: () => number;

  private state: PetSessionState | undefined;
  private unsubscribe: (() => void) | undefined;
  private lastWriteAt = 0;

  constructor(options: PetReporterOptions = {}) {
    this.sessionsDir = options.sessionsDir ?? getPetSessionsDir();
    this.heartbeatFile = options.heartbeatFile ?? getPetOverlayHeartbeatFile();
    this.now = options.now ?? (() => Date.now());
  }

  attachSession(session: SessionEventSource, meta: PetReporterSessionMeta): void {
    this.detachSession();
    this.state = {
      sessionId: meta.sessionId,
      cwd: meta.cwd,
      status: 'idle',
      pid: process.pid,
      termProgram: process.env['TERM_PROGRAM'],
      updatedAt: this.now(),
    };
    this.unsubscribe = session.onEvent((event) => {
      if (event.sessionId !== meta.sessionId) return;
      this.handleEvent(event);
    });
  }

  detachSession(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const state = this.state;
    this.state = undefined;
    if (state !== undefined) {
      rmSync(petSessionStateFile(this.sessionsDir, state.sessionId), { force: true });
    }
  }

  /** Approval/question request surfaced — the pet should flag attention. */
  notifyInteractionPending(statusText: string): void {
    this.apply('awaiting', statusText);
  }

  /** The pending approval/question was answered; back to work. */
  notifyInteractionResolved(): void {
    if (this.state?.status === 'awaiting') {
      this.apply('working', undefined);
    }
  }

  handleEvent(event: Event): void {
    switch (event.type) {
      case 'turn.started':
        if (event.prompt !== undefined) {
          this.setTitle(truncate(oneLine(event.prompt), 60));
        }
        this.apply('working', '思考中…');
        return;
      case 'tool.call.started':
        this.apply('working', truncate(oneLine(event.description ?? event.name)));
        return;
      case 'agent.status.updated': {
        const phase = event.phase;
        if (phase?.kind === 'awaiting_approval') {
          this.apply('awaiting', '等待你的确认…');
        } else if (phase?.kind === 'running' || phase?.kind === 'streaming') {
          // Keep the current statusText (usually the active tool call).
          this.apply('working', this.state?.statusText ?? '思考中…');
        }
        return;
      }
      case 'turn.ended':
        switch (event.reason) {
          case 'completed':
            this.apply('done', `任务完成${formatDurationSuffix(event.durationMs)}`);
            return;
          case 'failed':
            this.apply('failed', '任务出错了');
            return;
          case 'blocked':
            this.apply('awaiting', '任务被阻塞，需要处理');
            return;
          default:
            this.apply('idle', undefined);
            return;
        }
      case 'error':
        this.apply('failed', truncate(oneLine(event.message)));
        return;
      case 'assistant.delta':
      case 'thinking.delta':
        // Long streaming turns produce no other events; refresh the TTL so the
        // pet does not fall back to idle mid-turn.
        this.refresh();
        return;
      default:
        return;
    }
  }

  private refresh(): void {
    if (this.state === undefined) return;
    this.state = { ...this.state, updatedAt: this.now() };
    if (this.now() - this.lastWriteAt >= REFRESH_WRITE_INTERVAL_MS) {
      this.persist();
    }
  }

  private setTitle(title: string): void {
    if (this.state === undefined) return;
    this.state = { ...this.state, title };
  }

  private apply(status: PetSessionStatus, statusText: string | undefined): void {
    if (this.state === undefined) return;
    const changed = this.state.status !== status || this.state.statusText !== statusText;
    this.state = { ...this.state, status, statusText, updatedAt: this.now() };
    if (changed) {
      // State transitions are rare and user-visible; persist immediately.
      this.lastWriteAt = 0;
    }
    this.refresh();
  }

  private persist(): void {
    if (this.state === undefined) return;
    if (!isPetOverlayAlive(this.heartbeatFile, this.now())) return;
    this.lastWriteAt = this.now();
    try {
      writeJsonFileAtomicSync(petSessionStateFile(this.sessionsDir, this.state.sessionId), this.state);
    } catch {
      // Best-effort: a failed write must never break the session.
    }
  }
}

function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number = STATUS_TEXT_MAX_LENGTH): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function formatDurationSuffix(durationMs: number | undefined): string {
  if (durationMs === undefined) return '';
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `（${seconds}s）`;
  return `（${Math.floor(seconds / 60)}m${seconds % 60}s）`;
}
