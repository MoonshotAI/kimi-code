import { describe, expect, it } from 'vitest';

import { Emitter } from '#/_base/event';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import type {
  SessionActivityChangedEvent,
  SessionActivityState,
} from '#/session/sessionActivity/sessionActivity';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import { SessionOutcomeRecorder } from '#/session/sessionActivity/sessionOutcomeRecorderService';

function state(lastTurnReason?: SessionActivityState['lastTurnReason']): SessionActivityState {
  return { busy: false, mainTurnActive: false, pendingInteraction: 'none', lastTurnReason };
}

function fire(
  emitter: Emitter<SessionActivityChangedEvent>,
  cause: SessionActivityChangedEvent['cause'],
  s: SessionActivityState,
): void {
  emitter.fire({ state: s, cause });
}

describe('SessionOutcomeRecorder', () => {
  function harness() {
    const onDidChange = new Emitter<SessionActivityChangedEvent>();
    const activity = { onDidChange: onDidChange.event } as unknown as ISessionActivityView;
    const writes: SessionMeta['lastTurnOutcome'][] = [];
    const metadata = {
      update: async (patch: { lastTurnOutcome?: SessionMeta['lastTurnOutcome'] }) => {
        writes.push(patch.lastTurnOutcome);
      },
    } as unknown as ISessionMetadata;
    const recorder = new SessionOutcomeRecorder(activity, metadata);
    return {
      onDidChange,
      writes,
      dispose: () => {
        recorder.dispose();
      },
    };
  }

  it('persists completed/failed when a main turn ends', () => {
    const { onDidChange, writes, dispose } = harness();
    fire(onDidChange, 'turn_ended', state('failed'));
    fire(onDidChange, 'turn_ended', state('completed'));
    expect(writes).toEqual(['failed', 'completed']);
    dispose();
  });

  it('never persists cancelled (the teardown outcome would race disposal)', () => {
    const { onDidChange, writes, dispose } = harness();
    fire(onDidChange, 'turn_ended', state('cancelled'));
    expect(writes).toEqual([]);
    dispose();
  });

  it('ignores non-turn_ended causes and empty outcomes', () => {
    const { onDidChange, writes, dispose } = harness();
    fire(onDidChange, 'turn_started', state('failed'));
    fire(onDidChange, 'background', state('failed'));
    fire(onDidChange, 'turn_ended', state());
    expect(writes).toEqual([]);
    dispose();
  });

  it('dedupes repeated outcomes within the process', () => {
    const { onDidChange, writes, dispose } = harness();
    fire(onDidChange, 'turn_ended', state('failed'));
    fire(onDidChange, 'turn_ended', state('failed'));
    expect(writes).toEqual(['failed']);
    dispose();
  });
});
