import { describe, expect, it } from 'vitest';

import { UNDO_LIMIT_STATUS_TURN_ID } from '#/tui/constant/kimi-tui';
import {
  hasResumableTranscriptContent,
  ProgramResumeController,
  type ProgramResumeControllerOptions,
  type ProgramResumeState,
  type ProgramResumeTranscriptEntry,
} from '#/tui/controllers/program-resume';

import { decodeOsc7577, type DecodedProgramResume } from '../../helpers/osc7577';

interface MutableHarnessState extends ProgramResumeState {
  readonly appState: {
    isReplaying: boolean;
    sessionId: string;
    workDir: string;
  };
  transcriptEntries: Array<ProgramResumeTranscriptEntry & { readonly id?: string }>;
}

const TEST_TOKEN = 'secret-osc7577-token';
const TEST_PID = 42424;

function makeHarness(options: ProgramResumeControllerOptions = { token: TEST_TOKEN }) {
  let now = 1_795_543_200;
  const state: MutableHarnessState = {
    appState: {
      isReplaying: false,
      sessionId: '',
      workDir: '/workspace/project',
    },
    transcriptEntries: [],
  };
  const writes: string[] = [];
  const terminal = {
    write(data: string): void {
      writes.push(data);
    },
  };
  const controller = new ProgramResumeController(state, terminal, {
    pid: TEST_PID,
    nowSeconds: () => now,
    ...options,
  });
  return {
    controller,
    state,
    writes,
    advanceTime(seconds = 10): number {
      now += seconds;
      return now;
    },
    decoded(token = options.token ?? TEST_TOKEN): DecodedProgramResume[] {
      return writes.map((item) => decodeOsc7577(item, token));
    },
  };
}

