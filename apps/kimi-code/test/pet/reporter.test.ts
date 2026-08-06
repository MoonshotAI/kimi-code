/**
 * Pet state reporter: event-to-state mapping, overlay-heartbeat gating,
 * cross-session filtering, and cleanup on detach. Uses a fake session event
 * source and temp dirs; no engine involved.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Event } from '@moonshot-ai/kimi-code-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PetReporter } from '#/pet/reporter';
import type { PetSessionState } from '#/pet/state';
import { petSessionStateFile, writePetOverlayHeartbeat } from '#/pet/state';

class FakeSession {
  private readonly listeners = new Set<(event: Event) => void>();

  onEvent(listener: (event: Event) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: Partial<Event> & { type: string }): void {
    for (const listener of this.listeners) {
      listener(event as Event);
    }
  }
}

describe('PetReporter', () => {
  let dir: string;
  let sessionsDir: string;
  let heartbeatFile: string;
  let session: FakeSession;
  let reporter: PetReporter;

  const stateFile = (sessionId: string): string => petSessionStateFile(sessionsDir, sessionId);

  const readState = (sessionId: string): PetSessionState =>
    JSON.parse(readFileSync(stateFile(sessionId), 'utf-8')) as PetSessionState;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-pet-reporter-'));
    sessionsDir = join(dir, 'sessions');
    heartbeatFile = join(dir, 'overlay.json');
    session = new FakeSession();
    reporter = new PetReporter({ sessionsDir, heartbeatFile });
    reporter.attachSession(session, { sessionId: 's1', cwd: '/repo' });
  });

  afterEach(() => {
    reporter.detachSession();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes nothing while the overlay is not running', () => {
    session.emit({ type: 'turn.started', sessionId: 's1', turnId: 1, prompt: 'fix the bug' });
    expect(existsSync(stateFile('s1'))).toBe(false);
  });

  it('reports a working turn with the prompt as title once the overlay is alive', () => {
    writePetOverlayHeartbeat(heartbeatFile);
    session.emit({ type: 'turn.started', sessionId: 's1', turnId: 1, prompt: 'fix\n the bug' });
    const state = readState('s1');
    expect(state.status).toBe('working');
    expect(state.title).toBe('fix the bug');
    expect(state.statusText).toBe('思考中…');
    expect(state.cwd).toBe('/repo');
    expect(state.pid).toBe(process.pid);
  });

  it('mirrors tool calls as working status text', () => {
    writePetOverlayHeartbeat(heartbeatFile);
    session.emit({
      type: 'tool.call.started',
      sessionId: 's1',
      turnId: 1,
      toolCallId: 't1',
      name: 'Bash',
      description: 'Bash: npm test',
    });
    expect(readState('s1').statusText).toBe('Bash: npm test');
  });

  it('flags pending confirmations and returns to working once resolved', () => {
    writePetOverlayHeartbeat(heartbeatFile);
    reporter.notifyInteractionPending('等待你的确认…');
    expect(readState('s1').status).toBe('awaiting');
    reporter.notifyInteractionResolved();
    expect(readState('s1').status).toBe('working');
  });

  it('maps awaiting_approval phases to the awaiting state', () => {
    writePetOverlayHeartbeat(heartbeatFile);
    session.emit({
      type: 'agent.status.updated',
      sessionId: 's1',
      phase: { kind: 'awaiting_approval', turnId: 1, since: 1 },
    });
    expect(readState('s1').status).toBe('awaiting');
  });

  it('reports completed turns as done with the duration', () => {
    writePetOverlayHeartbeat(heartbeatFile);
    session.emit({
      type: 'turn.ended',
      sessionId: 's1',
      turnId: 1,
      reason: 'completed',
      durationMs: 65_000,
    });
    const state = readState('s1');
    expect(state.status).toBe('done');
    expect(state.statusText).toBe('任务完成（1m5s）');
  });

  it('reports failed turns and error events as failed', () => {
    writePetOverlayHeartbeat(heartbeatFile);
    session.emit({ type: 'turn.ended', sessionId: 's1', turnId: 1, reason: 'failed' });
    expect(readState('s1').status).toBe('failed');
    session.emit({ type: 'error', sessionId: 's1', message: 'boom' });
    expect(readState('s1').statusText).toBe('boom');
  });

  it('ignores events from other sessions', () => {
    writePetOverlayHeartbeat(heartbeatFile);
    session.emit({ type: 'turn.started', sessionId: 'other', turnId: 1, prompt: 'nope' });
    expect(existsSync(stateFile('s1'))).toBe(false);
    expect(existsSync(stateFile('other'))).toBe(false);
  });

  it('removes the state file on detach', () => {
    writePetOverlayHeartbeat(heartbeatFile);
    session.emit({ type: 'turn.started', sessionId: 's1', turnId: 1 });
    expect(existsSync(stateFile('s1'))).toBe(true);
    reporter.detachSession();
    expect(existsSync(stateFile('s1'))).toBe(false);
  });
});