describe('ProgramResumeController', () => {
  it('stays completely silent when token is missing or empty', () => {
    for (const token of [undefined, '']) {
      const harness = makeHarness(token === undefined ? {} : { token });
      harness.state.appState.sessionId = 'ses-1';
      harness.state.transcriptEntries.push({});

      harness.controller.refresh();
      harness.controller.republish();
      const release = harness.controller.hold();
      release();
      harness.controller.preserveForSignal();
      harness.controller.clearForExit();
      harness.controller.clearForExit({ force: true });

      expect(harness.writes).toEqual([]);
    }
  });

  it('stays silent for empty sessions and does not emit clear=1 on exit if nothing was reported', () => {
    const harness = makeHarness();
    harness.controller.refresh();
    harness.controller.republish();

    harness.state.appState.sessionId = 'ses-empty';
    harness.controller.refresh();
    harness.controller.republish();

    harness.state.appState.sessionId = '';
    harness.state.transcriptEntries.push({});
    harness.controller.refresh();

    harness.controller.clearForExit();
    expect(harness.writes).toEqual([]);

    const forcedHarness = makeHarness();
    forcedHarness.controller.preserveForSignal();
    forcedHarness.controller.clearForExit({ force: true });
    expect(forcedHarness.writes).toEqual([]);
  });

  it('reports kimi -r <sessionId> with cwd once the session has transcript content and deduplicates across time', () => {
    const harness = makeHarness();
    harness.state.appState.sessionId = 'ses-alpha';
    harness.state.transcriptEntries.push({ id: 'msg-1' });
    harness.controller.refresh();

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-alpha'],
        cwd: '/workspace/project',
      },
    ]);

    harness.advanceTime(30);
    harness.state.transcriptEntries.push({ id: 'msg-2' });
    harness.controller.refresh();
    expect(harness.writes).toHaveLength(1);
  });

  it('updates the reported command when sessionId or workDir changes and supports custom commandName', () => {
    const harness = makeHarness({ token: TEST_TOKEN, commandName: '/usr/local/bin/kimi' });
    harness.state.appState.sessionId = 'ses-1';
    harness.state.transcriptEntries.push({});
    harness.controller.refresh();

    const t2 = harness.advanceTime(5);
    harness.state.appState.workDir = '/workspace/other';
    harness.controller.refresh();

    const t3 = harness.advanceTime(5);
    harness.state.appState.sessionId = 'ses-2';
    harness.controller.refresh();

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['/usr/local/bin/kimi', '-r', 'ses-1'],
        cwd: '/workspace/project',
      },
      {
        kind: 'resume',
        pid: TEST_PID,
        time: t2,
        argv: ['/usr/local/bin/kimi', '-r', 'ses-1'],
        cwd: '/workspace/other',
      },
      {
        kind: 'resume',
        pid: TEST_PID,
        time: t3,
        argv: ['/usr/local/bin/kimi', '-r', 'ses-2'],
        cwd: '/workspace/other',
      },
    ]);
  });

  it('emits a single clear=1 when a previously reported session becomes empty', () => {
    const harness = makeHarness();
    harness.state.appState.sessionId = 'ses-1';
    harness.state.transcriptEntries.push({});
    harness.controller.refresh();

    const clearTime = harness.advanceTime(12);
    harness.state.transcriptEntries = [];
    harness.controller.refresh();
    harness.advanceTime(12);
    harness.controller.refresh();
    harness.controller.clearForExit();

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-1'],
        cwd: '/workspace/project',
      },
      {
        kind: 'clear',
        pid: TEST_PID,
        time: clearTime,
      },
    ]);
  });

  it('suppresses unreportable targets initially and clears a prior report when the target becomes unreportable', () => {
    const unreportableCases = [
      { sessionId: 'ses-1', workDir: 'relative/dir' },
      { sessionId: 'ses-1', workDir: '/workspace/line\nbreak' },
      { sessionId: 'ses-\u001Bbad', workDir: '/workspace/project' },
      { sessionId: 'ses-1', workDir: `/workspace/${'x'.repeat(2048)}` },
    ];

    for (const bad of unreportableCases) {
      const fresh = makeHarness();
      fresh.state.appState.sessionId = bad.sessionId;
      fresh.state.appState.workDir = bad.workDir;
      fresh.state.transcriptEntries.push({});
      fresh.controller.refresh();
      expect(fresh.writes).toEqual([]);
    }

    const harness = makeHarness();
    harness.state.appState.sessionId = 'ses-valid';
    harness.state.transcriptEntries.push({});
    harness.controller.refresh();

    const clearTime = harness.advanceTime(7);
    harness.state.appState.workDir = 'relative/dir';
    harness.controller.refresh();
    harness.advanceTime(7);
    harness.state.appState.workDir = `/workspace/${'x'.repeat(2048)}`;
    harness.controller.refresh();

    const recoverTime = harness.advanceTime(7);
    harness.state.appState.workDir = '/workspace/recovered';
    harness.controller.refresh();

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-valid'],
        cwd: '/workspace/project',
      },
      {
        kind: 'clear',
        pid: TEST_PID,
        time: clearTime,
      },
      {
        kind: 'resume',
        pid: TEST_PID,
        time: recoverTime,
        argv: ['kimi', '-r', 'ses-valid'],
        cwd: '/workspace/recovered',
      },
    ]);
  });

  it('stays silent while isReplaying is true and converges once replay finishes', () => {
    const harness = makeHarness();
    harness.state.appState.isReplaying = true;
    harness.state.appState.sessionId = 'ses-replayed';
    harness.state.transcriptEntries.push({ id: '1' });
    harness.controller.refresh();
    harness.state.transcriptEntries.push({ id: '2' });
    harness.controller.refresh();
    expect(harness.writes).toEqual([]);

    const doneTime = harness.advanceTime(3);
    harness.state.appState.isReplaying = false;
    harness.controller.refresh();

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: doneTime,
        argv: ['kimi', '-r', 'ses-replayed'],
        cwd: '/workspace/project',
      },
    ]);
  });

  it('coalesces intermediate state transitions and prevents clear=1 flicker across nested holds', () => {
    const harness = makeHarness();
    harness.state.appState.sessionId = 'ses-old';
    harness.state.transcriptEntries = [{ id: 'old-msg' }];
    harness.controller.refresh();
    expect(harness.writes).toHaveLength(1);

    const releaseOuter = harness.controller.hold();
    const releaseInner = harness.controller.hold();

    harness.state.appState.sessionId = 'ses-new';
    harness.controller.refresh();
    harness.state.transcriptEntries = [];
    harness.controller.refresh();

    releaseInner();
    releaseInner();
    expect(harness.writes).toHaveLength(1);

    harness.state.transcriptEntries = [{ id: 'new-msg' }];
    harness.controller.refresh();
    expect(harness.writes).toHaveLength(1);

    const switchTime = harness.advanceTime(15);
    releaseOuter();
    releaseOuter();

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-old'],
        cwd: '/workspace/project',
      },
      {
        kind: 'resume',
        pid: TEST_PID,
        time: switchTime,
        argv: ['kimi', '-r', 'ses-new'],
        cwd: '/workspace/project',
      },
    ]);
  });

  it('runHeld coalesces async transitions and releases the hold even on rejection', async () => {
    const harness = makeHarness();
    const result = await harness.controller.runHeld(async () => {
      harness.state.appState.sessionId = 'ses-held';
      harness.controller.refresh();
      await Promise.resolve();
      harness.state.transcriptEntries = [{ id: 'msg-1' }];
      harness.controller.refresh();
      expect(harness.writes).toEqual([]);
      return 'done';
    });
    expect(result).toBe('done');
    expect(harness.writes).toHaveLength(1);

    const clearTime = harness.advanceTime(8);
    await expect(
      harness.controller.runHeld(async () => {
        harness.state.transcriptEntries = [];
        harness.controller.refresh();
        expect(harness.writes).toHaveLength(1);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-held'],
        cwd: '/workspace/project',
      },
      {
        kind: 'clear',
        pid: TEST_PID,
        time: clearTime,
      },
    ]);
  });

  it('republishes with a fresh timestamp when active and stays silent when empty', () => {
    const harness = makeHarness();
    harness.controller.republish();
    expect(harness.writes).toEqual([]);

    harness.state.appState.sessionId = 'ses-1';
    harness.state.transcriptEntries.push({});
    harness.controller.refresh();

    const republishTime = harness.advanceTime(45);
    harness.controller.republish();

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-1'],
        cwd: '/workspace/project',
      },
      {
        kind: 'resume',
        pid: TEST_PID,
        time: republishTime,
        argv: ['kimi', '-r', 'ses-1'],
        cwd: '/workspace/project',
      },
    ]);
  });

  it('clears once on normal exit and blocks subsequent writes', () => {
    const harness = makeHarness();
    harness.state.appState.sessionId = 'ses-1';
    harness.state.transcriptEntries.push({});
    harness.controller.refresh();

    const exitTime = harness.advanceTime(20);
    harness.controller.clearForExit();
    harness.advanceTime(5);
    harness.controller.refresh();
    harness.controller.republish();
    harness.controller.clearForExit({ force: true });

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-1'],
        cwd: '/workspace/project',
      },
      {
        kind: 'clear',
        pid: TEST_PID,
        time: exitTime,
      },
    ]);
  });

  it('preserves the last report on signal shutdown unless forced to clear', () => {
    const harness = makeHarness();
    harness.state.appState.sessionId = 'ses-1';
    harness.state.transcriptEntries.push({});
    harness.controller.refresh();

    harness.advanceTime(10);
    harness.controller.preserveForSignal();
    harness.state.transcriptEntries = [];
    harness.controller.refresh();
    harness.controller.republish();
    harness.controller.clearForExit();
    expect(harness.writes).toHaveLength(1);

    const forceClearTime = harness.advanceTime(5);
    harness.controller.clearForExit({ force: true });
    harness.controller.clearForExit({ force: true });

    expect(harness.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-1'],
        cwd: '/workspace/project',
      },
      {
        kind: 'clear',
        pid: TEST_PID,
        time: forceClearTime,
      },
    ]);
  });

  it('ignores undo-limit-status entries when empty and emits clear=1 when only undo-limit-status remains', () => {
    const undoStatusEntry = { kind: 'status', turnId: UNDO_LIMIT_STATUS_TURN_ID } as const;
    expect(hasResumableTranscriptContent([])).toBe(false);
    expect(hasResumableTranscriptContent([undoStatusEntry])).toBe(false);
    expect(hasResumableTranscriptContent([{ kind: 'status', turnId: 'turn-1' }])).toBe(true);
    expect(hasResumableTranscriptContent([{ kind: 'status' }])).toBe(true);

    const emptyWithUndoStatus = makeHarness();
    emptyWithUndoStatus.state.appState.sessionId = 'ses-empty-undo';
    emptyWithUndoStatus.state.transcriptEntries.push(undoStatusEntry);
    emptyWithUndoStatus.controller.refresh();
    emptyWithUndoStatus.controller.republish();
    emptyWithUndoStatus.controller.clearForExit();
    expect(emptyWithUndoStatus.writes).toEqual([]);

    const statusBeforeReal = makeHarness();
    statusBeforeReal.state.appState.sessionId = 'ses-before';
    statusBeforeReal.state.transcriptEntries.push(undoStatusEntry);
    statusBeforeReal.controller.refresh();
    expect(statusBeforeReal.writes).toEqual([]);

    statusBeforeReal.state.transcriptEntries.push({ id: 'msg-1', kind: 'user' });
    statusBeforeReal.controller.refresh();
    const clearBeforeTime = statusBeforeReal.advanceTime(10);
    statusBeforeReal.state.transcriptEntries = [undoStatusEntry];
    statusBeforeReal.controller.refresh();

    expect(statusBeforeReal.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-before'],
        cwd: '/workspace/project',
      },
      {
        kind: 'clear',
        pid: TEST_PID,
        time: clearBeforeTime,
      },
    ]);

    const statusAfterReal = makeHarness();
    statusAfterReal.state.appState.sessionId = 'ses-after';
    statusAfterReal.state.transcriptEntries.push(
      { id: 'msg-1', kind: 'user' },
      undoStatusEntry,
    );
    statusAfterReal.controller.refresh();
    const clearAfterTime = statusAfterReal.advanceTime(10);
    statusAfterReal.state.transcriptEntries = [undoStatusEntry];
    statusAfterReal.controller.refresh();

    expect(statusAfterReal.decoded()).toEqual([
      {
        kind: 'resume',
        pid: TEST_PID,
        time: 1_795_543_200,
        argv: ['kimi', '-r', 'ses-after'],
        cwd: '/workspace/project',
      },
      {
        kind: 'clear',
        pid: TEST_PID,
        time: clearAfterTime,
      },
    ]);
  });
});
